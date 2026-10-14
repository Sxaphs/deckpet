/**
 * 设置页（原生 DOM，无框架）。
 * 左侧导航：角色 / 后端 / 全局。全部样式在此注入 <style>，
 * index.html 只留 <div id="app"></div><script src="bundle.js"></script>。
 * 数据全部经 window.deckpet（PreloadApi）走 IPC，不直接碰配置文件。
 */
import type {
  AppSettings,
  BackendConfig,
  CharacterConfig,
  PermissionMode,
} from '../../core/types.js';
import '../../core/ipc-contract.js'; // 仅为引入 window.deckpet 的全局类型声明

// ─────────────────────────── 样式 ───────────────────────────

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #ddd; background: #1e1f24;
}
#app { display: flex; flex-direction: column; height: 100vh; }
.topbar {
  padding: 8px 14px; font-size: 12px; color: #9aa0aa;
  background: #26272c; border-bottom: 1px solid #33343a;
}
.layout { display: flex; flex: 1; min-height: 0; }
nav {
  width: 120px; padding: 12px 8px; background: #232428;
  border-right: 1px solid #33343a; display: flex; flex-direction: column; gap: 4px;
}
nav button {
  text-align: left; padding: 8px 10px; border: 0; border-radius: 6px;
  background: transparent; color: #ccc; cursor: pointer; font-size: 13px;
}
nav button:hover { background: #2e2f35; }
nav button.active { background: #34518a; color: #fff; }
main { flex: 1; overflow-y: auto; padding: 16px 20px; }
h2 { margin: 0 0 12px; font-size: 16px; }
.card {
  background: #26272c; border: 1px solid #33343a; border-radius: 8px;
  padding: 12px 14px; margin-bottom: 12px;
}
.card h3 { margin: 0 0 8px; font-size: 14px; }
.row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.row label { width: 96px; flex: none; color: #9aa0aa; }
.row.grow label { align-self: flex-start; padding-top: 4px; }
input[type=text], input[type=password], input[type=number], select, textarea {
  flex: 1; min-width: 0; padding: 5px 8px; border-radius: 5px;
  border: 1px solid #3a3b42; background: #1b1c20; color: #ddd; font: inherit;
}
textarea { resize: vertical; min-height: 56px; font-family: inherit; }
input[type=number] { max-width: 90px; flex: none; }
input[type=checkbox] { width: 15px; height: 15px; }
button.btn {
  padding: 6px 12px; border: 1px solid #3a3b42; border-radius: 6px;
  background: #2e2f35; color: #ddd; cursor: pointer; font-size: 12px;
}
button.btn:hover { background: #383941; }
button.btn.primary { background: #34518a; border-color: #34518a; color: #fff; }
button.btn.primary:hover { background: #3d5da0; }
button.btn.danger { color: #e57373; }
button.btn:disabled { opacity: .5; cursor: default; }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.hint { font-size: 12px; color: #8a8f98; }
.badge {
  font-size: 11px; color: #7ec88a; border: 1px solid #3c5a42;
  border-radius: 4px; padding: 1px 6px; margin-left: 6px;
}
.msg { padding: 6px 10px; border-radius: 6px; margin-bottom: 10px; font-size: 12px; }
.msg.ok { background: #20361f; color: #8fd694; }
.msg.err { background: #3a2226; color: #ef9a9a; }
.list-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-radius: 6px; cursor: pointer;
}
.list-item:hover { background: #2e2f35; }
.list-item.selected { background: #34518a; color: #fff; }
.split { display: flex; gap: 14px; }
.split .side { width: 200px; flex: none; }
.split .form { flex: 1; min-width: 0; }
`;

// ─────────────────────────── 小工具 ───────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 带 label 的表单行 */
function field(labelText: string, input: HTMLElement): HTMLElement {
  const row = el('div', 'row');
  row.append(el('label', '', labelText), input);
  return row;
}

function textInput(value: string, placeholder = ''): HTMLInputElement {
  const i = el('input');
  i.type = 'text';
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

function numberInput(value: number): HTMLInputElement {
  const i = el('input');
  i.type = 'number';
  i.min = '0';
  i.value = String(value);
  return i;
}

function checkbox(checked: boolean): HTMLInputElement {
  const i = el('input');
  i.type = 'checkbox';
  i.checked = checked;
  return i;
}

function textarea(value: string, placeholder = ''): HTMLTextAreaElement {
  const t = el('textarea');
  t.value = value;
  t.placeholder = placeholder;
  return t;
}

function select(options: Array<{ value: string; label: string }>, current: string): HTMLSelectElement {
  const s = el('select');
  for (const o of options) {
    const opt = el('option', '', o.label);
    opt.value = o.value;
    s.append(opt);
  }
  s.value = current;
  return s;
}

function btn(label: string, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

/** 生成简易唯一 id（本机配置用，无需强随机） */
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const api = () => window.deckpet;

// ─────────────────────────── 页面骨架 ───────────────────────────

type PageKey = 'characters' | 'backends' | 'global';

const root = document.getElementById('app')!;
const style = el('style');
style.textContent = CSS;
document.head.append(style);

const topbar = el('div', 'topbar', '密钥经 Windows DPAPI 加密存储，不写入配置文件。');
const layout = el('div', 'layout');
const nav = el('nav');
const main = el('main');
layout.append(nav, main);
root.append(topbar, layout);

let currentPage: PageKey = 'characters';
/** 顶部消息条（ok/err），渲染到 main 顶部 */
let flash: { kind: 'ok' | 'err'; text: string } | null = null;

function setFlash(kind: 'ok' | 'err', text: string) {
  flash = { kind, text };
}

const PAGES: Array<{ key: PageKey; label: string }> = [
  { key: 'characters', label: '角色' },
  { key: 'backends', label: '后端' },
  { key: 'global', label: '全局' },
];

function renderNav() {
  nav.textContent = '';
  for (const p of PAGES) {
    const b = btn(p.label, currentPage === p.key ? 'active' : '');
    b.onclick = () => {
      currentPage = p.key;
      flash = null;
      void render();
    };
    nav.append(b);
  }
}

async function render() {
  renderNav();
  main.textContent = '';
  if (flash) main.append(el('div', `msg ${flash.kind}`, flash.text));
  flash = null;
  try {
    if (currentPage === 'characters') await renderCharacters(main);
    else if (currentPage === 'backends') await renderBackends(main);
    else await renderGlobal(main);
  } catch (err) {
    main.append(el('div', 'msg err', `加载失败：${String(err)}`));
  }
}

// ─────────────────────────── 角色页 ───────────────────────────

/** 角色权限模式下拉：继承全局 / 只读 / 每步询问 / 自动执行 */
const CHAR_PERM_OPTIONS = [
  { value: '', label: '继承全局' },
  { value: 'readonly', label: '只读' },
  { value: 'ask', label: '每步询问' },
  { value: 'auto', label: '自动执行' },
];

async function renderCharacters(host: HTMLElement) {
  host.append(el('h2', '', '角色'));

  const importBtn = btn('导入照片', 'btn primary');
  importBtn.onclick = async () => {
    importBtn.disabled = true;
    importBtn.textContent = '导入中（抠图+占位素材）…';
    try {
      // importPhoto 弹文件对话框→抠图→占位素材，返回最新角色列表
      await api().importPhoto();
      setFlash('ok', '导入完成。');
    } catch (err) {
      setFlash('err', `导入失败：${String(err)}`);
    } finally {
      await render();
    }
  };
  host.append(importBtn, el('p', 'hint', '「导入照片」会新增一个角色；想换掉现有桌宠的形象，用下方角色卡片里的「上传照片替换形象」。'));

  const [characters, backends] = await Promise.all([api().listCharacters(), api().listBackends()]);
  if (characters.length === 0) {
    host.append(el('p', 'hint', '还没有角色，点击「导入照片」创建第一个。'));
    return;
  }

  for (const c of characters) {
    host.append(characterCard(c, backends));
  }
}

function characterCard(c: CharacterConfig, backends: BackendConfig[]): HTMLElement {
  // 编辑副本：保存前不动原始对象
  const draft: CharacterConfig = structuredClone(c);

  const card = el('div', 'card');
  card.append(el('h3', '', c.name || c.id));

  const nameIn = textInput(draft.name, '角色名称');
  const lineAIn = textInput(draft.lineA, '单击台词 A');
  const appearanceIn = textInput(draft.appearanceRequest, '形象要求（融入素材生成提示词）');
  const personaIn = textarea(draft.persona, '人设提示词（多行）');

  const backendSel = select(
    [
      { value: '', label: '全局默认' },
      ...backends.map((b) => ({ value: b.id, label: b.name || b.id })),
    ],
    draft.backendId ?? '',
  );

  const permSel = select(CHAR_PERM_OPTIONS, draft.permission?.mode ?? '');

  const regenBtn = btn('重新生成素材');
  regenBtn.onclick = async () => {
    regenBtn.disabled = true;
    regenBtn.textContent = '生成中…';
    try {
      // 先保存 appearanceRequest，再按其重新生成素材
      collect();
      await api().upsertCharacter(draft);
      await api().regenerateSprite(c.id);
      setFlash('ok', `「${draft.name}」素材已重新生成。`);
    } catch (err) {
      setFlash('err', `重新生成失败：${String(err)}`);
    } finally {
      await render();
    }
  };

  const appearanceRow = field('形象要求', appearanceIn);
  appearanceRow.append(regenBtn);

  const saveBtn = btn('保存', 'btn primary');
  const replaceBtn = btn('上传照片替换形象');
  const delBtn = btn('删除', 'btn danger');

  function collect() {
    draft.name = nameIn.value.trim();
    draft.lineA = lineAIn.value;
    draft.appearanceRequest = appearanceIn.value;
    draft.persona = personaIn.value;
    draft.backendId = backendSel.value || null;
    // 权限模式：继承全局 = 不写 mode
    const perm = { ...(draft.permission ?? {}) };
    if (permSel.value === '') delete perm.mode;
    else perm.mode = permSel.value as PermissionMode;
    draft.permission = Object.keys(perm).length > 0 ? perm : undefined;
  }

  saveBtn.onclick = async () => {
    collect();
    try {
      await api().upsertCharacter(draft);
      setFlash('ok', `「${draft.name}」已保存。`);
    } catch (err) {
      setFlash('err', `保存失败：${String(err)}`);
    }
    await render();
  };

  replaceBtn.onclick = async () => {
    replaceBtn.disabled = true;
    replaceBtn.textContent = '替换中（抠图+全套素材）…';
    try {
      // 先落外观要求，再按当前角色替换素材（不会新增第二个桌宠）
      collect();
      await api().upsertCharacter(draft);
      await api().importPhoto(c.id);
      setFlash('ok', `「${draft.name}」形象已替换。`);
    } catch (err) {
      setFlash('err', `替换失败：${String(err)}`);
    } finally {
      await render();
    }
  };

  delBtn.onclick = async () => {
    if (!confirm(`确定删除角色「${c.name}」？素材目录不删除，可手动清理。`)) return;
    try {
      await api().removeCharacter(c.id);
      setFlash('ok', `「${c.name}」已删除。`);
    } catch (err) {
      setFlash('err', `删除失败：${String(err)}`);
    }
    await render();
  };

  card.append(
    field('名称', nameIn),
    field('台词 A', lineAIn),
    appearanceRow,
    field('绑定后端', backendSel),
    field('人设', personaIn),
    field('权限模式', permSel),
  );
  const actions = el('div', 'actions');
  actions.append(saveBtn, replaceBtn, delBtn);
  card.append(actions);
  return card;
}

// ─────────────────────────── 后端页 ───────────────────────────

const BACKEND_TYPES = [
  { value: 'acp', label: 'Kimi Code CLI 等 ACP agent' },
  { value: 'dsh', label: 'DeepSeek Harness' },
  { value: 'openai-http', label: '自定义 OpenAI 兼容接口' },
];

async function renderBackends(host: HTMLElement) {
  host.append(el('h2', '', '后端'));

  const [backends, settings] = await Promise.all([api().listBackends(), api().getSettings()]);

  const split = el('div', 'split');
  const side = el('div', 'side');
  const formHost = el('div', 'form');
  split.append(side, formHost);
  host.append(split);

  let selectedId: string | null = backends[0]?.id ?? null;

  const addBtn = btn('新增后端', 'btn primary');
  side.append(addBtn);
  const listBox = el('div');
  side.append(listBox);

  function renderList() {
    listBox.textContent = '';
    for (const b of backends) {
      const item = el('div', `list-item${b.id === selectedId ? ' selected' : ''}`);
      item.append(el('span', '', b.name || b.id));
      if (b.id === settings.defaultBackendId) item.append(el('span', 'badge', '全局默认'));
      item.onclick = () => {
        selectedId = b.id;
        renderList();
        renderForm();
      };
      listBox.append(item);
    }
  }

  function renderForm() {
    formHost.textContent = '';
    const editing = backends.find((b) => b.id === selectedId) ?? null;
    formHost.append(backendForm(editing, settings.defaultBackendId, async (msg, isErr) => {
      setFlash(isErr ? 'err' : 'ok', msg);
      await render();
    }));
  }

  addBtn.onclick = () => {
    selectedId = null;
    renderList();
    renderForm();
  };

  renderList();
  renderForm();
}

function backendForm(
  editing: BackendConfig | null,
  defaultBackendId: string | null,
  done: (msg: string, isErr: boolean) => void,
): HTMLElement {
  // 新增时给一组合理默认：acp 类型 + kimi acp
  const draft: BackendConfig = editing
    ? structuredClone(editing)
    : { id: newId('backend'), name: '', type: 'acp', command: 'kimi', args: ['acp'] };

  const card = el('div', 'card');
  card.append(el('h3', '', editing ? `编辑：${editing.name || editing.id}` : '新增后端'));

  const nameIn = textInput(draft.name, '显示名称');
  const typeSel = select(BACKEND_TYPES, draft.type || 'acp');
  const commandIn = textInput(draft.command ?? 'kimi', '子进程命令，如 kimi');
  const argsIn = textInput((draft.args ?? ['acp']).join(' '), '参数，空格分隔，如 acp');
  const baseUrlIn = textInput(draft.baseUrl ?? '', 'https://api.deepseek.com/v1');
  const modelIn = textInput(draft.model ?? '', '模型名，如 deepseek-chat');
  const keyIn = el('input');
  keyIn.type = 'password';
  // 已保存过 key 时提示覆盖语义；key 本体不会回传到 renderer
  keyIn.placeholder = draft.apiKeyRef ? '已保存（输入以覆盖）' : 'API Key';
  const dshVersionIn = textInput(draft.dshVersion ?? '', '锁定的 harness 版本，如 0.3.0');

  const cmdRow = field('命令', commandIn);
  const argsRow = field('参数', argsIn);
  const baseUrlRow = field('Base URL', baseUrlIn);
  const modelRow = field('模型', modelIn);
  const dshRow = field('dsh 版本', dshVersionIn);

  function syncVisibility() {
    const t = typeSel.value;
    cmdRow.style.display = t === 'acp' || t === 'dsh' ? '' : 'none';
    argsRow.style.display = t === 'acp' || t === 'dsh' ? '' : 'none';
    baseUrlRow.style.display = t === 'openai-http' ? '' : 'none';
    modelRow.style.display = t === 'openai-http' ? '' : 'none';
    dshRow.style.display = t === 'dsh' ? '' : 'none';
  }
  typeSel.onchange = syncVisibility;

  card.append(field('名称', nameIn), field('类型', typeSel), cmdRow, argsRow, baseUrlRow, modelRow, field('API Key', keyIn), dshRow);
  syncVisibility();

  const testResult = el('div', 'hint');
  const saveBtn = btn('保存', 'btn primary');
  const testBtn = btn('测试连接');
  const defaultBtn = btn('设为全局默认');
  const delBtn = btn('删除', 'btn danger');

  // 测试连接针对已保存的后端（主进程按 id 取配置与密钥）
  testBtn.disabled = !editing;
  if (!editing) testBtn.title = '请先保存，再测试连接';

  function collect(): { backend: BackendConfig; apiKey?: string } {
    draft.name = nameIn.value.trim();
    draft.type = typeSel.value;
    if (draft.type === 'acp' || draft.type === 'dsh') {
      draft.command = commandIn.value.trim() || 'kimi';
      draft.args = argsIn.value.trim() ? argsIn.value.trim().split(/\s+/) : ['acp'];
    } else {
      delete draft.command;
      delete draft.args;
    }
    if (draft.type === 'openai-http') {
      draft.baseUrl = baseUrlIn.value.trim();
      draft.model = modelIn.value.trim();
    } else {
      delete draft.baseUrl;
      delete draft.model;
    }
    if (draft.type === 'dsh') draft.dshVersion = dshVersionIn.value.trim() || undefined;
    else delete draft.dshVersion;
    const apiKey = keyIn.value.trim() || undefined; // 留空 = 不覆盖已保存的 key
    return { backend: draft, apiKey };
  }

  saveBtn.onclick = async () => {
    const { backend, apiKey } = collect();
    if (!backend.name) {
      done('名称不能为空。', true);
      return;
    }
    try {
      // apiKey 明文仅内存传递，主进程侧经 DPAPI 加密后落 keystore
      await api().addBackend(backend, apiKey);
      done(`后端「${backend.name}」已保存。`, false);
    } catch (err) {
      done(`保存失败：${String(err)}`, true);
    }
  };

  testBtn.onclick = async () => {
    if (!editing) return;
    testBtn.disabled = true;
    testResult.textContent = '测试中…';
    try {
      const r = await api().testBackend(editing.id);
      testResult.textContent = r.ok ? `连接正常${r.detail ? `：${r.detail}` : ''}` : `连接失败${r.detail ? `：${r.detail}` : ''}`;
      testResult.style.color = r.ok ? '#8fd694' : '#ef9a9a';
    } catch (err) {
      testResult.textContent = `测试出错：${String(err)}`;
      testResult.style.color = '#ef9a9a';
    } finally {
      testBtn.disabled = false;
    }
  };

  defaultBtn.disabled = !editing || editing.id === defaultBackendId;
  defaultBtn.onclick = async () => {
    if (!editing) return;
    try {
      const s = await api().getSettings();
      s.defaultBackendId = editing.id;
      await api().saveSettings(s);
      done(`已将「${editing.name}」设为全局默认后端。`, false);
    } catch (err) {
      done(`设置失败：${String(err)}`, true);
    }
  };

  delBtn.style.display = editing ? '' : 'none';
  delBtn.onclick = async () => {
    if (!editing) return;
    if (!confirm(`确定删除后端「${editing.name}」？`)) return;
    try {
      await api().removeBackend(editing.id);
      done(`后端「${editing.name}」已删除。`, false);
    } catch (err) {
      done(`删除失败：${String(err)}`, true);
    }
  };

  // 启动/停止：为绑定该后端的角色预建常驻会话（聊天零冷启动）
  const startBtn = btn('启动');
  const stopBtn = btn('停止');
  const statusText = el('span', '', '');
  startBtn.disabled = stopBtn.disabled = !editing;
  if (!editing) {
    startBtn.title = '请先保存，再启动';
    stopBtn.title = '请先保存，再启动';
  }

  async function refreshStatus(): Promise<void> {
    if (!editing) {
      statusText.textContent = '';
      return;
    }
    const { running } = await api().backendStatus(editing.id);
    statusText.textContent = running ? '● 运行中（会话常驻）' : '○ 未启动（首次聊天时才拉起）';
    statusText.style.color = running ? '#8fd694' : '#999';
  }
  void refreshStatus();

  startBtn.onclick = async () => {
    if (!editing) return;
    startBtn.disabled = true;
    testResult.textContent = '启动中（拉起后端进程并预建会话）…';
    testResult.style.color = '#999';
    try {
      const r = await api().startBackend(editing.id);
      testResult.textContent = r.ok ? `启动成功：${r.detail ?? ''}` : `启动失败：${r.detail ?? ''}`;
      testResult.style.color = r.ok ? '#8fd694' : '#ef9a9a';
    } catch (err) {
      testResult.textContent = `启动出错：${String(err)}`;
      testResult.style.color = '#ef9a9a';
    } finally {
      startBtn.disabled = false;
      void refreshStatus();
    }
  };
  stopBtn.onclick = async () => {
    if (!editing) return;
    await api().stopBackend(editing.id);
    testResult.textContent = '已停止，会话与后端进程已释放。';
    testResult.style.color = '#999';
    void refreshStatus();
  };

  const actions = el('div', 'actions');
  actions.append(saveBtn, testBtn, startBtn, stopBtn, defaultBtn, delBtn);
  card.append(actions, statusText, testResult);
  return card;
}

// ─────────────────────────── 全局页 ───────────────────────────

const GLOBAL_PERM_OPTIONS = [
  { value: 'readonly', label: '只读' },
  { value: 'ask', label: '每步询问' },
  { value: 'auto', label: '自动执行' },
];

async function renderGlobal(host: HTMLElement) {
  host.append(el('h2', '', '全局'));
  const settings = await api().getSettings();
  const draft: AppSettings = structuredClone(settings);

  const card = el('div', 'card');

  // 系统
  card.append(el('h3', '', '系统'));
  const autostartCb = checkbox(draft.autostart);
  autostartCb.onchange = async () => {
    draft.autostart = autostartCb.checked;
    try {
      // 开机自启走系统注册表，立即生效
      await api().setAutostart(autostartCb.checked);
    } catch (err) {
      autostartCb.checked = !autostartCb.checked;
      draft.autostart = autostartCb.checked;
      setFlash('err', `设置开机自启失败：${String(err)}`);
      await render();
    }
  };
  card.append(field('开机自启', autostartCb));

  // 协作与气泡
  card.append(el('h3', '', '协作与气泡'));
  const collabCb = checkbox(draft.collabEnabled);
  const foldCb = checkbox(draft.bubbleFold.enabled);
  const maxLinesIn = numberInput(draft.bubbleFold.maxLines);
  const maxCharsIn = numberInput(draft.bubbleFold.maxChars);
  card.append(
    field('协作模式', collabCb),
    field('气泡折叠', foldCb),
    field('折叠行数阈值', maxLinesIn),
    field('折叠字符阈值', maxCharsIn),
  );

  // 图像生成（素材管线用，Seedream/SeedEdit 等 OpenAI 兼容图生图服务）
  card.append(el('h3', '', '形象素材 AI 生成'));
  const imgKeyIn = document.createElement('input');
  imgKeyIn.type = 'password';
  imgKeyIn.placeholder = '已保存则显示 ••••（输入新值以覆盖）；留空 = AI 生成关闭，用抠图变换素材';
  imgKeyIn.className = 'input';
  const imgKeyBtn = btn('保存图像 Key', 'btn');
  imgKeyBtn.onclick = async () => {
    const v = imgKeyIn.value.trim();
    if (!v) return;
    try {
      await api().setImageApiKey(v);
      imgKeyIn.value = '';
      setFlash('ok', '图像 API Key 已加密保存（DPAPI），导入/重新生成素材时自动启用 AI 生成。');
    } catch (err) {
      setFlash('err', `保存失败：${String(err)}`);
    }
  };
  card.append(field('图像 API Key（火山方舟 ARK_API_KEY）', imgKeyIn), imgKeyBtn);

  // 权限
  card.append(el('h3', '', '权限（全局默认，角色可单独覆盖）'));
  const gp = draft.globalPermission;
  const modeSel = select(GLOBAL_PERM_OPTIONS, gp.mode);
  const allowedDirsIn = textarea(gp.allowedDirs.join('\n'), '目录白名单，每行一个绝对路径；留空 = 不限制');
  const blockedIn = textarea(gp.blockedCommands.join('\n'), '命令黑名单，每行一个子串（小写匹配）');
  const networkCb = checkbox(gp.networkEnabled);
  const hostsIn = textarea(gp.allowedLocalHosts.join('\n'), '内网/回环豁免名单，每行一个，如 localhost');
  card.append(
    field('权限模式', modeSel),
    field('目录白名单', allowedDirsIn),
    field('命令黑名单', blockedIn),
    field('允许联网', networkCb),
    field('网络豁免名单', hostsIn),
  );

  const saveBtn = btn('保存全局设置', 'btn primary');
  saveBtn.onclick = async () => {
    draft.collabEnabled = collabCb.checked;
    draft.bubbleFold = {
      enabled: foldCb.checked,
      maxLines: Math.max(0, Number(maxLinesIn.value) || 0),
      maxChars: Math.max(0, Number(maxCharsIn.value) || 0),
    };
    draft.autostart = autostartCb.checked;
    draft.globalPermission = {
      mode: modeSel.value as PermissionMode,
      allowedDirs: allowedDirsIn.value.split('\n').map((s) => s.trim()).filter(Boolean),
      blockedCommands: blockedIn.value.split('\n').map((s) => s.trim()).filter(Boolean),
      networkEnabled: networkCb.checked,
      allowedLocalHosts: hostsIn.value.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    try {
      await api().saveSettings(draft);
      setFlash('ok', '全局设置已保存。');
    } catch (err) {
      setFlash('err', `保存失败：${String(err)}`);
    }
    await render();
  };
  const actions = el('div', 'actions');
  actions.append(saveBtn);
  card.append(actions);
  host.append(card);
}

// ─────────────────────────── 启动 ───────────────────────────

void render();
