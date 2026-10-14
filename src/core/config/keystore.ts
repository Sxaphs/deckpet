/**
 * 密钥存储抽象。Electron 环境用 safeStorage（Windows 下即 DPAPI）；
 * 纯 CLI（无 Electron）环境退化到 PowerShell ProtectedData（同样是 DPAPI）。
 * 明文只存在于内存，绝不写入 settings.json。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface KeyStore {
  setSecret(ref: string, plaintext: string): Promise<void>;
  getSecret(ref: string): Promise<string | null>;
  deleteSecret(ref: string): Promise<void>;
}

/** Electron safeStorage 实现（主进程注入 safeStorage 实例） */
export class SafeStorageKeyStore implements KeyStore {
  constructor(
    private safeStorage: {
      isEncryptionAvailable(): boolean;
      encryptString(s: string): Buffer;
      decryptString(b: Buffer): string;
    },
    private fileFor: (ref: string) => string,
  ) {}

  async setSecret(ref: string, plaintext: string): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('系统加密不可用（DPAPI），拒绝明文落盘');
    }
    const fs = await import('node:fs');
    const buf = this.safeStorage.encryptString(plaintext);
    fs.writeFileSync(this.fileFor(ref), buf);
  }

  async getSecret(ref: string): Promise<string | null> {
    const fs = await import('node:fs');
    try {
      const buf = fs.readFileSync(this.fileFor(ref));
      return this.safeStorage.decryptString(buf);
    } catch {
      return null;
    }
  }

  async deleteSecret(ref: string): Promise<void> {
    const fs = await import('node:fs');
    fs.rmSync(this.fileFor(ref), { force: true });
  }
}

/** CLI 环境的 DPAPI 实现：通过 PowerShell ProtectedData（CurrentUser 范围） */
export class DpapiKeyStore implements KeyStore {
  constructor(private fileFor: (ref: string) => string) {}

  private async runPs(script: string): Promise<string> {
    const { stdout } = await execFileP(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.trim();
  }

  async setSecret(ref: string, plaintext: string): Promise<void> {
    const fs = await import('node:fs');
    const b64 = Buffer.from(plaintext, 'utf-8').toString('base64');
    const out = await this.runPs(
      `Add-Type -AssemblyName System.Security; ` +
        `$b=[Convert]::FromBase64String('${b64}'); ` +
        `$e=[System.Security.Cryptography.ProtectedData]::Protect($b,[byte[]]@(),'CurrentUser'); ` +
        `[Convert]::ToBase64String($e)`,
    );
    fs.mkdirSync(this.dirOf(this.fileFor(ref)), { recursive: true });
    fs.writeFileSync(this.fileFor(ref), out, 'utf-8');
  }

  async getSecret(ref: string): Promise<string | null> {
    const fs = await import('node:fs');
    let enc: string;
    try {
      enc = fs.readFileSync(this.fileFor(ref), 'utf-8').trim();
    } catch {
      return null;
    }
    if (!enc) return null;
    const out = await this.runPs(
      `Add-Type -AssemblyName System.Security; ` +
        `$e=[Convert]::FromBase64String('${enc}'); ` +
        `$b=[System.Security.Cryptography.ProtectedData]::Unprotect($e,[byte[]]@(),'CurrentUser'); ` +
        `[Convert]::ToBase64String($b)`,
    );
    if (!out) return null;
    return Buffer.from(out, 'base64').toString('utf-8');
  }

  async deleteSecret(ref: string): Promise<void> {
    const fs = await import('node:fs');
    fs.rmSync(this.fileFor(ref), { force: true });
  }

  private dirOf(f: string): string {
    return f.slice(0, Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')));
  }
}
