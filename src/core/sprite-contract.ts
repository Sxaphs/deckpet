/**
 * 素材契约：pipeline（placeholder_gen.py / gen_frames.ts）与 renderer/sprite.ts
 * 共同遵守的帧清单格式。所有帧 PNG 透明背景，统一锚点为脚底中心。
 */

export type SpriteAction =
  | 'crawl' // 爬行循环（对角步态）
  | 'climb' // 垂直攀爬（沿窗口侧边）
  | 'hang' // 边缘悬挂晃荡
  | 'roll' // 打滚/玩耍
  | 'rest' // 休息/打盹
  | 'talk_open' // 口型：张嘴
  | 'talk_half' // 口型：半张
  | 'talk_closed' // 口型：闭嘴
  | 'wave' // 挥手（打招呼）
  | 'jump' // 蹦跳（成功/加油）
  | 'sit_sad' // 沮丧坐下（出错）
  | 'think' // 挠头思考
  | 'scared' // 被拎起来时的害怕挣扎
  | 'fall_sit' // 摔倒屁股着地
  | 'get_up'; // 摔倒后爬起来

/** 循环动作（多帧动画） */
export const LOOP_ACTIONS = ['crawl', 'climb', 'hang', 'roll', 'rest'] as const;
/** 情境动作（单帧或短循环） */
export const GESTURE_ACTIONS = ['wave', 'jump', 'sit_sad', 'think', 'scared', 'fall_sit', 'get_up'] as const;

export interface SpriteFrame {
  file: string; // 相对 manifest 所在目录
  width: number;
  height: number;
  /** 该帧显示时长 ms（循环帧用） */
  durationMs?: number;
}

export interface SpriteManifest {
  characterId: string;
  /** 'placeholder' | 'ai-generated' | 'cutout' */
  source: string;
  generatedAt: string; // ISO
  /** 生成时使用的形象要求文本 */
  appearanceRequest?: string;
  frames: Partial<Record<SpriteAction, SpriteFrame[]>>;
}

/** 情绪标签 → 动作名（renderer 状态机查表用） */
export const EMOTION_TO_ACTION: Record<string, SpriteAction> = {
  greet: 'wave',
  success: 'jump',
  error: 'sit_sad',
  think: 'think',
  happy: 'jump',
  talk: 'talk_half',
  idle: 'rest',
};
