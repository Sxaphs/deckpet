import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_POLICY,
  DefaultPolicyEngine,
} from '../src/core/permission/policy-engine.js';
import type { PermissionPolicy } from '../src/core/types.js';

function policy(over: Partial<PermissionPolicy>): PermissionPolicy {
  return { ...DEFAULT_POLICY, ...over };
}

describe('DefaultPolicyEngine', () => {
  it('readonly 档拒绝 fs.write', async () => {
    const e = new DefaultPolicyEngine(policy({ mode: 'readonly' }));
    const d = await e.authorize({ kind: 'fs.write', path: 'C:/tmp/x.txt' });
    expect(d.allow).toBe(false);
    // fs.read 仍放行
    const r = await e.authorize({ kind: 'fs.read', path: 'C:/tmp/x.txt' });
    expect(r.allow).toBe(true);
  });

  it('ask 档：confirmer 拒绝则拒绝', async () => {
    const e = new DefaultPolicyEngine(policy({ mode: 'ask' }), async () => false);
    const d = await e.authorize({ kind: 'fs.write', path: 'C:/tmp/x.txt' });
    expect(d.allow).toBe(false);
  });

  it('ask 档：confirmer 接受则放行', async () => {
    const e = new DefaultPolicyEngine(policy({ mode: 'ask' }), async () => true);
    const d = await e.authorize({ kind: 'fs.write', path: 'C:/tmp/x.txt' });
    expect(d.allow).toBe(true);
  });

  it('auto 档放行写文件', async () => {
    const e = new DefaultPolicyEngine(policy({ mode: 'auto' }));
    const d = await e.authorize({ kind: 'fs.write', path: 'C:/tmp/x.txt' });
    expect(d.allow).toBe(true);
  });

  it('allowedDirs 白名单：子目录放行、目录外拒绝', async () => {
    const root = path.join(os.tmpdir(), 'deckpet-allow-test');
    const e = new DefaultPolicyEngine(
      policy({ mode: 'auto', allowedDirs: [root] }),
    );
    const inside = await e.authorize({
      kind: 'fs.write',
      path: path.join(root, 'sub', 'deep', 'a.txt'),
    });
    expect(inside.allow).toBe(true);
    const exact = await e.authorize({ kind: 'fs.write', path: root });
    expect(exact.allow).toBe(true);
    const outside = await e.authorize({
      kind: 'fs.write',
      path: path.join(os.tmpdir(), 'deckpet-other', 'a.txt'),
    });
    expect(outside.allow).toBe(false);
  });

  it('blockedCommands：自定义命中拒绝', async () => {
    const e = new DefaultPolicyEngine(
      policy({ mode: 'auto', blockedCommands: ['evilcmd'] }),
    );
    const d = await e.authorize({
      kind: 'shell.exec',
      command: 'evilcmd --do-something',
    });
    expect(d.allow).toBe(false);
  });

  it('blockedCommands：内置兜底 shutdown 命中拒绝', async () => {
    const e = new DefaultPolicyEngine(policy({ mode: 'auto' }));
    const d = await e.authorize({
      kind: 'shell.exec',
      command: 'shutdown /s /t 0',
    });
    expect(d.allow).toBe(false);
  });

  it('networkEnabled=false 拒绝 net.fetch', async () => {
    const e = new DefaultPolicyEngine(
      policy({ mode: 'auto', networkEnabled: false }),
    );
    const d = await e.authorize({
      kind: 'net.fetch',
      url: 'https://api.example.com/v1/chat',
    });
    expect(d.allow).toBe(false);
  });

  it('内网 URL 拒绝（localhost / 192.168.x）', async () => {
    const e = new DefaultPolicyEngine(policy({ mode: 'auto' }));
    for (const url of [
      'http://localhost:11434/v1/chat',
      'http://127.0.0.1:8080/api',
      'http://192.168.1.10/admin',
    ]) {
      const d = await e.authorize({ kind: 'net.fetch', url });
      expect(d.allow).toBe(false);
    }
    const pub = await e.authorize({
      kind: 'net.fetch',
      url: 'https://api.deepseek.com/v1/chat/completions',
    });
    expect(pub.allow).toBe(true);
  });
});
