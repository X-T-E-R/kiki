import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
      disposables.dispose();
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
      disposables.dispose();
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
      disposables.dispose();
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
      disposables.dispose();
    }
  });
});
