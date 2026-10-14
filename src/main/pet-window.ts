/**
 * 桌宠窗口：全屏、透明、无边框、置顶（screen-saver 级）、不抢焦点。
 * 默认整体鼠标穿透（空白处点击直达下层窗口）；
 * renderer 命中宠物/气泡时经 CH.setClickable 切回可点击。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { CH } from '../core/ipc-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** preload 产物：tsc 把 src/preload/index.mts 编译为 dist/main/preload/index.mjs */
export const PRELOAD_PATH = path.join(__dirname, '../preload/index.mjs');
/** renderer 产物根（dist/renderer/），HTML 由 renderer 组提供 */
export const RENDERER_ROOT = path.join(__dirname, '../../renderer');

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

export function createPetWindow(logger: Logger = () => {}): BrowserWindow {
  // 主屏物理边界（primary display 的 x/y 通常为 0,0）
  const b = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false, // 桌宠永不抢焦点
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // ESM preload（.mjs）要求非沙箱
      backgroundThrottling: false, // 关键：透明穿透置顶窗会被误判"被遮挡"而停止渲染（宠物突然消失）
    },
  });
  // screen-saver 级置顶：盖过普通 alwaysOnTop 窗口
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);

  // 启动即空白穿透；forward 让 renderer 仍能收到 mousemove 做命中测试
  win.setIgnoreMouseEvents(true, { forward: true });
  ipcMain.on(CH.setClickable, (_e, clickable: boolean) => {
    if (win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!clickable, { forward: true });
  });

  // 聊天时临时可聚焦：focusable:false 下输入框/输入法候选框会错位到屏幕左上角
  ipcMain.on(CH.setChatFocus, (_e, on: boolean) => {
    if (win.isDestroyed()) return;
    win.setFocusable(on);
    if (on) win.focus();
  });

  // 多显示器 / 分辨率变化时跟随主屏重新铺满
  const refit = () => {
    if (win.isDestroyed()) return;
    const nb = screen.getPrimaryDisplay().bounds;
    win.setBounds({ x: nb.x, y: nb.y, width: nb.width, height: nb.height });
  };
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
  screen.on('display-metrics-changed', refit);

  win.loadFile(path.join(RENDERER_ROOT, 'pet/index.html')).catch((err) => {
    logger('error', `桌宠页面加载失败: ${String(err)}`);
  });
  return win;
}
