#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import type {
  AppSettings,
  BackendConfig,
  OrcEvent,
  PermissionAction,
} from '../core/types.js';
import { SettingsStore, defaultDataDir } from '../core/config/settings.js';
import { DpapiKeyStore } from '../core/config/keystore.js';
import { DefaultPolicyEngine } from '../core/permission/policy-engine.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';
import { createDriver } from '../core/adapters/registry.js';
import { registerBuiltinDrivers } from '../core/adapters/index.js';

/**
 * DeckPet CLI —— 第一阶段验收入口（纯 Node，不依赖 Electron）。
 *
 *   backends list | add | remove <id> | test <id>
 *   chars add --id <id> --name <n> [--line-a ...] [--persona ...] [--backend <id>]
 *   chat --char <id> [--backend <id>] [--new] "消息"
 *   collab --chars <id1,id2> --task "..."
 */

const dataDir = defaultDataDir();
const store = new SettingsStore(dataDir);
// apiKeyRef 形如 backend:<id> → 文件 <datadir>/keys/<id>.key
const keystore = new DpapiKeyStore(
  (ref) => path.join(dataDir, 'keys', ref.replace(/^backend:/, '') + '.key'),
);

const logger = (level: 'info' | 'warn' | 'error', msg: string) =>
  console.error(`[${level}] ${msg}`);

/** ask 档人工确认：打印动作摘要，读一行 [y/N]；非交互 stdin（EOF）或 60s 无应答自动拒绝 */
function cliConfirmer(action: PermissionAction): Promise<boolean> {
  const target = action.path ?? action.command ?? action.url ?? '';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      rl.close();
      process.stdout.write('(超时，自动拒绝)\n');
      resolve(false);
    }, 60000);
    rl.on('close', () => {
      clearTimeout(timer);
      resolve(false);
    });
    rl.question(
      `[权限请求] ${action.kind} ${target}\n` +
        `  原因: ${action.reason ?? '-'}  来源: ${action.origin ?? '-'}\n` +
        `允许执行？[y/N] `,
      (ans) => {
        clearTimeout(timer);
        rl.removeAllListeners('close');
        rl.close();
        resolve(ans.trim().toLowerCase() === 'y');
      },
    );
  });
}

function makeOrchestrator(s: SettingsStore = store): Orchestrator {
  return new Orchestrator(s, (ref) => keystore.getSecret(ref), cliConfirmer, logger);
}

// ─────────────────────────── backends ───────────────────────────

async function backendsCmd(args: string[]): Promise<void> {
  const action = args[0];
  const rest = args.slice(1);

  if (action === 'list') {
    const s = store.load();
    if (s.backends.length === 0) {
      console.log('（无后端，用 backends add 添加）');
      return;
    }
    for (const b of s.backends) {
      const def = s.defaultBackendId === b.id ? ' *默认*' : '';
      const key = b.apiKeyRef ? ' [有密钥]' : '';
      console.log(`${b.id}  ${b.name}  (${b.type})${key}${def}`);
    }
    return;
  }

  if (action === 'add') {
    const { values } = parseArgs({
      args: rest,
      options: {
        type: { type: 'string' },
        name: { type: 'string' },
        id: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string' },
        'api-key': { type: 'string' },
        'set-default': { type: 'boolean' },
      },
    });
    if (!values.type || !values.name) {
      throw new Error('backends add 需要 --type 与 --name');
    }
    const id =
      values.id ?? `${values.type}-${Math.random().toString(36).slice(2, 8)}`;
    const s = store.load();
    if (s.backends.some((b) => b.id === id)) {
      throw new Error(`后端 id 已存在: ${id}`);
    }
    const backend: BackendConfig = { id, name: values.name, type: values.type };
    if (values.command) backend.command = values.command;
    if (values.args) backend.args = values.args.split(/\s+/).filter(Boolean);
    if (values['base-url']) backend.baseUrl = values['base-url'];
    if (values.model) backend.model = values.model;
    if (values['api-key']) {
      backend.apiKeyRef = `backend:${id}`;
      await keystore.setSecret(backend.apiKeyRef, values['api-key']);
    }
    s.backends.push(backend);
    if (values['set-default'] || !s.defaultBackendId) s.defaultBackendId = id;
    store.save(s);
    console.log(`已添加后端 ${id}（${backend.name}, ${backend.type}）`);
    return;
  }

  if (action === 'remove') {
    const id = rest[0];
    if (!id) throw new Error('backends remove 需要 <id>');
    const s = store.load();
    const before = s.backends.length;
    s.backends = s.backends.filter((b) => b.id !== id);
    if (s.backends.length === before) throw new Error(`后端不存在: ${id}`);
    if (s.defaultBackendId === id) s.defaultBackendId = s.backends[0]?.id ?? null;
    for (const c of s.characters) {
      if (c.backendId === id) c.backendId = null;
    }
    store.save(s);
    await keystore.deleteSecret(`backend:${id}`);
    console.log(`已删除后端 ${id}`);
    return;
  }

  if (action === 'test') {
    const id = rest[0];
    if (!id) throw new Error('backends test 需要 <id>');
    const s = store.load();
    const backend = s.backends.find((b) => b.id === id);
    if (!backend) throw new Error(`后端不存在: ${id}`);
    const driver = createDriver(backend, {
      policy: new DefaultPolicyEngine(s.globalPermission, cliConfirmer),
      resolveSecret: (ref) => keystore.getSecret(ref),
      log: logger,
    });
    const r = await driver.test();
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.detail ?? ''}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`未知 backends 子命令: ${action ?? '(空)'}`);
}

// ─────────────────────────── chars ───────────────────────────

function charsCmd(args: string[]): void {
  const action = args[0];
  const rest = args.slice(1);

  if (action === 'add') {
    const { values } = parseArgs({
      args: rest,
      options: {
        id: { type: 'string' },
        name: { type: 'string' },
        'line-a': { type: 'string' },
        persona: { type: 'string' },
        backend: { type: 'string' },
      },
    });
    if (!values.id || !values.name) {
      throw new Error('chars add 需要 --id 与 --name');
    }
    const s = store.load();
    if (s.characters.some((c) => c.id === values.id)) {
      throw new Error(`角色 id 已存在: ${values.id}`);
    }
    if (values.backend && !s.backends.some((b) => b.id === values.backend)) {
      throw new Error(`后端不存在: ${values.backend}`);
    }
    s.characters.push({
      id: values.id,
      name: values.name,
      spriteDir: path.join('assets', 'sprites', values.id),
      lineA: values['line-a'] ?? '你好！',
      appearanceRequest: '',
      persona: values.persona ?? '',
      backendId: values.backend ?? null,
    });
    store.save(s);
    console.log(`已添加角色 ${values.id}（${values.name}）`);
    return;
  }

  if (action === 'list') {
    const s = store.load();
    for (const c of s.characters) {
      console.log(`${c.id}  ${c.name}  (backend=${c.backendId ?? '默认'})`);
    }
    return;
  }

  throw new Error(`未知 chars 子命令: ${action ?? '(空)'}`);
}

// ─────────────────────────── 事件打印 ───────────────────────────

function printEvent(ev: OrcEvent, speakerPrefix: boolean): void {
  switch (ev.kind) {
    case 'speaker-start':
      if (speakerPrefix) process.stdout.write(`\n【${ev.charName}】`);
      break;
    case 'token':
      process.stdout.write(ev.text);
      break;
    case 'status':
      process.stdout.write(`\n[status] ${ev.text}\n`);
      break;
    case 'speaker-end':
      process.stdout.write('\n');
      if (ev.folded) process.stdout.write('(已折叠, 精华版见上)\n');
      break;
    case 'error':
      console.error(`[error] ${ev.error}`);
      break;
    case 'emotion':
    case 'done':
      break;
  }
}

// ─────────────────────────── chat ───────────────────────────

/** 临时覆盖角色 backendId 的 SettingsStore（不落盘，仅内存叠加） */
class OverlayStore extends SettingsStore {
  constructor(
    dir: string,
    private backendOverride?: { charId: string; backendId: string },
  ) {
    super(dir);
  }

  override load(): AppSettings {
    const s = super.load();
    if (this.backendOverride) {
      const { charId, backendId } = this.backendOverride;
      s.characters = s.characters.map((c) =>
        c.id === charId ? { ...c, backendId } : c,
      );
    }
    return s;
  }
}

async function chatCmd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      char: { type: 'string' },
      backend: { type: 'string' },
      new: { type: 'boolean' },
    },
  });
  if (!values.char) throw new Error('chat 需要 --char <id>');
  const text = positionals.join(' ').trim();
  if (!text) throw new Error('chat 需要一条消息（位置参数）');

  const s = store.load();
  const char = s.characters.find((c) => c.id === values.char);
  if (!char) throw new Error(`角色不存在: ${values.char}`);
  if (values.backend && !s.backends.some((b) => b.id === values.backend)) {
    throw new Error(`后端不存在: ${values.backend}`);
  }

  if (values.new) {
    fs.rmSync(path.join(store.historyDir(char.id), 'session.jsonl'), {
      force: true,
    });
  }

  const s2 = values.backend
    ? new OverlayStore(dataDir, { charId: char.id, backendId: values.backend })
    : store;
  const orc = makeOrchestrator(s2);
  try {
    for await (const ev of orc.chat(char.id, text)) {
      printEvent(ev, false);
    }
  } finally {
    // 释放 ACP 子进程，否则进程挂住不退出
    await orc.disposeAll();
  }
}

// ─────────────────────────── collab ───────────────────────────

async function collabCmd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      chars: { type: 'string' },
      task: { type: 'string' },
    },
  });
  if (!values.chars) throw new Error('collab 需要 --chars <id1,id2>');
  const charIds = values.chars.split(',').map((x) => x.trim()).filter(Boolean);
  const task = (values.task ?? positionals.join(' ')).trim();
  if (!task) throw new Error('collab 需要 --task "..."');

  const s = store.load();
  for (const id of charIds) {
    if (!s.characters.some((c) => c.id === id)) {
      throw new Error(`角色不存在: ${id}`);
    }
  }

  const orc = makeOrchestrator();
  try {
    for await (const ev of orc.collab(task, charIds)) {
      printEvent(ev, true);
    }
  } finally {
    await orc.disposeAll();
  }
}

// ─────────────────────────── 入口 ───────────────────────────

async function main(): Promise<void> {
  registerBuiltinDrivers();
  const [group, ...rest] = process.argv.slice(2);
  switch (group) {
    case 'backends':
      await backendsCmd(rest);
      break;
    case 'chars':
      charsCmd(rest);
      break;
    case 'chat':
      await chatCmd(rest);
      break;
    case 'collab':
      await collabCmd(rest);
      break;
    default:
      console.log(
        '用法:\n' +
          '  backends list | add --type <t> --name <n> [...] | remove <id> | test <id>\n' +
          '  chars add --id <id> --name <n> [--line-a ...] [--persona ...] [--backend <id>]\n' +
          '  chat --char <id> [--backend <id>] [--new] "消息"\n' +
          '  collab --chars <id1,id2> --task "..."',
      );
      if (group) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
