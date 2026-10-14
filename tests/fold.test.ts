import { describe, expect, it } from 'vitest';
import { foldText } from '../src/core/orchestrator/fold.js';

describe('foldText', () => {
  it('未超阈值原样返回', () => {
    const r = foldText('短回复', { enabled: true, maxLines: 6, maxChars: 400 });
    expect(r.folded).toBe(false);
    expect(r.summary).toBe('短回复');
  });

  it('超行数折叠为首段', () => {
    const full = '第一段要点。\n\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行';
    const r = foldText(full, { enabled: true, maxLines: 3, maxChars: 400 });
    expect(r.folded).toBe(true);
    expect(r.summary).toBe('第一段要点。');
  });

  it('首段自身超行数/字符数时截断并加省略号', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `第${i}行`).join('\n');
    const r = foldText(lines, { enabled: true, maxLines: 3, maxChars: 400 });
    expect(r.folded).toBe(true);
    expect(r.summary).toBe('第0行\n第1行\n第2行…');

    const long = '啊'.repeat(500);
    const r2 = foldText(long, { enabled: true, maxLines: 6, maxChars: 100 });
    expect(r2.folded).toBe(true);
    expect(r2.summary.length).toBe(101);
    expect(r2.summary.endsWith('…')).toBe(true);
  });

  it('enabled=false 不折叠', () => {
    const full = '一\n二\n三\n四\n五\n六\n七\n八';
    const r = foldText(full, { enabled: false, maxLines: 1, maxChars: 1 });
    expect(r.folded).toBe(false);
    expect(r.summary).toBe(full);
  });
});
