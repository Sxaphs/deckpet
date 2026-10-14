/**
 * Win32 顶层窗口枚举（koffi FFI）。
 * 用途：renderer 根据其他窗口的矩形爬行/攀爬/悬挂。
 *
 * 风险与降级：koffi 是原生模块，Electron 主进程加载时可能 ABI 不匹配。
 * 所有初始化包在 try/catch 里，失败时 logger warn 并整体退化为
 * getWindowRects() 返回空数组 —— 桌宠功能不受影响，只是不爬窗。
 */
import koffi from 'koffi';
import type { WebContents } from 'electron';
import { CH, type WinRect } from '../core/ipc-contract.js';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Win32Api {
  EnumWindows(cb: unknown, lParam: number): boolean;
  IsWindowVisible(hwnd: unknown): boolean;
  IsIconic(hwnd: unknown): boolean;
  GetWindowTextLengthW(hwnd: unknown): number;
  GetWindowTextW(hwnd: unknown, buf: Buffer, maxCount: number): number;
  GetWindowRect(hwnd: unknown, rect: Rect): boolean;
  GetWindowThreadProcessId(hwnd: unknown, pidBuf: Buffer): number;
}

let api: Win32Api | null = null;
let initFailed = false;
/** 枚举回调注册后必须常驻引用，否则被 GC 后回调悬穿会崩进程 */
let enumCb: ReturnType<typeof koffi.register> | null = null;
/** 回调内收集结果的临时容器（EnumWindows 同步执行，无并发问题） */
let collector: WinRect[] = [];

/** koffi 回调里的 hwnd 可能是 number / bigint / 不透明指针对象，统一转 number */
function hwndToNumber(hwnd: unknown): number {
  if (typeof hwnd === 'number') return hwnd;
  if (typeof hwnd === 'bigint') return Number(hwnd);
  try {
    return Number(koffi.address(hwnd));
  } catch {
    return 0;
  }
}

function init(logger: Logger): boolean {
  if (api) return true;
  if (initFailed) return false;
  try {
    // 命名 struct，供字符串签名里的 'RECT *' 引用
    koffi.struct('RECT', {
      left: 'long',
      top: 'long',
      right: 'long',
      bottom: 'long',
    });
    const WndEnumProc = koffi.proto(
      '__stdcall',
      'WndEnumProc',
      'bool',
      ['void *', 'intptr_t'],
    );
    const user32 = koffi.load('user32.dll');

    const selfPid = process.pid;
    const onEnum = (hwnd: unknown, _lParam: unknown): boolean => {
      try {
        if (!api!.IsWindowVisible(hwnd)) return true;
        // 排除本进程窗口（桌宠自己全屏透明，不应出现在列表里）
        const pidBuf = Buffer.alloc(4);
        api!.GetWindowThreadProcessId(hwnd, pidBuf);
        if (pidBuf.readUInt32LE(0) === selfPid) return true;
        // 无标题窗口不算（大量系统辅助窗口）
        const len = api!.GetWindowTextLengthW(hwnd);
        if (len <= 0) return true;
        const buf = Buffer.alloc((len + 1) * 2);
        api!.GetWindowTextW(hwnd, buf, len + 1);
        const title = buf.toString('utf16le').replace(/\0[\s\S]*$/, '');
        if (!title || title === 'Program Manager') return true;
        const rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
        if (!api!.GetWindowRect(hwnd, rect)) return true;
        collector.push({
          hwnd: hwndToNumber(hwnd),
          title,
          ...rect,
          // 最小化窗口不排除，单独标注（renderer 可决定是否避让）
          minimized: api!.IsIconic(hwnd),
        });
      } catch {
        // 单个窗口读取失败不中断枚举
      }
      return true;
    };
    enumCb = koffi.register(onEnum, koffi.pointer(WndEnumProc));

    api = {
      EnumWindows: user32.func(
        '__stdcall',
        'EnumWindows',
        'bool',
        ['void *', 'intptr_t'],
      ) as Win32Api['EnumWindows'],
      IsWindowVisible: user32.func(
        'bool __stdcall IsWindowVisible(void *hwnd)',
      ) as Win32Api['IsWindowVisible'],
      IsIconic: user32.func(
        'bool __stdcall IsIconic(void *hwnd)',
      ) as Win32Api['IsIconic'],
      GetWindowTextLengthW: user32.func(
        'int __stdcall GetWindowTextLengthW(void *hwnd)',
      ) as Win32Api['GetWindowTextLengthW'],
      // lpString 声明为 void *，传 Buffer 手动解码 utf16le，避开 koffi 字符串输出参数的坑
      GetWindowTextW: user32.func(
        'int __stdcall GetWindowTextW(void *hwnd, void *buf, int maxCount)',
      ) as Win32Api['GetWindowTextW'],
      GetWindowRect: user32.func(
        'bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)',
      ) as Win32Api['GetWindowRect'],
      GetWindowThreadProcessId: user32.func(
        'uint32 __stdcall GetWindowThreadProcessId(void *hwnd, void *pid)',
      ) as Win32Api['GetWindowThreadProcessId'],
    };
    return true;
  } catch (err) {
    initFailed = true;
    api = null;
    logger('warn', `koffi/user32 初始化失败，窗口枚举已禁用: ${String(err)}`);
    return false;
  }
}

/** 枚举当前可见顶层窗口矩形（屏幕物理像素）。koffi 不可用时返回空数组。 */
function getWindowRects(logger: Logger = () => {}): WinRect[] {
  if (!init(logger) || !api) return [];
  const out: WinRect[] = [];
  collector = out;
  try {
    api.EnumWindows(enumCb, 0);
  } catch {
    // 枚举过程异常返回已收集的部分
  } finally {
    collector = [];
  }
  return out;
}

/**
 * 轮询推送窗口矩形到 renderer（默认 100ms ≈ 10Hz）。
 * 与上次结果完全相同则跳过发送，减少 IPC 噪音。
 * 返回停止函数（app will-quit 时调用）。
 */
export function startPolling(
  webContents: WebContents,
  intervalMs = 100,
  logger: Logger = () => {},
): () => void {
  let lastKey = '';
  const timer = setInterval(() => {
    const rects = getWindowRects(logger);
    const key = JSON.stringify(rects);
    if (key === lastKey) return;
    lastKey = key;
    try {
      webContents.send(CH.rects, rects);
    } catch {
      // renderer 已销毁（窗口关闭/崩溃），停止轮询
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
