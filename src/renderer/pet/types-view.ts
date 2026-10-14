/**
 * renderer 内部视图模型（仅表现层使用，不进契约层）。
 * 坐标系：屏幕 CSS 像素，x 向右、y 向下；宠物的 (x, y) 为「脚底中心」。
 */
import type { SpriteAction } from '../../core/sprite-contract.js';

/** 自主行为状态机的状态 */
export type BehaviorMode =
  | 'crawl' // 随机方向爬行
  | 'climb' // 贴窗口侧边攀爬
  | 'hang' // 挂窗口上沿晃荡
  | 'peek' // 边缘探头张望
  | 'roll' // 打滚玩耍
  | 'rest' // 打盹
  | 'chase' // 追逐最近的同伴
  | 'drag' // 被用户拖拽（物理暂停）
  | 'bar_hang' // 被拖到屏幕顶端：抓"单杠"悬挂 5s 后松手下落
  | 'trip' // 拖拽抛落后摔倒了：屁股着地 → 爬起来（定番序列）
  | 'gesture'; // 情境动作（wave/jump/sit_sad/think），播完回原状态

/**
 * 支撑关系：宠物当前站在/贴在什么上面。
 * rect 支撑记录相对偏移（dx/dy），窗口移动时物理层按 hwnd 找回矩形并跟随。
 */
export type Support =
  | { type: 'ground' } // 屏幕底边
  | { type: 'top' } // 屏幕顶边（单杠悬挂点）
  | {
      type: 'rect';
      hwnd: number;
      /** top=站上沿 / left|right=贴侧边 */
      edge: 'top' | 'left' | 'right';
      /** top：距矩形左边的水平偏移；侧边：未用 */
      dx: number;
      /** top：0=站着，>0=悬挂在上沿下方；侧边：距矩形顶边的垂直偏移 */
      dy: number;
    }
  | null;

/** 单个宠物的全部可变状态（物理 + 状态机 + 动画共用） */
export interface PetState {
  charId: string;
  /** 脚底中心坐标 */
  x: number;
  y: number;
  /** 速度 px/s */
  vx: number;
  vy: number;
  /** 朝向：1 右 / -1 左（渲染用 scaleX 翻转） */
  facing: 1 | -1;
  mode: BehaviorMode;
  /** gesture/drag 结束后恢复的状态 */
  prevMode: BehaviorMode;
  /** 当前播放的动作（状态机每帧刷新） */
  action: SpriteAction;
  /** 帧序号与帧内累计时间 */
  frameIndex: number;
  frameElapsedMs: number;
  /** 动画播放倍速（peek 减速、chase 加速） */
  animSpeed: number;
  /** 当前状态已停留时长 / 最短停留时长（到点才允许转移） */
  modeElapsedMs: number;
  minDwellMs: number;
  /** gesture 状态截止时间戳（performance.now 域）与动作 */
  gestureUntil: number;
  gestureAction: SpriteAction | null;
  /** 协作模式的集合点：限时强制爬向该 x 坐标（"开会"可视化） */
  meetTarget: { x: number; until: number } | null;
  /** 拖拽发生过明显纵向移动：松手落地时要摔一跤 */
  thrown: boolean;
  support: Support;
}

/** 初始状态：站在屏幕底部，随机朝向爬行 */
export function createPetState(charId: string, x: number, screenH: number, rng: () => number): PetState {
  const facing = rng() < 0.5 ? 1 : -1;
  return {
    charId,
    x,
    y: screenH,
    vx: 0,
    vy: 0,
    facing: facing as 1 | -1,
    mode: 'crawl',
    prevMode: 'crawl',
    action: 'crawl',
    frameIndex: 0,
    frameElapsedMs: 0,
    animSpeed: 1,
    modeElapsedMs: 0,
    minDwellMs: 3000 + rng() * 5000,
    gestureUntil: 0,
    gestureAction: null,
    meetTarget: null,
    thrown: false,
    support: { type: 'ground' },
  };
}
