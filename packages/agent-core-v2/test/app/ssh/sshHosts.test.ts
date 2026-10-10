import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { SSHKaos } from '@kiki/kaos/ssh';
import { utils } from 'ssh2';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { SshHostStore } from '#/app/ssh/sshHosts';
import { ISshHostService, SshHostService } from '#/app/ssh/sshService';
import { appendSshHost, discoverSshAliases, parseTransientSshTarget, resolveSshConfig, workspaceSshKey } from '#/app/ssh/sshConfig';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { SshCredentialStore, type SecretEntryFactory } from '#/persistence/backends/node-fs/sshCredentialStore';
import { ISshCredentialStore } from '#/persistence/interface/sshCredentialStore';
import { ISshHostDocumentStore } from '#/persistence/interface/sshHostDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function fixture(): Promise<{ home: string; config: string; hosts: SshHostStore }> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-ssh-hosts-'));
  directories.push(home);
  vi.stubEnv('KIKI_HOME', home);
  const sshDir = join(home, '.ssh');
  await mkdir(join(sshDir, 'fragments'), { recursive: true });
  const config = join(sshDir, 'config');
  await writeFile(config, 'Include fragments/*\nHost dev\n  HostName 127.0.0.1\n  User tester\n  Port 2222\nHost *.example.test\n  User wildcard\n');
  await writeFile(join(sshDir, 'fragments', 'extra'), 'Host bastion\n  HostName bastion.example.test\n');
  const storage = new FileStorageService(home, 0o700, 0o600);
  return { home, config, hosts: new SshHostStore(new TomlAtomicDocumentStore(storage), config) };
}

describe('SSH host store', () => {
  it('uses workspace-id hashed files and merges workspace overrides without leaking to other workspaces', async () => {
    const { home, hosts } = await fixture();
    await hosts.upsert({ id: 'dev', name: 'Development', hostname: '127.0.0.1', user: 'tester' });
    await hosts.upsert({ id: 'dev', name: 'Workspace dev', hostname: '127.0.0.1', user: 'tester' }, '/work/one');
    await hosts.upsert({ id: 'gpu', name: 'GPU', hostname: 'gpu.example.test', user: 'tester' }, '/work/one');
    expect((await hosts.list('/work/one')).map((host) => host.name)).toEqual(['bastion', 'Workspace dev', 'GPU']);
    expect((await hosts.list('/work/two')).map((host) => host.name)).toEqual(['bastion', 'Development']);
    expect(await readFile(join(home, workspaceSshKey('/work/one')), 'utf8')).toContain('Workspace dev');
    await hosts.remove('dev', '/work/one');
    expect((await hosts.list('/work/one')).find((host) => host.id === 'dev')?.name).toBe('Development');
  });

  it('discovers Include aliases, toggles live sync, resolves ssh -G and writes only a selected host', async () => {
    const { config, hosts } = await fixture();
    expect((await discoverSshAliases(config))).toEqual(['bastion', 'dev']);
    expect((await hosts.discover()).map((host) => host.id)).toEqual(['bastion', 'dev']);
    expect((await hosts.list()).map((host) => host.id)).toEqual(['bastion', 'dev']);
    await hosts.setSyncSshConfig(false);
    expect(await hosts.list()).toEqual([]);
    await hosts.setSyncSshConfig(true);
    expect((await hosts.list()).map((host) => host.id)).toEqual(['bastion', 'dev']);
    const resolved = await resolveSshConfig('dev', config);
    expect(resolved).toMatchObject({ hostname: '127.0.0.1', user: 'tester', port: 2222 });
    await writeFile(config, (await readFile(config, 'utf8')).replace('HostName 127.0.0.1', 'HostName redirected.example.test'));
    expect(await hosts.resolve('dev')).toMatchObject({ hostname: 'redirected.example.test', user: 'tester', port: 2222 });
    await hosts.upsert({ id: 'gpu', name: 'GPU', hostname: 'gpu.example.test', user: 'tester', port: 2200 });
    await hosts.writeBack('gpu');
    expect(await readFile(config, 'utf8')).toContain('Host gpu\n  HostName gpu.example.test\n  User tester\n  Port 2200');
    await expect(hosts.writeBack('gpu')).rejects.toThrow('already exists');
    await expect(appendSshHost(config, '-bad', 'example.test', 'tester', 22)).rejects.toThrow('Invalid SSH host alias');
    await expect(resolveSshConfig('-oProxyCommand=bad', config)).rejects.toThrow('Invalid SSH host alias');
  });

  it('recovers native path boundaries for Windows lists, spaces, Includes and expanded tokens', async () => {
    const { home, config } = await fixture();
    const defaults = await resolveSshConfig('dev', config);
    expect(defaults.userKnownHostsFiles).toHaveLength(2);
    expect(defaults.userKnownHostsFiles[0]).toMatch(/[/\\]known_hosts$/);
    expect(defaults.userKnownHostsFiles[1]).toMatch(/[/\\]known_hosts2$/);
    const first = 'C:\\Users\\tester\\.ssh\\known_hosts';
    const second = 'C:\\Users\\tester\\.ssh\\known_hosts2';
    await writeFile(config, `Host dev\n  HostName example.test\n  User tester\n  UserKnownHostsFile ${first} ${second}\n`);
    expect((await resolveSshConfig('dev', config)).userKnownHostsFiles).toEqual([first, second]);
    const spaced = join(home, '.ssh', 'known hosts');
    await writeFile(join(home, '.ssh', 'fragments', 'paths'), `Host dev\n  UserKnownHostsFile "${spaced}" "~/.ssh/%h-%p-%r-%%"\n`);
    await writeFile(config, `Include "${join(home, '.ssh', 'fragments', 'paths')}"\nHost dev\n  HostName example.test\n  User tester\n  Port 2200\n`);
    const paths = (await resolveSshConfig('dev', config)).userKnownHostsFiles;
    expect(paths[0]).toBe(spaced);
    expect(paths[1]).toMatch(/[/\\]example\.test-2200-tester-%$/);
    await writeFile(config, `Host other\n  UserKnownHostsFile "${spaced} second"\nHost dev\n  UserKnownHostsFile "${spaced}" second\n  HostName example.test\n  User tester\n`);
    await expect(resolveSshConfig('dev', config)).rejects.toThrow('path boundaries');
  });

  it('parses temporary SSH targets without shell options or invalid ports', () => {
    expect(parseTransientSshTarget('tester@example.test:2222')).toEqual({
      user: 'tester', hostname: 'example.test', port: 2222,
    });
    expect(parseTransientSshTarget('tester@example.test')).toEqual({
      user: 'tester', hostname: 'example.test', port: 22,
    });
    for (const invalid of ['-oProxyCommand=evil@example.test', 'tester@example.test:0',
      'tester@example.test:65536', 'tester@host/../../secret', 'tester@host;evil']) {
      expect(parseTransientSshTarget(invalid)).toBeUndefined();
    }
  });

  it('persists global connection approval independently of workspace hosts and config sync', async () => {
    const { home, hosts } = await fixture();
    expect(await hosts.connectionApprovalEnabled()).toBe(true);
    await hosts.setConnectionApproval(false);
    await hosts.upsert({ id: 'dev', name: 'Workspace dev' }, 'workspace-1');
    expect(await hosts.connectionApprovalEnabled()).toBe(false);
    expect(await readFile(join(home, 'ssh', 'hosts.toml'), 'utf8')).toContain('connection_approval = false');
    await hosts.setConnectionApproval(true);
    expect(await hosts.connectionApprovalEnabled()).toBe(true);
  });

  it('inherits shared SSH hosts with home precedence and writes only into the child', async () => {
    const { home, config } = await fixture();
    const base = await mkdtemp(join(tmpdir(), 'kiki-ssh-base-'));
    directories.push(base);
    const baseDocs = new TomlAtomicDocumentStore(new FileStorageService(base, 0o700, 0o600));
    const homeDocs = new TomlAtomicDocumentStore(new FileStorageService(home, 0o700, 0o600));
    await baseDocs.setText('', 'ssh/hosts.toml', '[hosts.shared]\nname = "Base"\nhostname = "base.example.test"\n[hosts.dev]\nname = "Base dev"\n');
    const child = new SshHostStore(homeDocs, config, baseDocs);
    expect((await child.list()).find((host) => host.id === 'shared')?.name).toBe('Base');
    await child.upsert({ id: 'dev', name: 'Child dev', hostname: 'child.example.test' });
    expect((await child.list()).find((host) => host.id === 'dev')?.hostname).toBe('child.example.test');
    expect(await baseDocs.getText('', 'ssh/hosts.toml')).toContain('Base dev');
    expect(await homeDocs.getText('', 'ssh/hosts.toml')).toContain('Child dev');
    const isolated = new SshHostStore(homeDocs, config);
    expect((await isolated.list()).some((host) => host.id === 'shared')).toBe(false);
  });

  it('accepts only absolute POSIX workspace roots', async () => {
    const { hosts } = await fixture();
    const host = { id: 'gpu', name: 'GPU', hostname: 'gpu.example.test' };
    for (const root of ['relative', 'C:\\work', '/work\\other', '/work\0other']) {
      await expect(hosts.upsert({ ...host, roots: [root] })).rejects.toThrow('absolute POSIX');
    }
    await expect(hosts.upsert({ ...host, roots: [] })).rejects.toThrow('absolute POSIX');
    await hosts.upsert({ ...host, roots: ['/home/user/../user/project', '/scratch'] });
    expect((await hosts.list()).find((entry) => entry.id === 'gpu')?.roots).toEqual(['/home/user/project', '/scratch']);
  });

  it('scopes a temporary user@host:port target to one session without persisting it', async () => {
    const { home } = await fixture();
    const disposables = new DisposableStore();
    try {
      const ix = createServices(disposables, {
        additionalServices: (registry) => {
          registry.defineInstance(IFileSystemStorageService, new FileStorageService(home, 0o700, 0o600));
          registry.define(ISshHostDocumentStore, TomlAtomicDocumentStore);
          registry.definePartialInstance(IBootstrapService, { homeDir: home, osHomeDir: home });
          registry.definePartialInstance(IFlagService, { enabled: () => true });
          registry.definePartialInstance(ISshCredentialStore, { read: async () => undefined, forget: async () => undefined });
          registry.define(ISshHostService, SshHostService);
        },
      });
      const service = ix.get(ISshHostService);
      await service.addTransient('tester@example.test:2202', 'workspace-1', 'session-1');
      expect((await service.list('workspace-1')).some((entry) => entry.source === 'session')).toBe(false);
      expect((await service.list('workspace-1', 'session-1')).at(-1)).toMatchObject({
        id: 'tester@example.test:2202', source: 'session', port: 2202,
      });
      expect((await service.list('workspace-1', 'session-2')).some((entry) => entry.source === 'session')).toBe(false);
      expect(await service.resolveTarget('tester@example.test:2202', 'workspace-1')).toMatchObject({
        hostname: 'example.test', user: 'tester', port: 2202,
      });
      await service.addTransient('second@example.test:2203', 'C:/work/one', 'session-1');
      await service.addTransient('third@example.test:2204', 'C:/work/two', 'session-2');
      await service.removeSessionTransients('session-1');
      expect((await service.listRuntimeHosts('workspace-1')).some((entry) => entry.source === 'session')).toBe(false);
      expect((await service.listRuntimeHosts('C:/work/one')).some((entry) => entry.source === 'session')).toBe(false);
      expect((await service.list('C:/work/two', 'session-2')).some((entry) => entry.source === 'session')).toBe(true);
      await service.removeTransient('third@example.test:2204', 'C:/work/two', 'session-2');
    } finally {
      await disposables.dispose();
    }
  });

  it('refuses an approved target redirected before SSH transport acquisition', async () => {
    const { home, config } = await fixture();
    const disposables = new DisposableStore();
    try {
      const ix = createServices(disposables, {
        additionalServices: (registry) => {
          registry.defineInstance(IFileSystemStorageService, new FileStorageService(home, 0o700, 0o600));
          registry.define(ISshHostDocumentStore, TomlAtomicDocumentStore);
          registry.definePartialInstance(IBootstrapService, { homeDir: home, osHomeDir: home });
          registry.definePartialInstance(IFlagService, { enabled: () => true });
          registry.definePartialInstance(ISshCredentialStore, { read: async () => undefined, forget: async () => undefined });
          registry.define(ISshHostService, SshHostService);
        },
      });
      const service = ix.get(ISshHostService);
      const record = (await service.list()).find((host) => host.id === 'dev')!;
      const fingerprint = JSON.stringify({ record, target: await service.resolveTarget('dev') });
      await writeFile(config, (await readFile(config, 'utf8')).replace('HostName 127.0.0.1', 'HostName redirect.example.test'));
      await expect(service.connect('dev', undefined, undefined, true, fingerprint)).rejects.toThrow('changed after connection approval');
      expect(service.status('dev').state).toBe('idle');
    } finally {
      await disposables.dispose();
    }
  });

  it('resolves the app-scoped host service through DI and gates connections with the native SSH flag', async () => {
    const { home } = await fixture();
    const disposables = new DisposableStore();
    try {
      const ix = createServices(disposables, {
        additionalServices: (registry) => {
          registry.defineInstance(IFileSystemStorageService, new FileStorageService(home, 0o700, 0o600));
          registry.define(ISshHostDocumentStore, TomlAtomicDocumentStore);
          registry.definePartialInstance(IBootstrapService, { homeDir: home, osHomeDir: home });
          registry.definePartialInstance(IFlagService, { enabled: () => false });
          registry.definePartialInstance(ISshCredentialStore, { read: async () => undefined, forget: async () => undefined });
          registry.define(ISshHostService, SshHostService);
        },
      });
      const service = ix.get(ISshHostService);
      await service.upsert({ id: 'dev', name: 'Dev', hostname: '127.0.0.1', user: 'tester' });
      expect((await service.list()).map((host) => host.id)).toEqual(['bastion', 'dev']);
      await expect(service.connect('dev')).rejects.toThrow('Native SSH is disabled');
    } finally {
      await disposables.dispose();
    }
  });

  it('forgets saved credentials when auth changes, on removal, and before re-adding the same ID', async () => {
    const { home } = await fixture();
    const values = new Map<string, string>();
    const factory: SecretEntryFactory = async (account) => ({
      async setPassword(value) { values.set(account, value); },
      async getPassword() { return values.get(account); },
      async deleteCredential() { return values.delete(account); },
    });
    const store = new SshCredentialStore(home, factory);
    const disposables = new DisposableStore();
    try {
      const ix = createServices(disposables, { additionalServices: (registry) => {
        registry.defineInstance(IFileSystemStorageService, new FileStorageService(home, 0o700, 0o600));
        registry.define(ISshHostDocumentStore, TomlAtomicDocumentStore);
        registry.definePartialInstance(IBootstrapService, { homeDir: home, osHomeDir: home });
        registry.definePartialInstance(IFlagService, { enabled: () => false });
        registry.definePartialInstance(ISshCredentialStore, store);
        registry.define(ISshHostService, SshHostService);
      } });
      const service = ix.get(ISshHostService);
      const account = JSON.stringify(['workspace', 'dev']);
      const host = { id: 'dev', name: 'Dev', hostname: 'example.test', user: 'tester' };
      await service.upsert(host, 'workspace');
      await store.save(account, 'password', 'old password');
      const key = await store.savePrivateKey(account, 'test private key');
      await store.save(account, 'identityFile', key);
      await store.save(account, 'passphrase', 'old passphrase');
      await service.upsert({ ...host, identityFile: '/tmp/new-key' }, 'workspace');
      expect(await store.read(account, 'password')).toBeUndefined();
      expect(await store.read(account, 'passphrase')).toBeUndefined();
      await expect((await import('node:fs/promises')).stat(key)).rejects.toMatchObject({ code: 'ENOENT' });
      const nextKey = await store.savePrivateKey(account, 'replacement key');
      await store.save(account, 'identityFile', nextKey);
      await store.save(account, 'password', 'new password');
      await service.remove('dev', 'workspace');
      for (const kind of ['password', 'passphrase', 'identityFile'] as const) expect(await store.read(account, kind)).toBeUndefined();
      await expect((await import('node:fs/promises')).stat(nextKey)).rejects.toMatchObject({ code: 'ENOENT' });
      await service.upsert(host, 'workspace');
      expect(await store.read(account, 'password')).toBeUndefined();
      expect(values.size).toBe(0);
    } finally {
      await disposables.dispose();
    }
  });
});


describe('S5 authoritative SSH settings reads', () => {
  const documents = new DisposableStore();
  afterEach(async () => { await documents.clear(); });
  function persistedDocuments(home: string) {
    const ix = createServices(documents, { additionalServices: (registry) => {
      registry.defineInstance(IFileSystemStorageService, new FileStorageService(home, 0o700, 0o600));
      registry.define(ISshHostDocumentStore, TomlAtomicDocumentStore);
    } });
    return ix.get(ISshHostDocumentStore);
  }

  it('reads default, persisted off and on after refresh with empty or fully shadowed config', async () => {
    const { home, config, hosts } = await fixture();
    await writeFile(config, '');
    expect(await hosts.configSync()).toEqual({ enabled: true, source: 'default' });
    expect(await hosts.list()).toEqual([]);
    const refresh = () => new SshHostStore(persistedDocuments(home), config);
    for (const enabled of [false, true, false]) {
      await hosts.setSyncSshConfig(enabled);
      expect(await refresh().configSync()).toEqual({ enabled, source: 'home' });
      expect(await refresh().list()).toEqual([]);
    }
    await writeFile(config, 'Host dev\n  HostName example.test\n');
    await hosts.upsert({ id: 'dev', name: 'Saved', hostname: 'saved.example.test' });
    await hosts.setSyncSshConfig(true);
    expect(await refresh().list()).toMatchObject([{ id: 'dev', source: 'kiki' }]);
    expect(await refresh().configSync()).toEqual({ enabled: true, source: 'home' });
    await hosts.setSyncSshConfig(false);
    expect(await refresh().list()).toMatchObject([{ id: 'dev', source: 'kiki' }]);
    expect(await refresh().configSync()).toEqual({ enabled: false, source: 'home' });
  });

  it('reports base and home precedence and propagates invalid or failed settings reads', async () => {
    const { home, config } = await fixture();
    const base = await mkdtemp(join(tmpdir(), 'kiki-ssh-base-'));
    directories.push(base);
    const baseDocs = persistedDocuments(base);
    const homeDocs = persistedDocuments(home);
    await baseDocs.setText('', 'ssh/hosts.toml', 'sync_ssh_config = false\n');
    const store = new SshHostStore(homeDocs, config, baseDocs);
    expect(await store.configSync()).toEqual({ enabled: false, source: 'base' });
    await store.setSyncSshConfig(true);
    expect(await store.configSync()).toEqual({ enabled: true, source: 'home' });
    expect(await baseDocs.getText('', 'ssh/hosts.toml')).toBe('sync_ssh_config = false\n');
    await homeDocs.setText('', 'ssh/hosts.toml', 'sync_ssh_config = "false"\n');
    await expect(store.configSync()).rejects.toThrow('Invalid SSH config sync setting');
    const failed = vi.spyOn(homeDocs, 'getText').mockRejectedValue(new Error('fixture read failed'));
    await expect(store.configSync()).rejects.toThrow('fixture read failed');
    failed.mockRestore();
  });

  it('inspects saved identity overrides without connecting, credentials or trust writes', async () => {
    const { home, config } = await fixture();
    const path = join(home, '.ssh', 'known_hosts');
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid test host key');
    const text = `[saved.example.test]:2200 ssh-rsa ${parsed.getPublicSSH().toString('base64')}\n`;
    await writeFile(path, text);
    await writeFile(config, `Host dev\n  HostName alias.example.test\n  User tester\n  Port 2222\n  UserKnownHostsFile ${path}\n`);
    const disposables = new DisposableStore();
    const create = vi.spyOn(SSHKaos, 'create');
    const credentials = vi.fn(async () => { throw new Error('Unexpected credentials read'); });
    try {
      const ix = createServices(disposables, { additionalServices: (registry) => {
        registry.defineInstance(IFileSystemStorageService, new FileStorageService(home, 0o700, 0o600));
        registry.define(ISshHostDocumentStore, TomlAtomicDocumentStore);
        registry.definePartialInstance(IBootstrapService, { homeDir: home, osHomeDir: home });
        registry.definePartialInstance(IFlagService, { enabled: () => true });
        registry.definePartialInstance(ISshCredentialStore, { read: credentials, forget: async () => undefined });
        registry.define(ISshHostService, SshHostService);
      } });
      const service = ix.get(ISshHostService);
      await service.upsert({ id: 'dev', name: 'Saved', hostname: 'saved.example.test', user: 'tester', port: 2200 }, 'workspace');
      expect(await service.hostKeys('dev', 'workspace')).toMatchObject({ hostId: 'dev', workspaceId: 'workspace',
        hostname: 'saved.example.test', port: 2200, state: 'recorded', records: [{ algorithm: 'ssh-rsa', status: 'recorded' }] });
      expect(await service.hostKeys('dev')).toMatchObject({ hostname: 'alias.example.test', port: 2222, state: 'unrecorded' });
      await expect(service.hostKeys('absent')).rejects.toThrow('Unknown SSH host');
      await writeFile(config, `Host dev\n  HostName alias.example.test\n  User tester\n  UserKnownHostsFile "${path} second"\n`);
      expect((await service.resolveTarget('dev')).userKnownHostsFiles).toEqual([`${path} second`]);
      expect(await service.hostKeys('dev')).toMatchObject({ state: 'unrecorded', files: [{ path: `${path} second`, state: 'missing' }] });
      await writeFile(config, `Host dev\n  HostName alias.example.test\n  User tester\n  UserKnownHostsFile ${path} second\n`);
      expect((await service.resolveTarget('dev')).userKnownHostsFiles).toEqual([path, 'second']);
      expect(await service.hostKeys('dev')).toMatchObject({ state: 'unrecorded', files: [{ path, state: 'read' }, { path: 'second', state: 'missing' }] });
      await writeFile(config, 'Host dev\n  HostName alias.example.test\n  User tester\n  UserKnownHostsFile none\n');
      expect((await service.resolveTarget('dev')).userKnownHostsFiles).toEqual([]);
      expect(await service.hostKeys('dev')).toMatchObject({ state: 'unrecorded', files: [] });
      expect(create).not.toHaveBeenCalled();
      expect(credentials).not.toHaveBeenCalled();
      expect(service.status('dev', 'workspace').state).toBe('idle');
      expect(await readFile(path, 'utf8')).toBe(text);
    } finally {
      create.mockRestore();
      await disposables.dispose();
    }
  });
});
