/**
 * 独立阅读窗口：展示折叠前的完整 markdown 回复。
 * 每次打开新窗口（不单例），内容经 'reader:load' 推送，
 * 由 preload 的 deckpetReader.onReaderLoad 转给 reader 页面。
 */
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { PRELOAD_PATH, RENDERER_ROOT } from './pet-window.js';

interface ReaderPayload {
  markdown: string;
  title: string;
}

export function openReaderWindow(payload: ReaderPayload): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 840,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 必须等页面加载完再发，否则 ipcRenderer 监听尚未注册，消息丢失
  win.webContents.once('did-finish-load', () => {
    try {
      win.webContents.send('reader:load', payload);
    } catch {
      // 窗口可能已被用户关闭
    }
  });
  void win.loadFile(path.join(RENDERER_ROOT, 'reader/index.html'));
  return win;
}
