import path from 'node:path';
import type {
  Confirmer,
  Decision,
  PermissionAction,
  PermissionPolicy,
  PolicyEngine,
} from '../types.js';

/** 内置危险命令兜底黑名单（小写子串匹配），用户配置在此之上追加 */
const BUILTIN_BLOCKED = [
  'rm -rf /',
  'rm -rf ~',
  'format ',
  'del /f /s /q c:\\',
  'rd /s /q c:\\',
  'shutdown',
  'reboot',
  'mkfs',
  ':(){:|:&};:',
  'diskpart',
  'bcdedit',
  'reg delete hk',
];

export const DEFAULT_POLICY: PermissionPolicy = {
  mode: 'ask',
  allowedDirs: [],
  blockedCommands: [],
  networkEnabled: true,
  allowedLocalHosts: [],
};

export function mergePolicy(
  base: PermissionPolicy,
  override?: Partial<PermissionPolicy>,
): PermissionPolicy {
  if (!override) return base;
  return {
    mode: override.mode ?? base.mode,
    allowedDirs: override.allowedDirs ?? base.allowedDirs,
    blockedCommands: override.blockedCommands ?? base.blockedCommands,
    networkEnabled: override.networkEnabled ?? base.networkEnabled,
    allowedLocalHosts: override.allowedLocalHosts ?? base.allowedLocalHosts,
  };
}

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function pathAllowed(p: string, allowedDirs: string[]): boolean {
  if (allowedDirs.length === 0) return true;
  const norm = normalizePath(p);
  return allowedDirs.some((dir) => {
    const d = normalizePath(dir);
    return norm === d || norm.startsWith(d.endsWith('/') ? d : d + '/');
  });
}

function commandBlocked(command: string, extra: string[]): string | null {
  const cmd = command.toLowerCase();
  for (const bad of [...BUILTIN_BLOCKED, ...extra]) {
    if (bad && cmd.includes(bad.toLowerCase())) return bad;
  }
  return null;
}

export class DefaultPolicyEngine implements PolicyEngine {
  constructor(
    private policy: PermissionPolicy,
    private confirmer?: Confirmer,
  ) {}

  async authorize(action: PermissionAction): Promise<Decision> {
    const pre = this.check(action);
    if (!pre.allow) return pre;
    if (this.policy.mode === 'ask') {
      if (!this.confirmer) {
        return { allow: false, reason: 'ask 模式下无确认通道，已拒绝' };
      }
      const ok = await this.confirmer(action);
      return ok ? { allow: true } : { allow: false, reason: '用户拒绝' };
    }
    return { allow: true };
  }

  /** 静态规则判定（不含人工确认分支）。 */
  private check(action: PermissionAction): Decision {
    const p = this.policy;

    // readonly 档：只允许 fs.read
    if (p.mode === 'readonly' && action.kind !== 'fs.read') {
      return { allow: false, reason: `只读模式下禁止 ${action.kind}` };
    }

    // fs.read 在所有模式下都放行（个人 AI 读文件是基本能力），仍受白名单约束
    if ((action.kind === 'fs.read' || action.kind === 'fs.write') && action.path) {
      if (!pathAllowed(action.path, p.allowedDirs)) {
        return {
          allow: false,
          reason: `路径不在工作目录白名单内: ${action.path}`,
        };
      }
    }

    if (action.kind === 'shell.exec' && action.command) {
      const hit = commandBlocked(action.command, p.blockedCommands);
      if (hit) {
        return { allow: false, reason: `命令命中黑名单 "${hit}": ${action.command}` };
      }
    }

    if (action.kind === 'net.fetch') {
      if (!p.networkEnabled) {
        return { allow: false, reason: '联网开关已关闭' };
      }
      if (action.url) {
        let host = '';
        try {
          host = new URL(action.url).hostname;
        } catch {
          return { allow: false, reason: `非法 URL: ${action.url}` };
        }
        // 阻断内网/回环，防 SSRF 式探测；豁免名单（如本地模型服务）放行
        const exempt = p.allowedLocalHosts.some(
          (h) => host === h.toLowerCase(),
        );
        if (
          !exempt &&
          (host === 'localhost' ||
            host === '127.0.0.1' ||
            host === '::1' ||
            host.endsWith('.local') ||
            /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host))
        ) {
          return {
            allow: false,
            reason: `禁止访问内网地址: ${host}（可在 allowedLocalHosts 中豁免）`,
          };
        }
      }
    }

    return { allow: true };
  }
}
