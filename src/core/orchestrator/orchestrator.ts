import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentSessionHandle,
  BackendConfig,
  CharacterConfig,
  Confirmer,
  DriverContext,
  EmotionTag,
  OrcEvent,
  OrchestratorApi,
} from '../types.js';
import { DefaultPolicyEngine, mergePolicy } from '../permission/policy-engine.js';
import { SettingsStore } from '../config/settings.js';
import { createDriver } from '../adapters/registry.js';
import { matchEmotion } from './emotion.js';
import { foldText } from './fold.js';

/**
 * 编排层：消息路由、会话管理、权限二次校验、多 Agent 调度。
 * 不 import 任何具体 driver —— 只经 registry 拿 AgentDriver。
 */
export class Orchestrator implements OrchestratorApi {
  private sessions = new Map<
    string,
    { handle: AgentSessionHandle; pendingPersona: string | null }
  >();
  private engines = new Map<string, DefaultPolicyEngine>();

  constructor(
    private store: SettingsStore,
    private resolveSecret: (ref: string) => Promise<string | null>,
    /** ask 档确认回调由宿主注入（CLI 提示符 / Electron 弹窗） */
    private confirmer?: Confirmer,
    private logger: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
  ) {}

  reloadSettings(): void {
    // 配置变更后丢弃缓存的会话与策略引擎（driver 持有的后端可能已改）
    for (const s of this.sessions.values()) void s.handle.dispose().catch(() => {});
    this.sessions.clear();
    this.engines.clear();
  }

  listCharacters(): CharacterConfig[] {
    return this.store.load().characters;
  }

  listBackends(): BackendConfig[] {
    return this.store.load().backends;
  }

  lineA(charId: string): { text: string; emotion: EmotionTag } {
    const c = this.character(charId);
    return { text: c.lineA, emotion: matchEmotion(c.lineA) };
  }

  private character(charId: string): CharacterConfig {
    const c = this.store.load().characters.find((x) => x.id === charId);
    if (!c) throw new Error(`角色不存在: ${charId}`);
    return c;
  }

  private backendFor(c: CharacterConfig): BackendConfig {
    const s = this.store.load();
    const id = c.backendId ?? s.defaultBackendId;
    const b = s.backends.find((x) => x.id === id);
    if (!b) {
      throw new Error(
        `角色 ${c.name} 未绑定可用后端（backendId=${id ?? '(默认空)'}）`,
      );
    }
    return b;
  }

  private engineFor(c: CharacterConfig): DefaultPolicyEngine {
    let e = this.engines.get(c.id);
    if (!e) {
      const s = this.store.load();
      e = new DefaultPolicyEngine(
        mergePolicy(s.globalPermission, c.permission),
        this.confirmer,
      );
      this.engines.set(c.id, e);
    }
    return e;
  }

  private driverCtx(c: CharacterConfig): DriverContext {
    return {
      policy: this.engineFor(c),
      resolveSecret: this.resolveSecret,
      log: this.logger,
    };
  }

  private async sessionFor(
    c: CharacterConfig,
  ): Promise<{ handle: AgentSessionHandle; pendingPersona: string | null }> {
    const existing = this.sessions.get(c.id);
    if (existing) return existing;
    const backend = this.backendFor(c);
    const driver = createDriver(backend, this.driverCtx(c));
    // 人设缺省时按昵称合成默认：自称用这个名字
    const persona =
      c.persona.trim() ||
      `你是名叫「${c.name}」的桌面宠物，自称「${c.name}」，说话简短可爱、口语化。`;
    const systemPrompt = [backend.systemPrompt, persona]
      .filter(Boolean)
      .join('\n\n');
    const handle = await driver.createSession({
      characterId: c.id,
      systemPrompt: systemPrompt || undefined,
      workingDir: process.cwd(),
    });
    const entry = {
      handle,
      // driver 不支持原生 system prompt 时，人设并入首条用户消息
      pendingPersona:
        driver.supportsSystemPrompt === false && systemPrompt
          ? systemPrompt
          : null,
    };
    this.sessions.set(c.id, entry);
    return entry;
  }

  private appendHistory(charId: string, role: string, content: string): void {
    const file = path.join(this.store.historyDir(charId), 'session.jsonl');
    fs.appendFileSync(
      file,
      JSON.stringify({ ts: Date.now(), role, content }) + '\n',
      'utf-8',
    );
  }

  /** 详细过程日志：每轮对话的全部事件（含 status/工具调用）落盘，供 Web 日志页查看 */
  private writeDetailLog(charId: string, prompt: string, events: unknown[], full: string): void {
    try {
      const dir = path.join(this.store.historyDir(charId), '..', '..', 'logs', charId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}.jsonl`);
      const lines = [
        JSON.stringify({ ts: Date.now(), type: 'prompt', content: prompt }),
        ...events.map((e) => JSON.stringify(e)),
        JSON.stringify({ ts: Date.now(), type: 'final', content: full }),
      ];
      fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
    } catch {
      // 日志失败不影响对话
    }
  }

  /** 驱动一个角色完成一次发言，流式产出 OrcEvent，并负责折叠收尾 */
  private async *speak(
    charId: string,
    prompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<OrcEvent> {
    const c = this.character(charId);
    yield { kind: 'speaker-start', charId, charName: c.name };
    let full = '';
    const rawEvents: unknown[] = []; // 详细过程（含工具调用/status），只落盘不进气泡
    try {
      const entry = await this.sessionFor(c);
      // 气泡场景回复风格：结论/结果导向，不报过程（过程看 Web 日志页）
      const styleGuide = '\n\n【回复要求】直接给出结论和结果，语言精炼、口语化（你是桌宠在气泡里说话）；不要描述中间过程，不要罗列工具调用。';
      let effective = prompt + styleGuide;
      if (entry.pendingPersona) {
        effective = `【你的设定】\n${entry.pendingPersona}\n\n【用户消息】\n${prompt}${styleGuide}`;
        entry.pendingPersona = null;
      }
      for await (const chunk of entry.handle.prompt(effective, { signal })) {
        if (signal?.aborted) break;
        rawEvents.push({ ts: Date.now(), ...chunk });
        if (chunk.type === 'delta') {
          full += chunk.text;
          yield { kind: 'token', charId, text: chunk.text };
        } else if (chunk.type === 'status') {
          yield { kind: 'status', charId, text: chunk.text };
        } else if (chunk.type === 'error') {
          yield { kind: 'error', charId, error: chunk.error };
          yield { kind: 'emotion', charId, emotion: 'error' };
        }
      }
    } catch (err) {
      yield { kind: 'error', charId, error: String(err) };
      yield { kind: 'emotion', charId, emotion: 'error' };
    }
    if (full) {
      this.appendHistory(charId, 'user', prompt);
      this.appendHistory(charId, 'assistant', full);
      yield { kind: 'emotion', charId, emotion: matchEmotion(full) };
    }
    this.writeDetailLog(charId, prompt, rawEvents, full);
    const fold = foldText(full, this.store.load().bubbleFold);
    yield {
      kind: 'speaker-end',
      charId,
      fullText: full,
      summary: fold.summary,
      folded: fold.folded,
    };
  }

  chat(charId: string, text: string): AsyncIterable<OrcEvent> {
    return this.withDone(this.speak(charId, text));
  }

  /** 释放全部缓存会话（CLI 退出前/配置重载时调用） */
  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.handle.dispose().catch(() => {})));
  }

  async cancel(charId: string): Promise<void> {
    await this.sessions.get(charId)?.handle.cancel();
  }

  /** 绑定某后端的所有角色 id（含走默认后端的） */
  private charsOfBackend(backendId: string): string[] {
    const s = this.store.load();
    return s.characters
      .filter((c) => (c.backendId ?? s.defaultBackendId) === backendId)
      .map((c) => c.id);
  }

  async startBackend(backendId: string): Promise<{ ok: boolean; detail?: string }> {
    const chars = this.charsOfBackend(backendId);
    if (chars.length === 0) {
      return { ok: false, detail: '没有角色绑定该后端（先在角色卡片里绑定，或设为全局默认）' };
    }
    try {
      for (const id of chars) {
        await this.sessionFor(this.character(id)); // 预建会话，拉起子进程常驻
      }
      return { ok: true, detail: `已启动，${chars.length} 个角色的会话常驻中` };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }

  async stopBackend(backendId: string): Promise<void> {
    for (const id of this.charsOfBackend(backendId)) {
      const s = this.sessions.get(id);
      if (s) {
        this.sessions.delete(id);
        await s.handle.dispose().catch(() => {});
      }
    }
  }

  backendStatus(backendId: string): boolean {
    return this.charsOfBackend(backendId).some((id) => this.sessions.has(id));
  }

  /**
   * 协作模式：主角色（charIds[0]）拆任务 → 各角色依次汇报 → 主角色汇总。
   * 分解结果解析失败时降级：把整任务依次交给每个角色。
   */
  async *collab(task: string, charIds: string[]): AsyncGenerator<OrcEvent> {
    if (charIds.length === 0) {
      yield { kind: 'error', charId: null, error: '协作模式至少需要一个角色' };
      return;
    }
    const lead = charIds[0];
    const members = charIds.map((id) => this.character(id));
    const roster = members.map((m) => `${m.id}: ${m.name}`).join('; ');

    // 1. 主角色拆分
    let subtasks: Array<{ charId: string; subtask: string }> = [];
    let planRaw = '';
    const planPrompt =
      `你是协作任务的主负责人。团队成员: ${roster}。\n` +
      `把下面的任务拆成 ${members.length} 个子任务分派给大家（含你自己）。` +
      `只输出 JSON 数组，形如 [{"charId":"...","subtask":"..."}]，不要输出任何其他文字。\n任务: ${task}`;
    try {
      const entry = await this.sessionFor(members[0]);
      let planEffective = planPrompt;
      if (entry.pendingPersona) {
        planEffective = `【你的设定】\n${entry.pendingPersona}\n\n【用户消息】\n${planPrompt}`;
        entry.pendingPersona = null;
      }
      for await (const ch of entry.handle.prompt(planEffective)) {
        if (ch.type === 'delta') planRaw += ch.text;
      }
      const m = planRaw.match(/\[[\s\S]*\]/);
      const parsed = m ? JSON.parse(m[0]) : [];
      subtasks = parsed.filter(
        (x: { charId?: string; subtask?: string }) =>
          x.charId && x.subtask && charIds.includes(x.charId),
      );
    } catch {
      subtasks = [];
    }
    if (subtasks.length === 0) {
      subtasks = charIds.map((id) => ({ charId: id, subtask: task }));
    }

    // 2. 各角色依次汇报
    const reports: Array<{ charId: string; name: string; text: string }> = [];
    for (const st of subtasks) {
      const c = this.character(st.charId);
      let text = '';
      const gen = this.speak(
        st.charId,
        `[协作子任务] ${st.subtask}\n请直接凭你的能力回答，不要调用任何工具、不要读写文件。完成后用简洁中文汇报结果。`,
      );
      for await (const ev of gen) {
        if (ev.kind === 'token') text += ev.text;
        yield ev;
      }
      reports.push({ charId: st.charId, name: c.name, text });
    }

    // 3. 主角色汇总
    const summaryPrompt =
      `大家已完成各自子任务，汇报如下：\n` +
      reports.map((r) => `【${r.name}】${r.text}`).join('\n\n') +
      `\n\n请以主负责人身份汇总结论，简洁分点。`;
    yield* this.speak(lead, summaryPrompt);
    yield { kind: 'done' };
  }

  private async *withDone(gen: AsyncGenerator<OrcEvent>): AsyncGenerator<OrcEvent> {
    yield* gen;
    yield { kind: 'done' };
  }
}
