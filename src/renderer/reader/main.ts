/**
 * 独立阅读面板：主进程通过 window.deckpetReader.onReaderLoad 推入
 * { markdown, title }，本页用 markdown-it 渲染（html:false 防 XSS），
 * 代码块经 highlight.js 上色。样式全部在此注入 <style>（不 import
 * highlight.js 的 css——esbuild iife 会把 css 拆成独立 bundle.css，
 * index.html 不引用它，故只注入 minimal 的 pre/code 背景样式）。
 */
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

/** reader 页的 preload API（见 src/core/ipc-contract.ts 注释约定） */
declare global {
  interface Window {
    deckpetReader: {
      onReaderLoad(cb: (payload: { markdown: string; title: string }) => void): void;
    };
  }
}

// ─────────────────────────── 样式 ───────────────────────────

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 14px/1.7 "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #ddd; background: #1e1f24;
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
}
.titlebar {
  flex: none; padding: 10px 16px; font-size: 14px; font-weight: 600;
  background: #26272c; border-bottom: 1px solid #33343a;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.content { flex: 1; overflow-y: auto; padding: 16px 24px 48px; }
.article { max-width: 760px; margin: 0 auto; }
.article h1, .article h2, .article h3 { line-height: 1.4; }
.article a { color: #7aa2f7; }
.article img { max-width: 100%; }
/* 代码块 minimal 高亮样式：背景/边框即可，hljs 类名上色省略 */
.article pre {
  background: #16171b; border: 1px solid #33343a; border-radius: 8px;
  padding: 12px 14px; overflow-x: auto;
}
.article code {
  font-family: Consolas, "Cascadia Mono", monospace; font-size: 13px;
}
.article :not(pre) > code {
  background: #16171b; border: 1px solid #33343a; border-radius: 4px;
  padding: 1px 5px;
}
.article blockquote {
  margin: 0; padding: 2px 14px; color: #9aa0aa;
  border-left: 3px solid #3a3b42;
}
.article table { border-collapse: collapse; }
.article th, .article td { border: 1px solid #3a3b42; padding: 4px 10px; }
`;

// ─────────────────────────── 渲染 ───────────────────────────

const style = document.createElement('style');
style.textContent = CSS;
document.head.append(style);

const root = document.getElementById('app')!;
const titlebar = document.createElement('div');
titlebar.className = 'titlebar';
titlebar.textContent = '阅读';
const content = document.createElement('div');
content.className = 'content';
const article = document.createElement('div');
article.className = 'article';
content.append(article);
root.append(titlebar, content);

const md = new MarkdownIt({
  html: false, // 防 XSS：不渲染 markdown 里的原始 HTML，保持默认关闭
  linkify: true,
  highlight(code, lang) {
    // 返回值会作为 HTML 直接嵌入；hljs.highlight 输出已转义，安全
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        // 高亮失败则回落到默认转义输出
      }
    }
    return ''; // 空串 = 交给 markdown-it 默认转义
  },
});

window.deckpetReader.onReaderLoad(({ markdown, title }) => {
  titlebar.textContent = title || '阅读';
  document.title = title ? `${title} - DeckPet 阅读` : 'DeckPet 阅读';
  article.innerHTML = md.render(markdown);
  content.scrollTop = 0;
});
