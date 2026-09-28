import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { SshHostStore } from '#/app/ssh/sshHosts';
import { ISshHostService, SshHostService } from '#/app/ssh/sshService';
import { appendSshHost, discoverSshAliases, resolveSshConfig, workspaceSshKey } from '#/app/ssh/sshConfig';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { ISshCredentialStore } from '#/persistence/interface/sshCredentialStore';
import { ISshHostDocumentStore } from '#/persistence/interface/sshHostDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ home: string; config: string; hosts: SshHostStore }> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-ssh-hosts-'));
  directories.push(home);
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
    expect((await hosts.list('/work/one')).map((host) => host.name)).toEqual(['Workspace dev', 'GPU']);
    expect((await hosts.list('/work/two')).map((host) => host.name)).toEqual(['Development']);
    expect(await readFile(join(home, workspaceSshKey('/work/one')), 'utf8')).toContain('Workspace dev');
    await hosts.remove('dev', '/work/one');
    expect((await hosts.list('/work/one')).find((host) => host.id === 'dev')?.name).toBe('Development');
  });

  it('discovers Include aliases, toggles live sync, resolves ssh -G and writes only a selected host', async () => {
    const { config, hosts } = await fixture();
    expect((await discoverSshAliases(config))).toEqual(['bastion', 'dev']);
    expect((await hosts.discover()).map((host) => host.id)).toEqual(['bastion', 'dev']);
    expect(await hosts.list()).toEqual([]);
    await hosts.setSyncSshConfig(true);
    expect((await hosts.list()).map((host) => host.id)).toEqual(['bastion', 'dev']);
    const resolved = await resolveSshConfig('dev', config);
    expect(resolved).toMatchObject({ hostname: '127.0.0.1', user: 'tester', port: 2222 });
    await hosts.upsert({ id: 'gpu', name: 'GPU', hostname: 'gpu.example.test', user: 'tester', port: 2200 });
    await hosts.writeBack('gpu');
    expect(await readFile(config, 'utf8')).toContain('Host gpu\n  HostName gpu.example.test\n  User tester\n  Port 2200');
    await expect(hosts.writeBack('gpu')).rejects.toThrow('already exists');
    await expect(appendSshHost(config, '-bad', 'example.test', 'tester', 22)).rejects.toThrow('Invalid SSH host alias');
    await expect(resolveSshConfig('-oProxyCommand=bad', config)).rejects.toThrow('Invalid SSH host alias');
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
          registry.definePartialInstance(ISshCredentialStore, { read: async () => undefined });
          registry.define(ISshHostService, SshHostService);
        },
      });
      const service = ix.get(ISshHostService);
      await service.upsert({ id: 'dev', name: 'Dev', hostname: '127.0.0.1', user: 'tester' });
      expect((await service.list()).map((host) => host.id)).toEqual(['dev']);
      await expect(service.connect('dev')).rejects.toThrow('Native SSH is disabled');
    } finally {
      disposables.dispose();
    }
  });
});
