/**
 * 素材加载与播放：按角色加载 manifest.json，预加载帧图，缺帧优雅回退。
 * 目录约定：assets/sprites/<id>/ 被复制到 dist/renderer/pet/sprites/<id>/，
 * 页面从 dist/renderer/pet/index.html 加载，故用相对路径 sprites/<id>/... 即可。
 */
import type { CharacterConfig } from '../../core/types.js';
import type { SpriteAction, SpriteManifest } from '../../core/sprite-contract.js';
import type { PetState } from './types-view.js';

export interface LoadedFrame {
  url: string;
  img: HTMLImageElement;
  durationMs: number;
  width: number;
  height: number;
  /** 加载失败标记（onerror），渲染时跳过 */
  broken: boolean;
}

/** 从 spriteDir 取相对 assets/sprites 的路径（支持存档目录等多级路径）；取不到用角色 id */
function spriteRelOf(char: CharacterConfig): string {
  const norm = char.spriteDir.replace(/\\/g, '/');
  const m = norm.match(/assets\/sprites\/(.+)$/);
  if (m) return m[1].replace(/\/+$/, '');
  const segs = norm.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? char.id;
}

function loadImg(url: string, onerror: () => void): HTMLImageElement {
  const img = new Image();
  img.onerror = onerror;
  img.src = url;
  return img;
}

/** 占位帧：canvas 画一个极简小人，素材全缺时兜底，保证不崩 */
function makePlaceholder(): LoadedFrame {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 48;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = 'rgba(120,160,220,0.95)';
    g.beginPath();
    g.arc(24, 13, 8, 0, Math.PI * 2); // 头
    g.fill();
    g.fillRect(15, 21, 18, 17); // 身
    g.fillRect(9, 38, 12, 6); // 左腿
    g.fillRect(27, 38, 12, 6); // 右腿
  }
  const url = c.toDataURL();
  return { url, img: loadImg(url, () => {}), durationMs: 200, width: 48, height: 48, broken: false };
}

/** 一个角色的整套素材 */
export class SpriteSet {
  private actions = new Map<SpriteAction, LoadedFrame[]>();
  private placeholder: LoadedFrame[] | null = null;

  constructor(readonly characterId: string) {}

  addFrames(action: SpriteAction, frames: LoadedFrame[]): void {
    if (frames.length) this.actions.set(action, frames);
  }

  /**
   * 取某动作的可用帧；缺帧回退顺序：
   * 本动作（剔除加载失败帧）→ talk_closed → crawl → 任意非空动作 → 占位帧。
   */
  getFrames(action: SpriteAction): LoadedFrame[] {
    const ok = (a: SpriteAction) => this.actions.get(a)?.filter((f) => !f.broken);
    const own = ok(action);
    if (own?.length) return own;
    const talk = ok('talk_closed');
    if (talk?.length) return talk;
    const crawl = ok('crawl');
    if (crawl?.length) return crawl;
    for (const frames of this.actions.values()) {
      const alive = frames.filter((f) => !f.broken);
      if (alive.length) return alive;
    }
    if (!this.placeholder) this.placeholder = [makePlaceholder()];
    return this.placeholder;
  }

  getFrame(action: SpriteAction, index: number): LoadedFrame {
    const frames = this.getFrames(action);
    return frames[index % frames.length];
  }
}

/**
 * 加载角色素材。manifest 拉取失败 / 帧图 404 均不抛错，回退到占位帧。
 */
export async function loadSpriteSet(char: CharacterConfig): Promise<SpriteSet> {
  const rel = spriteRelOf(char);
  // sprite://local/<rel>/<file> 自定义协议直接映射 assets/sprites（运行期素材实时可读）
  const base = `sprite://local/${rel}`;
  const set = new SpriteSet(char.id);

  let manifest: SpriteManifest | null = null;
  try {
    // 加时间戳防浏览器缓存：重新生成素材后必须拿到新 manifest
    const res = await fetch(`${base}/manifest.json?t=${Date.now()}`);
    if (res.ok) manifest = (await res.json()) as SpriteManifest;
  } catch {
    manifest = null; // file:// 环境 fetch 可能被拦，走占位
  }

  if (manifest?.frames) {
    // 帧图同样带版本戳（manifest.generatedAt 变化即换 URL，避开图片缓存）
    const v = encodeURIComponent(manifest.generatedAt ?? '');
    for (const [action, frames] of Object.entries(manifest.frames)) {
      if (!frames?.length) continue;
      const loaded: LoadedFrame[] = frames.map((f) => {
        const url = `${base}/${f.file}?v=${v}`;
        const frame: LoadedFrame = {
          url,
          img: new Image(),
          durationMs: f.durationMs ?? 120,
          width: f.width || 48,
          height: f.height || 48,
          broken: false,
        };
        frame.img.onerror = () => {
          frame.broken = true; // 单帧 404：标记后由 getFrames 剔除
        };
        frame.img.src = url; // 预加载
        return frame;
      });
      set.addFrames(action as SpriteAction, loaded);
    }
  }
  return set;
}

/** 按帧时长推进动画（考虑 animSpeed 倍速），直接原地更新 pet 的帧字段 */
export function advanceFrame(set: SpriteSet, pet: PetState, dtMs: number): void {
  const frames = set.getFrames(pet.action);
  pet.frameIndex %= frames.length;
  pet.frameElapsedMs += dtMs * pet.animSpeed;
  let guard = 0;
  while (guard++ < 16) {
    const cur = frames[pet.frameIndex % frames.length];
    if (pet.frameElapsedMs < cur.durationMs) break;
    pet.frameElapsedMs -= cur.durationMs;
    pet.frameIndex = (pet.frameIndex + 1) % frames.length;
  }
}

/** 像素透明度掩码：用于命中测试（点击穿透判定） */
export interface AlphaMask {
  width: number;
  height: number;
  data: Uint8Array; // 1=不透明
}

const maskCache = new Map<string, AlphaMask | null>();

/**
 * 读帧图 alpha 生成掩码；file:// 画布被污染或图未加载完时返回 null，
 * 调用方退化为包围盒命中。
 */
export function getAlphaMask(frame: LoadedFrame): AlphaMask | null {
  const cached = maskCache.get(frame.url);
  if (cached !== undefined) return cached;
  let mask: AlphaMask | null = null;
  try {
    if (frame.img.complete && frame.img.naturalWidth > 0) {
      const c = document.createElement('canvas');
      c.width = frame.width;
      c.height = frame.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (g) {
        g.drawImage(frame.img, 0, 0, frame.width, frame.height);
        const src = g.getImageData(0, 0, frame.width, frame.height).data;
        const data = new Uint8Array(frame.width * frame.height);
        for (let i = 0; i < data.length; i++) data[i] = src[i * 4 + 3] > 24 ? 1 : 0;
        mask = { width: frame.width, height: frame.height, data };
      }
    }
  } catch {
    mask = null; // SecurityError：file:// 污染画布
  }
  maskCache.set(frame.url, mask);
  return mask;
}
