import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { readPrivateFile, writePrivateFile } from '../../services/auth/privateFiles';

interface SecretEntry { setPassword(value: string): Promise<void>; getPassword(): Promise<string | undefined>; deleteCredential(): Promise<boolean> }
export type ExportKeyring = (account: string) => Promise<SecretEntry>;
const keyring: ExportKeyring = async (account) => {
  const require = createRequire(import.meta.resolve('@kiki/agent-core-v2'));
  const { AsyncEntry } = require('@napi-rs/keyring') as { AsyncEntry: new (service: string, account: string, options?: unknown) => SecretEntry };
  return new AsyncEntry('Kiki Usage Export', account, process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
};
async function restrictAcl(path: string): Promise<void> {
  if (process.platform === 'win32') await promisify(execFile)('icacls', [path, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], { windowsHide: true });
}
export class UsageExportSecretStore {
  constructor(private readonly credentialsHome: string, private readonly accountNamespace: string | (() => string), private readonly factory: ExportKeyring = keyring) {}
  private account(id: string): string { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid-secret-id'); return `${typeof this.accountNamespace === 'string' ? this.accountNamespace : this.accountNamespace()}/${id}`; }
  private path(id: string): string { this.account(id); return join(this.credentialsHome, 'credentials', 'usage-export', `${id}.secret`); }
  async save(id: string, value: string, storage: 'keyring' | 'private-file', acknowledgeFile = false): Promise<void> {
    if (storage === 'keyring') { await (await this.factory(this.account(id))).setPassword(value); await rm(this.path(id), { force: true }); return; }
    if (!acknowledgeFile) throw new Error('private-file-storage-requires-consent');
    const path = this.path(id); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await restrictAcl(dirname(path));
    await writePrivateFile(path, value); await restrictAcl(path);
  }
  async remove(id: string, storage: 'none' | 'keyring' | 'private-file'): Promise<void> {
    if (storage === 'keyring') { await (await this.factory(this.account(id))).deleteCredential(); return; }
    await rm(this.path(id), { force: true });
  }
  async read(id: string, storage: 'none' | 'keyring' | 'private-file'): Promise<string | undefined> {
    if (storage === 'none') return undefined;
    if (storage === 'keyring') return (await this.factory(this.account(id))).getPassword();
    try { return (await readPrivateFile(this.path(id))).toString('utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}
