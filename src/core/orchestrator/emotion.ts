import type { EmotionTag } from '../types.js';

/** 台词/回复文本 → 情绪标签（驱动动作库匹配）。纯函数，便于测试。 */
const RULES: Array<{ emotion: EmotionTag; words: string[] }> = [
  { emotion: 'greet', words: ['你好', '您好', 'hello', 'hi ', '嗨', '早上好', '晚上好', 'hey'] },
  { emotion: 'success', words: ['加油', '成功', '完成', '搞定', '太好了', '棒', '冲呀', 'done', 'success'] },
  { emotion: 'think', words: ['思考', '想想', '让我看', '分析', '考虑', 'hmm', '嗯…', '嗯…', '稍等'] },
  { emotion: 'error', words: ['失败', '错误', '出错', '抱歉', '不行', '无法', 'error', 'failed', 'sorry'] },
  { emotion: 'happy', words: ['谢谢', '开心', '哈哈', '感谢', '高兴', 'thanks'] },
];

export function matchEmotion(text: string): EmotionTag {
  const t = text.toLowerCase();
  for (const r of RULES) {
    if (r.words.some((w) => t.includes(w.toLowerCase()))) return r.emotion;
  }
  return 'happy'; // 无匹配 → 默认开心蹦跳
}
