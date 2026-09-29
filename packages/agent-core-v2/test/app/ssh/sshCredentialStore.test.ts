import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { SshCredentialStore, type SecretEntryFactory } from '#/persistence/backends/node-fs/sshCredentialStore';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-ssh-secrets-'));
  directories.push(home);
  return home;
}

describe('SSH credentials', () => {
  it('remembers in keyring, supports opt-out, and never stores a pasted key in hosts.toml', async () => {
    const values = new Map<string, string>();
    const factory: SecretEntryFactory = async (id) => ({
      async setPassword(value) { values.set(id, value); },
      async getPassword() { return values.get(id); },
      async deleteCredential() { return values.delete(id); },
    });
    const home = await temporaryHome();
    const store = new SshCredentialStore(home, factory);
    expect(await store.save('dev', 'password', 'secret')).toBe('keyring');
    expect(await store.read('dev', 'password')).toBe('secret');
    expect(await store.save('dev', 'passphrase', 'once', false)).toBe('memory');
    expect(await store.read('dev', 'passphrase')).toBe('once');
    const keyPath = await store.savePrivateKey('dev', 'private material');
    expect(await store.save('workspace:dev', 'identityFile', keyPath)).toBe('keyring');
    expect(await store.read('workspace:dev', 'identityFile')).toBe(keyPath);
    expect(await store.read('other-workspace:dev', 'identityFile')).toBeUndefined();
    expect(await readFile(keyPath, 'utf8')).toBe('private material');
    if (process.platform !== 'win32') expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    await store.forget('dev', 'password');
    expect(await store.read('dev', 'password')).toBeUndefined();
  });

  it('falls back to restricted credentials directory when keyring is unavailable', async () => {
    const home = await temporaryHome();
    const store = new SshCredentialStore(home, async () => { throw new Error('locked keychain'); });
    expect(await store.save('dev', 'password', 'secret')).toBe('file');
    expect(await store.read('dev', 'password')).toBe('secret');
    if (process.platform !== 'win32') {
      const path = join(home, 'credentials', 'ssh');
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(path);
      expect((await stat(join(path, entries[0]!))).mode & 0o777).toBe(0o600);
    }
    await store.forget('dev', 'password');
    expect(await store.read('dev', 'password')).toBeUndefined();
    expect(await store.save('dev', 'password', 'temporary', false)).toBe('memory');
    expect(await store.read('dev', 'password')).toBe('temporary');
  });

  it('forgets keyring, fallback, memory, and every managed pasted key for a host', async () => {
    const home = await temporaryHome();
    const values = new Map<string, string>();
    let keyringAvailable = true;
    const factory: SecretEntryFactory = async (account) => ({
      async setPassword(value) { if (!keyringAvailable) throw new Error('unavailable'); values.set(account, value); },
      async getPassword() { return values.get(account); },
      async deleteCredential() { return values.delete(account); },
    });
    const store = new SshCredentialStore(home, factory);
    const account = '["workspace","dev"]';
    await store.save(account, 'password', 'keyring-secret');
    keyringAvailable = false;
    await store.save(account, 'passphrase', 'fallback-secret');
    await store.save(account, 'password', 'one-time-secret', false);
    const first = await store.savePrivateKey(account, 'pasted-one');
    const second = await store.savePrivateKey(account, 'pasted-two');
    await store.save(account, 'identityFile', second);
    for (const kind of ['password', 'passphrase', 'identityFile'] as const) await store.forget(account, kind);
    for (const kind of ['password', 'passphrase', 'identityFile'] as const) expect(await store.read(account, kind)).toBeUndefined();
    expect(values.size).toBe(0);
    await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(second)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.read('["workspace","other"]', 'identityFile')).toBeUndefined();
  });

  it('keeps shared accounts unchanged and namespaces isolated accounts with a durable cleanup inventory', async () => {
    const base = await temporaryHome();
    const isolatedHome = await temporaryHome();
    const values = new Map<string, string>();
    const factory: SecretEntryFactory = async (account) => ({
      async setPassword(value) { values.set(account, value); },
      async getPassword() { return values.get(account); },
      async deleteCredential() { return values.delete(account); },
    });
    const shared = new SshCredentialStore(base, factory);
    const isolated = new SshCredentialStore(isolatedHome, factory, 'h-isolated');
    await shared.save('dev', 'password', 'base');
    await isolated.save('dev', 'password', 'child');
    expect(await shared.read('dev', 'password')).toBe('base');
    expect(await isolated.read('dev', 'password')).toBe('child');
    const originalAccount = [...values.keys()].find((account) => !account.startsWith('h-'))!;
    expect(originalAccount).toMatch(/^password-[a-f0-9]{64}$/);
    expect(values.get(`h-isolated/${originalAccount}`)).toBe('child');
    const inventory = join(isolatedHome, 'credentials', 'ssh', 'keyring-accounts.json');
    expect(JSON.parse(await readFile(inventory, 'utf8'))).toEqual([`h-isolated/${originalAccount}`]);
    await isolated.forget('dev', 'password');
    expect(JSON.parse(await readFile(inventory, 'utf8'))).toEqual([]);
    expect(await shared.read('dev', 'password')).toBe('base');
    const key = await isolated.savePrivateKey('dev', 'isolated private key');
    expect(key.startsWith(join(isolatedHome, 'credentials', 'ssh', 'keys'))).toBe(true);
  });

  it.runIf(process.platform === 'win32' && process.env['KIKI_TEST_NATIVE_KEYRING'] === '1')('round-trips a disposable secret through native Windows Credential Manager', async () => {
    const store = new SshCredentialStore(await temporaryHome());
    const hostId = `smoke-${randomUUID()}`;
    try {
      expect(await store.save(hostId, 'password', 'temporary probe')).toBe('keyring');
      expect(await store.read(hostId, 'password')).toBe('temporary probe');
    } finally {
      await store.forget(hostId, 'password');
    }
  });
});
