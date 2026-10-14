/**
 * AI 帧生成（DeckPet pipeline，Node TS）—— 真实可用的实现。
 *
 * 流程：抠图 PNG + 姿态提示词 + 用户 appearanceRequest
 *   → 调 OpenAI 兼容 images/generations（支持 image 字段的图生图模型，
 *     默认按火山方舟 SeedEdit 3.0 i2i 的调用方式：JSON body 带 base64 图）
 *   → 每个动作生成 1 张规范姿态图
 *   → python frame_post.py 抠图 + 旋转变体出多帧（打滚旋转等不再费 API）
 *   → 落盘并更新 manifest.json（source='ai-generated'）
 *
 * 配置（环境变量）：
 *   DECKPET_IMAGE_BASE_URL  默认 https://ark.cn-beijing.volces.com/api/v3
 *   DECKPET_IMAGE_API_KEY   必填（火山方舟 ARK_API_KEY 或其他兼容服务）
 *   DECKPET_IMAGE_MODEL     默认 doubao-seedream-4-0-20260415
 *
 * 用法：
 *   node dist/core/pipeline/gen_frames.js --char-id <id> --out <spritesDir> \
 *       [--cutout <cutout.png>] [--appearance "形象要求"] \
 *       [--python <python.exe>]   # frame_post.py 用的解释器，默认自动探测
 *
 * 说明：SpriteAction/SpriteManifest 类型与 src/core/sprite-contract.ts
 * 保持一致（此处复制最小定义，避免 pipeline 反向依赖 src 编译产物）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────── 契约（镜像 sprite-contract.ts） ───────────────────────────

type SpriteAction =
  | 'crawl'
  | 'climb'
  | 'hang'
  | 'roll'
  | 'rest'
  | 'talk_open'
  | 'talk_half'
  | 'talk_closed'
  | 'wave'
  | 'jump'
  | 'sit_sad'
  | 'think'
  | 'scared' // 被拎起来时的害怕挣扎
  | 'fall_sit' // 摔倒屁股着地
  | 'get_up'; // 摔倒后爬起来

interface SpriteFrame {
  file: string;
  width: number;
  height: number;
  durationMs?: number;
}

interface SpriteManifest {
  characterId: string;
  source: string;
  generatedAt: string;
  appearanceRequest?: string;
  frames: Partial<Record<SpriteAction, SpriteFrame[]>>;
}

/** 循环动作（与 LOOP_ACTIONS 一致），帧时长 120ms */
const LOOP_ACTIONS: ReadonlySet<string> = new Set(['crawl', 'climb', 'hang', 'roll', 'rest']);
const LOOP_DURATION_MS = 120;

/**
 * 每个动作的本地变体角度（传给 frame_post.py）。
 * AI 只生成 1 张规范姿态图（每动作 1 次 API 调用），多帧由旋转/平移派生。
 */
const ACTION_ANGLES: Record<SpriteAction, number[]> = {
  crawl: [-14, -6, 14, 6], // 爬行：左右倾斜交替 ≈ 对角步态
  climb: [-8, 0, 8, 0],
  hang: [-10, 10],
  roll: [0, 90, 180, 270],
  rest: [0, 2], // 休息：AI 已是坐姿，本地只做极轻微起伏（呼吸感），大角度旋转会像抽搐
  talk_open: [0],
  talk_half: [0],
  talk_closed: [0],
  wave: [-18, -6],
  jump: [0, 8],
  sit_sad: [0],
  think: [0],
  scared: [-8, 8], // 害怕：身体左右扭动挣扎
  fall_sit: [0],
  get_up: [0],
};

// ─────────────────────────── 提示词模板 ───────────────────────────

/** 各动作姿态指令（SeedEdit 建议：单指令、精准描述对谁做什么） */
const POSE_PROMPTS: Record<SpriteAction, string> = {
  crawl: '把角色变成四肢着地在地上爬行的姿势：双手撑地、双膝跪地、身体水平、头抬起看前方',
  climb: '把角色变成竖直攀爬的姿势：双手举过头顶向上抓握，双腿蹬踏，像正在爬墙',
  hang: '把角色变成双手抓住上方边缘悬挂的姿势：双臂伸直举过头顶，身体自然下垂',
  roll: '把角色变成蜷缩成一团的姿势：抱膝低头，团成球形',
  rest: '把角色变成坐在地上闭眼休息打盹的姿势，表情放松',
  talk_open: '保持角色站姿不变，把嘴改成张大的说话口型',
  talk_half: '保持角色站姿不变，把嘴改成半张的说话口型',
  talk_closed: '保持角色站姿不变，把嘴改成闭合',
  wave: '把角色变成单手举高挥手打招呼的姿势，表情开心',
  jump: '把角色变成四肢张开向上跃起的姿势，表情兴奋',
  sit_sad: '把角色变成坐在地上低着头的姿势，表情沮丧',
  think: '把角色变成站立单手扶头的姿势，若有所思',
  scared: '把角色变成被拎到半空中害怕挣扎的姿势：瞪大眼睛、张大嘴、四肢慌乱蹬踢，表情惊恐',
  fall_sit: '把角色变成摔倒后屁股着地的姿势：坐在地上向后仰、双腿翘起、双手后撑，表情吃痛',
  get_up: '把角色变成摔倒后正在爬起来的姿势：单手撑地、半起身、膝盖还跪在地上',
};

/** 公共约束：保留特征与物种 + 补全双手/爪子 + 纯色背景（便于二次抠图） */
const COMMON_SUFFIX =
  '严格保持原角色的物种、形态、配色、长相与服装特征，不得换装或改变面部；' +
  '如果原图是动物就保持动物形态，绝不能拟人化成人形；' +
  '画面中只保留原角色一个，绝不新增其他人物或动物；' +
  '如果手/爪子被遮挡或不完整，按原物种自然补全；纯色浅蓝背景，全身像，角色居中';

/** 半身/特写照 → 全身基图：先补全四肢躯干，后续动作都以这张全身像为参考 */
const FULLBODY_PROMPT =
  '把图中角色补全为完整的全身站立像：如果原图只有脸部特写或上半身，' +
  '按原角色的长相、发型、配色与服装风格自然补全躯干、双臂、双手、双腿、双脚，站姿端正';

function buildPrompt(action: SpriteAction, appearance: string): string {
  const extra = appearance ? `另外：${appearance}。` : '';
  return `${POSE_PROMPTS[action]}。${extra}${COMMON_SUFFIX}`;
}

// ─────────────────────────── 配置与参数 ───────────────────────────

interface ImageApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function readConfig(): ImageApiConfig | null {
  const apiKey = process.env.DECKPET_IMAGE_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.DECKPET_IMAGE_BASE_URL?.trim() || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, ''),
    apiKey,
    model: process.env.DECKPET_IMAGE_MODEL?.trim() || 'doubao-seedream-4-0-20260415',
  };
}

interface CliArgs {
  charId: string;
  out: string;
  cutout?: string;
  appearance?: string;
  python?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) {
      throw new Error(`参数解析失败：${argv.slice(i).join(' ')}（需要 --key value 成对出现）`);
    }
    map.set(argv[i].slice(2), argv[i + 1]);
  }
  const charId = map.get('char-id');
  const out = map.get('out');
  if (!charId || !out) {
    throw new Error('缺少必填参数：--char-id <id> --out <dir> [--cutout <png>] [--appearance <文本>] [--python <exe>]');
  }
  return { charId, out, cutout: map.get('cutout'), appearance: map.get('appearance'), python: map.get('python') };
}

// ─────────────────────────── 图像 API 调用 ───────────────────────────

interface ImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/**
 * 生成一张规范姿态图。
 * 默认按火山方舟 SeedEdit i2i 的方式：POST /images/generations，JSON body 里
 * image 字段带 base64 data URL。其他 OpenAI 兼容服务若只认 /images/edits，
 * 设 DECKPET_IMAGE_USE_EDITS=1 走 multipart。
 */
async function generateImage(cfg: ImageApiConfig, prompt: string, cutoutPath?: string): Promise<Buffer> {
  let imageDataUrl: string | undefined;
  if (cutoutPath) {
    const png = await readFile(cutoutPath);
    imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  }

  let res: Response;
  if (cutoutPath && process.env.DECKPET_IMAGE_USE_EDITS === '1') {
    // OpenAI 官方 images/edits 风格（multipart）
    const form = new FormData();
    form.append('image', new Blob([await readFile(cutoutPath)], { type: 'image/png' }), path.basename(cutoutPath));
    form.append('model', cfg.model);
    form.append('prompt', prompt);
    res = await fetch(`${cfg.baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
  } else {
    // 火山方舟 / 大多数 OpenAI 兼容服务：generations + image 字段
    const body: Record<string, unknown> = {
      model: cfg.model,
      prompt,
      response_format: 'b64_json',
      size: '1024x1024',
    };
    if (imageDataUrl) body.image = imageDataUrl;
    res = await fetch(`${cfg.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `图像 API 调用失败：HTTP ${res.status} ${res.statusText}\n` +
        `模型：${cfg.model}，端点：${res.url}\n响应体：${text.slice(0, 500)}\n` +
        '排查：确认 key 有额度、模型名支持图生图（SeedEdit i2i / gpt-image 等）。',
    );
  }

  const json = (await res.json()) as ImageResponse;
  const item = json.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new Error(`下载生成图失败：HTTP ${img.status}（${item.url}）`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error(`图像 API 响应缺少 data[0].b64_json / url：${JSON.stringify(json).slice(0, 500)}`);
}

// ─────────────────────────── 帧后处理（python） ───────────────────────────

function detectPython(cliPython?: string): string {
  if (cliPython) return cliPython;
  // 优先 pipeline venv（装了 rembg+Pillow），其次系统 python
  const venv = path.join(__dirname, '../../pipeline/.venv/Scripts/python.exe');
  if (existsSync(venv)) return venv;
  return 'python';
}

async function postProcess(python: string, genPng: string, outDir: string, action: SpriteAction): Promise<void> {
  const script = path.join(__dirname, '../../pipeline/frame_post.py');
  const angles = ACTION_ANGLES[action].join(',');
  await execFileP(python, [script, '--input', genPng, '--out-dir', outDir, '--action', action, '--angles', angles], {
    maxBuffer: 4 * 1024 * 1024,
  });
}

// ─────────────────────────── 主流程 ───────────────────────────

export async function main(args: string[]): Promise<void> {
  const cfg = readConfig();
  if (!cfg) {
    console.error(
      '未配置图像 API（DECKPET_IMAGE_API_KEY 为空），调用方应回退占位素材。\n' +
        '火山方舟开通 SeedEdit 后：\n' +
        '  set DECKPET_IMAGE_API_KEY=<ARK_API_KEY>\n' +
        '可选：DECKPET_IMAGE_BASE_URL（默认 ark cn-beijing）/ DECKPET_IMAGE_MODEL（默认 doubao-seedream-4-0-20260415）',
    );
    process.exit(3);
  }

  const cli = parseArgs(args);
  await mkdir(cli.out, { recursive: true });

  if (cli.cutout && !existsSync(cli.cutout)) {
    console.warn(`警告：抠图文件不存在（${cli.cutout}），改用纯文本提示词生成。`);
    cli.cutout = undefined;
  }

  const python = detectPython(cli.python);
  // 暂存目录：全部成功后才原子换入正式目录，中断不会破坏线上素材
  const stagingDir = `${cli.out}.staging-${process.pid}`;
  const tmpDir = path.join(cli.out, '.raw');
  await mkdir(tmpDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  // 半身照/特写先补全全身基图（断点续跑：.raw/fullbody.png 已存在则复用），
  // 之后 15 个动作全部以这张全身像为参考图，保证四肢完整
  let refImg = cli.cutout;
  const fullbodyPath = path.join(tmpDir, 'fullbody.png');
  if (cli.cutout) {
    if (!existsSync(fullbodyPath)) {
      console.log('[fullbody] 补全全身基图…');
      const extra = cli.appearance ? `另外：${cli.appearance}。` : '';
      const png = await generateImage(cfg, `${FULLBODY_PROMPT}。${extra}${COMMON_SUFFIX}`, cli.cutout);
      await writeFile(fullbodyPath, png);
    } else {
      console.log('[fullbody] 复用已生成的全身基图（.raw/fullbody.png）');
    }
    refImg = fullbodyPath;
  }

  // 续跑：正式目录已有该动作帧且 raw 也在 → 跳过；否则重新生成该动作
  const manifestPath = path.join(cli.out, 'manifest.json');
  let manifest: SpriteManifest;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SpriteManifest;
  } else {
    manifest = { characterId: cli.charId, source: 'ai-generated', generatedAt: '', frames: {} };
  }
  manifest.characterId = cli.charId;
  manifest.source = 'ai-generated';
  if (cli.appearance) manifest.appearanceRequest = cli.appearance;

  const actions = Object.keys(ACTION_ANGLES) as SpriteAction[];
  const doneActions: SpriteAction[] = [];
  for (const action of actions) {
    // 已完整生成的动作跳过（正式目录有帧文件即可信）
    const existing = manifest.frames[action];
    const allPresent =
      existing &&
      existing.length === ACTION_ANGLES[action].length &&
      existing.every((f) => existsSync(path.join(cli.out, f.file)));
    if (allPresent) {
      doneActions.push(action);
      console.log(`[${action}] 已存在且完整，跳过`);
      continue;
    }

    const rawPath = path.join(tmpDir, `${action}.png`);
    if (!existsSync(rawPath)) {
      const prompt = buildPrompt(action, cli.appearance ?? '');
      console.log(`[${action}] 生成规范姿态图…`);
      const png = await generateImage(cfg, prompt, refImg);
      await writeFile(rawPath, png);
    } else {
      console.log(`[${action}] 复用已生成的规范姿态图（.raw/${action}.png）`);
    }

    console.log(`[${action}] 抠图 + 变体派生（${ACTION_ANGLES[action].length} 帧）…`);
    await postProcess(python, rawPath, stagingDir, action);
    doneActions.push(action);
  }

  // 全部动作就绪后：暂存帧并入正式目录，再更新 manifest（最后一步才动线上素材）
  const { cpSync, rmSync } = await import('node:fs');
  cpSync(stagingDir, cli.out, { recursive: true });
  rmSync(stagingDir, { recursive: true, force: true });
  manifest.generatedAt = new Date().toISOString();
  for (const action of actions) {
    if (manifest.frames[action]) continue; // 已有完整条目不动
    const entries: SpriteFrame[] = ACTION_ANGLES[action].map((_, i) => {
      const entry: SpriteFrame = { file: `${action}-${i}.png`, width: 96, height: 96 };
      if (LOOP_ACTIONS.has(action)) entry.durationMs = LOOP_DURATION_MS;
      return entry;
    });
    manifest.frames[action] = entries;
  }
  // manifest 里指向不存在文件的条目清掉重记
  for (const action of actions) {
    const entries = manifest.frames[action];
    if (entries && !entries.every((f) => existsSync(path.join(cli.out, f.file)))) {
      delete manifest.frames[action];
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`全部完成：${doneActions.length} 个动作本轮就绪 → ${cli.out}（原始生成图保留在 .raw/ 供复查）`);
}

// 直接运行（node gen_frames.js ...）时进入 main；被 import 时不执行
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
