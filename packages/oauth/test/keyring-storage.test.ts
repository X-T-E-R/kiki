import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREDENTIALS_STORE_CONFIG_KEY,
  KEYRING_PROBE_SERVICE,
  KEYRING_SERVICE,
  KeyringTokenStorage,
  OAuthStorageUnavailableError,
  inspectTokenStorage,
  keyringServiceForCredentialsDir,
  registerKeyringBackend,
  resolveCredentialsStoreMode,
  resolveTokenStorage,
  unregisterKeyringBackend,
} from '../src/keyring-storage';
import type { KeyringApi, KeyringEntry, KeyringStorageObserver } from '../src/keyring-storage';
import { FileTokenStorage } from '../src/storage';
import { revokedTombstone } from '../src/token-state';
import type { TokenInfo } from '../src/types';
import { tokenToWire } from '../src/types';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `kimi-keyring-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'at-abc',
    refreshToken: 'rt-xyz',
    expiresAt: 1_700_000_000,
    scope: 'read write',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

function token(accessToken: string, issuedAt: number, expiresIn = 3600): TokenInfo {
  return sampleToken({
    accessToken,
    refreshToken: `rt-${accessToken}`,
    expiresAt: issuedAt + expiresIn,
    expiresIn,
  });
}

class FakeKeyring implements KeyringApi {
  readonly store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\0${account}`;
  }

  createEntry(service: string, account: string): KeyringEntry {
    const key = this.key(service, account);
    return {
      getPassword: () => this.store.get(key) ?? null,
      setPassword: (value) => {
        this.store.set(key, value);
      },
      deleteCredential: () => this.store.delete(key),
    };
  }

  findAccounts(service: string): string[] {
    const prefix = `${service}\0`;
    return [...this.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}

class ConfigurableKeyring extends FakeKeyring {
  throwOnGet = false;
  throwOnSet = false;
  throwOnDelete = false;
  throwOnFind = false;
  deleteRemoves = true;
  deleteReturns = true;

  override createEntry(service: string, account: string): KeyringEntry {
    const entry = super.createEntry(service, account);
    return {
      getPassword: () => {
        if (this.throwOnGet) throw new Error('keychain read failed');
        return entry.getPassword();
      },
      setPassword: (value) => {
        if (this.throwOnSet) throw new Error('keychain write failed');
        entry.setPassword(value);
      },
      deleteCredential: () => {
        if (this.throwOnDelete) throw new Error('keychain delete failed');
        if (this.deleteRemoves) return entry.deleteCredential();
        return this.deleteReturns;
      },
    };
  }

  override findAccounts(service: string): string[] {
    if (this.throwOnFind) throw new Error('keychain store unreachable');
    return super.findAccounts(service);
  }
}

class RecordingKeyring extends FakeKeyring {
  readonly accountsByService = new Map<string, string[]>();

  override createEntry(service: string, account: string): KeyringEntry {
    this.accountsByService.set(service, [...(this.accountsByService.get(service) ?? []), account]);
    return super.createEntry(service, account);
  }
}

class FakeObserver implements KeyringStorageObserver {
  readonly selected: Array<{ backend: 'keyring' | 'file'; reason?: string }> = [];
  readonly degraded: Array<{ operation: string; message: string }> = [];
  readonly migrated: string[] = [];

  onBackendSelected(backend: 'keyring' | 'file', reason?: string): void {
    this.selected.push({ backend, reason });
  }

  onKeyringDegraded(operation: string, message: string): void {
    this.degraded.push({ operation, message });
  }

  onMigrated(name: string): void {
    this.migrated.push(name);
  }
}

describe('KeyringTokenStorage', () => {
  let dir: string;
  let legacy: FileTokenStorage;
  let keyring: FakeKeyring;
  let observer: FakeObserver;
  let storage: KeyringTokenStorage;

  beforeEach(() => {
    dir = makeTmpDir();
    legacy = new FileTokenStorage(dir);
    keyring = new FakeKeyring();
    observer = new FakeObserver();
    storage = new KeyringTokenStorage({ keyring, legacy, observer });
  });

  afterEach(() => {
    unregisterKeyringBackend();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips wire JSON and removes both keyring and file stores', async () => {
    const value = sampleToken();
    await storage.save('kimi-code', value);
    expect(JSON.parse(keyring.store.get(`${KEYRING_SERVICE}\0kimi-code`) as string)).toEqual(tokenToWire(value));
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(await storage.load('kimi-code')).toEqual(value);
    expect(await storage.list()).toEqual(['kimi-code']);

    await legacy.save('kimi-code', value);
    await storage.remove('kimi-code');
    expect(keyring.store.size).toBe(0);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('migrates a legacy file and compare-deletes only the matching file', async () => {
    const value = sampleToken();
    await legacy.save('kimi-code', value);
    expect(await storage.load('kimi-code')).toEqual(value);
    expect(keyring.findAccounts(KEYRING_SERVICE)).toEqual(['kimi-code']);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.migrated).toEqual(['kimi-code']);
  });

  it('does not delete a file that keeps changing during migration', async () => {
    const values = Array.from({ length: 5 }, (_, index) => token(`at-${index}`, 1000 + index));
    class RacyLegacy extends FileTokenStorage {
      loadCalls = 0;
      removeCalls = 0;

      override loadUnlocked(): TokenInfo | undefined {
        const value = values[this.loadCalls] ?? values.at(-1);
        this.loadCalls += 1;
        return value;
      }

      override removeIfMatchesUnlocked(name: string, expected: string): boolean {
        this.removeCalls += 1;
        return super.removeIfMatchesUnlocked(name, expected);
      }
    }
    const racy = new RacyLegacy(dir);
    await racy.save('kimi-code', values[0]!);
    const loaded = await new KeyringTokenStorage({ keyring, legacy: racy, observer }).load('kimi-code');
    expect(loaded).toEqual(values[3]);
    expect(racy.removeCalls).toBe(0);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });

  it('adopts only a strictly newer valid file token on a keyring hit', async () => {
    const oldToken = token('old', 1000);
    const newToken = token('new', 2000);
    await storage.save('kimi-code', oldToken);
    await legacy.save('kimi-code', newToken);
    expect(await storage.load('kimi-code')).toEqual(newToken);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.migrated).toEqual(['kimi-code']);
  });

  it('never resurrects a valid file over a keyring tombstone', async () => {
    const valid = sampleToken();
    await legacy.save('kimi-code', valid);
    keyring.createEntry(KEYRING_SERVICE, 'kimi-code').setPassword(
      JSON.stringify(tokenToWire(revokedTombstone(valid))),
    );
    expect(await storage.load('kimi-code')).toEqual(revokedTombstone(valid));
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });

  it('dual-writes and repairs the bridge in auto mode without pruning', async () => {
    const auto = new KeyringTokenStorage({ keyring, legacy, observer, coexist: true });
    const value = sampleToken();
    await auto.save('kimi-code', value);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
    expect(await auto.load('kimi-code')).toEqual(value);

    rmSync(join(dir, 'kimi-code.json'));
    expect(await auto.load('kimi-code')).toEqual(value);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });

  it('disambiguates a false delete result with account listing', async () => {
    const denying = new ConfigurableKeyring();
    denying.deleteRemoves = false;
    denying.deleteReturns = false;
    const strict = new KeyringTokenStorage({ keyring: denying, legacy, observer });

    await expect(strict.remove('missing')).resolves.toBeUndefined();
    await strict.save('kimi-code', sampleToken());
    await legacy.save('kimi-code', sampleToken());
    await expect(strict.remove('kimi-code')).rejects.toThrow(/failed to delete keyring credential/);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
    expect(observer.degraded).toEqual([]);
  });

  it('degrades to a readable file copy but never treats a keyring-only token as missing', async () => {
    const flaky = new ConfigurableKeyring();
    const degraded = new KeyringTokenStorage({ keyring: flaky, legacy, observer });
    await degraded.save('kimi-code', sampleToken());
    flaky.throwOnGet = true;
    await expect(degraded.load('kimi-code')).rejects.toBeInstanceOf(OAuthStorageUnavailableError);
    expect(observer.degraded).toEqual([{ operation: 'load', message: 'keychain read failed' }]);

    const fallback = sampleToken({ accessToken: 'file-token' });
    await legacy.save('kimi-code', fallback);
    expect(await degraded.load('kimi-code')).toEqual(fallback);
    expect(await degraded.list()).toEqual(['kimi-code']);
  });

  it('rejects invalid names before touching the keyring', async () => {
    for (const name of ['../etc/passwd', '.hidden', '']) {
      await expect(storage.save(name, sampleToken())).rejects.toThrow(/Invalid token name/);
      await expect(storage.load(name)).rejects.toThrow(/Invalid token name/);
      await expect(storage.remove(name)).rejects.toThrow(/Invalid token name/);
    }
    expect(keyring.store.size).toBe(0);
  });
});

describe('resolveTokenStorage', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    unregisterKeyringBackend();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses a capability probe only for mutable resolver selection and namespaces services by directory', async () => {
    const keyring = new RecordingKeyring();
    const observer = new FakeObserver();
    const selected = resolveTokenStorage(dir, { loadKeyring: () => keyring, observer });
    expect(selected).toBeInstanceOf(KeyringTokenStorage);
    expect(observer.selected).toEqual([{ backend: 'keyring', reason: 'auto' }]);
    expect(keyring.findAccounts(KEYRING_PROBE_SERVICE)).toEqual([]);
    await selected.save('kimi-code', sampleToken());
    expect(keyring.findAccounts(keyringServiceForCredentialsDir(dir))).toEqual(['kimi-code']);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
  });

  it('fails closed for strict keyring mode without a backend', () => {
    expect(() => resolveTokenStorage(dir, { mode: 'keyring', loadKeyring: () => undefined })).toThrow(OAuthStorageUnavailableError);
  });

  it('honors file/keyring/auto config and the disable kill switch', async () => {
    const keyring = new FakeKeyring();
    const credentialsDir = join(dir, 'credentials');
    writeFileSync(join(dir, 'config.toml'), `${CREDENTIALS_STORE_CONFIG_KEY} = "file"\n`);
    expect(resolveTokenStorage(credentialsDir, { loadKeyring: () => keyring })).toBeInstanceOf(FileTokenStorage);

    writeFileSync(join(dir, 'config.toml'), `${CREDENTIALS_STORE_CONFIG_KEY} = "keyring"\n`);
    expect(resolveTokenStorage(credentialsDir, { loadKeyring: () => keyring })).toBeInstanceOf(KeyringTokenStorage);
    vi.stubEnv('KIMI_DISABLE_KEYRING', '1');
    expect(resolveTokenStorage(credentialsDir, { loadKeyring: () => keyring })).toBeInstanceOf(FileTokenStorage);
    expect(keyring.findAccounts(KEYRING_PROBE_SERVICE)).toEqual([]);

    expect(resolveCredentialsStoreMode(credentialsDir)).toBe('keyring');
    writeFileSync(join(dir, 'config.toml'), 'malformed = [\n');
    expect(resolveCredentialsStoreMode(credentialsDir)).toBe('auto');
  });
});

describe('inspectTokenStorage', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    unregisterKeyringBackend();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is read-only: no probe, migration, compare-delete, or bridge repair', async () => {
    const keyring = new FakeKeyring();
    const value = token('file', 2000);
    const legacy = new FileTokenStorage(dir);
    await legacy.save('kimi-code', value);
    const result = await inspectTokenStorage(dir, 'kimi-code', {
      mode: 'keyring',
      loadKeyring: () => keyring,
    });
    expect(result).toEqual({ backend: 'keyring', token: value });
    expect(keyring.store.size).toBe(0);
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(true);
    expect(existsSync(join(dir, 'kimi-code.lock-target'))).toBe(true);
  });

  it('reconciles a fresher file in memory without changing either store', async () => {
    const keyring = new FakeKeyring();
    const oldToken = token('old', 1000);
    const newToken = token('new', 2000);
    keyring.createEntry(keyringServiceForCredentialsDir(dir), 'kimi-code').setPassword(
      JSON.stringify(tokenToWire(oldToken)),
    );
    await new FileTokenStorage(dir).save('kimi-code', newToken);
    const before = readFileSync(join(dir, 'kimi-code.json'), 'utf8');
    const result = await inspectTokenStorage(dir, 'kimi-code', {
      mode: 'auto',
      loadKeyring: () => keyring,
    });
    expect(result).toEqual({ backend: 'keyring', token: newToken });
    expect(readFileSync(join(dir, 'kimi-code.json'), 'utf8')).toBe(before);
    expect(keyring.createEntry(keyringServiceForCredentialsDir(dir), 'kimi-code').getPassword()).toBe(
      JSON.stringify(tokenToWire(oldToken)),
    );
  });

  it('returns unavailable instead of signed out for keyring mode without a backend', async () => {
    await expect(inspectTokenStorage(dir, 'kimi-code', { mode: 'keyring', loadKeyring: () => undefined }))
      .rejects.toBeInstanceOf(OAuthStorageUnavailableError);
  });

  it('allows a readable file fallback for auto mode without a backend', async () => {
    const value = sampleToken();
    await new FileTokenStorage(dir).save('kimi-code', value);
    await expect(inspectTokenStorage(dir, 'kimi-code', { mode: 'auto', loadKeyring: () => undefined }))
      .resolves.toEqual({ backend: 'file', token: value });
  });

  it('keeps keyring backend metadata stable across inspect, resolve, and migration', async () => {
    const keyring = new FakeKeyring();
    const value = sampleToken();
    await new FileTokenStorage(dir).save('kimi-code', value);
    await expect(inspectTokenStorage(dir, 'kimi-code', { mode: 'keyring', loadKeyring: () => keyring }))
      .resolves.toEqual({ backend: 'keyring', token: value });

    const selected = resolveTokenStorage(dir, { mode: 'keyring', loadKeyring: () => keyring });
    await expect(selected.load('kimi-code')).resolves.toEqual(value);
    await expect(inspectTokenStorage(dir, 'kimi-code', { mode: 'keyring', loadKeyring: () => keyring }))
      .resolves.toEqual({ backend: 'keyring', token: value });
    expect(existsSync(join(dir, 'kimi-code.json'))).toBe(false);
  });

  it('returns missing only when the selected backend is readable and empty', async () => {
    const keyring = new FakeKeyring();
    await expect(inspectTokenStorage(dir, 'kimi-code', { mode: 'keyring', loadKeyring: () => keyring }))
      .resolves.toEqual({ backend: 'keyring' });
  });
});
