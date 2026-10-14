/**
 * 素材管线（Node 侧）：照片导入 → 抠图 → 占位素材 → 注册新角色。
 *
 * 外部脚本约定（由 pipeline 组实现，均不存在/失败则降级，不阻塞导入）：
 *   pipeline/cutout.py --input <照片> --out-dir <目录>
 *        —— 人像抠图（透明背景），产物 <目录>/cutout-1.png
 *   pipeline/placeholder_gen.py --char-id <id> --out <角色素材目录> [--name --appearance]
 *        —— 程序化生成全套动作占位帧并写 manifest.json（不依赖输入图）
 * Python 解释器探测顺序：pipeline/.venv/Scripts/python.exe → PATH 的 python。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { app, dialog } from 'electron';
import type { CharacterConfig } from '../core/types.js';
import type { SpriteAction, SpriteManifest } from '../core/sprite-contract.js';
import type { SettingsStore } from '../core/config/settings.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根（dist/main/main → 上三级）；打包后指向 asar 内（只读） */
const ROOT = path.resolve(__dirname, '../../..');
/**
 * 素材根目录：开发态 = 项目 assets/；打包后 = userData/assets（可写，
 * 导入照片/AI 生成的素材都落这里）。sprite:// 协议也映射到这里。
 */
export const ASSETS = app.isPackaged
  ? path.join(app.getPath('userData'), 'assets')
  : path.join(ROOT, 'assets');
/** pipeline 脚本目录：打包后随 asarUnpack 解压到 resources 下 */
const PIPELINE = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'pipeline')
  : path.join(ROOT, 'pipeline');
/** 预置小人素材（打包内置，免 Python 后备） */
const PRESETS = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'presets')
  : path.join(ROOT, 'assets', 'presets');

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

/** 把 spriteDirAbs 整套复制到 dest，并把昵称写进存档 manifest（列表展示用） */
function copySpriteVersion(spriteDirAbs: string, dest: string, label?: string): void {
  fs.cpSync(spriteDirAbs, dest, { recursive: true });
  if (!label) return;
  try {
    const mp = path.join(dest, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    m.label = label;
    fs.writeFileSync(mp, JSON.stringify(m, null, 2), 'utf-8');
  } catch { /* 昵称写不进就算了 */ }
}

/**
 * 形象版本存档：覆盖生成前把当前整套素材复制到 assets/sprites/_archive/<charId>/<ts>/。
 * force=true 时允许对存档目录本身再存一份（手动另存场景）。
 */
function archiveSprites(spriteDirAbs: string, charId: string, logger: Logger, label?: string, force = false): void {
  if (!force && spriteDirAbs.includes('_archive')) return; // 当前用的就是存档版，不再套娃存档
  const manifestPath = path.join(spriteDirAbs, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return; // 首次生成无存档必要
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(ASSETS, 'sprites', '_archive', charId, ts);
    copySpriteVersion(spriteDirAbs, dest, label);
    logger('info', `形象已存档: ${dest}`);
  } catch (err) {
    logger('warn', `形象存档失败（不阻塞生成）: ${String(err)}`);
  }
}

/** 手动另存当前形象为命名版本（不重新生成） */
export function saveSpriteAs(spriteDirAbs: string, charId: string, label: string, logger: Logger): void {
  if (!label.trim()) throw new Error('昵称不能为空');
  if (spriteDirAbs.includes('_archive') && !fs.existsSync(path.join(spriteDirAbs, 'manifest.json'))) {
    throw new Error('当前形象没有素材可存');
  }
  archiveSprites(spriteDirAbs, charId, logger, label.trim(), true);
}

/** spriteDir 绝对化：相对路径按素材基准（开发态=项目根，打包后=userData）解析 */
export function resolveSpriteDir(c: CharacterConfig): string {
  return path.isAbsolute(c.spriteDir) ? c.spriteDir : path.join(ASSETS, '..', c.spriteDir);
}

/** 把内置奶龙预置包复制为某角色的素材目录，返回相对 spriteDir；预置缺失返回 null */
function materializeNailong(charId: string): string | null {
  const preset = path.join(PRESETS, 'nailong');
  if (!fs.existsSync(path.join(preset, 'manifest.json'))) return null;
  const spriteDirAbs = path.join(ASSETS, 'sprites', charId);
  fs.rmSync(spriteDirAbs, { recursive: true, force: true });
  fs.mkdirSync(spriteDirAbs, { recursive: true });
  fs.cpSync(preset, spriteDirAbs, { recursive: true });
  try {
    const mp = path.join(spriteDirAbs, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as SpriteManifest;
    m.characterId = charId;
    m.generatedAt = new Date().toISOString();
    fs.writeFileSync(mp, JSON.stringify(m, null, 2), 'utf-8');
  } catch { /* 有帧就行 */ }
  return `assets/sprites/${charId}`;
}

/**
 * 首开默认角色：没有任何角色时，把内置奶龙预置包复制为 char-1，
 * 让用户开箱即有一只桌宠（Agent 后端仍需在设置页配置）。
 */
export function ensureDefaultCharacter(store: SettingsStore, logger: Logger): void {
  if (store.load().characters.length > 0) return;
  const rel = materializeNailong('char-1');
  if (!rel) return;
  const s = store.load();
  s.characters.push({
    id: 'char-1',
    name: '奶龙',
    spriteDir: rel,
    lineA: '爸爸',
    appearanceRequest: '',
    backendId: null,
    persona: '',
  });
  store.save(s);
  logger('info', '已创建默认角色「奶龙」（内置预置素材）');
}

/**
 * 启动完整性兜底：角色的素材目录丢了（比如设置是从开发环境带来的、
 * 相对 spriteDir 在打包版 userData 下不存在）时回退为内置奶龙，
 * 避免桌面上出现火柴人占位。
 */
export function ensureSpritesIntact(store: SettingsStore, logger: Logger): void {
  const s = store.load();
  let changed = false;
  for (const c of s.characters) {
    if (fs.existsSync(path.join(resolveSpriteDir(c), 'manifest.json'))) continue;
    const rel = materializeNailong(c.id);
    if (!rel) return;
    logger('warn', `角色「${c.name}」素材缺失（原 ${c.spriteDir}），已回退为内置奶龙形象`);
    c.spriteDir = rel;
    changed = true;
  }
  if (changed) store.save(s);
}

/** 列出某角色的历史形象版本（新到旧） */
export function listSpriteArchive(charId: string): Array<{ rel: string; generatedAt: string; source: string; label?: string }> {
  const dir = path.join(ASSETS, 'sprites', '_archive', charId);
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ rel: string; generatedAt: string; source: string; label?: string }> = [];
  for (const sub of fs.readdirSync(dir)) {
    const mp = path.join(dir, sub, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as { generatedAt?: string; source?: string; label?: string };
      out.push({
        rel: `_archive/${charId}/${sub}`,
        generatedAt: m.generatedAt ?? sub,
        source: m.source ?? 'unknown',
        label: m.label,
      });
    } catch {
      /* 跳过坏档 */
    }
  }
  return out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

/** 切换到历史形象：只改 spriteDir 指向存档目录（热刷新，不重新生成） */
export function switchSprite(
  store: SettingsStore,
  charId: string,
  archiveRel: string,
): void {
  const s = store.load();
  const c = s.characters.find((x) => x.id === charId);
  if (!c) throw new Error(`角色不存在: ${charId}`);
  const abs = path.join(ASSETS, 'sprites', archiveRel);
  if (!archiveRel.startsWith('_archive/') || !fs.existsSync(path.join(abs, 'manifest.json'))) {
    throw new Error(`历史形象不存在: ${archiveRel}`);
  }
  c.spriteDir = `assets/sprites/${archiveRel}`;
  store.save(s);
}

/** 删除历史形象版本（正在使用中的版本拒绝删除，先切换再删） */
export function deleteSpriteArchive(store: SettingsStore, charId: string, archiveRel: string): void {
  const c = store.load().characters.find((x) => x.id === charId);
  if (!c) throw new Error(`角色不存在: ${charId}`);
  if (!archiveRel.startsWith(`_archive/${charId}/`)) {
    throw new Error(`非法的历史版本路径: ${archiveRel}`);
  }
  if (c.spriteDir === `assets/sprites/${archiveRel}`) {
    throw new Error('该版本正在使用中，请先切换到其他形象再删除');
  }
  fs.rmSync(path.join(ASSETS, 'sprites', archiveRel), { recursive: true, force: true });
}

/** 占位清单需要覆盖的全部动作（均指向同一帧，保证 renderer 状态机查表不空） */
const ALL_ACTIONS: SpriteAction[] = [
  'crawl', 'climb', 'hang', 'roll', 'rest',
  'talk_open', 'talk_half', 'talk_closed',
  'wave', 'jump', 'sit_sad', 'think', 'scared', 'fall_sit', 'get_up',
];

/** 探测 python：优先 pipeline/.venv，其次 PATH */
function detectPython(): string {
  const venv = path.join(PIPELINE, '.venv', 'Scripts', 'python.exe');
  return fs.existsSync(venv) ? venv : 'python';
}

/** 调 pipeline 脚本；脚本不存在或执行失败返回 null（调用方自行降级） */
async function runPipelineScript(
  script: string,
  args: string[],
  logger: Logger,
): Promise<boolean> {
  const scriptPath = path.join(PIPELINE, script);
  if (!fs.existsSync(scriptPath)) {
    logger('warn', `pipeline 脚本不存在，跳过: ${script}`);
    return false;
  }
  try {
    await execFileP(detectPython(), [scriptPath, ...args], { timeout: 120_000 });
    return true;
  } catch (err) {
    logger('warn', `pipeline 脚本执行失败 ${script}: ${String(err)}`);
    return false;
  }
}

/** 免依赖读取 PNG 宽高（IHDR 固定在第 16~24 字节）；非 PNG/失败返回 null */
function pngSize(file: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.alloc(24);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/** 生成不冲突的角色 id：char-1、char-2 … */
function nextCharId(store: SettingsStore): string {
  const ids = new Set(store.load().characters.map((c) => c.id));
  let n = 1;
  while (ids.has(`char-${n}`)) n++;
  return `char-${n}`;
}

/**
 * 兜底素材：优先复制预置小人包（免 Python、免依赖，29 帧全套）；
 * 预置包缺失才退回"源图单帧"。
 */
function writeFallbackSprite(
  spriteDirAbs: string,
  srcImg: string,
  charId: string,
  appearanceRequest: string,
  source: string,
): void {
  // 按 charId 选个预置颜色（稳定不重样）
  const COLORS = ['yellow', 'blue', 'green', 'pink'];
  const hash = [...charId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const preset = path.join(PRESETS, COLORS[hash % COLORS.length]);
  if (fs.existsSync(path.join(preset, 'manifest.json'))) {
    fs.mkdirSync(spriteDirAbs, { recursive: true });
    fs.cpSync(preset, spriteDirAbs, { recursive: true });
    // manifest 归属改回当前角色
    try {
      const mp = path.join(spriteDirAbs, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as SpriteManifest;
      m.characterId = charId;
      m.source = 'preset';
      m.generatedAt = new Date().toISOString();
      if (appearanceRequest) m.appearanceRequest = appearanceRequest;
      fs.writeFileSync(mp, JSON.stringify(m, null, 2), 'utf-8');
    } catch { /* 有帧就行 */ }
    return;
  }

  // 预置包都没有 → 源图单帧兜底
  fs.mkdirSync(spriteDirAbs, { recursive: true });
  const ext = path.extname(srcImg).toLowerCase() || '.png';
  const frameFile = `idle${ext}`;
  try {
    fs.copyFileSync(srcImg, path.join(spriteDirAbs, frameFile));
  } catch {
    // 源图也没有：写个空 manifest，renderer 会画占位小人
  }
  const size = fs.existsSync(path.join(spriteDirAbs, frameFile))
    ? (pngSize(path.join(spriteDirAbs, frameFile)) ?? { width: 256, height: 256 })
    : { width: 256, height: 256 };
  const frame = { file: frameFile, ...size, durationMs: 200 };
  const frames: SpriteManifest['frames'] = {};
  for (const a of ALL_ACTIONS) frames[a] = [frame];
  const manifest: SpriteManifest = {
    characterId: charId,
    source,
    generatedAt: new Date().toISOString(),
    appearanceRequest: appearanceRequest || undefined,
    frames,
  };
  fs.writeFileSync(
    path.join(spriteDirAbs, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
}

/**
 * 由底图生成整套素材。优先级：
 * 1. 配置了 DECKPET_IMAGE_API_KEY 且有抠图 → 调 AI 图像编辑生成规范姿态图
 *    （dist/pipeline/gen_frames.js，内部再调 frame_post.py 抠图+变体）；
 * 2. placeholder_gen.py（抠图模式：--base-image 用真实形象变换出帧）；
 * 3. 脚本不可用时底图单帧兜底。
 */
async function genSpriteSet(
  spriteDirAbs: string,
  baseImg: string,
  charId: string,
  name: string,
  appearanceRequest: string,
  source: string,
  logger: Logger,
): Promise<void> {
  // 1. AI 生成（需 DECKPET_IMAGE_API_KEY 或设置页存的 key）
  const genScript = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'pipeline', 'gen_frames.js')
    : path.join(ROOT, 'dist', 'pipeline', 'gen_frames.js');
  if (source === 'cutout' && process.env.DECKPET_IMAGE_API_KEY && fs.existsSync(genScript)) {
    try {
      // ELECTRON_RUN_AS_NODE：用 Electron 自带的 Node 运行时跑脚本
      await execFileP(
        process.execPath,
        [
          genScript,
          '--char-id', charId,
          '--out', spriteDirAbs,
          '--cutout', baseImg,
          '--appearance', appearanceRequest,
          '--python', detectPython(),
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 600_000 },
      );
      if (fs.existsSync(path.join(spriteDirAbs, 'manifest.json'))) {
        logger('info', `AI 素材生成完成: ${charId}`);
        return;
      }
    } catch (err) {
      logger('warn', `AI 素材生成失败，回退占位管线: ${String(err).slice(0, 300)}`);
    }
  }

  // 2. 占位管线（抠图模式下用真实形象出帧）
  const args = [
    '--char-id', charId,
    '--out', spriteDirAbs,
    '--name', name,
    '--appearance', appearanceRequest,
  ];
  if (source === 'cutout' && fs.existsSync(baseImg)) {
    args.push('--base-image', baseImg);
  }
  const ok = await runPipelineScript('placeholder_gen.py', args, logger);
  if (ok && fs.existsSync(path.join(spriteDirAbs, 'manifest.json'))) return;
  writeFallbackSprite(spriteDirAbs, baseImg, charId, appearanceRequest, source);
}

/** 导入照片 → 抠图（可选）→ 素材 → 角色。replaceCharId 给定时不新建角色，
 *  直接替换该角色的形象素材（保留名字/人设/台词），并热刷新上屏。 */
export async function importPhoto(
  store: SettingsStore,
  logger: Logger,
  srcPath?: string, // Web 控制台/测试直接传文件路径，跳过对话框
  replaceCharId?: string,
): Promise<CharacterConfig[]> {
  // 测试钩子：DECKPET_IMPORT_PHOTO 指向图片时跳过文件对话框
  const envPhoto = process.env.DECKPET_IMPORT_PHOTO;
  let src: string | undefined = srcPath ?? envPhoto;
  if (!src) {
    const r = await dialog.showOpenDialog({
      title: '选择角色照片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return store.load().characters;
    src = r.filePaths[0];
  }

  const photosDir = path.join(ASSETS, 'photos');
  fs.mkdirSync(photosDir, { recursive: true });
  const photoDest = path.join(
    photosDir,
    `${Date.now()}-${path.basename(src).replace(/[\\/:*?"<>|]/g, '_')}`,
  );
  fs.copyFileSync(src, photoDest);

  // 替换模式：沿用现有角色 id 与素材目录（spriteDir 可能指向自定义目录）
  const existing = replaceCharId
    ? store.load().characters.find((c) => c.id === replaceCharId)
    : undefined;
  const charId = existing ? existing.id : nextCharId(store);
  const spriteDirAbs = existing
    ? resolveSpriteDir(existing)
    : path.join(ASSETS, 'sprites', charId);

  // 抠图：当前版本简化为「整张照片抠图生成一个角色」。
  // TODO: 多人照片逐个提取人物、分别生成角色（cutout.py 当前只输出 cutout-1.png）。
  // cutout.py 接口：--input <照片> --out-dir <目录>，产物为 <目录>/cutout-1.png
  let baseImg = photoDest;
  let source = 'placeholder';
  const cutoutDir = path.join(ASSETS, 'cutouts', charId);
  const cutoutPath = path.join(cutoutDir, 'cutout-1.png');
  const cutoutOk = await runPipelineScript(
    'cutout.py',
    ['--input', photoDest, '--out-dir', cutoutDir],
    logger,
  );
  if (cutoutOk && fs.existsSync(cutoutPath)) {
    baseImg = cutoutPath;
    source = 'cutout';
  } else {
    logger('warn', '抠图不可用，使用原图生成占位素材');
  }

  const name = existing
    ? existing.name
    : path.basename(src, path.extname(src)) || charId;
  // 替换模式：存档旧形象 + 清掉旧 AI 原始图缓存（否则断点续跑会复用旧形象）
  if (existing) {
    archiveSprites(spriteDirAbs, charId, logger);
    fs.rmSync(path.join(spriteDirAbs, '.raw'), { recursive: true, force: true });
  }
  await genSpriteSet(
    spriteDirAbs,
    baseImg,
    charId,
    name,
    existing?.appearanceRequest ?? '',
    source,
    logger,
  );
  const s = store.load();
  if (!existing) {
    s.characters.push({
      id: charId,
      name, // 用户后续在设置页改名
      spriteDir: `assets/sprites/${charId}`, // 相对项目根，renderer 按约定解析
      lineA: '爸爸', // 默认台词 A（可在设置页改）
      appearanceRequest: '',
      backendId: null,
      persona: '',
    });
    store.save(s);
  }
  return s.characters;
}

/**
 * 按 character.appearanceRequest 重新生成素材。
 * TODO: settings.backends 里 type==='image' 的图像生成后端是预留扩展，
 * 当前版本未实现 AI 生图，统一回退到占位管线（脚本或单帧）。
 */
export async function regenerateSprite(
  store: SettingsStore,
  charId: string,
  logger: Logger,
): Promise<void> {
  const c = store.load().characters.find((x) => x.id === charId);
  if (!c) throw new Error(`角色不存在: ${charId}`);
  const spriteDirAbs = resolveSpriteDir(c);

  // 重新生成前存档当前形象（可随时切回，不必再花额度生成）
  archiveSprites(spriteDirAbs, charId, logger);

  // 找底图：素材目录里已有的 idle.*，否则用抠图结果（仅兜底单帧路径需要）
  let baseImg: string | null = null;
  try {
    baseImg =
      fs
        .readdirSync(spriteDirAbs)
        .filter((f) => /^idle\.(png|jpe?g|webp|bmp)$/i.test(f))
        .map((f) => path.join(spriteDirAbs, f))[0] ?? null;
  } catch {
    baseImg = null;
  }
  if (!baseImg) {
    const cand = path.join(ASSETS, 'cutouts', charId, 'cutout-1.png');
    baseImg = fs.existsSync(cand) ? cand : null;
  }

  // TODO: 若配置了 type==='image' 的后端，按 appearanceRequest 调图像 API 生成底图。
  if (baseImg) {
    // 抠图结果作为底图 → 用真实形象出帧
    const source = baseImg.includes('cutouts') ? 'cutout' : 'placeholder';
    await genSpriteSet(
      spriteDirAbs,
      baseImg,
      charId,
      c.name,
      c.appearanceRequest,
      source,
      logger,
    );
    return;
  }
  // 无底图也要尽量让占位脚本跑（它不依赖输入图）
  const ok = await runPipelineScript(
    'placeholder_gen.py',
    [
      '--char-id', charId,
      '--out', spriteDirAbs,
      '--name', c.name,
      '--appearance', c.appearanceRequest,
    ],
    logger,
  );
  if (!ok) throw new Error(`角色 ${charId} 没有可用底图且占位脚本不可用，无法重新生成素材`);
}
