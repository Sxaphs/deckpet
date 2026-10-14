/**
 * 自主行为状态机：crawl/climb/hang/peek/roll/rest/chase/drag/gesture。
 * 加权随机转移 + 每状态最短停留（3~8s 随机）防止机械重复；
 * 存在窗口障碍物时提高 climb/hang/peek 权重。
 * 全部为纯函数（返回新 PetState），pickNext 单独导出便于测试。
 */
import type { WinRect } from '../../core/ipc-contract.js';
import type { SpriteAction } from '../../core/sprite-contract.js';
import { GESTURE_ACTIONS } from '../../core/sprite-contract.js';
import type { BehaviorMode, PetState } from './types-view.js';

export type Rng = () => number;

const CRAWL_SPEED = 45; // px/s
const CHASE_SPEED = 95;
const CLIMB_SPEED = 40;
const PEEK_SPEED = 14; // 探头往返幅值（px/s 级摆动）
const HANG_LEN = 26; // 悬挂时脚底在上沿下方的距离 px
const GESTURE_MS = 1800; // 情境动作默认时长
const CHASE_ARRIVE = 36; // 追逐到达距离
const BAR_HANG_MS = 5000; // 单杠悬挂时长（到点自动松手）
const TRIP_FALL_MS = 1200; // 摔倒屁股着地时长
const TRIP_GETUP_MS = 1200; // 爬起来时长

/** 未最小化的窗口列表 */
function visibleRects(obstacles: WinRect[]): WinRect[] {
  return obstacles.filter((o) => !o.minimized);
}

/** 距宠物最近（按中心点曼哈顿距离）的窗口 */
function nearestRect(pet: PetState, obstacles: WinRect[]): WinRect | undefined {
  let best: WinRect | undefined;
  let bd = Infinity;
  for (const r of visibleRects(obstacles)) {
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const d = Math.abs(cx - pet.x) + Math.abs(cy - pet.y);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 加权随机挑选下一个状态。
 * 基础：crawl 最高，rest/roll 较低；有同伴才 chase；有窗口才 climb/hang/peek。
 * 当前状态从候选中剔除，避免原地续命式重复。
 */
export function pickNext(pet: PetState, others: PetState[], obstacles: WinRect[], rng: Rng): BehaviorMode {
  const w = new Map<BehaviorMode, number>();
  w.set('crawl', 3);
  w.set('rest', 1.2);
  w.set('roll', 0.9);
  if (others.some((o) => o.charId !== pet.charId)) w.set('chase', 1.6);
  if (visibleRects(obstacles).length > 0) {
    w.set('climb', 2.2);
    w.set('hang', 1.8);
    w.set('peek', 1.8);
  }
  w.delete(pet.mode);
  let total = 0;
  for (const v of w.values()) total += v;
  if (total <= 0) return 'crawl';
  let r = rng() * total;
  for (const [k, v] of w) {
    r -= v;
    if (r <= 0) return k;
  }
  return 'crawl';
}

/** 进入新状态：重置停留计时，并按状态准备支撑/速度 */
function enterMode(p: PetState, next: BehaviorMode, obstacles: WinRect[], rng: Rng): void {
  p.mode = next;
  p.modeElapsedMs = 0;
  p.minDwellMs = 3000 + rng() * 5000;
  switch (next) {
    case 'crawl':
      p.facing = rng() < 0.5 ? 1 : -1;
      p.vx = p.facing * CRAWL_SPEED;
      p.vy = 0;
      break;
    case 'rest':
    case 'roll':
      p.vx = 0;
      break;
    case 'climb': {
      const r = nearestRect(p, obstacles);
      if (!r) {
        enterMode(p, 'crawl', obstacles, rng); // 没窗口可爬，退回爬行
        return;
      }
      // 吸到较近的侧边，从当前高度开始向上爬
      const edge = Math.abs(p.x - r.left) <= Math.abs(p.x - r.right) ? 'left' : 'right';
      const dy = clamp(p.y - r.top, 10, r.bottom - r.top - 4);
      p.support = { type: 'rect', hwnd: r.hwnd, edge, dx: 0, dy };
      p.vx = 0;
      p.vy = 0;
      break;
    }
    case 'hang': {
      const r = nearestRect(p, obstacles);
      if (!r) {
        enterMode(p, 'crawl', obstacles, rng);
        return;
      }
      const dx = clamp(p.x - r.left, 8, r.right - r.left - 8);
      p.support = { type: 'rect', hwnd: r.hwnd, edge: 'top', dx, dy: HANG_LEN };
      p.vx = 0;
      p.vy = 0;
      break;
    }
    case 'peek': {
      const r = nearestRect(p, obstacles);
      if (!r) {
        enterMode(p, 'crawl', obstacles, rng);
        return;
      }
      // 站上沿靠左/右的角落，朝外张望
      const w = r.right - r.left;
      const nearLeft = Math.abs(p.x - r.left) < w / 2;
      p.support = { type: 'rect', hwnd: r.hwnd, edge: 'top', dx: nearLeft ? 6 : w - 6, dy: 0 };
      p.facing = nearLeft ? -1 : 1;
      p.vx = 0;
      break;
    }
    case 'chase':
    case 'drag':
    case 'gesture':
      break; // chase 每帧定向；drag/gesture 由外部驱动
  }
}

/**
 * 外部强制情境动作（emotion 匹配的 wave/jump/sit_sad/think）。
 * 非 GESTURE_ACTIONS 的动作（如 talk/idle 映射结果）忽略；drag 中不打断。
 */
export function triggerGesture(pet: PetState, action: SpriteAction, now: number, durationMs = GESTURE_MS): PetState {
  if (!(GESTURE_ACTIONS as readonly string[]).includes(action)) return pet;
  if (pet.mode === 'drag') return pet;
  const p: PetState = { ...pet, support: pet.support ? { ...pet.support } : null };
  if (p.mode !== 'gesture') p.prevMode = p.mode;
  p.mode = 'gesture';
  p.gestureAction = action;
  p.gestureUntil = now + durationMs;
  p.frameIndex = 0;
  p.frameElapsedMs = 0;
  return p;
}

/** 状态 → 播放动作（peek/chase 复用 crawl 帧，不新增素材） */
function actionFor(p: PetState): SpriteAction {
  switch (p.mode) {
    case 'climb':
      return 'climb';
    case 'hang':
    case 'bar_hang': // 单杠悬挂复用悬挂帧
      return 'hang';
    case 'roll':
      return 'roll';
    case 'rest':
      return 'rest';
    case 'trip': // 摔倒序列：先屁股着地，再爬起来
      return p.modeElapsedMs < TRIP_FALL_MS ? 'fall_sit' : 'get_up';
    case 'gesture':
      return p.gestureAction ?? 'think';
    case 'drag':
      return 'scared'; // 被拎着：害怕挣扎（缺帧时回退链兜底）
    default:
      return 'crawl';
  }
}

/** 推进一帧行为：到期转移 + 各状态的运动学输出 */
export function step(
  pet: PetState,
  others: PetState[],
  obstacles: WinRect[],
  dtMs: number,
  now: number,
  rng: Rng,
): PetState {
  const p: PetState = { ...pet, support: pet.support ? { ...pet.support } : null };
  p.modeElapsedMs += dtMs;

  // ── 状态转移 ──
  if (p.mode === 'gesture') {
    if (now >= p.gestureUntil) {
      p.mode = p.prevMode === 'gesture' || p.prevMode === 'drag' ? 'crawl' : p.prevMode;
      p.gestureAction = null;
      p.modeElapsedMs = 0;
      p.minDwellMs = 3000 + rng() * 5000;
    }
  } else if (
    p.mode !== 'drag' &&
    p.mode !== 'trip' && // 定番序列：演完才走（各自有退出计时）
    p.mode !== 'bar_hang' &&
    p.modeElapsedMs >= p.minDwellMs
  ) {
    // 离开 hang：随机翻上窗口（dy=0 站上沿）或松手跳下
    if (p.mode === 'hang' && p.support?.type === 'rect') {
      if (rng() < 0.5) {
        p.support = { ...p.support, edge: 'top', dy: 0 };
      } else {
        p.support = null;
        p.vy = 0;
        p.vx = (rng() < 0.5 ? -1 : 1) * CRAWL_SPEED;
      }
    }
    enterMode(p, pickNext(p, others, obstacles, rng), obstacles, rng);
  }

  // 看门狗：任何状态滞留超过 20s（异常兜底）一律回爬行，杜绝"卡住不恢复"
  if (p.mode !== 'drag' && p.mode !== 'gesture' && p.mode !== 'trip' && p.mode !== 'bar_hang' && p.modeElapsedMs > 20000) {
    enterMode(p, 'crawl', obstacles, rng);
  }

  // 单杠悬挂：5 秒到点松手落下
  if (p.mode === 'bar_hang' && p.modeElapsedMs >= BAR_HANG_MS) {
    p.support = null;
    p.vy = 0;
    enterMode(p, 'crawl', obstacles, rng);
  }

  // 摔倒定番：屁股着地 1.2s → 爬起来 1.2s → 回爬行
  if (p.mode === 'trip' && p.modeElapsedMs >= TRIP_FALL_MS + TRIP_GETUP_MS) {
    enterMode(p, 'crawl', obstacles, rng);
  }

  // ── 各状态每帧行为 ──
  switch (p.mode) {
    case 'crawl': {
      p.animSpeed = 1;
      p.vx = p.facing * CRAWL_SPEED;
      // 站在窗口上沿时走到边缘折返（不掉下去）
      if (p.support?.type === 'rect' && p.support.edge === 'top') {
        const r = obstacles.find((o) => o.hwnd === (p.support as { hwnd: number }).hwnd && !o.minimized);
        if (r) {
          if (p.facing < 0 && p.support.dx < 10) p.facing = 1;
          else if (p.facing > 0 && p.support.dx > r.right - r.left - 10) p.facing = -1;
        }
      }
      break;
    }
    case 'climb': {
      p.animSpeed = 1;
      p.vx = 0;
      if (p.support?.type === 'rect' && (p.support.edge === 'left' || p.support.edge === 'right')) {
        const r = obstacles.find((o) => o.hwnd === (p.support as { hwnd: number }).hwnd && !o.minimized);
        if (!r) {
          enterMode(p, 'crawl', obstacles, rng); // 窗口没了，退回爬行（物理层会处理下落）
          break;
        }
        p.support.dy -= CLIMB_SPEED * (dtMs / 1000); // 向上爬
        if (p.support.dy <= 6) {
          // 爬到顶：翻上上沿继续爬
          const w = r.right - r.left;
          const fromLeft = p.support.edge === 'left';
          p.support = { type: 'rect', hwnd: r.hwnd, edge: 'top', dx: fromLeft ? 6 : w - 6, dy: 0 };
          enterMode(p, 'crawl', obstacles, rng);
          p.facing = fromLeft ? 1 : -1;
        }
      } else {
        enterMode(p, 'crawl', obstacles, rng);
      }
      break;
    }
    case 'hang':
      p.animSpeed = 1;
      p.vx = 0; // 晃荡由循环帧表现
      break;
    case 'peek':
      p.animSpeed = 0.35; // crawl 帧减速播放冒充张望
      p.vx = Math.sin(p.modeElapsedMs / 350) * PEEK_SPEED; // 小幅往返
      break;
    case 'roll':
      p.animSpeed = 1;
      p.vx = 0;
      break;
    case 'rest':
      p.animSpeed = 0.6;
      p.vx = 0;
      break;
    case 'chase': {
      p.animSpeed = 1.4;
      let best: PetState | null = null;
      let bd = Infinity;
      for (const o of others) {
        if (o.charId === p.charId) continue;
        const d = Math.abs(o.x - p.x) + Math.abs(o.y - p.y);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      if (best && bd > CHASE_ARRIVE) {
        p.facing = best.x >= p.x ? 1 : -1;
        p.vx = p.facing * CHASE_SPEED;
      } else {
        p.vx = 0; // 追上了就停下
      }
      break;
    }
    case 'gesture':
      p.animSpeed = 1;
      p.vx = 0;
      break;
    case 'bar_hang': // 单杠：挂住不动（物理层钉住位置）
      p.animSpeed = 1;
      p.vx = 0;
      break;
    case 'trip': // 摔倒定番：躺/爬不起身时不动
      p.animSpeed = 1;
      p.vx = 0;
      break;
    case 'drag':
      p.vx = 0;
      p.vy = 0;
      break;
  }

  // ── 协作集合：限时强制爬向集合点（覆盖当前状态的移动输出） ──
  if (
    p.meetTarget &&
    p.mode !== 'drag' &&
    p.mode !== 'gesture' &&
    p.mode !== 'trip' &&
    p.mode !== 'bar_hang'
  ) {
    if (now >= p.meetTarget.until) {
      p.meetTarget = null;
    } else {
      const dxT = p.meetTarget.x - p.x;
      if (Math.abs(dxT) > 30) {
        p.facing = dxT > 0 ? 1 : -1;
        p.vx = p.facing * CHASE_SPEED;
        p.animSpeed = 1.4;
        p.action = 'crawl';
        return p;
      }
      p.vx = 0; // 已到集合点，围坐
    }
  }

  p.action = actionFor(p);
  return p;
}
