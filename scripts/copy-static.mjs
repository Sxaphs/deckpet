// 构建后静态文件拷贝：
// 1. src/renderer/<page>/index.html（及可选 style.css）→ dist/renderer/<page>/
//    覆盖 pet / settings / reader 三个页面目录，源文件不存在则跳过。
// 2. assets/sprites 存在时整体复制到 dist/renderer/pet/sprites/
//    （pet 页面以 file:// 加载，renderer 内用相对路径 sprites/<id>/manifest.json 取素材）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = ['pet', 'settings', 'reader'];

for (const page of pages) {
  const srcDir = path.join(root, 'src/renderer', page);
  const dstDir = path.join(root, 'dist/renderer', page);
  const html = path.join(srcDir, 'index.html');
  if (!fs.existsSync(html)) continue; // 该页面尚未交付，跳过
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(html, path.join(dstDir, 'index.html'));
  const css = path.join(srcDir, 'style.css');
  if (fs.existsSync(css)) fs.copyFileSync(css, path.join(dstDir, 'style.css'));
}

const spritesSrc = path.join(root, 'assets/sprites');
const spritesDst = path.join(root, 'dist/renderer/pet/sprites');
if (fs.existsSync(spritesSrc)) {
  fs.mkdirSync(path.dirname(spritesDst), { recursive: true });
  fs.cpSync(spritesSrc, spritesDst, { recursive: true });
}

console.log('[copy-static] done');
