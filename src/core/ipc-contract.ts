import type {
  AppSettings,
  BackendConfig,
  CharacterConfig,
  EmotionTag,
  OrcEvent,
} from './types.js';

/**
 * 表现层 ↔ 编排层 的 IPC 契约（Electron channel 白名单）。
 * 主进程 ipc.ts 与 preload/index.ts 必须严格按本文件实现；
 * renderer 只准使用 PreloadApi，不得直接碰 ipcRenderer。
 */

/** 窗口矩形（屏幕物理像素坐标，koffi/EnumWindows 提供） */
export interface WinRect {
  hwnd: number;
  title: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  minimized: boolean;
}

/** 流式事件的请求-响应对：renderer 发 invoke，主进程回推事件流 */
export const CH = {
  // invoke（renderer → main，返回 Promise）
  chat: 'orc:chat', // (reqId, charId, text)
  collab: 'orc:collab', // (reqId, task, charIds)
  cancel: 'orc:cancel', // (reqId, charId)
  lineA: 'orc:lineA', // (charId) → { text, emotion }
  listCharacters: 'cfg:listCharacters',
  listBackends: 'cfg:listBackends',
  getSettings: 'cfg:get',
  saveSettings: 'cfg:save', // (settings) 保存并 orchestrator.reloadSettings()
  addBackend: 'cfg:addBackend', // (backend, apiKey?)  apiKey 明文仅内存传递→DPAPI
  removeBackend: 'cfg:removeBackend', // (id)
  testBackend: 'cfg:testBackend', // (id) → {ok, detail}
  startBackend: 'cfg:startBackend', // (id) → {ok, detail} 启动常驻会话
  stopBackend: 'cfg:stopBackend', // (id)
  backendStatus: 'cfg:backendStatus', // (id) → {running}
  upsertCharacter: 'cfg:upsertCharacter', // (char)
  removeCharacter: 'cfg:removeCharacter', // (id)
  importPhoto: 'asset:importPhoto', // ({replaceCharId?}) 弹文件对话框→抠图→素材→返回新角色列表
  regenerateSprite: 'asset:regenerateSprite', // (charId) 按 appearanceRequest 重新生成
  openSettings: 'win:openSettings',
  openReader: 'win:openReader', // (charId, markdown, title) 独立阅读面板
  setClickable: 'pet:setClickable', // (boolean) 命中测试 → setIgnoreMouseEvents
  setChatFocus: 'pet:setChatFocus', // (boolean) 聊天开关 → 临时让窗口可聚焦（修输入法/键盘焦点）
  setAutostart: 'sys:setAutostart', // (boolean)
  setImageApiKey: 'cfg:setImageApiKey', // (key) 图像生成 API Key → DPAPI 加密存储
  // main → renderer 推送
  event: 'orc:event', // (reqId, ev: OrcEvent)
  rects: 'win32:rects', // (WinRect[])  ~10Hz
  workArea: 'win32:workArea', // ({x,y,width,height}) 工作区（不含任务栏），启动与显示器变化时推送
  charactersChanged: 'cfg:charactersChanged', // (CharacterConfig[], spriteIds: string[]) 角色增删/素材重生成后推送
  reminder: 'sys:reminder', // ({title, category}) 循环提醒触发
} as const;

/** preload 暴露给 renderer 的完整 API（contextBridge） */
export interface PreloadApi {
  // 编排
  chat(charId: string, text: string): string; // 返回 reqId
  collab(task: string, charIds: string[]): string;
  cancel(reqId: string, charId: string): void;
  onEvent(reqId: string, cb: (ev: OrcEvent) => void): void;
  lineA(charId: string): Promise<{ text: string; emotion: EmotionTag }>;
  // 配置
  listCharacters(): Promise<CharacterConfig[]>;
  listBackends(): Promise<BackendConfig[]>;
  getSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<void>;
  addBackend(b: BackendConfig, apiKey?: string): Promise<void>;
  removeBackend(id: string): Promise<void>;
  testBackend(id: string): Promise<{ ok: boolean; detail?: string }>;
  /** 启动/停止后端常驻会话；backendStatus 查询运行状态 */
  startBackend(id: string): Promise<{ ok: boolean; detail?: string }>;
  stopBackend(id: string): Promise<void>;
  backendStatus(id: string): Promise<{ running: boolean }>;
  upsertCharacter(c: CharacterConfig): Promise<void>;
  removeCharacter(id: string): Promise<void>;
  // 素材
  importPhoto(replaceCharId?: string): Promise<CharacterConfig[]>;
  regenerateSprite(charId: string): Promise<void>;
  // 窗口与系统
  openSettings(): void;
  openReader(charId: string, markdown: string, title: string): void;
  setClickable(clickable: boolean): void;
  /** 聊天打开/关闭时切换窗口可聚焦性（focusable:false 会让输入框/IME 失焦错位） */
  setChatFocus(on: boolean): void;
  setAutostart(on: boolean): Promise<void>;
  /** 保存图像生成 API Key（DPAPI 加密，不进 settings.json） */
  setImageApiKey(key: string): Promise<void>;
  onRects(cb: (rects: WinRect[]) => void): void;
  /** 工作区变化推送（不含任务栏的区域；物理边界以此为准） */
  onWorkArea(cb: (wa: { x: number; y: number; width: number; height: number }) => void): void;
  /** 角色列表变化（导入照片/删除/素材重生成）时推送最新列表与需重载素材的角色 id */
  onCharactersChanged(cb: (chars: CharacterConfig[], spriteIds: string[]) => void): void;
  /** 循环提醒触发 */
  onReminder(cb: (r: { title: string; category: string }) => void): void;
}

declare global {
  interface Window {
    deckpet: PreloadApi;
  }
}
