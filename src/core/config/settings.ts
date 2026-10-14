import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppSettings } from '../types.js';
import { DEFAULT_POLICY } from '../permission/policy-engine.js';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultBackendId: null,
  collabEnabled: true,
  bubbleFold: { enabled: true, maxLines: 6, maxChars: 400 },
  autostart: false,
  globalPermission: { ...DEFAULT_POLICY },
  backends: [],
  characters: [],
  reminders: [],
  disabledReminderCategories: [],
};

export function defaultDataDir(): string {
  return process.env.DECKPET_HOME || path.join(os.homedir(), '.deckpet');
}

/** 设置持久化：纯 JSON 文件，原子写入。密钥不在此文件（见 keystore）。 */
export class SettingsStore {
  readonly file: string;

  constructor(readonly dir: string = defaultDataDir()) {
    this.file = path.join(dir, 'settings.json');
  }

  load(): AppSettings {
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        bubbleFold: { ...DEFAULT_SETTINGS.bubbleFold, ...parsed.bubbleFold },
        globalPermission: {
          ...DEFAULT_SETTINGS.globalPermission,
          ...parsed.globalPermission,
        },
      };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  save(settings: AppSettings): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  historyDir(charId: string): string {
    const d = path.join(this.dir, 'history', charId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}
