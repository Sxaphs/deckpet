import { spawn, ChildProcess } from 'node:child_process';
import type {
  AgentDriver,
  AgentSessionHandle,
  BackendConfig,
  ChatChunk,
  DriverContext,
  PromptOptions,
} from '../types.js';

/**
 * DeepSeek Harness（dsh）driver —— 可选编排引擎接入。
 *
 * ⚠️ 安全须知（务必阅读）：
 * - dsh 目前处于 developer preview，未经完整安全审计；
 * - 本 driver 仅负责把 dsh 作为"编排引擎"接入（CLI print/headless 模式拉流），
 *   dsh 内部的一切高危操作（读写文件、执行命令等）审批以本应用权限层
 *   （DriverContext.policy）为准，不信任 dsh 自身的审批逻辑；
 * - backend.dshVersion 用于版本锁定提示：test() 会执行 `dsh --version` 并对比，
 *   不一致时给出 warn 日志但仍返回 ok（preview 阶段允许漂移，仅提示）。
 *
 * 通信方式：每次 prompt 以子进程拉起一次 headless 运行，默认
 *   dsh run --output-format stream-json --prompt "<text>"
 * 第二次起的 prompt 追加续聊参数（默认 --continue，可被 backend.options 覆盖）。
 * stdout 按 JSONL 逐行解析为 ChatChunk；无法识别的行降级为 status 块。
 *
 * 可覆盖项（backend.options）：
 *   runArgs: string[]       默认 ['run', '--output-format', 'stream-json']
 *   promptFlag: string      默认 '--prompt'
 *   continueArgs: string[]  默认 ['--continue']；设 [] 关闭续聊
 *
 * 权限兜底：任何子进程拉起前过 PolicyEngine.authorize({kind:'shell.exec'})，
 * 拒绝即报错。
 */

function optStrings(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as string[])
    : fallback;
}

function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 宽容地把一行 JSONL 映射为 ChatChunk；不认识的一律 status */
function lineToChunk(line: string): ChatChunk {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { type: 'status', text: truncate(line) };
  }

  // 常见的文本载体字段，逐个尝试
  const text = extractText(j);
  if (text) return { type: 'delta', text };

  if (j.type === 'result' || j.type === 'done' || j.done === true) {
    return { type: 'done' };
  }
  return { type: 'status', text: truncate(line) };
}

function extractText(j: Record<string, unknown>): string | null {
  if (typeof j.text === 'string' && j.text) return j.text;
  const delta = j.delta as Record<string, unknown> | undefined;
  if (typeof delta?.text === 'string' && delta.text) return delta.text;
  const content = (j.message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(content)) {
    const t = content
      .filter((b) => (b as Record<string, unknown>)?.type === 'text')
      .map((b) => String((b as Record<string, unknown>).text ?? ''))
      .join('');
    if (t) return t;
  }
  const choice = (j.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const cd = (choice?.delta as Record<string, unknown> | undefined)?.content;
  if (typeof cd === 'string' && cd) return cd;
  return null;
}

export function createDshDriver(
  backend: BackendConfig,
  ctx: DriverContext,
): AgentDriver {
  const command = backend.command ?? 'dsh';
  const runArgs = optStrings(backend.options?.runArgs, [
    'run',
    '--output-format',
    'stream-json',
  ]);
  const promptFlag =
    typeof backend.options?.promptFlag === 'string'
      ? backend.options.promptFlag
      : '--prompt';
  const continueArgs = optStrings(backend.options?.continueArgs, ['--continue']);

  async function authorizeSpawn(args: string[]): Promise<void> {
    const d = await ctx.policy.authorize({
      kind: 'shell.exec',
      command: [command, ...args].join(' '),
      reason: `拉起 dsh 子进程（backend=${backend.id}）`,
      origin: 'dsh',
    });
    if (!d.allow) throw new Error(`权限层拒绝执行子进程: ${d.reason}`);
  }

  function spawnDsh(args: string[], cwd?: string): ChildProcess {
    return spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: cwd || process.cwd(),
      windowsHide: true,
    });
  }

  return {
    type: 'dsh',
    // headless CLI 无会话级 system prompt 通道，人设由编排层并入首条用户消息
    supportsSystemPrompt: false,

    async test() {
      // 版本探测 + 锁定版本比对；不一致仅 warn，不判失败
      try {
        await authorizeSpawn(['--version']);
        const out = await new Promise<string>((resolve, reject) => {
          const proc = spawnDsh(['--version']);
          let buf = '';
          proc.stdout?.on('data', (d) => (buf += d.toString()));
          proc.stderr?.on('data', (d) => (buf += d.toString()));
          proc.on('error', reject);
          proc.on('close', (code) =>
            code === 0 ? resolve(buf.trim()) : reject(new Error(`exit ${code}: ${buf.trim()}`)),
          );
        });
        if (backend.dshVersion && !out.includes(backend.dshVersion)) {
          ctx.log(
            'warn',
            `[dsh] 版本漂移：锁定 ${backend.dshVersion}，实际 "${out}"（preview 阶段仅提示）`,
          );
        }
        return { ok: true, detail: `dsh --version -> ${out}` };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }
    },

    async createSession(opts): Promise<AgentSessionHandle> {
      let proc: ChildProcess | null = null;
      let turns = 0;

      const handle: AgentSessionHandle = {
        id: `dsh-${Math.random().toString(36).slice(2, 10)}`,

        async *prompt(text: string, popts?: PromptOptions): AsyncIterable<ChatChunk> {
          const args = [
            ...runArgs,
            ...(turns > 0 ? continueArgs : []),
            promptFlag,
            text,
          ];
          turns++;
          try {
            await authorizeSpawn(args);
          } catch (err) {
            yield { type: 'error', error: String(err) };
            yield { type: 'done' };
            return;
          }

          const queue: ChatChunk[] = [];
          let wake: (() => void) | null = null;
          let closed = false;
          let stderrBuf = '';
          let exitCode: number | null = null;
          const spawnErr: { err: Error | null } = { err: null };
          let sawDone = false;
          let cancelled = false;

          const child = spawnDsh(args, popts?.workingDir ?? opts.workingDir);
          proc = child;
          const onAbort = () => child.kill();
          popts?.signal?.addEventListener('abort', onAbort, { once: true });

          let buf = '';
          child.stdout!.setEncoding('utf-8');
          child.stdout!.on('data', (d: string) => {
            buf += d;
            let idx: number;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line) continue;
              const chunk = lineToChunk(line);
              if (chunk.type === 'done') sawDone = true;
              queue.push(chunk);
            }
            wake?.();
          });
          child.stderr!.setEncoding('utf-8');
          child.stderr!.on('data', (d: string) => {
            stderrBuf += d;
          });
          child.on('error', (err) => {
            spawnErr.err = err;
            closed = true;
            wake?.();
          });
          child.on('close', (code) => {
            exitCode = code;
            closed = true;
            wake?.();
          });

          while (true) {
            while (queue.length > 0) {
              const c = queue.shift()!;
              if (cancelled && c.type === 'delta') continue;
              yield c;
            }
            if (popts?.signal?.aborted && !cancelled) {
              cancelled = true;
              child.kill();
              yield { type: 'status', text: '已中断' };
              yield { type: 'done' };
              break;
            }
            if (closed) {
              if (spawnErr.err) {
                yield { type: 'error', error: `dsh 拉起失败: ${spawnErr.err.message}` };
              } else if (exitCode !== 0) {
                yield {
                  type: 'error',
                  error: `dsh 退出码 ${exitCode}: ${truncate(stderrBuf.trim(), 300)}`,
                };
              }
              if (!sawDone) yield { type: 'done' };
              break;
            }
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }

          popts?.signal?.removeEventListener('abort', onAbort);
          proc = null;
        },

        async cancel() {
          proc?.kill();
        },

        async dispose() {
          proc?.kill();
          proc = null;
        },
      };
      return handle;
    },
  };
}
