import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { ISshCredentialStore } from '#/persistence/interface/sshCredentialStore';

const execFileAsync = promisify(execFile);

async function restrictWindowsAcl(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await execFileAsync('icacls', [path, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], { windowsHide: true });
}

interface SecretEntry {
  setPassword(value: string): Promise<void>;
  getPassword(): Promise<string | undefined>;
  deleteCredential(): Promise<boolean>;
}

export type SecretEntryFactory = (account: string) => Promise<SecretEntry>;

async function systemKeyring(account: string): Promise<SecretEntry> {
  const { AsyncEntry } = createRequire(import.meta.url)('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
  return new AsyncEntry('Kiki SSH', account, process.platform === 'linux'
    ? { linux: { store: 'secret-service' } }
    : undefined);
}

export class SshCredentialStore {
  private readonly ephemeral = new Map<string, string>();

  constructor(
    private readonly homeDir: string,
    private readonly entryFactory: SecretEntryFactory = systemKeyring,
  ) {}

  private account(hostId: string, kind: 'password' | 'passphrase' | 'identityFile'): string {
    if (!hostId.trim()) throw new Error('SSH host ID is required');
    return `${kind}-${createHash('sha256').update(hostId).digest('hex')}`;
  }

  private fallbackPath(account: string): string {
    return join(this.homeDir, 'credentials', 'ssh', `${account}.secret`);
  }

  async save(hostId: string, kind: 'password' | 'passphrase' | 'identityFile', value: string, remember = true): Promise<'keyring' | 'file' | 'memory'> {
    const account = this.account(hostId, kind);
    if (!remember) {
      await this.forget(hostId, kind);
      this.ephemeral.set(account, value);
      return 'memory';
    }
    let savedToKeyring = false;
    try {
      await (await this.entryFactory(account)).setPassword(value);
      savedToKeyring = true;
    } catch {
    }
    if (savedToKeyring) {
      await unlink(this.fallbackPath(account)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      this.ephemeral.delete(account);
      return 'keyring';
    }
    const path = this.fallbackPath(account);
    const directory = join(this.homeDir, 'credentials', 'ssh');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restrictWindowsAcl(directory);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await restrictWindowsAcl(temporary);
      await file.writeFile(value, 'utf8');
    } catch (error) {
      await file.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await file.close();
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    this.ephemeral.delete(account);
    return 'file';
  }

  async read(hostId: string, kind: 'password' | 'passphrase' | 'identityFile'): Promise<string | undefined> {
    const account = this.account(hostId, kind);
    const memory = this.ephemeral.get(account);
    if (memory !== undefined) return memory;
    try {
      return await readFile(this.fallbackPath(account), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      return await (await this.entryFactory(account)).getPassword();
    } catch {
      return undefined;
    }
  }

  async forget(hostId: string, kind: 'password' | 'passphrase' | 'identityFile'): Promise<void> {
    const account = this.account(hostId, kind);
    let entry: SecretEntry | undefined;
    try {
      entry = await this.entryFactory(account);
    } catch {
    }
    let keyringError: unknown;
    try {
      await entry?.deleteCredential();
    } catch (error) {
      keyringError = error;
    }
    try {
      await unlink(this.fallbackPath(account));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (keyringError !== undefined) throw new Error('Could not remove SSH credential from system keyring', { cause: keyringError });
    this.ephemeral.delete(account);
  }

  async savePrivateKey(hostId: string, contents: string): Promise<string> {
    const account = this.account(hostId, 'passphrase');
    const directory = join(this.homeDir, 'credentials', 'ssh', 'keys');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restrictWindowsAcl(join(this.homeDir, 'credentials', 'ssh'));
    await restrictWindowsAcl(directory);
    const path = join(directory, `${account}-${randomUUID()}`);
    const file = await open(path, 'wx', 0o600);
    try {
      await restrictWindowsAcl(path);
      await file.writeFile(contents, 'utf8');
    } catch (error) {
      await file.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }
    await file.close();
    return path;
  }
}

export class SshCredentialStorageService implements ISshCredentialStore {
  declare readonly _serviceBrand: undefined;
  private readonly store: SshCredentialStore;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    this.store = new SshCredentialStore(bootstrap.homeDir);
  }

  save(hostId: string, kind: 'password' | 'passphrase' | 'identityFile', value: string, remember?: boolean): Promise<'keyring' | 'file' | 'memory'> {
    return this.store.save(hostId, kind, value, remember);
  }

  read(hostId: string, kind: 'password' | 'passphrase' | 'identityFile'): Promise<string | undefined> {
    return this.store.read(hostId, kind);
  }

  forget(hostId: string, kind: 'password' | 'passphrase' | 'identityFile'): Promise<void> {
    return this.store.forget(hostId, kind);
  }

  savePrivateKey(hostId: string, contents: string): Promise<string> {
    return this.store.savePrivateKey(hostId, contents);
  }
}

registerScopedService(LifecycleScope.App, ISshCredentialStore, SshCredentialStorageService, ScopeActivation.OnDemand, 'ssh');
