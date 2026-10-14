import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import type {
  AgentDriver,
  AgentSessionHandle,
  BackendConfig,
  ChatChunk,
  DriverContext,
  PermissionAction,
  PolicyEngine,
} from '../types.js';

/**
 * ACP driver（首选）：本应用作为 ACP client，把 agent CLI 作为本地子进程
 * 拉起，通过 stdio 以换行分隔的 JSON-RPC 2.0（NDJSON）通信。
 *
 * 手搓协议而不依赖 SDK 的原因：ACP 是稳定的 JSON-RPC 协议，SDK 包名/版本
 * 仍在漂移；直接实现约 300 行且零依赖。协议参考 agentclientprotocol.com。
 *
 * 权限兜底：agent 发起的 fs/read_text_file、fs/write_text_file、
 * terminal/create、session/request_permission 全部先过 PolicyEngine，
 * 不信任 agent 侧自己的审批。
 */

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface TerminalState {
  proc: ChildProcess;
  output: string;
  exitCode: number | null;
  exited: Promise<void>;
  resolveExited: () => void;
}

class AcpConnection {
  private nextId = 1;
  private buffer = '';
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private onNotification?: (method: string, params: unknown) => void;
  private terminals = new Map<string, TerminalState>();
  private terminalSeq = 0;

  constructor(
    private proc: ChildProcess,
    private policy: PolicyEngine,
    private log: DriverContext['log'],
  ) {
    proc.stdout!.setEncoding('utf-8');
    proc.stdout!.on('data', (d: string) => this.feed(d));
    proc.stderr!.setEncoding('utf-8');
    proc.stderr!.on('data', (d: string) => this.log('warn', `[acp-stderr] ${d.trim()}`));
  }

  setNotificationHandler(fn: (method: string, params: unknown) => void): void {
    this.onNotification = fn;
  }

  private feed(data: string): void {
    this.buffer += data;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.log('warn', `[acp] 丢弃无法解析的行: ${line.slice(0, 120)}`);
        continue;
      }
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: JsonRpcMessage): Promise<void> {
    // 响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      return;
    }
    // agent → client 请求
    if (msg.method && msg.id !== undefined) {
      try {
        const result = await this.handleAgentRequest(msg.method, msg.params);
        this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
      } catch (err) {
        this.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: String(err) },
        });
      }
      return;
    }
    // 通知
    if (msg.method && this.onNotification) {
      this.onNotification(msg.method, msg.params);
    }
  }

  private send(msg: JsonRpcMessage): void {
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** agent → client 能力回调：一律过权限层 */
  private async handleAgentRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'fs/read_text_file': {
        const filePath = String(p.path ?? '');
        const d = await this.policy.authorize({
          kind: 'fs.read',
          path: filePath,
          reason: 'agent 请求读取文件',
          origin: 'acp',
        });
        if (!d.allow) throw new Error(`权限层拒绝: ${d.reason}`);
        const fs = await import('node:fs/promises');
        let content = await fs.readFile(filePath, 'utf-8');
        const line = typeof p.line === 'number' ? p.line : undefined;
        const limit = typeof p.limit === 'number' ? p.limit : undefined;
        if (line !== undefined || limit !== undefined) {
          const lines = content.split('\n');
          content = lines.slice((line ?? 1) - 1, limit ? (line ?? 1) - 1 + limit : undefined).join('\n');
        }
        return { content };
      }
      case 'fs/write_text_file': {
        const filePath = String(p.path ?? '');
        const d = await this.policy.authorize({
          kind: 'fs.write',
          path: filePath,
          reason: 'agent 请求写入文件',
          origin: 'acp',
        });
        if (!d.allow) throw new Error(`权限层拒绝: ${d.reason}`);
        const fs = await import('node:fs/promises');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, String(p.content ?? ''), 'utf-8');
        return null;
      }
      case 'terminal/create': {
        const command = String(p.command ?? '');
        const args = Array.isArray(p.args) ? (p.args as string[]) : [];
        const full = [command, ...args].join(' ');
        const d = await this.policy.authorize({
          kind: 'shell.exec',
          command: full,
          reason: 'agent 请求执行终端命令',
          origin: 'acp',
        });
        if (!d.allow) throw new Error(`权限层拒绝: ${d.reason}`);
        return { terminalId: this.spawnTerminal(command, args, p.cwd as string | undefined) };
      }
      case 'terminal/output': {
        const t = this.terminals.get(String(p.terminalId));
        if (!t) throw new Error('terminal 不存在');
        return {
          output: t.output,
          truncated: false,
          exitStatus: t.exitCode === null ? null : { exitCode: t.exitCode, signal: null },
        };
      }
      case 'terminal/wait_for_exit': {
        const t = this.terminals.get(String(p.terminalId));
        if (!t) throw new Error('terminal 不存在');
        await t.exited;
        return { exitCode: t.exitCode ?? 0, signal: null };
      }
      case 'terminal/kill': {
        const t = this.terminals.get(String(p.terminalId));
        t?.proc.kill();
        return null;
      }
      case 'terminal/release': {
        this.terminals.delete(String(p.terminalId));
        return null;
      }
      case 'session/request_permission': {
        return this.handlePermissionRequest(p);
      }
      default:
        this.log('warn', `[acp] 未实现的 agent 请求: ${method}`);
        throw new Error(`unsupported method: ${method}`);
    }
  }

  /** agent 自带的权限请求 → 仍走本应用权限层兜底 */
  private async handlePermissionRequest(p: Record<string, unknown>): Promise<unknown> {
    const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
    const options = Array.isArray(p.options) ? (p.options as Array<Record<string, unknown>>) : [];
    const title = String(toolCall.title ?? toolCall.kind ?? '未知操作');
    const kind = String(toolCall.kind ?? '');

    const action: PermissionAction = {
      kind: kind === 'execute' ? 'shell.exec' : kind === 'edit' || kind === 'delete' ? 'fs.write' : 'fs.read',
      command: typeof toolCall.command === 'string' ? toolCall.command : undefined,
      path: extractPath(toolCall),
      reason: `agent 权限请求: ${title}`,
      origin: 'acp-permission',
    };
    const d = await this.policy.authorize(action);

    const pick = (kinds: string[]) =>
      options.find((o) => kinds.includes(String(o.kind)));

    if (d.allow) {
      const opt = pick(['allow_once', 'allow_always']) ?? options[0];
      return { outcome: { outcome: 'selected', optionId: opt?.optionId ?? 'allow_once' } };
    }
    const opt = pick(['reject_once', 'reject_always']) ?? options[options.length - 1];
    return {
      outcome: opt
        ? { outcome: 'selected', optionId: opt.optionId }
        : { outcome: 'cancelled' },
    };
  }

  private spawnTerminal(command: string, args: string[], cwd?: string): string {
    const id = `t${++this.terminalSeq}`;
    const proc = spawn(command, args, {
      cwd: cwd || process.cwd(),
      shell: true,
      windowsHide: true,
    });
    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => (resolveExited = r));
    const state: TerminalState = { proc, output: '', exitCode: null, exited, resolveExited };
    proc.stdout?.on('data', (d) => (state.output += d.toString()));
    proc.stderr?.on('data', (d) => (state.output += d.toString()));
    proc.on('exit', (code) => {
      state.exitCode = code ?? 0;
      resolveExited();
    });
    this.terminals.set(id, state);
    return id;
  }

  killAll(): void {
    for (const t of this.terminals.values()) t.proc.kill();
    this.terminals.clear();
  }
}

function extractPath(toolCall: Record<string, unknown>): string | undefined {
  const locs = toolCall.locations;
  if (Array.isArray(locs) && locs[0] && typeof (locs[0] as Record<string, unknown>).path === 'string') {
    return (locs[0] as Record<string, unknown>).path as string;
  }
  return undefined;
}

interface SessionUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  title?: string;
  status?: string;
}

export function createAcpDriver(backend: BackendConfig, ctx: DriverContext): AgentDriver {
  const command = backend.command ?? 'kimi';
  const args = backend.args ?? ['acp'];

  return {
    type: 'acp',

    // ACP 协议无 system prompt 通道，人设由编排层并入首条用户消息
    supportsSystemPrompt: false,

    async test() {
      try {
        const conn = spawnProbe();
        const res = (await conn.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: 'deckpet', version: '0.1.0' },
        })) as Record<string, unknown>;
        conn.close();
        return { ok: true, detail: `ACP initialize ok, agentCapabilities=${JSON.stringify(res?.agentCapabilities ?? {})}` };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }

      function spawnProbe(): { request: (m: string, p: unknown) => Promise<unknown>; close: () => void } {
        const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const conn = new AcpConnection(proc, ctx.policy, ctx.log);
        return {
          request: (m, p) => conn.request(m, p),
          close: () => proc.kill(),
        };
      }
    },

    async createSession(opts): Promise<AgentSessionHandle> {
      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.workingDir || process.cwd(),
        windowsHide: true,
        env: { ...process.env },
      });
      const conn = new AcpConnection(proc, ctx.policy, ctx.log);

      await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'deckpet', version: '0.1.0' },
      });

      const newRes = (await conn.request('session/new', {
        cwd: opts.workingDir || process.cwd(),
        mcpServers: [],
      })) as { sessionId: string };

      const sessionId = newRes.sessionId;
      let cancelled = false;

      const handle: AgentSessionHandle = {
        id: sessionId,

        async *prompt(text: string): AsyncIterable<ChatChunk> {
          cancelled = false;
          const queue: ChatChunk[] = [];
          let wake: (() => void) | null = null;
          let promptDone = false;
          let promptError: Error | null = null;

          conn.setNotificationHandler((method, params) => {
            if (method !== 'session/update') return;
            const p = params as { sessionId?: string; update?: SessionUpdate };
            if (p.sessionId !== sessionId) return;
            const u = p.update ?? {};
            if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
              queue.push({ type: 'delta', text: u.content.text });
            } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
              const label = u.title ?? u.status ?? 'tool';
              queue.push({ type: 'status', text: String(label) });
            }
            wake?.();
          });

          conn
            .request('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text }],
            })
            .then(() => {
              promptDone = true;
              wake?.();
            })
            .catch((err) => {
              promptError = err as Error;
              promptDone = true;
              wake?.();
            });

          while (true) {
            while (queue.length > 0) {
              const c = queue.shift()!;
              if (cancelled && c.type === 'delta') continue;
              yield c;
            }
            if (cancelled) {
              conn.notify('session/cancel', { sessionId });
              yield { type: 'status', text: '已中断' };
              yield { type: 'done' };
              return;
            }
            if (promptError) {
              yield { type: 'error', error: String(promptError) };
              yield { type: 'done' };
              return;
            }
            if (promptDone) {
              yield { type: 'done' };
              return;
            }
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }
        },

        async cancel() {
          cancelled = true;
          conn.notify('session/cancel', { sessionId });
        },

        async dispose() {
          conn.killAll();
          proc.kill();
        },
      };
      return handle;
    },
  };
}
