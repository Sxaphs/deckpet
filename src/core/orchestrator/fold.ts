import type { BubbleFoldSettings } from '../types.js';

export interface FoldResult {
  /** 气泡里展示的精华版 */
  summary: string;
  /** 是否被折叠（false = 全文直接显示，无「展开全部」按钮） */
  folded: boolean;
}

function countLines(s: string): number {
  return s.split('\n').length;
}

/**
 * 长回复折叠（纯函数，与 UI 解耦，vitest 覆盖）：
 * 超过阈值 → 取首段要点（首个非空段落，再按行数/字符数截断）；
 * 模型侧一句话摘要由 orchestrator 可选附加，本函数只做确定性兜底。
 */
export function foldText(full: string, cfg: BubbleFoldSettings): FoldResult {
  if (!cfg.enabled) return { summary: full, folded: false };

  const over = countLines(full) > cfg.maxLines || full.length > cfg.maxChars;
  if (!over) return { summary: full, folded: false };

  // 首段要点：第一个非空段落
  const paragraphs = full.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let summary = paragraphs[0] ?? full;

  // 再按行数与字符数硬截断
  const lines = summary.split('\n');
  if (lines.length > cfg.maxLines) {
    summary = lines.slice(0, cfg.maxLines).join('\n') + '…';
  }
  if (summary.length > cfg.maxChars) {
    summary = summary.slice(0, cfg.maxChars) + '…';
  }
  return { summary, folded: true };
}
