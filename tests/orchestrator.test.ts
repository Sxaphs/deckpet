import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentDriver,
  AgentSessionHandle,
  BackendConfig,
  ChatChunk,
  DriverContext,
  OrcEvent,
} from '../src/core/types.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/core/config/settings.js';
import { hasDriver, registerDriver } from '../src/core/adapters/registry.js';
import { Orchestrator } from '../src/core/orchestrator/orchestrator.js';

/**
 * MockDriver：脚本化 ChatChunk 序列，不碰网络/子进程。
 * 按 prompt 内容分支：
 *   含「只输出 JSON 数组」→ collab 拆任务，返回 JSON 数组
 *   含「[协作子任务]」     → 子任务汇报
 *   含「汇总结论」         → 主角色汇总
 *   其余                  → 普通 chat 回复（多段，用于折叠断言）
 */
function createMockDriver(_backend: BackendConfig, _ctx: DriverContext): AgentDriver {
  return {
    type: 'mock',
    async test() {
      return { ok: true, detail: 'mock' };
    },
    async createSession(opts): Promise<AgentSessionHandle> {
      const charId = opts.characterId;
      return {
        id: `mock-${charId}`,
        async *prompt(text: string): AsyncIterable<ChatChunk> {
          if (text.includes('只输出 JSON 数组')) {
            yield {
              type: 'delta',
              text: '[{"charId":"alpha","subtask":"写代码"},{"charId":"beta","subtask":"写文档"}]',
            };
          } else if (text.includes('[协作子任务]')) {
            yield { type: 'delta', text: `${charId} 汇报完成` };
          } else if (text.includes('汇总结论')) {
            yield { type: 'delta', text: '汇总：全部搞定' };
          } else {
            yield { type: 'delta', text: '第一段要点。\n\n' };
            yield { type: 'delta', text: '第二行\n第三行\n第四行\n第五行' };
          }
          yield { type: 'done' };
        },
        async cancel() {},
        async dispose() {},
      };
    },
  };
}

let dir: string;
let store: SettingsStore;
let orc: Orchestrator;

async function collect(gen: AsyncIterable<OrcEvent>): Promise<OrcEvent[]> {
  const out: OrcEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckpet-orc-test-'));
  store = new SettingsStore(dir);
  store.save({
    ...DEFAULT_SETTINGS,
    defaultBackendId: 'mock1',
    bubbleFold: { enabled: true, maxLines: 2, maxChars: 20 },
    backends: [{ id: 'mock1', name: 'Mock', type: 'mock' }],
    characters: [
      {
        id: 'alpha',
        name: '小甲',
        spriteDir: '',
        lineA: '你好，我是小甲',
        appearanceRequest: '',
        persona: '',
      },
      {
        id: 'beta',
        name: '小乙',
        spriteDir: '',
        lineA: '随便说点什么',
        appearanceRequest: '',
        persona: '',
      },
    ],
  });
  if (!hasDriver('mock')) registerDriver('mock', createMockDriver);
  orc = new Orchestrator(store, async () => null, undefined, () => {});
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Orchestrator.chat', () => {
  it('事件序列 speaker-start → token → speaker-end，且折叠正确', async () => {
    const events = await collect(orc.chat('alpha', 'hi'));
    const kinds = events.map((e) => e.kind);

    expect(kinds[0]).toBe('speaker-start');
    expect(kinds[kinds.length - 1]).toBe('done');

    const startIdx = kinds.indexOf('speaker-start');
    const endIdx = kinds.indexOf('speaker-end');
    const tokenIdxs = kinds
      .map((k, i) => (k === 'token' ? i : -1))
      .filter((i) => i >= 0);
    expect(tokenIdxs.length).toBeGreaterThan(0);
    for (const i of tokenIdxs) {
      expect(i).toBeGreaterThan(startIdx);
      expect(i).toBeLessThan(endIdx);
    }

    const end = events[endIdx];
    if (end.kind !== 'speaker-end') throw new Error('unreachable');
    expect(end.fullText).toBe('第一段要点。\n\n第二行\n第三行\n第四行\n第五行');
    expect(end.folded).toBe(true);
    expect(end.summary).toBe('第一段要点。');
  });

  it('lineA 情绪按词义匹配', () => {
    const a = orc.lineA('alpha');
    expect(a.text).toBe('你好，我是小甲');
    expect(a.emotion).toBe('greet');
    expect(orc.lineA('beta').emotion).toBe('happy');
  });
});

describe('Orchestrator.collab', () => {
  it('按 charIds 顺序依次汇报，主角色最后汇总', async () => {
    const events = await collect(orc.collab('做个网页', ['alpha', 'beta']));

    const starts = events
      .filter((e) => e.kind === 'speaker-start')
      .map((e) => (e.kind === 'speaker-start' ? e.charId : ''));
    // alpha 汇报 → beta 汇报 → alpha 汇总
    expect(starts).toEqual(['alpha', 'beta', 'alpha']);

    const full = events
      .filter((e) => e.kind === 'token')
      .map((e) => (e.kind === 'token' ? e.text : ''))
      .join('');
    expect(full).toContain('alpha 汇报完成');
    expect(full).toContain('beta 汇报完成');
    expect(full).toContain('汇总：全部搞定');

    expect(events[events.length - 1].kind).toBe('done');
  });
});
