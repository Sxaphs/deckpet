/**
 * DeckPet Electron 主进程入口。
 * 职责：组装核心层（drivers / SettingsStore / KeyStore / Orchestrator）、
 * 创建桌宠窗与托盘、注册 IPC、启动 Win32 窗口矩形轮询。
 * 桌宠常驻：window-all-closed 不退出，只能从托盘「退出」结束进程。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, dialog, safeStorage, protocol, screen } from 'electron';
import type { Confirmer } from '../core/types.js';
import { registerBuiltinDrivers } from '../core/adapters/index.js';
import { SettingsStore } from '../core/config/settings.js';
import { SafeStorageKeyStore } from '../core/config/keystore.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';
import { createPetWindow } from './pet-window.js';
import { createTray } from './tray.js';
import { setupIpc } from './ipc.js';
import { startPolling } from './win32.js';
import { openSettingsWindow } from './settings-window.js';
import { startWebConsole } from './web-console.js';
import { ASSETS, ensureDefaultCharacter, ensureSpritesIntact } from './asset-pipeline.js';
import { startScheduler } from './scheduler.js';
import { shell } from 'electron';
import { CH } from '../core/ipc-contract.js';

// 透明穿透置顶窗防"被遮挡休眠"三件套（否则宠物会突然消失/冻结）：
// 1. 关闭遮挡窗口后台化 2. 关闭 renderer 后台化 3. webPreferences.backgroundThrottling=false（pet-window.ts）
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根（dist/main/main → 上三级） */
const ROOT = path.resolve(__dirname, '../../..');
const SPRITES_DIR = path.join(ASSETS, 'sprites');

// sprite://<charId>/<file> → assets/sprites/<charId>/<file>
// 素材在运行期生成，不能依赖构建期拷贝；必须在 app ready 前注册特权 scheme
protocol.registerSchemesAsPrivileged([
  { scheme: 'sprite', privileges: { supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

/** 主进程统一日志：目前打到控制台，后续可接文件日志 */
const logger: Logger = (level, msg) => {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[deckpet:${level}] ${msg}`);
};

/** ask 档权限确认：无父窗口的系统弹窗，默认焦点在「允许」左侧之外的安全位（拒绝） */
const electronConfirmer: Confirmer = async (action) => {
  const detail = [
    `动作类型: ${action.kind}`,
    action.path ? `目标路径: ${action.path}` : null,
    action.command ? `命令: ${action.command}` : null,
    action.url ? `URL: ${action.url}` : null,
    action.reason ? `发起方说明: ${action.reason}` : null,
    action.origin ? `来源: ${action.origin}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const r = await dialog.showMessageBox({
    type: 'question',
    buttons: ['允许', '拒绝'],
    defaultId: 0,
    cancelId: 1, // Esc/关闭 = 拒绝，安全兜底
    title: 'DeckPet 权限确认',
    message: `桌宠（${action.origin ?? '未知来源'}）请求执行 ${action.kind} 操作`,
    detail,
    noLink: true,
  });
  return r.response === 0;
};

// 单实例锁：第二个实例直接退出
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 桌宠无边框无可聚焦窗口，第二实例唤醒时仅打开设置窗作为反馈
    openSettingsWindow();
  });

  // 桌宠常驻：所有窗口关闭也不退出（托盘菜单退出）
  app.on('window-all-closed', () => {});

  void app.whenReady().then(async () => {
    // sprite://local/<rel>/<file> 协议：素材目录实时映射（支持多级 rel，如存档目录）
    protocol.registerFileProtocol('sprite', (req, cb) => {
      try {
        const u = new URL(req.url);
        const rel = decodeURIComponent(u.pathname)
          .replace(/^\/+/, '')
          .replace(/\.\./g, '');
        cb(path.join(SPRITES_DIR, rel));
      } catch {
        cb(path.join(SPRITES_DIR, '__none__'));
      }
    });

    registerBuiltinDrivers();

    const store = new SettingsStore();
    // SafeStorageKeyStore.setSecret 不自建目录，这里保证 keys/ 存在
    fs.mkdirSync(path.join(store.dir, 'keys'), { recursive: true });
    const keystore = new SafeStorageKeyStore(safeStorage, (ref) =>
      path.join(store.dir, 'keys', ref + '.key'),
    );

    const orchestrator = new Orchestrator(
      store,
      keystore.getSecret.bind(keystore),
      electronConfirmer,
      logger,
    );

    // 图像生成 API Key：DPAPI 取出后注入进程环境，供素材管线（gen_frames）使用
    const imgKey = await keystore.getSecret('image-api');
    if (imgKey && !process.env.DECKPET_IMAGE_API_KEY) {
      process.env.DECKPET_IMAGE_API_KEY = imgKey;
    }

    const petWin = createPetWindow(logger);
    setupIpc({ orchestrator, store, keystore, confirmer: electronConfirmer, logger });

    // 工作区（不含任务栏）推送：物理边界以此为准，宠物不会落进任务栏/飞出顶端
    const pushWorkArea = () => {
      if (petWin.isDestroyed()) return;
      const wa = screen.getPrimaryDisplay().workArea;
      petWin.webContents.send(CH.workArea, wa);
    };
    petWin.webContents.on('did-finish-load', pushWorkArea);
    screen.on('display-metrics-changed', pushWorkArea);

    // Web 自助配置台（浏览器里上传照片/配密钥/调形象 prompt）
    const webServer = startWebConsole(store, keystore, logger);
    const webPort = () => {
      const a = webServer.address();
      return typeof a === 'object' && a ? a.port : 17890;
    };

    // 循环提醒调度（到点推气泡）
    const stopScheduler = startScheduler(store, () => petWin.webContents, logger);
    app.on('will-quit', () => stopScheduler());

    createTray(
      () => openSettingsWindow(),
      logger,
      () => petWin,
      () => void shell.openExternal(`http://127.0.0.1:${webPort()}`),
    );

    // Win32 窗口矩形轮询（koffi 不可用时内部退化为空数组推送，不崩溃）
    const stopPolling = startPolling(petWin.webContents, 100, logger);
    app.on('will-quit', () => stopPolling());

    // 首开默认角色：内置奶龙直接上屏
    const hadCharacters = store.load().characters.length > 0;
    ensureDefaultCharacter(store, logger);
    // 素材目录丢失的角色回退内置奶龙（防止火柴人占位）
    ensureSpritesIntact(store, logger);

    // 首次运行（原本没有任何角色）：自动打开设置页引导配置后端/导入照片
    if (!hadCharacters) {
      openSettingsWindow();
    }

    // 冒烟测试：DECKPET_SMOKE=<png路径> 时，加载完成后等待数秒截屏并退出；
    // DECKPET_SMOKE_JS 可在截屏前往页面注入一段 JS（驱动气泡/聊天等）
    const smokeShot = process.env.DECKPET_SMOKE;
    if (smokeShot) {
      petWin.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const js = process.env.DECKPET_SMOKE_JS;
            if (js) {
              const r = await petWin.webContents.executeJavaScript(js);
              if (r !== undefined) console.log(`[smoke] JS 返回: ${JSON.stringify(r)}`);
              await new Promise((r2) =>
                setTimeout(r2, Number(process.env.DECKPET_SMOKE_DELAY ?? 4000)),
              );
            }
            const img = await petWin.webContents.capturePage();
            fs.writeFileSync(smokeShot, img.toPNG());
            console.log(`[smoke] 截图已保存: ${smokeShot}`);
            // 附加窗口（设置/阅读面板）也各截一张：<smokeShot 去掉.png>-win<N>.png
            const { BrowserWindow } = await import('electron');
            const others = BrowserWindow.getAllWindows().filter((w) => w !== petWin);
            console.log(`[smoke] 附加窗口数: ${others.length}`);
            for (let i = 0; i < others.length; i++) {
              console.log(`[smoke] win${i} url=${others[i].webContents.getURL()}`);
              let o = await others[i].webContents.capturePage();
              let buf = o.toPNG();
              if (buf.length === 0) {
                // 截图为空（离屏渲染未出帧）：退化为 DOM 断言验证内容渲染
                const text: string = await others[i].webContents.executeJavaScript(
                  'document.body.innerText.slice(0, 200)',
                );
                const codeTokens: number = await others[i].webContents.executeJavaScript(
                  "document.querySelectorAll('pre code [class*=\"hljs\"], pre code.hljs, pre .hljs-keyword, pre code span').length",
                );
                console.log(`[smoke] win${i} DOM 文本: ${JSON.stringify(text)}`);
                console.log(`[smoke] win${i} 代码高亮节点数: ${codeTokens}`);
              }
              const p = smokeShot.replace(/\.png$/i, `-win${i}.png`);
              if (buf.length > 0) {
                fs.writeFileSync(p, buf);
                console.log(`[smoke] 附加窗口截图: ${p} (${buf.length} bytes)`);
              } else {
                console.log(`[smoke] 附加窗口截图为空，已用 DOM 断言替代: win${i}`);
              }
            }
          } catch (err) {
            console.error(`[smoke] 失败: ${err}`);
          }
          app.quit();
        }, 3000);
      });
    }

    // 演示片录制：DECKPET_SMOKE_VIDEO=<帧输出目录> 时，按固定帧率连拍
    // DECKPET_SMOKE_JS 驱动动作，DECKPET_SMOKE_DELAY 动作提前量，
    // DECKPET_SMOKE_DURATION 录制时长 ms（默认 5000），DECKPET_SMOKE_FPS（默认 10）
    const smokeVideo = process.env.DECKPET_SMOKE_VIDEO;
    if (smokeVideo) {
      petWin.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            fs.mkdirSync(smokeVideo, { recursive: true });
            const js = process.env.DECKPET_SMOKE_JS;
            if (js) await petWin.webContents.executeJavaScript(js);
            await new Promise((r2) => setTimeout(r2, Number(process.env.DECKPET_SMOKE_DELAY ?? 1000)));
            const fps = Number(process.env.DECKPET_SMOKE_FPS ?? 10);
            const frames = Math.round((Number(process.env.DECKPET_SMOKE_DURATION ?? 5000) / 1000) * fps);
            for (let i = 0; i < frames; i++) {
              const img = await petWin.webContents.capturePage();
              fs.writeFileSync(path.join(smokeVideo, `f${String(i).padStart(4, '0')}.png`), img.toPNG());
              await new Promise((r2) => setTimeout(r2, 1000 / fps));
            }
            console.log(`[smoke] 录制完成: ${frames} 帧 → ${smokeVideo}`);
          } catch (err) {
            console.error(`[smoke] 录制失败: ${err}`);
          }
          app.quit();
        }, 3000);
      });
    }
  });
}
