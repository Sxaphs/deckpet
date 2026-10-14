/**
 * 物理层：重力、摩擦、屏幕边界反弹、窗口矩形（WinRect）支撑。
 * 纯函数：step() 返回新状态，不改入参（浅拷贝 + support 拷贝，字段均为原始值）。
 */
import type { WinRect } from '../../core/ipc-contract.js';
import type { PetState } from './types-view.js';

/** 物理边界（工作区，不含任务栏） */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const G = 2600; // 重力加速度 px/s²
const RESTITUTION = 0.35; // 边界反弹恢复系数
const FRICTION = 6; // 着地时的水平摩擦（指数衰减系数）
const BAR_HANG_OFFSET = 56; // 单杠悬挂时脚底距工作区顶的距离
const CEIL_MARGIN = 40; // 上升封顶余量（脚底不越过 顶边+该值）

/** 按 hwnd 找未最小化的窗口矩形 */
function findRect(obstacles: WinRect[], hwnd: number): WinRect | undefined {
  return obstacles.find((o) => o.hwnd === hwnd && !o.minimized);
}

/** 屏幕左右边界处理（空中与地面共用）：反弹并掉头 */
function bounceWalls(p: PetState, left: number, right: number): void {
  if (p.x < left) {
    p.x = left;
    p.vx = -p.vx * RESTITUTION;
    p.facing = 1;
  } else if (p.x > right) {
    p.x = right;
    p.vx = -p.vx * RESTITUTION;
    p.facing = -1;
  }
}

/** 落地处理：被抛出去（thrown）的落地 → 摔一跤（trip 序列） */
function land(p: PetState): void {
  if (p.thrown) {
    p.thrown = false;
    p.mode = 'trip';
    p.modeElapsedMs = 0;
    p.vx = 0;
    p.frameIndex = 0;
    p.frameElapsedMs = 0;
  }
}

/**
 * 推进一帧物理。
 * @param obstacles 当前所有窗口矩形（onRects 每 ~100ms 更新）
 * @param dtMs 帧间隔毫秒
 * @param bounds 工作区边界（不含任务栏；宠物不落到任务栏后、不飞出顶端）
 */
export function step(pet: PetState, obstacles: WinRect[], dtMs: number, bounds: Bounds): PetState {
  const p: PetState = { ...pet, support: pet.support ? { ...pet.support } : null };
  const dt = dtMs / 1000;
  if (dt <= 0) return p;

  // 坐标污染自愈：任何 NaN/Infinity 直接重置到底边中央（防"突然消失"）
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    p.x = (bounds.left + bounds.right) / 2;
    p.y = bounds.bottom;
    p.vx = 0;
    p.vy = 0;
    p.support = { type: 'ground' };
    p.mode = 'crawl';
    p.modeElapsedMs = 0;
    return p;
  }

  // 拖拽中：物理完全暂停（位置由鼠标驱动）
  if (p.mode === 'drag') return p;

  // ── 窗口矩形支撑：跟随 / 失去支撑 ──
  if (p.support?.type === 'top') {
    // 屏幕顶"单杠"：钉死在悬挂点，由状态机计时松手
    p.y = bounds.top + BAR_HANG_OFFSET;
    p.vx = 0;
    p.vy = 0;
    return p;
  }
  if (p.support?.type === 'rect') {
    const r = findRect(obstacles, p.support.hwnd);
    // 窗口被拖出工作区：宠物不跟出屏幕，脱手落回屏内
    const offscreen = r && (r.right < bounds.left || r.left > bounds.right || r.bottom < bounds.top || r.top > bounds.bottom);
    if (!r || offscreen) {
      // 窗口消失/最小化/出屏 → 失去支撑，进入下落
      p.support = null;
      p.x = Math.min(Math.max(p.x, bounds.left), bounds.right);
      p.y = Math.min(Math.max(p.y, bounds.top + CEIL_MARGIN), bounds.bottom);
    } else if (p.support.edge === 'top') {
      if (p.mode !== 'hang') {
        // 站在上沿：水平爬行折算进 dx，窗口移动时天然跟随
        p.support.dx += p.vx * dt;
        const w = r.right - r.left;
        if (p.support.dx < 0 || p.support.dx > w) {
          p.support = null; // 走出边缘 → 下落
        } else {
          p.x = r.left + p.support.dx;
          p.y = r.top;
          p.vy = 0;
          p.vx *= Math.exp(-FRICTION * dt);
          bounceWalls(p, bounds.left, bounds.right);
          return p;
        }
      } else {
        // 悬挂在上沿下方：位置钉死在悬挂点
        p.x = r.left + p.support.dx;
        p.y = r.top + p.support.dy;
        p.vx = 0;
        p.vy = 0;
        return p;
      }
    } else {
      // 贴侧边攀爬：dy 由状态机增减
      const h = r.bottom - r.top;
      if (p.support.dy > h) {
        p.support = null; // 爬到底部以下 → 脱手下落
      } else {
        p.x = p.support.edge === 'left' ? r.left : r.right;
        p.y = r.top + p.support.dy;
        p.vx = 0;
        p.vy = 0;
        return p;
      }
    }
  }

  // ── 地面支撑 ──
  if (p.support?.type === 'ground') {
    p.y = bounds.bottom;
    p.vy = 0;
    p.x += p.vx * dt;
    p.vx *= Math.exp(-FRICTION * dt);
    bounceWalls(p, bounds.left, bounds.right);
    return p;
  }

  // ── 空中：重力 + 边界 + 落窗检测 ──
  p.vy += G * dt;
  const prevY = p.y;
  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // 下落时穿过某窗口上沿 → 落在上面
  if (p.vy > 0) {
    for (const r of obstacles) {
      if (r.minimized) continue;
      if (p.x >= r.left && p.x <= r.right && prevY <= r.top && p.y >= r.top) {
        p.y = r.top;
        p.vy = 0;
        p.support = { type: 'rect', hwnd: r.hwnd, edge: 'top', dx: p.x - r.left, dy: 0 };
        land(p);
        break;
      }
    }
  }

  if (!p.support) {
    if (p.y >= bounds.bottom) {
      // 落地
      p.y = bounds.bottom;
      p.vy = 0;
      p.support = { type: 'ground' };
      land(p);
    } else if (p.y < bounds.top + CEIL_MARGIN) {
      // 上升封顶：不飞出工作区顶边
      p.y = bounds.top + CEIL_MARGIN;
      p.vy = -p.vy * RESTITUTION;
    }
    bounceWalls(p, bounds.left, bounds.right);
  }
  return p;
}
