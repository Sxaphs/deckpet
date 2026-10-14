/**
 * 设置窗口（单例）：重复打开只聚焦已有窗口。
 */
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { PRELOAD_PATH, RENDERER_ROOT } from './pet-window.js';

let settingsWin: BrowserWindow | null = null;

export function openSettingsWindow(): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 860,
    height: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  void settingsWin.loadFile(path.join(RENDERER_ROOT, 'settings/index.html'));
  return settingsWin;
}
