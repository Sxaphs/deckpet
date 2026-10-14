/**
 * DeckPet preload（renderer 的唯一入口）。
 *
 * 关键决策：本文件刻意使用 .mts 后缀。
 * 项目是 NodeNext/ESM（package.json "type":"module"），tsc 会把 .mts 编译成
 * .mjs —— Electron 28+ 仅在 sandbox:false 且扩展名为 .mjs 时才支持 ESM
 * preload。若用普通 .ts，产物是 ESM 语法的 .js，会被当作 CJS 加载而失败。
 * pet-window.ts 的 PRELOAD_PATH 指向编译产物 dist/main/preload/index.mjs。
 *
 * renderer 只准使用 window.deckpet（PreloadApi），不得直接碰 ipcRenderer。
 * 额外的 deckpetReader 全局仅服务 reader 页面（'reader:load' 不在 PreloadApi 契约里）。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../core/ipc-contract.js';
import type { PreloadApi, WinRect } from '../core/ipc-contract.js';
import type { OrcEvent, CharacterConfig } from '../core/types.js';

/** reqId → 事件回调；done/error 后自动清理防泄漏 */
const eventListeners = new Map<string, (ev: OrcEvent) => void>();

// 全局只注册一次 CH.event 监听，按 reqId 分发（避免重复注册累积）
ipcRenderer.on(CH.event, (_e, reqId: string, ev: OrcEvent) => {
  const cb = eventListeners.get(reqId);
  if (!cb) return;
  cb(ev);
  if (ev.kind === 'done' || ev.kind === 'error') eventListeners.delete(reqId);
});

const api: PreloadApi = {
  // ───────── 编排（流式：send 发起，onEvent 收事件） ─────────
  chat(charId, text) {
    const reqId = crypto.randomUUID();
    ipcRenderer.send(CH.chat, reqId, charId, text);
    return reqId;
  },
  collab(task, charIds) {
    const reqId = crypto.randomUUID();
    ipcRenderer.send(CH.collab, reqId, task, charIds);
    return reqId;
  },
  cancel(reqId, charId) {
    ipcRenderer.send(CH.cancel, reqId, charId);
  },
  onEvent(reqId, cb) {
    eventListeners.set(reqId, cb);
  },
  lineA(charId) {
    return ipcRenderer.invoke(CH.lineA, charId);
  },

  // ───────── 配置（invoke） ─────────
  listCharacters: () => ipcRenderer.invoke(CH.listCharacters),
  listBackends: () => ipcRenderer.invoke(CH.listBackends),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  saveSettings: (s) => ipcRenderer.invoke(CH.saveSettings, s),
  addBackend: (b, apiKey) => ipcRenderer.invoke(CH.addBackend, b, apiKey),
  removeBackend: (id) => ipcRenderer.invoke(CH.removeBackend, id),
  testBackend: (id) => ipcRenderer.invoke(CH.testBackend, id),
  startBackend: (id) => ipcRenderer.invoke(CH.startBackend, id),
  stopBackend: (id) => ipcRenderer.invoke(CH.stopBackend, id),
  backendStatus: (id) => ipcRenderer.invoke(CH.backendStatus, id),
  upsertCharacter: (c) => ipcRenderer.invoke(CH.upsertCharacter, c),
  removeCharacter: (id) => ipcRenderer.invoke(CH.removeCharacter, id),

  // ───────── 素材 ─────────
  importPhoto: (replaceCharId) => ipcRenderer.invoke(CH.importPhoto, replaceCharId),
  regenerateSprite: (charId) => ipcRenderer.invoke(CH.regenerateSprite, charId),

  // ───────── 窗口与系统 ─────────
  openSettings: () => ipcRenderer.send(CH.openSettings),
  openReader: (charId, markdown, title) =>
    ipcRenderer.send(CH.openReader, charId, markdown, title),
  setClickable: (clickable) => ipcRenderer.send(CH.setClickable, clickable),
  setChatFocus: (on) => ipcRenderer.send(CH.setChatFocus, on),
  setAutostart: (on) => ipcRenderer.invoke(CH.setAutostart, on),
  setImageApiKey: (key) => ipcRenderer.invoke(CH.setImageApiKey, key),
  onRects(cb) {
    ipcRenderer.on(CH.rects, (_e, rects: WinRect[]) => cb(rects));
  },
  onWorkArea(cb) {
    ipcRenderer.on(CH.workArea, (_e, wa: { x: number; y: number; width: number; height: number }) =>
      cb(wa),
    );
  },
  onCharactersChanged(cb) {
    ipcRenderer.on(CH.charactersChanged, (_e, chars: CharacterConfig[], spriteIds: string[]) =>
      cb(chars, spriteIds ?? []),
    );
  },
  onReminder(cb) {
    ipcRenderer.on(CH.reminder, (_e, r: { title: string; category: string }) => cb(r));
  },
};

contextBridge.exposeInMainWorld('deckpet', api);

// reader 页面专用：接收主进程推送的 markdown 内容（不属于 PreloadApi 契约）
const readerApi = {
  onReaderLoad(cb: (data: { markdown: string; title: string }) => void): void {
    ipcRenderer.on('reader:load', (_e, data: { markdown: string; title: string }) =>
      cb(data),
    );
  },
};
contextBridge.exposeInMainWorld('deckpetReader', readerApi);

declare global {
  interface Window {
    deckpetReader: typeof readerApi;
  }
}
