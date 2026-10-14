/**
 * IPC 转发层：严格按 src/core/ipc-contract.ts 的 CH 白名单实现。
 * 编排类走 ipcMain.on + CH.event 回推流式事件；配置类走 ipcMain.handle。
 * 本文件只做参数编解码与转发，业务全在 core / asset-pipeline。
 */
import { app, ipcMain, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import { CH } from '../core/ipc-contract.js';
import type {
  AppSettings,
  BackendConfig,
  CharacterConfig,
  Confirmer,
  DriverContext,
  OrcEvent,
} from '../core/types.js';
import type { KeyStore } from '../core/config/keystore.js';
import type { SettingsStore } from '../core/config/settings.js';
import { DefaultPolicyEngine } from '../core/permission/policy-engine.js';
import { createDriver } from '../core/adapters/registry.js';
import type { Orchestrator } from '../core/orchestrator/orchestrator.js';
import { importPhoto, regenerateSprite } from './asset-pipeline.js';
import { openReaderWindow } from './reader-window.js';
import { openSettingsWindow } from './settings-window.js';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

export interface MainDeps {
  orchestrator: Orchestrator;
  store: SettingsStore;
  keystore: KeyStore;
  confirmer: Confirmer;
  logger: Logger;
}

/** renderer 销毁后 send 会抛，统一兜底 */
function safeSend(sender: WebContents, channel: string, ...args: unknown[]): boolean {
  try {
    if (sender.isDestroyed()) return false;
    sender.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

/** 角色列表变化时广播给所有窗口；spriteIds 标记素材需强制重载的角色 */
export function notifyCharactersChanged(store: SettingsStore, spriteIds: string[] = []): void {
  for (const w of BrowserWindow.getAllWindows()) {
    safeSend(w.webContents, CH.charactersChanged, store.load().characters, spriteIds);
  }
}

/** 流式转发：orchestrator 的每个 OrcEvent 原样推给 renderer，sender 销毁即中断 */
function forwardStream(
  deps: MainDeps,
  sender: WebContents,
  reqId: string,
  stream: AsyncIterable<OrcEvent>,
  errCharId: string | null,
): void {
  void (async () => {
    try {
      for await (const ev of stream) {
        if (!safeSend(sender, CH.event, reqId, ev)) break;
      }
    } catch (err) {
      safeSend(sender, CH.event, reqId, {
        kind: 'error',
        charId: errCharId,
        error: String(err),
      } satisfies OrcEvent);
    }
  })().catch(() => {});
}

export function setupIpc(deps: MainDeps): void {
  const { orchestrator, store, keystore, logger } = deps;

  // ───────── 编排（流式） ─────────
  ipcMain.on(CH.chat, (e, reqId: string, charId: string, text: string) => {
    forwardStream(deps, e.sender, reqId, orchestrator.chat(charId, text), charId);
  });
  ipcMain.on(CH.collab, (e, reqId: string, task: string, charIds: string[]) => {
    forwardStream(deps, e.sender, reqId, orchestrator.collab(task, charIds), null);
  });
  ipcMain.on(CH.cancel, (_e, _reqId: string, charId: string) => {
    orchestrator.cancel(charId).catch((err) => logger('warn', `cancel 失败: ${String(err)}`));
  });

  // ───────── 编排（单次） ─────────
  ipcMain.handle(CH.lineA, (_e, charId: string) => orchestrator.lineA(charId));
  ipcMain.handle(CH.listCharacters, () => orchestrator.listCharacters());
  ipcMain.handle(CH.listBackends, () => orchestrator.listBackends());

  // ───────── 配置 ─────────
  ipcMain.handle(CH.getSettings, () => store.load());
  ipcMain.handle(CH.saveSettings, (_e, s: AppSettings) => {
    store.save(s);
    orchestrator.reloadSettings();
  });
  ipcMain.handle(CH.addBackend, async (_e, backend: BackendConfig, apiKey?: string) => {
    const b = { ...backend };
    if (apiKey) {
      // 明文只在内存中传递，加密落盘到 keystore，settings 里只存引用名
      const ref = `backend:${b.id}`;
      await keystore.setSecret(ref, apiKey);
      b.apiKeyRef = ref;
    }
    const s = store.load();
    const i = s.backends.findIndex((x) => x.id === b.id);
    if (i >= 0) s.backends[i] = b;
    else s.backends.push(b);
    store.save(s);
    orchestrator.reloadSettings();
  });
  ipcMain.handle(CH.removeBackend, async (_e, id: string) => {
    const s = store.load();
    s.backends = s.backends.filter((x) => x.id !== id);
    if (s.defaultBackendId === id) s.defaultBackendId = null;
    for (const c of s.characters) if (c.backendId === id) c.backendId = null;
    await keystore.deleteSecret(`backend:${id}`); // 连带删除密钥
    store.save(s);
    orchestrator.reloadSettings();
  });
  ipcMain.handle(CH.testBackend, async (_e, id: string) => {
    try {
      const s = store.load();
      const b = s.backends.find((x) => x.id === id);
      if (!b) return { ok: false, detail: `后端不存在: ${id}` };
      // 临时 DriverContext：用全局权限策略，密钥经 keystore 解密
      const ctx: DriverContext = {
        policy: new DefaultPolicyEngine(s.globalPermission, deps.confirmer),
        resolveSecret: keystore.getSecret.bind(keystore),
        log: logger,
      };
      return await createDriver(b, ctx).test();
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  });
  // 后端启动/停止/状态：常驻会话管理（启动后聊天零冷启动）
  ipcMain.handle(CH.startBackend, (_e, id: string) => orchestrator.startBackend(id));
  ipcMain.handle(CH.stopBackend, (_e, id: string) => orchestrator.stopBackend(id));
  ipcMain.handle(CH.backendStatus, (_e, id: string) => ({ running: orchestrator.backendStatus(id) }));
  ipcMain.handle(CH.upsertCharacter, (_e, c: CharacterConfig) => {
    const s = store.load();
    const i = s.characters.findIndex((x) => x.id === c.id);
    if (i >= 0) s.characters[i] = c;
    else s.characters.push(c);
    store.save(s);
    orchestrator.reloadSettings();
    notifyCharactersChanged(store);
  });
  ipcMain.handle(CH.removeCharacter, (_e, id: string) => {
    const s = store.load();
    s.characters = s.characters.filter((x) => x.id !== id);
    store.save(s);
    orchestrator.reloadSettings();
    notifyCharactersChanged(store);
  });

  ipcMain.handle(CH.setImageApiKey, async (_e, key: string) => {
    await keystore.setSecret('image-api', key);
    process.env.DECKPET_IMAGE_API_KEY = key; // 立即对素材管线生效
  });

  // ───────── 素材 ─────────
  ipcMain.handle(CH.importPhoto, async (_e, replaceCharId?: string) => {
    const chars = await importPhoto(store, logger, undefined, replaceCharId);
    // 替换模式需要强制重载该角色素材
    notifyCharactersChanged(store, replaceCharId ? [replaceCharId] : []);
    return chars;
  });
  ipcMain.handle(CH.regenerateSprite, async (_e, charId: string) => {
    await regenerateSprite(store, charId, logger);
    notifyCharactersChanged(store, [charId]); // 素材目录已更新，renderer 需重载精灵
  });

  // ───────── 窗口与系统 ─────────
  ipcMain.on(CH.openSettings, () => openSettingsWindow());
  ipcMain.on(CH.openReader, (_e, _charId: string, markdown: string, title: string) => {
    openReaderWindow({ markdown, title });
  });
  ipcMain.handle(CH.setAutostart, (_e, on: boolean) => {
    app.setLoginItemSettings({ openAtLogin: on });
    const s = store.load();
    s.autostart = on;
    store.save(s);
  });
}
