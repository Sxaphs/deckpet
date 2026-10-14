/**
 * 单个角色的 DOM 组装与每帧驱动：
 * 精灵 img（scaleX 翻转朝向）+ 气泡 + 右键菜单（聊天/协作任务/打开设置）。
 * 每帧 update = 状态机 → 物理 → 动画推进 → 渲染。
 */
import type { CharacterConfig } from '../../core/types.js';
import type { WinRect } from '../../core/ipc-contract.js';
import type { SpriteAction } from '../../core/sprite-contract.js';
import { SpriteSet, advanceFrame, getAlphaMask } from './sprite.js';
import * as sm from './state-machine.js';
import * as phys from './physics.js';
import { Bubble } from './bubble.js';
import { createPetState, type PetState } from './types-view.js';

export interface PetViewHooks {
  onOpenChat(view: PetView): void;
  onOpenCollab(view: PetView): void;
  /** 右键「刷新形象」：重新拉取该角色素材（热换皮） */
  onRefreshSprite(view: PetView): void;
  onOpenSettings(): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const DRAG_THRESHOLD = 5; // 超过视为拖拽而非点击
const THROW_MAX_VX = 600; // 抛出速度上限 px/s
const THROW_MAX_VY = 800;
/** 宠物渲染放大倍数（素材帧为 96px，屏幕上放大一倍显示） */
export const PET_SCALE = 2;

export class PetView {
  pet: PetState;
  /** 聊天对话框打开时冻结：待在原地，物理/状态机暂停（manual 关闭或 10s 空闲才恢复） */
  frozen = false;
  /** 工作区顶边（物理边界），由 update 每帧写入；endDrag 判定"拖到顶端"用 */
  private boundsTop = 0;
  readonly root: HTMLDivElement;
  readonly img: HTMLImageElement;
  readonly bubble: Bubble;
  private menu: HTMLDivElement;
  private lastFrameUrl = '';

  // 拖拽状态（物理暂停，跟随鼠标，松手按速度抛出）
  private dragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragStartY = 0; // 按下时的 y：判断是否有明显纵向移动（落地摔跤用）
  private lastDragX = 0;
  private lastDragY = 0;
  private lastDragT = 0;
  private throwVx = 0;
  private throwVy = 0;

  constructor(
    readonly char: CharacterConfig,
    readonly sprites: SpriteSet,
    private hooks: PetViewHooks,
    initialX: number,
    screenH: number,
    rng: () => number,
  ) {
    this.pet = createPetState(char.id, initialX, screenH, rng);

    this.root = document.createElement('div');
    this.root.className = 'dp-pet';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.root.appendChild(this.img);

    this.bubble = new Bubble(char.id, char.name);
    document.body.appendChild(this.bubble.el);

    this.menu = this.buildMenu();
    document.body.appendChild(this.menu);
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showMenu(e.clientX, e.clientY);
    });
    // 双击进入聊天
    this.root.addEventListener('dblclick', () => this.hooks.onOpenChat(this));
    // 点别处收起菜单
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.menu.contains(e.target as Node)) this.menu.style.display = 'none';
      },
      true,
    );
  }

  private buildMenu(): HTMLDivElement {
    const menu = document.createElement('div');
    menu.className = 'dp-menu';
    menu.style.display = 'none';
    const items: [string, () => void][] = [
      ['聊天', () => this.hooks.onOpenChat(this)],
      ['协作任务', () => this.hooks.onOpenCollab(this)],
      ['刷新形象', () => this.hooks.onRefreshSprite(this)],
      ['打开设置', () => this.hooks.onOpenSettings()],
    ];
    for (const [label, fn] of items) {
      const item = document.createElement('div');
      item.className = 'dp-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => {
        menu.style.display = 'none';
        fn();
      });
      menu.appendChild(item);
    }
    return menu;
  }

  private showMenu(x: number, y: number): void {
    this.menu.style.display = 'block';
    // clamp 在屏幕内
    const w = this.menu.offsetWidth;
    const h = this.menu.offsetHeight;
    this.menu.style.left = `${clamp(x, 4, window.innerWidth - w - 4)}px`;
    this.menu.style.top = `${clamp(y, 4, window.innerHeight - h - 4)}px`;
  }

  /** 每帧：状态机 → 物理 → 动画 → 渲染；actionOverride 用于口型覆盖 */
  update(
    dtMs: number,
    others: PetState[],
    obstacles: WinRect[],
    bounds: phys.Bounds,
    now: number,
    rng: () => number,
    actionOverride?: SpriteAction,
  ): void {
    this.boundsTop = bounds.top;
    if (!this.dragging && !this.frozen) {
      this.pet = sm.step(this.pet, others, obstacles, dtMs, now, rng);
      this.pet = phys.step(this.pet, obstacles, dtMs, bounds);
    }
    // 拖拽中状态机/物理暂停，动作强制为害怕挣扎（缺帧时回退链兜底）；
    // 单击不触发：dragging 要过了 5px 阈值才为 true。
    // 聊天冻结且没在说话时：站姿闭嘴待命（talk_closed 就是生成时的站姿原貌）
    const action = this.dragging
      ? 'scared'
      : (actionOverride ?? (this.frozen ? 'talk_closed' : this.pet.action));
    advanceFrame(this.sprites, this.pet, dtMs);
    this.render(action);
  }

  private render(action: SpriteAction): void {
    const frame = this.sprites.getFrame(action, this.pet.frameIndex);
    if (frame.url !== this.lastFrameUrl) {
      this.img.src = frame.url;
      this.lastFrameUrl = frame.url;
    }
    const w = frame.width * PET_SCALE;
    const h = frame.height * PET_SCALE;
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
    this.root.style.transform = `translate(${Math.round(this.pet.x - w / 2)}px, ${Math.round(this.pet.y - h)}px)`;
    this.img.style.transform = this.pet.facing < 0 ? 'scaleX(-1)' : '';
    this.bubble.update(this.pet.x, this.pet.y, w, h, this.pet.facing);
  }

  /** 命中测试（仅精灵非透明像素）；气泡部分由 DOM 自身接收事件 */
  hitTestSprite(px: number, py: number): boolean {
    const frame = this.sprites.getFrame(this.pet.action, this.pet.frameIndex);
    const w = frame.width * PET_SCALE;
    const h = frame.height * PET_SCALE;
    if (px < this.pet.x - w / 2 || px >= this.pet.x + w / 2) return false;
    if (py < this.pet.y - h || py >= this.pet.y) return false;
    // 换算回原图素坐标查 alpha 掩码
    const lx = Math.floor((px - (this.pet.x - w / 2)) / PET_SCALE);
    const ly = Math.floor((py - (this.pet.y - h)) / PET_SCALE);
    if (lx < 0 || ly < 0 || lx >= frame.width || ly >= frame.height) return false;
    const mask = getAlphaMask(frame);
    if (!mask) return true; // 画布被污染等：退化为包围盒
    return mask.data[ly * mask.width + lx] === 1;
  }

  /** 悬停命中（精灵像素 或 可见气泡/菜单区域）→ 决定 setClickable */
  hitTest(px: number, py: number): boolean {
    if (this.hitTestSprite(px, py)) return true;
    if (this.bubble.isVisible()) {
      const r = this.bubble.el.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) return true;
    }
    // 右键菜单打开时菜单区域也要可点击（否则点击穿透漏到桌面，菜单点不动）
    if (this.menu.style.display !== 'none') {
      const r = this.menu.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) return true;
    }
    return false;
  }

  /** 右键菜单是否展开（展开期间强制窗口可点击） */
  isMenuOpen(): boolean {
    return this.menu.style.display !== 'none';
  }

  isDragging(): boolean {
    return this.dragging;
  }

  beginDrag(px: number, py: number): void {
    this.dragging = true;
    this.pet = {
      ...this.pet,
      prevMode: this.pet.mode === 'drag' ? this.pet.prevMode : this.pet.mode,
      mode: 'drag',
      support: null,
      vx: 0,
      vy: 0,
    };
    this.dragOffsetX = this.pet.x - px;
    this.dragOffsetY = this.pet.y - py;
    this.dragStartY = this.pet.y;
    this.lastDragX = px;
    this.lastDragY = py;
    this.lastDragT = performance.now();
    this.throwVx = 0;
    this.throwVy = 0;
  }

  dragTo(px: number, py: number): void {
    if (!this.dragging) return;
    const now = performance.now();
    const dt = Math.max(1, now - this.lastDragT) / 1000;
    // 指数平滑的瞬时速度，作为松手抛出速度
    this.throwVx = this.throwVx * 0.7 + ((px - this.lastDragX) / dt) * 0.3;
    this.throwVy = this.throwVy * 0.7 + ((py - this.lastDragY) / dt) * 0.3;
    this.lastDragX = px;
    this.lastDragY = py;
    this.lastDragT = now;
    this.pet = { ...this.pet, x: px + this.dragOffsetX, y: py + this.dragOffsetY };
  }

  /** 松手：拖到顶端 → 抓单杠悬挂；否则按拖拽速度抛出，纵向移动过则落地摔一跤 */
  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    // 以"精灵顶边"判定顶端（素材放大后脚底锚点离顶部有一个身位）；
    // 相对工作区顶边判定（任务栏在顶时也正确）
    const frame = this.sprites.getFrame(this.pet.action, this.pet.frameIndex);
    const spriteH = frame.height * PET_SCALE;
    const nearTop = this.pet.y - spriteH < this.boundsTop + 40;
    if (nearTop) {
      this.pet = {
        ...this.pet,
        // 身体完整挂在顶边之下（y 是脚底锚点，不修正会整只爬出屏幕顶）
        y: this.boundsTop + spriteH,
        mode: 'bar_hang',
        modeElapsedMs: 0,
        vx: 0,
        vy: 0,
        support: { type: 'top' },
        thrown: false,
      };
      return;
    }
    const movedY = Math.abs(this.pet.y - this.dragStartY) > 30;
    this.pet = {
      ...this.pet,
      mode: this.pet.prevMode === 'drag' ? 'crawl' : this.pet.prevMode,
      modeElapsedMs: 0,
      vx: clamp(this.throwVx, -THROW_MAX_VX, THROW_MAX_VX),
      vy: clamp(this.throwVy, -THROW_MAX_VY, 200),
      support: null, // 从抛出点自由下落
      thrown: movedY, // 纵向拖过 → 落地触发摔倒爬起序列（physics 落地时消费）
    };
  }

  triggerGesture(action: SpriteAction, now: number): void {
    this.pet = sm.triggerGesture(this.pet, action, now);
  }

  getDragThreshold(): number {
    return DRAG_THRESHOLD;
  }

  destroy(): void {
    this.root.remove();
    this.bubble.el.remove();
    this.menu.remove();
  }
}
