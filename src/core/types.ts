/**
 * DeckPet 跨层契约 —— 全部四层的公共类型。
 * 分层规则（硬性）：
 *   表现层(renderer) ──IPC──▶ 编排层(orchestrator) ──AgentDriver──▶ 适配层(adapters)
 *   适配层/编排层的所有写文件、命令执行、联网动作 ──authorize()──▶ 权限层(permission)
 * UI 不得直接 import adapters；adapter 不得绕过 permission。
 */

// ─────────────────────────── 权限层 ───────────────────────────

export type PermissionMode = 'readonly' | 'ask' | 'auto';

export type ActionKind = 'fs.read' | 'fs.write' | 'shell.exec' | 'net.fetch';

export interface PermissionAction {
  kind: ActionKind;
  /** fs.* 动作的目标路径（绝对或相对均可，引擎内规范化） */
  path?: string;
  /** shell.exec 的完整命令行 */
  command?: string;
  /** net.fetch 的目标 URL */
  url?: string;
  /** 发起方描述（用于确认弹窗与日志） */
  reason?: string;
  /** 来源标识：角色 id 或 driver 名，便于审计 */
  origin?: string;
}

export interface PermissionPolicy {
  mode: PermissionMode;
  /** 允许读写的目录白名单（绝对路径）；空数组 = 不限制 */
  allowedDirs: string[];
  /** 禁止执行的命令黑名单（子串匹配，小写）；内置兜底清单之外追加 */
  blockedCommands: string[];
  /** 联网开关 */
  networkEnabled: boolean;
  /** 内网/回环豁免名单（如 'localhost'、'127.0.0.1'，用于本地 vLLM/Ollama 等服务） */
  allowedLocalHosts: string[];
}

export type Decision =
  | { allow: true }
  | { allow: false; reason: string };

/** ask 模式下向宿主（CLI 提示符 / Electron 弹窗）请求人工确认的回调 */
export type Confirmer = (action: PermissionAction) => Promise<boolean>;

export interface PolicyEngine {
  /** 一切高危动作的唯一入口。readonly/auto 同步判定，ask 经 Confirmer。 */
  authorize(action: PermissionAction): Promise<Decision>;
}

// ─────────────────────────── 配置 ───────────────────────────

export interface BackendConfig {
  id: string;
  name: string;
  /** driver 类型，对应 registry 注册的 key：'acp' | 'dsh' | 'openai-http' | 插件扩展 */
  type: string;
  /** acp/dsh：拉起子进程的命令，如 'kimi'；args 如 ['acp'] */
  command?: string;
  args?: string[];
  /** openai-http：API 地址，如 https://api.deepseek.com/v1 */
  baseUrl?: string;
  model?: string;
  /** API Key 不明文存放；这里存 keystore 里的引用名 */
  apiKeyRef?: string;
  /** 后端级系统提示词（角色人设在其上叠加） */
  systemPrompt?: string;
  /** dsh 专用：锁定的 harness 版本 */
  dshVersion?: string;
  /** driver 私有扩展字段 */
  options?: Record<string, unknown>;
}

export interface CharacterConfig {
  id: string;
  name: string;
  /** 素材目录（assets/sprites/<id>/） */
  spriteDir: string;
  /** 单击台词 A */
  lineA: string;
  /** 形象要求文本（融入素材生成，可改后重新生成） */
  appearanceRequest: string;
  /** 绑定后端；null/undefined = 用全局默认 */
  backendId?: string | null;
  /** 人设提示词 */
  persona: string;
  /** 角色级权限覆盖；缺省用全局 */
  permission?: Partial<PermissionPolicy>;
}

export interface BubbleFoldSettings {
  enabled: boolean;
  maxLines: number;
  maxChars: number;
}

/** 循环提醒任务（每日定时，桌宠气泡弹出提醒） */
export interface ReminderTask {
  id: string;
  title: string;
  /** 每日触发时间，HH:MM */
  time: string;
  /** 分类（日常/会议/自定义…），Web 控制台按分类批量开关 */
  category: string;
  enabled: boolean;
}

export interface AppSettings {
  defaultBackendId: string | null;
  collabEnabled: boolean;
  bubbleFold: BubbleFoldSettings;
  autostart: boolean;
  globalPermission: PermissionPolicy;
  backends: BackendConfig[];
  characters: CharacterConfig[];
  /** 启动时默认上屏的主桌宠（null = 角色列表第一个；启动只显示这一只） */
  activeCharId?: string | null;
  /** 循环提醒任务 */
  reminders: ReminderTask[];
  /** 被整体关闭的提醒分类 */
  disabledReminderCategories: string[];
}

// ─────────────────────────── 适配层 ───────────────────────────

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 流式响应的统一事件块 */
export type ChatChunk =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string } // 工具调用等中间状态，可显示为动作提示
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface PromptOptions {
  /** 角色人设 + 后端系统提示词由编排层合成后传入 */
  systemPrompt?: string;
  signal?: AbortSignal;
  /** agent 的工作目录（受权限层白名单约束） */
  workingDir?: string;
}

export interface AgentSessionHandle {
  readonly id: string;
  /** 发送一条用户消息，流式返回回复块；可重复调用保持上下文 */
  prompt(text: string, opts?: PromptOptions): AsyncIterable<ChatChunk>;
  /** 中断当前进行中的输出 */
  cancel(): Promise<void>;
  /** 释放子进程/连接 */
  dispose(): Promise<void>;
}

export interface DriverContext {
  policy: PolicyEngine;
  /** 按 apiKeyRef 取明文 key（主进程内存中解密，不落盘） */
  resolveSecret(ref: string): Promise<string | null>;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

export interface AgentDriver {
  readonly type: string;
  /**
   * 是否原生支持系统提示词。false 时编排层会把人设文本并入首条用户消息
   * （如 ACP 协议没有 system prompt 通道）。
   */
  readonly supportsSystemPrompt?: boolean;
  /** 连通性自检（拉起进程/探测接口），不消耗对话 */
  test(): Promise<{ ok: boolean; detail?: string }>;
  createSession(opts: {
    characterId: string;
    workingDir?: string;
    systemPrompt?: string;
  }): Promise<AgentSessionHandle>;
}

export type DriverFactory = (backend: BackendConfig, ctx: DriverContext) => AgentDriver;

// ─────────────────────────── 编排层 ───────────────────────────

/** 动作/情绪标签：驱动桌宠动作库匹配 */
export type EmotionTag =
  | 'think'
  | 'success'
  | 'error'
  | 'greet'
  | 'happy'
  | 'talk'
  | 'idle';

/** 编排层 → 表现层 的事件（CLI 与 Electron IPC 共用同一套） */
export type OrcEvent =
  | { kind: 'speaker-start'; charId: string; charName: string }
  | { kind: 'token'; charId: string; text: string }
  | { kind: 'status'; charId: string; text: string }
  | { kind: 'emotion'; charId: string; emotion: EmotionTag }
  | { kind: 'speaker-end'; charId: string; fullText: string; summary: string; folded: boolean }
  | { kind: 'error'; charId: string | null; error: string }
  | { kind: 'done' };

/** 编排层对表现层暴露的完整 API（Electron ipc.ts 只是它的薄转发） */
export interface OrchestratorApi {
  /** 单角色私聊：流式事件 */
  chat(charId: string, text: string): AsyncIterable<OrcEvent>;
  /** 协作模式：主角色拆分任务 → 各角色依次汇报 → 主角色汇总 */
  collab(task: string, charIds: string[]): AsyncIterable<OrcEvent>;
  /** 中断某角色当前输出 */
  cancel(charId: string): Promise<void>;
  /** 启动后端：为绑定它的角色预建会话（进程常驻，聊天零冷启动） */
  startBackend(backendId: string): Promise<{ ok: boolean; detail?: string }>;
  /** 停止后端：释放其下所有会话/子进程 */
  stopBackend(backendId: string): Promise<void>;
  /** 后端运行状态（是否有存活会话） */
  backendStatus(backendId: string): boolean;
  /** 单击台词 A：编排层只负责按词义匹配 emotion，文案由配置给出 */
  lineA(charId: string): { text: string; emotion: EmotionTag };
  listCharacters(): CharacterConfig[];
  listBackends(): BackendConfig[];
  reloadSettings(): void;
}
