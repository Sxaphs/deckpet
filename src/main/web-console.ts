/**
 * Web 自助配置台：在 Electron 主进程里起一个 127.0.0.1 本地 HTTP 服务，
 * 让普通用户用浏览器完成：上传照片生成角色、配置各类密钥、调整形象要求 prompt、
 * 改台词、重新生成素材。只监听回环地址，单页内联 HTML 无构建依赖。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SettingsStore } from '../core/config/settings.js';
import type { KeyStore } from '../core/config/keystore.js';
import { importPhoto, regenerateSprite, listSpriteArchive, switchSprite, saveSpriteAs, deleteSpriteArchive, resolveSpriteDir } from './asset-pipeline.js';
import { notifyCharactersChanged } from './ipc.js';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

/** HTML 转义 */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LOG_CSS =
  'body{font-family:system-ui;max-width:860px;margin:20px auto;padding:0 16px;background:#f4f5f7}' +
  'h2 a{font-size:13px;color:#888;text-decoration:none;font-weight:normal}' +
  '.turn{background:#fff;border-radius:8px;padding:12px 16px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}' +
  '.prompt{color:#2d4a7a;font-weight:600}.status{color:#999;font-size:12px;margin:2px 0}' +
  '.delta{white-space:pre-wrap;margin:8px 0}.final{border-top:1px solid #eee;margin-top:8px;padding-top:8px;white-space:pre-wrap}' +
  'a{color:#2d4a7a}';

/** 会话过程日志页：/logs → 角色列表；/logs/<charId> → 该角色各轮对话；/logs/<charId>/<file> → 单轮完整过程 */
function handleLogs(
  url: URL,
  store: SettingsStore,
  res: http.ServerResponse,
): boolean {
  const parts = url.pathname.split('/').filter(Boolean); // ['logs', charId?, file?]
  if (parts[0] !== 'logs') return false;
  const html = (title: string, body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${LOG_CSS}</style></head><body>${body}</body></html>`);
  };
  const logsRoot = path.join(store.dir, 'logs');

  if (parts.length === 1) {
    // 角色列表
    const chars = store.load().characters;
    const items = chars
      .map((c) => {
        const dir = path.join(logsRoot, c.id);
        const n = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length : 0;
        return `<div class="turn"><a href="/logs/${c.id}"><b>${esc(c.name)}</b>（${n} 轮记录）</a></div>`;
      })
      .join('');
    html('会话日志', `<h2>会话过程日志 <a href="/">← 控制台</a></h2>${items || '暂无记录'}`);
    return true;
  }

  const charId = parts[1].replace(/[^a-zA-Z0-9_-]/g, ''); // 防路径穿越
  const dir = path.join(logsRoot, charId);
  if (parts.length === 2) {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse()
      : [];
    const items = files
      .map((f) => {
        let preview = '';
        try {
          const first = fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')[0];
          preview = (JSON.parse(first) as { content?: string }).content?.slice(0, 60) ?? '';
        } catch { /* 忽略坏行 */ }
        const ts = new Date(Number(f.replace('.jsonl', ''))).toLocaleString('zh-CN');
        return `<div class="turn"><a href="/logs/${charId}/${f}"><small>${ts}</small><br>${esc(preview)}…</a></div>`;
      })
      .join('');
    html(`日志 ${charId}`, `<h2>${esc(charId)} 的对话记录 <a href="/logs">← 全部角色</a></h2>${items || '暂无记录'}`);
    return true;
  }

  const file = parts[2].replace(/[^a-zA-Z0-9_.-]/g, '');
  const fp = path.join(dir, file);
  if (!fs.existsSync(fp)) {
    html('404', '<h2>记录不存在</h2>');
    return true;
  }
  const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
  const body = lines
    .map((l) => {
      try {
        const e = JSON.parse(l) as { type?: string; content?: string; text?: string; error?: string };
        if (e.type === 'prompt') return `<div class="prompt">问：${esc(e.content ?? '')}</div>`;
        if (e.type === 'final') return `<div class="final"><b>答（完整）：</b>\n${esc(e.content ?? '')}</div>`;
        if (e.type === 'status') return `<div class="status">⚙ ${esc(e.text ?? '')}</div>`;
        if (e.type === 'error') return `<div class="status" style="color:#c33">✗ ${esc(e.error ?? '')}</div>`;
        return '';
      } catch {
        return '';
      }
    })
    .join('');
  html(`详情 ${file}`, `<h2><a href="/logs/${charId}">← ${esc(charId)}</a></h2><div class="turn">${body}</div>`);
  return true;
}


const PAGE = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>DeckPet 控制台</title>
<style>
body{font-family:system-ui;margin:0;background:#f4f5f7;color:#222}
header{background:#f5c845;padding:14px 20px;font-size:18px;font-weight:600}
main{max-width:720px;margin:20px auto;padding:0 16px}
.card{background:#fff;border-radius:10px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h3{margin:0 0 12px}
label{display:block;margin:10px 0 4px;font-size:13px;color:#555}
input[type=text],input[type=password],textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px}
textarea{min-height:64px}
button{background:#f5c845;border:0;border-radius:6px;padding:8px 16px;font-size:14px;cursor:pointer;margin-top:8px}
button.ghost{background:#eee}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.char{border-top:1px solid #eee;padding-top:10px;margin-top:10px}
#flash{position:fixed;top:10px;right:10px;background:#333;color:#fff;padding:8px 14px;border-radius:6px;display:none}
small{color:#888}
</style></head><body>
<header>🐒 DeckPet 控制台 <a href="/logs" style="font-size:13px;margin-left:12px">会话过程日志 →</a></header>
<main>
<div class="card"><h3>① 上传照片 → 生成桌宠</h3>
<input type="file" id="photo" accept="image/*">
<div class="row" style="margin-top:8px"><select id="upmode" style="padding:6px"></select><button onclick="upload()">开始生成</button></div>
<small>自动抠图 + 生成爬行/悬挂/口型全套动作帧（配了图像 Key 走 AI 姿态重绘）。选"替换形象"则不新增宠物，只换皮并即时刷新。</small></div>

<div class="card"><h3>② 密钥配置（DPAPI 加密存储）</h3>
<label>图像生成 API Key（火山方舟 ARK_API_KEY，用于 AI 姿态素材）</label>
<input type="password" id="imgkey" placeholder="留空不修改"><button onclick="saveImgKey()">保存</button>
<label>聊天后端 API Key（仅 openai-http 类型后端需要；kimi acp 本机登录无需 key）</label>
<input type="text" id="bburl" placeholder="Base URL，如 https://api.deepseek.com/v1">
<input type="text" id="bbmodel" placeholder="模型名，如 deepseek-chat" style="margin-top:6px">
<input type="password" id="bbkey" placeholder="API Key" style="margin-top:6px"><button onclick="addBackend()">添加后端</button></div>

<div class="card"><h3>③ 角色</h3><div id="chars">加载中…</div></div>

<div class="card"><h3>④ 循环任务 / 提醒</h3>
<small>到点桌宠气泡弹出提醒。按分类可整类关闭（如"日常"、"会议"）。</small>
<div id="cats"></div>
<div id="reminders">加载中…</div>
<div style="border-top:1px solid #eee;margin-top:10px;padding-top:10px">
<label>新提醒</label>
<input type="text" id="rtitle" placeholder="内容，如：下午三点开周会">
<div class="row"><input type="text" id="rtime" placeholder="时间 HH:MM" style="width:110px">
<input type="text" id="rcat" placeholder="分类，如：会议" style="width:140px">
<button onclick="addReminder()">添加</button></div></div></div>
</main>
<div id="flash"></div>
<script>
const $=id=>document.getElementById(id);
function flash(t){const f=$('flash');f.textContent=t;f.style.display='block';setTimeout(()=>f.style.display='none',3000)}
async function api(p,opts){const r=await fetch('/api/'+p,opts);const j=await r.json();if(!j.ok)throw new Error(j.error||'失败');return j}
async function load(){
  const s=await api('state');
  // 上传模式选择：新角色 / 替换某角色形象
  $('upmode').innerHTML='<option value="">导入为新角色</option>'+
    s.characters.map(c=>\`<option value="\${c.id}">替换「\${c.name}」的形象</option>\`).join('');
  $('chars').innerHTML=s.characters.map(c=>\`<div class="char"><b>\${c.name}</b> <small>\${c.id}</small>
    <label>昵称（自称也用这个名字）</label><input type="text" id="nm-\${c.id}" value="\${c.name.replace(/"/g,'&quot;')}">
    <label>单击台词</label><input type="text" id="la-\${c.id}" value="\${c.lineA.replace(/"/g,'&quot;')}">
    <label>形象要求 prompt（改完点重新生成）</label><textarea id="ap-\${c.id}">\${c.appearanceRequest||''}</textarea>
    <div class="row"><button onclick="saveChar('\${c.id}')">保存</button>
    <button class="ghost" onclick="regen('\${c.id}')">重新生成素材</button></div>
    <label>当前形象另存为（起个昵称，以后随时切回）</label>
    <div class="row"><input type="text" id="sn-\${c.id}" placeholder="版本昵称，如：初版小黄" style="flex:1">
    <button class="ghost" onclick="saveAs('\${c.id}')">另存为</button></div>
    <label>历史形象（随时切回，不重新生成）</label>
    <div class="row"><select id="his-\${c.id}" style="padding:6px;flex:1"></select>
    <button class="ghost" onclick="switchHis('\${c.id}')">切换</button>
    <button class="ghost" onclick="delHis('\${c.id}')">删除</button></div></div>\`).join('')||'还没有角色，先上传照片';
  s.characters.forEach(async c=>{
    const h=await api('sprite-history?charId='+c.id);
    const sel=$('his-'+c.id);
    if(sel) sel.innerHTML=\`<option value="">当前（\${c.spriteDir.split('/').pop()}）</option>\`+
      h.versions.map(v=>\`<option value="\${v.rel}">\${v.label?v.label+' · ':''}\${v.generatedAt.slice(0,19).replace('T',' ')}（\${v.source}）</option>\`).join('');
  });
  // 循环任务：分类总开关 + 单任务开关
  const cats=[...new Set(s.reminders.map(r=>r.category))];
  $('cats').innerHTML=cats.map(cat=>{
    const off=s.disabledReminderCategories.includes(cat);
    return \`<label style="display:inline-flex;margin-right:14px"><input type="checkbox" \${off?'':'checked'} onchange="toggleCat('\${cat}',this.checked)" style="width:auto"> 分类「\${cat}」\${off?'（已关闭）':''}</label>\`;
  }).join('');
  $('reminders').innerHTML=s.reminders.map(r=>\`<div class="row" style="border-top:1px solid #f0f0f0;padding:6px 0">
    <input type="checkbox" \${r.enabled?'checked':''} onchange="toggleRem('\${r.id}',this.checked)" style="width:auto">
    <b>\${r.time}</b> <span>\${r.title}</span> <small>[\${r.category}]</small>
    <button class="ghost" onclick="delRem('\${r.id}')" style="margin:0;padding:2px 8px">删</button></div>\`).join('')||'暂无提醒任务';
}
async function addReminder(){const t=$('rtitle').value.trim(),time=$('rtime').value.trim(),cat=$('rcat').value.trim()||'日常';
  if(!t||!/^\\d{2}:\\d{2}$/.test(time))return flash('需要内容和时间 HH:MM');
  await api('reminder',{method:'POST',body:JSON.stringify({title:t,time,category:cat})});
  $('rtitle').value='';flash('已添加');load()}
async function toggleRem(id,enabled){await api('reminder-toggle',{method:'POST',body:JSON.stringify({id,enabled})});load()}
async function delRem(id){await api('reminder-delete',{method:'POST',body:JSON.stringify({id})});load()}
async function toggleCat(category,on){await api('reminder-category',{method:'POST',body:JSON.stringify({category,enabled:on})});load()}
async function upload(){
  const f=$('photo').files[0];if(!f)return flash('先选照片');
  const mode=$('upmode').value;
  flash(mode?'替换形象生成中（一两分钟）…':'上传并生成中（一两分钟）…');
  const r=await fetch('/api/upload?name='+encodeURIComponent(f.name)+(mode?'&replace='+encodeURIComponent(mode):''),{method:'POST',body:f});
  const j=await r.json();flash(j.ok?(mode?'形象已替换并刷新':'已生成新角色'):'失败：'+j.error);load();
}
async function saveImgKey(){const k=$('imgkey').value.trim();if(!k)return flash('请输入 key');
  await api('image-key',{method:'POST',body:JSON.stringify({key:k})});$('imgkey').value='';flash('已加密保存')}
async function addBackend(){try{await api('backend',{method:'POST',body:JSON.stringify({baseUrl:$('bburl').value,model:$('bbmodel').value,apiKey:$('bbkey').value})});
  flash('后端已添加')}catch(e){flash(String(e.message||e))}}
async function saveChar(id){await api('character',{method:'POST',body:JSON.stringify({id,name:$('nm-'+id).value,lineA:$('la-'+id).value,appearanceRequest:$('ap-'+id).value})});flash('已保存')}
async function saveAs(id){const label=$('sn-'+id).value.trim();if(!label)return flash('先起个昵称');
  await api('sprite-save-as',{method:'POST',body:JSON.stringify({charId:id,label})});$('sn-'+id).value='';flash('已另存为「'+label+'」');load()}
async function regen(id){await saveChar(id);flash('重新生成中（AI 出图约一两分钟）…');
  const j=await api('regenerate',{method:'POST',body:JSON.stringify({charId:id})});flash(j.ok?'已重新生成':'失败：'+j.error)}
async function switchHis(id){const rel=$('his-'+id).value;if(!rel)return flash('先选一个历史版本');
  await api('sprite-switch',{method:'POST',body:JSON.stringify({charId:id,rel})});flash('已切换历史形象');load()}
async function delHis(id){const rel=$('his-'+id).value;if(!rel)return flash('先选一个历史版本');
  if(!confirm('确定删除该历史形象？文件将从磁盘移除，不可恢复。'))return;
  await api('sprite-delete',{method:'POST',body:JSON.stringify({charId:id,rel})});flash('已删除该历史形象');load()}
load();
</script></body></html>`;

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function startWebConsole(
  store: SettingsStore,
  keystore: KeyStore,
  logger: Logger,
  port = 17890,
): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const json = (data: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      };
      try {
        if (req.method === 'GET' && url.pathname.startsWith('/logs')) {
          if (handleLogs(url, store, res)) return;
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(PAGE);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const s = store.load();
          json({
            ok: true,
            characters: s.characters,
            backends: s.backends.map((b) => ({ ...b, apiKeyRef: undefined })),
            hasImageKey: !!(await keystore.getSecret('image-api')),
            reminders: s.reminders,
            disabledReminderCategories: s.disabledReminderCategories,
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/sprite-history') {
          const charId = url.searchParams.get('charId') ?? '';
          json({ ok: true, versions: listSpriteArchive(charId) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/sprite-save-as') {
          const { charId, label } = JSON.parse((await readBody(req)).toString('utf-8')) as {
            charId: string;
            label: string;
          };
          const c = store.load().characters.find((x) => x.id === charId);
          if (!c) throw new Error('角色不存在');
          saveSpriteAs(resolveSpriteDir(c), charId, label, logger);
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/sprite-switch') {
          const { charId, rel } = JSON.parse((await readBody(req)).toString('utf-8')) as {
            charId: string;
            rel: string;
          };
          switchSprite(store, charId, rel);
          notifyCharactersChanged(store, [charId]); // 热换皮
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/sprite-delete') {
          const { charId, rel } = JSON.parse((await readBody(req)).toString('utf-8')) as {
            charId: string;
            rel: string;
          };
          deleteSpriteArchive(store, charId, rel);
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reminder') {
          const body = JSON.parse((await readBody(req)).toString('utf-8')) as {
            id?: string; title?: string; time?: string; category?: string;
          };
          if (!body.title?.trim() || !/^\d{2}:\d{2}$/.test(body.time ?? '')) {
            throw new Error('需要 title 和 HH:MM 格式时间');
          }
          const s = store.load();
          if (body.id) {
            const t = s.reminders.find((x) => x.id === body.id);
            if (t) { t.title = body.title.trim(); t.time = body.time!; t.category = body.category ?? t.category; }
          } else {
            s.reminders.push({
              id: `rem-${Date.now().toString(36)}`,
              title: body.title.trim(),
              time: body.time!,
              category: body.category?.trim() || '日常',
              enabled: true,
            });
          }
          store.save(s);
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reminder-toggle') {
          const { id, enabled } = JSON.parse((await readBody(req)).toString('utf-8')) as { id: string; enabled: boolean };
          const s = store.load();
          const t = s.reminders.find((x) => x.id === id);
          if (!t) throw new Error('任务不存在');
          t.enabled = !!enabled;
          store.save(s);
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reminder-delete') {
          const { id } = JSON.parse((await readBody(req)).toString('utf-8')) as { id: string };
          const s = store.load();
          s.reminders = s.reminders.filter((x) => x.id !== id);
          store.save(s);
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reminder-category') {
          const { category, enabled } = JSON.parse((await readBody(req)).toString('utf-8')) as { category: string; enabled: boolean };
          const s = store.load();
          const set = new Set(s.disabledReminderCategories);
          if (enabled) set.delete(category);
          else set.add(category);
          s.disabledReminderCategories = [...set];
          store.save(s);
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/image-key') {
          const { key } = JSON.parse((await readBody(req)).toString('utf-8')) as { key: string };
          if (!key?.trim()) throw new Error('key 为空');
          await keystore.setSecret('image-api', key.trim());
          process.env.DECKPET_IMAGE_API_KEY = key.trim();
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/backend') {
          const body = JSON.parse((await readBody(req)).toString('utf-8')) as {
            baseUrl?: string;
            model?: string;
            apiKey?: string;
          };
          if (!body.baseUrl || !body.model) throw new Error('需要 baseUrl 和 model');
          const s = store.load();
          const id = `openai-http-${Date.now().toString(36)}`;
          if (body.apiKey?.trim()) {
            await keystore.setSecret(`backend:${id}`, body.apiKey.trim());
          }
          s.backends.push({
            id,
            name: body.baseUrl.replace(/^https?:\/\//, '').split('/')[0],
            type: 'openai-http',
            baseUrl: body.baseUrl.trim(),
            model: body.model.trim(),
            apiKeyRef: body.apiKey?.trim() ? `backend:${id}` : undefined,
          });
          if (!s.defaultBackendId) s.defaultBackendId = id;
          store.save(s);
          json({ ok: true, id });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/character') {
          const body = JSON.parse((await readBody(req)).toString('utf-8')) as {
            id: string;
            name?: string;
            lineA?: string;
            appearanceRequest?: string;
          };
          const s = store.load();
          const c = s.characters.find((x) => x.id === body.id);
          if (!c) throw new Error('角色不存在');
          if (body.name !== undefined && body.name.trim()) c.name = body.name.trim();
          if (body.lineA !== undefined) c.lineA = body.lineA;
          if (body.appearanceRequest !== undefined) c.appearanceRequest = body.appearanceRequest;
          store.save(s);
          notifyCharactersChanged(store);
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/regenerate') {
          const { charId } = JSON.parse((await readBody(req)).toString('utf-8')) as { charId: string };
          await regenerateSprite(store, charId, logger);
          notifyCharactersChanged(store, [charId]);
          json({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/upload') {
          const name = (url.searchParams.get('name') ?? 'photo.png').replace(/[\\/:*?"<>|]/g, '_');
          const replaceId = url.searchParams.get('replace') ?? undefined;
          const buf = await readBody(req);
          if (!buf.length) throw new Error('空文件');
          const tmp = path.join(os.tmpdir(), `deckpet-upload-${Date.now()}-${name}`);
          fs.writeFileSync(tmp, buf);
          const chars = await importPhoto(store, logger, tmp, replaceId);
          // 替换模式：强制重载该角色素材（热换皮）
          notifyCharactersChanged(store, replaceId ? [replaceId] : []);
          json({ ok: true, characters: chars });
          return;
        }
        json({ ok: false, error: 'not found' }, 404);
      } catch (err) {
        json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
      }
    })();
  });

  // 端口被占则递增重试
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && port < 17900) {
      logger('warn', `web 控制台端口 ${port} 被占，试 ${port + 1}`);
      startWebConsole(store, keystore, logger, port + 1);
    } else {
      logger('error', `web 控制台启动失败: ${String(err)}`);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    logger('info', `web 控制台: http://127.0.0.1:${port}`);
    console.log(`[deckpet] Web 控制台: http://127.0.0.1:${port}`);
  });
  return server;
}
