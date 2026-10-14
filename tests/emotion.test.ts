import { describe, expect, it } from 'vitest';
import { matchEmotion } from '../src/core/orchestrator/emotion.js';

describe('matchEmotion', () => {
  it("'你好' → greet", () => {
    expect(matchEmotion('你好，今天过得怎么样')).toBe('greet');
  });

  it("'加油' → success", () => {
    expect(matchEmotion('加油，快搞定了')).toBe('success');
  });

  it("'出错了' → error", () => {
    expect(matchEmotion('抱歉，刚才出错了')).toBe('error');
  });

  it('无匹配 → happy（默认）', () => {
    expect(matchEmotion('今天天气晴朗万里无云')).toBe('happy');
  });
});
