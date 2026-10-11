import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'pathe';

import { SPACE_ID_PATTERN } from '@kiki/protocol';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { TomlAtomicDocumentStore } from './atomicDocumentStore';
import { FileStorageService } from './fileStorageService';
import { LifecycleScope } from '#/app/scopes';
import { ISshCredentialStore } from '#/persistence/interface/sshCredentialStore';

const execFileAsync = promisify(execFile);

async function restrictWindowsAcl(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await execFileAsync('icacls', [path, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], { windowsHide: true });
}

interface SecretEntry {
  setPassword(value: string): Promise<void>;
  getPassword(): Promise<string | null | undefined>;
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
  private readonly accounts: TomlAtomicDocumentStore | undefined;

  constructor(
    private readonly homeDir: string,
    private readonly entryFactory: SecretEntryFactory = systemKeyring,
    private readonly accountPrefix?: string,
  ) {
    if (accountPrefix !== undefined) {
      if (!SPACE_ID_PATTERN.test(accountPrefix)) throw new Error('Invalid SSH credential account prefix');
      this.accounts = new TomlAtomicDocumentStore(new FileStorageService(homeDir, 0o700, 0o600));
    }
  }

  private account(hostId: string, kind: 'password' | 'passphrase' | 'identityFile'): string {
    if (!hostId.trim()) throw new Error('SSH host ID is required');
    const digest = `${kind}-${createHash('sha256').update(hostId).digest('hex')}`;
    return this.accountPrefix === undefined ? digest : `${this.accountPrefix}/${digest}`;
  }

  private fallbackPath(account: string): string {
    return join(this.homeDir, 'credentials', 'ssh', `${account.slice(account.lastIndexOf('/') + 1)}.secret`);
  }

  private async trackAccount(account: string, remove = false): Promise<void> {
    if (this.accounts === undefined) return;
    const directory = join(this.homeDir, 'credentials', 'ssh');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restrictWindowsAcl(directory);
    const key = 'credentials/ssh/keyring-accounts.json';
    for (let attempt = 0; attempt < 4; attempt++) {
      const text = await this.accounts.getText('', key);
      const current: unknown = text === undefined ? [] : JSON.parse(text);
      if (!Array.isArray(current) || !current.every((entry) => typeof entry === 'string')) throw new Error('Invalid SSH keyring account manifest');
      const next = remove ? current.filter((entry) => entry !== account) : [...new Set([...current, account])];
      if (await this.accounts.compareAndSetText('', key, text, JSON.stringify(next))) return;
    }
    throw new Error('SSH keyring account manifest changed concurrently');
  }

  async save(hostId: string, kind: 'password' | 'passphrase' | 'identityFile', value: string, remember = true): Promise<'keyring' | 'file' | 'memory'> {
    const account = this.account(hostId, kind);
    if (!remember) {
      await this.forget(hostId, kind);
      this.ephemeral.set(account, value);
      return 'memory';
    }
    if (this.accounts !== undefined) await this.trackAccount(account);
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
      return (await (await this.entryFactory(account)).getPassword()) ?? undefined;
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
    if (kind === 'identityFile') {
      const directory = join(this.homeDir, 'credentials', 'ssh', 'keys');
      const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (info !== undefined) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('SSH key directory is not a regular directory');
        const passphraseAccount = this.account(hostId, 'passphrase');
        const prefix = `${passphraseAccount.slice(passphraseAccount.lastIndexOf('/') + 1)}-`;
        for (const name of await readdir(directory)) {
          if (!name.startsWith(prefix) || !/^[0-9a-f-]{36}$/.test(name.slice(prefix.length))) continue;
          await unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
    }
    if (keyringError !== undefined) throw new Error('Could not remove SSH credential from system keyring', { cause: keyringError });
    if (entry !== undefined) await this.trackAccount(account, true);
    this.ephemeral.delete(account);
  }

  async savePrivateKey(hostId: string, contents: string): Promise<string> {
    const account = this.account(hostId, 'passphrase');
    const directory = join(this.homeDir, 'credentials', 'ssh', 'keys');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restrictWindowsAcl(join(this.homeDir, 'credentials', 'ssh'));
    await restrictWindowsAcl(directory);
    const path = join(directory, `${account.slice(account.lastIndexOf('/') + 1)}-${randomUUID()}`);
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
    const isolated = bootstrap.baseHomeDir !== undefined && bootstrap.space?.inherit.credentials === 'isolated';
    this.store = new SshCredentialStore(bootstrap.credentialsHomeDir, systemKeyring, isolated ? bootstrap.spaceId : undefined);
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
