import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ISshHostService } from '#/app/ssh/sshService';
import type { SshHostRecord } from '#/app/ssh/sshHosts';
import { ISshHostService as HostToken } from '#/app/ssh/sshService';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { SshRuntime, SshRuntimeProviderFactory } from '#/runtime/sshRuntime';
import type { RuntimeProviderHost } from '#/runtime/runtimeUnitHost';

const dev: SshHostRecord = { id: 'dev', name: 'dev', source: 'kiki', roots: ['/home/tester'] };
const staging: SshHostRecord = { id: 'staging', name: 'staging', source: 'kiki', roots: ['/srv/app'] };

let testHome: string;
beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), 'kiki-ssh-runtime-'));
  vi.stubEnv('KIKI_HOME', testHome);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(testHome, { recursive: true, force: true });
});

function fixture() {
  let hosts: SshHostRecord[] = [dev];
  let listener: ((workspaceId?: string) => void | Promise<void>) | undefined;
  let generation = 0;
  const service = {
    list: async () => hosts,
    listRuntimeHosts: async () => hosts,
    onHostsChanged: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; },
    onStatus: () => () => {},
    status: (hostId: string) => ({ hostId, state: 'ready' as const, generation }),
    connect: async () => { throw new Error('unexpected network connection'); },
  } as unknown as ISshHostService;
  const registry = new RuntimeRegistry('workspace');
  const providerHost = {
    get: (token: typeof HostToken) => {
      expect(token).toBe(HostToken);
      return service;
    },
    registerRuntime: (runtime: SshRuntime) => {
      const registration = registry.register(runtime);
      return {
        runtimeId: runtime.identity.runtimeId,
        update: (make: () => SshRuntime) => registration.replace(make()),
        remove: () => registration.remove(),
      };
    },
  } as RuntimeProviderHost;
  return {
    registry, providerHost, service,
    setHosts: async (next: SshHostRecord[]) => {
      hosts = next;
      await listener?.('workspace');
    },
    reconnect: () => { generation += 1; },
  };
}

describe('SSH runtime provider', () => {
  it('publishes, replaces, and removes host runtimes without making a connection', async () => {
    const { registry, providerHost, setHosts, reconnect } = fixture();
    const attachment = await new SshRuntimeProviderFactory().attach({
      id: 'workspace', root: '/local', metadata: { id: 'workspace', root: '/local', name: 'local', createdAt: 0, lastOpenedAt: 0, pinned: false },
    }, providerHost);
    try {
      const initial = registry.current('ssh:dev')!;
      expect(initial.workspace.mapRoots({ workDir: '/local' }).workDir).toBe('/home/tester');
      expect([...initial.capabilities]).toEqual(['fs', 'process']);
      reconnect();
      expect(initial.identity.generation).toBe('ssh-1');
      await setHosts([{ ...dev, roots: ['/home/new'] }, staging]);
      expect(registry.current('ssh:dev')).not.toBe(initial);
      expect(registry.current('ssh:dev')?.workspace.mapRoots({ workDir: '/local' }).workDir).toBe('/home/new');
      expect(registry.current('ssh:staging')?.workspace.mapRoots({ workDir: '/local' }).workDir).toBe('/srv/app');
      await setHosts([staging]);
      expect(registry.current('ssh:dev')).toBeUndefined();
    } finally {
      await attachment.dispose();
      await registry.dispose();
    }
  });

  it('does not map a local workspace as a remote authorization root before connecting', () => {
    const { service } = fixture();
    const runtime = new SshRuntime('workspace', { ...dev, roots: undefined }, service);
    expect(runtime.workspace.mapRoots({ workDir: 'C:/local' }).workDir).toBe('/__ssh_connection_required__');
    runtime.dispose();
  });

  it('passes first-key auto-trust only when explicitly requested by yolo', async () => {
    const { service } = fixture();
    const remote = { probeEnvironment: vi.fn(async () => undefined) };
    const connect = vi.spyOn(service, 'connect').mockResolvedValue(remote as never);
    const runtime = new SshRuntime('workspace', dev, service);
    await runtime.connect();
    await runtime.connect(true, 'approved-target');
    expect(connect).toHaveBeenNthCalledWith(1, 'dev', 'workspace', undefined, false, undefined, undefined, undefined);
    expect(connect).toHaveBeenNthCalledWith(2, 'dev', 'workspace', undefined, true, 'approved-target', undefined, undefined);
    expect(remote.probeEnvironment).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
});
