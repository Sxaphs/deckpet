/**
 * 系统托盘：桌宠唯一的常驻 UI 入口。
 * 菜单：隐藏/显示桌宠 / 打开设置 / 退出。双击托盘图标也可切换隐藏。
 * 图标缺失时用空图标兜底，绝不崩溃。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, Menu, nativeImage, Tray, BrowserWindow } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根（dist/main/main → 上三级），图标放 assets/tray.png */
const TRAY_ICON = path.resolve(__dirname, '../../../assets/tray.png');

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

export function createTray(
  onOpenSettings: () => void,
  logger: Logger = () => {},
  getPetWindow: () => BrowserWindow | null = () => null,
  onOpenWebConsole?: () => void,
): Tray {
  let icon = nativeImage.createEmpty();
  try {
    if (fs.existsSync(TRAY_ICON)) {
      const img = nativeImage.createFromPath(TRAY_ICON);
      if (!img.isEmpty()) icon = img;
      else logger('warn', `托盘图标为空图: ${TRAY_ICON}`);
    } else {
      logger('warn', `托盘图标不存在，使用空图标: ${TRAY_ICON}`);
    }
  } catch (err) {
    logger('warn', `托盘图标加载失败，使用空图标: ${String(err)}`);
  }

  /** 隐藏/显示桌宠（缩小到系统状态栏） */
  const togglePet = () => {
    const win = getPetWindow();
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.show();
    rebuildMenu();
  };

  const rebuildMenu = () => {
    const visible = getPetWindow()?.isVisible() ?? false;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: visible ? '隐藏桌宠' : '显示桌宠', click: togglePet },
        { label: '打开设置', click: () => onOpenSettings() },
        ...(onOpenWebConsole
          ? [{ label: 'Web 控制台（浏览器配置）', click: () => onOpenWebConsole() }]
          : []),
        { type: 'separator' as const },
        { label: '退出', click: () => app.quit() },
      ]),
    );
  };

  const tray = new Tray(icon);
  tray.setToolTip('DeckPet（双击隐藏/显示）');
  rebuildMenu();
  tray.on('double-click', togglePet);
  return tray;
}
