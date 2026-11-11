import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiOAuthKeyring } from '#/persistence/backends/node-fs/kimiOAuthKeyring';
import { createOriginalOAuthKeyring } from '#/persistence/backends/node-fs/originalOAuthKeyring';
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
  it('normalizes a missing native keyring credential to undefined', async () => {
    const factory: SecretEntryFactory = async () => ({
      async setPassword() {},
      async getPassword() { return null; },
      async deleteCredential() { return false; },
    });
    const store = new SshCredentialStore(await temporaryHome(), factory);
    for (const kind of ['password', 'passphrase', 'identityFile'] as const) {
      expect(await store.read('example-host', kind)).toBeUndefined();
    }
  });
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

  it('routes SSH, Kimi OAuth, and original OAuth secrets through the loopback Android broker and falls back to 0o600 files when unconfigured', async () => {
    const brokerToken = `broker-${randomUUID()}`;
    const brokerWorkerCode = `
      const { createServer } = require('node:http');
      const { parentPort, workerData } = require('node:worker_threads');
      const brokerSecrets = new Map();
      const server = createServer(async (req, res) => {
        if (req.headers.authorization !== 'Bearer ' + workerData.brokerToken) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/v1/secret/list') {
          const service = url.searchParams.get('service') || '';
          const bucket = brokerSecrets.get(service);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accounts: bucket ? [...bucket.keys()] : [] }));
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (req.method === 'POST' && url.pathname === '/v1/secret/put') {
          const bucket = brokerSecrets.get(body.service) || new Map();
          bucket.set(body.account, body.value ?? '');
          brokerSecrets.set(body.service, bucket);
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/secret/get') {
          const bucket = brokerSecrets.get(body.service);
          const value = bucket ? bucket.get(body.account) : undefined;
          if (value === undefined) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ value }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/secret/delete') {
          const bucket = brokerSecrets.get(body.service);
          const deleted = bucket ? bucket.delete(body.account) : false;
          res.writeHead(deleted ? 204 : 404);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        parentPort.postMessage({ type: 'listening', port: server.address().port });
      });
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'close') {
          server.close(() => process.exit(0));
        }
      });
    `;
    const brokerWorker = new Worker(brokerWorkerCode, { eval: true, workerData: { brokerToken } });
    const port = await new Promise<number>((resolve, reject) => {
      brokerWorker.once('message', (msg: { port: number }) => resolve(msg.port));
      brokerWorker.once('error', reject);
    });
    const brokerUrl = `http://127.0.0.1:${port}`;
    const home = await temporaryHome();
    try {
      vi.stubEnv('KIKI_SECRET_BACKEND', 'android-broker');
      vi.stubEnv('KIKI_SECRET_BROKER_URL', brokerUrl);
      vi.stubEnv('KIKI_SECRET_BROKER_TOKEN', brokerToken);

      const sshStore = new SshCredentialStore(home);
      expect(await sshStore.save('phone-ssh', 'password', 'broker-ssh-pass')).toBe('keyring');
      expect(await sshStore.read('phone-ssh', 'password')).toBe('broker-ssh-pass');
      const listSshRes = await fetch(`${brokerUrl}/v1/secret/list?service=${encodeURIComponent('Kiki SSH')}`, {
        headers: { authorization: `Bearer ${brokerToken}` },
      });
      expect(((await listSshRes.json()) as { accounts: string[] }).accounts.length).toBe(1);
      await sshStore.forget('phone-ssh', 'password');
      expect(await sshStore.read('phone-ssh', 'password')).toBeUndefined();

      const syncKeyring = createKimiOAuthKeyring({ homeDir: home });
      const syncEntry = syncKeyring.createEntry('kimi-code', 'primary');
      expect(syncEntry.getPassword()).toBeNull();
      syncEntry.setPassword('{"access_token":"tok-1"}');
      expect(syncEntry.getPassword()).toBe('{"access_token":"tok-1"}');
      expect(syncKeyring.findAccounts('kimi-code')).toEqual(['primary']);
      expect(syncEntry.deleteCredential()).toBe(true);
      expect(syncEntry.getPassword()).toBeNull();
      expect(syncKeyring.findAccounts('kimi-code')).toEqual([]);

      const asyncKeyring = createOriginalOAuthKeyring({ homeDir: home });
      expect(await asyncKeyring.load('grok-build', 'acct-1')).toBeUndefined();
      await asyncKeyring.save('grok-build', 'acct-1', 'secret-refresh-token');
      expect(await asyncKeyring.load('grok-build', 'acct-1')).toBe('secret-refresh-token');

      vi.stubEnv('KIKI_SECRET_BACKEND', 'mobile-broker');
      const mobileBrokerSsh = new SshCredentialStore(home);
      expect(await mobileBrokerSsh.save('ios-ssh', 'password', 'ios-broker-pass')).toBe('keyring');
      expect(await mobileBrokerSsh.read('ios-ssh', 'password')).toBe('ios-broker-pass');
      await mobileBrokerSsh.forget('ios-ssh', 'password');
      expect(await mobileBrokerSsh.read('ios-ssh', 'password')).toBeUndefined();
      const mobileSyncKeyring = createKimiOAuthKeyring({ homeDir: home });
      const mobileSyncEntry = mobileSyncKeyring.createEntry('kimi-code', 'mobile-acct');
      mobileSyncEntry.setPassword('{"access_token":"tok-mobile"}');
      expect(mobileSyncEntry.getPassword()).toBe('{"access_token":"tok-mobile"}');
      expect(mobileSyncEntry.deleteCredential()).toBe(true);

      vi.stubEnv('KIKI_SECRET_BROKER_URL', '');
      vi.stubEnv('KIKI_SECRET_BROKER_TOKEN', '');
      const fallbackHome = await temporaryHome();
      const fallbackSsh = new SshCredentialStore(fallbackHome);
      expect(await fallbackSsh.save('cli-smoke', 'password', 'file-ssh-pass')).toBe('file');
      expect(await fallbackSsh.read('cli-smoke', 'password')).toBe('file-ssh-pass');

      const fallbackSync = createKimiOAuthKeyring({ homeDir: fallbackHome });
      const fallbackEntry = fallbackSync.createEntry('kimi-code', 'smoke-acct');
      fallbackEntry.setPassword('smoke-secret');
      expect(fallbackEntry.getPassword()).toBe('smoke-secret');
      expect(fallbackSync.findAccounts('kimi-code')).toEqual(['smoke-acct']);
      expect(fallbackEntry.deleteCredential()).toBe(true);
      expect(fallbackSync.findAccounts('kimi-code')).toEqual([]);

      const fallbackAsync = createOriginalOAuthKeyring({ homeDir: fallbackHome });
      await fallbackAsync.save('openai-codex', 'smoke', 'codex-secret');
      expect(await fallbackAsync.load('openai-codex', 'smoke')).toBe('codex-secret');
    } finally {
      vi.unstubAllEnvs();
      brokerWorker.postMessage({ type: 'close' });
      await brokerWorker.terminate().catch(() => undefined);
    }
  });
});
