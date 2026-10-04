import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ISshHostService } from '#/app/ssh/sshService';
import type { SshHostRecord } from '#/app/ssh/sshHosts';
import { ISshHostService as HostToken, SshHostService } from '#/app/ssh/sshService';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ISshCredentialStore } from '#/persistence/interface/sshCredentialStore';
import { ISshHostDocumentStore } from '#/persistence/interface/sshHostDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { workspaceSshKey } from '#/app/ssh/sshConfig';
import { AgentRuntimeService, IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IRuntimeResolver, IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { SshConnectionGateService, ISshConnectionGateService } from '#/agent/ssh/sshConnectionGateService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeResolveToolContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionApprovalService } from '#/session/approval/approval';
import { prepareToolRuntime, acquireToolRuntime } from '#/agent/tools/os/sshToolTarget';
import { Readable, Writable } from 'node:stream';
import { IBashTool } from '#/agent/tools/os/bash/bash';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IConfigService } from '#/app/config/config';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { RuntimeBinding } from '#/runtime/runtime';
import type { WorkspaceInstanceChange } from '#/workspace/workspaceInstance/workspaceInstanceManager';
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

async function approvedPreparationFixture() {
  const disposables = new DisposableStore();
  const registry = new RuntimeRegistry('workspace');
  registry.register(new FakeRuntime({ workspaceId: 'workspace', runtimeId: 'local', generation: 'local-one' }));
  let enabled = true;
  let decision: 'approved' | 'rejected' = 'approved';
  let agentId = 'main';
  const binding = { workspaceId: 'workspace', runtimeId: 'local' };
  let gate: ((context: BeforeResolveToolContext) => Promise<string | undefined>) | undefined;
  const credentials = { read: vi.fn(async () => undefined), forget: vi.fn(async () => undefined) };
  const tasks = new Map<string, Promise<void>>();
  const exec = vi.fn(async () => ({
    pid: 123, exitCode: 0, stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    stdout: Readable.from(['example-host\n']), stderr: Readable.from([]),
    wait: async () => 0, kill: async () => {}, dispose: async () => {},
  }));
  const ix = createServices(disposables, {
    strict: true,
    additionalServices: (reg) => {
      reg.defineInstance(IFileSystemStorageService, new FileStorageService(testHome, 0o700, 0o600));
      reg.define(ISshHostDocumentStore, TomlAtomicDocumentStore);
      reg.definePartialInstance(IBootstrapService, { homeDir: testHome, osHomeDir: testHome });
      reg.definePartialInstance(IFlagService, { enabled: () => enabled });
      reg.definePartialInstance(ISshCredentialStore, credentials);
      reg.define(HostToken, SshHostService);
      reg.definePartialInstance(IAgentRuntimeBindingService, { current: binding, onDidChange: Event.None as Event<RuntimeBinding> });
      reg.definePartialInstance(IRuntimeResolver, {
        inspect: (value) => registry.inspect(value), acquire: (value, required) => registry.acquire(value, required),
      });
      reg.definePartialInstance(IWorkspaceInstanceManager, {
        onDidChange: Event.None as Event<WorkspaceInstanceChange>, get: () => ({ runtimes: registry }) as never,
        prepareSshRuntime: async () => { await ix.get(HostToken).refreshRuntimeHosts('workspace'); },
      });
      reg.definePartialInstance(IAgentPermissionModeService, { mode: 'auto' });
      reg.define(IAgentRuntimeService, AgentRuntimeService);
      reg.definePartialInstance(IAgentToolExecutorService, {
        registerBeforeResolveTool: (handler) => { gate = handler; return { dispose: () => { gate = undefined; } }; },
      });
      reg.definePartialInstance(IAgentContextInjectorService, { register: () => ({ dispose: () => {} }) });
      reg.definePartialInstance(IAgentScopeContext, { get agentId() { return agentId; } });
      reg.definePartialInstance(ISessionContext, { sessionId: 'session', workspaceId: 'workspace' });
      reg.define(ISessionStateService, SessionStateService);
      reg.definePartialInstance(ISessionApprovalService, {
        request: async () => ({ decision }), takeSshCredential: () => undefined, clearSshCredential: () => {},
      });
      reg.define(ISshConnectionGateService, SshConnectionGateService);
      reg.definePartialInstance(ISessionWorkspaceContext, { workDir: '/local', additionalDirs: [] });
      reg.definePartialInstance(IAgentToolPolicyService, { isToolActive: () => false });
      reg.definePartialInstance(IConfigService, { get: <T>() => ({}) as T });
      reg.definePartialInstance(IAgentTaskService, {
        registerTask: (task) => {
          const id = `task-${tasks.size}`;
          tasks.set(id, Promise.resolve(task.start({ signal: new AbortController().signal,
            appendOutput: () => {}, settle: async () => true })));
          return id;
        },
        getTask: () => undefined,
        waitForForegroundRelease: async (id) => { await tasks.get(id); return 'terminal'; },
      });
      reg.define(IBashTool, BashTool);
    },
  });
  const hosts = ix.get(HostToken);
  const documents = ix.get(ISshHostDocumentStore);
  await documents.setText('', 'ssh/hosts.toml', 'sync_ssh_config = false\n');
  const target = { hostname: 'dev.example.test', user: 'tester', port: 22, identityFiles: [], userKnownHostsFiles: [] };
  vi.spyOn(hosts, 'resolveTarget').mockResolvedValue(target);
  const connect = vi.spyOn(hosts, 'connect').mockImplementation(async (id, workspaceId, _trust, _auto, fingerprint) => {
    const record = (await hosts.listRuntimeHosts(workspaceId!)).find((item) => item.id === id);
    if (fingerprint !== undefined && fingerprint !== JSON.stringify({ record, target })) throw new Error('fixture target changed after approval');
    return {
      probeEnvironment: async () => {},
      osEnv: { osKind: 'POSIX', osArch: 'x64', osVersion: 'fixture', shellName: 'sh', shellPath: '/bin/sh' },
      gethome: () => '/home/tester', getcwd: () => '/home/tester', withCwd: () => ({ execWithEnv: exec }),
    } as never;
  });
  const attachment = await new SshRuntimeProviderFactory().attach({
    id: 'workspace', root: '/local', metadata: { id: 'workspace', root: '/local', name: 'local', createdAt: 0, lastOpenedAt: 0, pinned: false },
  }, {
    get: () => hosts,
    provide: () => { throw new Error('unexpected local service'); },
    registerRuntime: (runtime) => {
      const handle = registry.register(runtime);
      return { runtimeId: runtime.identity.runtimeId, update: async (make) => handle.replace(await make()), remove: () => handle.remove() };
    },
  } as RuntimeProviderHost);
  ix.get(ISshConnectionGateService);
  const runtime = ix.get(IAgentRuntimeService);
  return {
    registry, runtime, connect, binding, credentials, exec,
    bash: async () => {
      const args = { host: 'dev', command: 'hostname', timeout: 20 };
      const signal = new AbortController().signal;
      const error = await gate!({ tool: { name: 'Bash' }, toolCall: { id: 'bash', name: 'Bash' },
        args, signal, turnId: 1, toolCalls: [] } as unknown as BeforeResolveToolContext);
      if (error !== undefined) throw new Error(error);
      const execution = ix.get(IBashTool).resolveExecution(args);
      if (!('execute' in execution)) throw new Error('Bash did not resolve an executable operation');
      return execution.execute({ signal, turnId: 1, toolCallId: 'bash' });
    },
    approve: async () => gate!({ tool: { name: 'Bash' }, toolCall: { id: 'approve', name: 'Bash' },
      args: { host: 'dev', command: 'hostname', timeout: 20 }, signal: new AbortController().signal,
      turnId: 1, toolCalls: [] } as unknown as BeforeResolveToolContext),
    removeInventory: async () => documents.setText('', workspaceSshKey('workspace'), ''),
    setEnabled: (value: boolean) => { enabled = value; },
    setDecision: (value: typeof decision) => { decision = value; },
    setAgent: (value: string) => { agentId = value; },
    writeInventory: async (workspaceId = 'workspace', hidden = false) => {
      await documents.setText('', workspaceSshKey(workspaceId), `[hosts.dev]\nname = "Development"\nroots = ["/home/tester"]\n${hidden ? 'agentAccess = "hidden"\n' : ''}`);
    },
    call: async (host = 'dev') => {
      const error = await gate!({ tool: { name: 'Bash' }, toolCall: { id: 'call', name: 'Bash' },
        args: { host, command: 'hostname', timeout: 20 }, signal: new AbortController().signal,
        turnId: 1, toolCalls: [] } as unknown as BeforeResolveToolContext);
      if (error !== undefined) return error;
      await prepareToolRuntime(runtime, host);
      const lease = acquireToolRuntime(runtime, host, ['process']);
      const selected = lease.runtime.identity.runtimeId;
      lease.dispose();
      return selected;
    },
    dispose: async () => { disposables.dispose(); await attachment.dispose(); await registry.dispose(); },
  };
}

describe('approved SSH tool preparation', () => {
  it('registers a configured host discovered after workspace attachment before the explicit Bash target is acquired', async () => {
    const f = await approvedPreparationFixture();
    try {
      await f.writeInventory();
      expect(f.registry.current('ssh:dev')).toBeUndefined();
      const result = await f.bash();
      expect(result.isError, String(result.output)).not.toBe(true);
      expect(result.output).toContain('host: dev\nexample-host');
      expect(f.exec).toHaveBeenCalledWith(['/bin/sh', '-c', "cd '/home/tester' && hostname"], expect.any(Object));
      expect(f.registry.current('ssh:dev')).toBeDefined();
      expect(f.binding.runtimeId).toBe('local');
      expect(f.credentials.read).not.toHaveBeenCalled();
      await Promise.all([f.call(), f.call()]);
      expect(f.registry.list().map((item) => item.identity.runtimeId)).toEqual(['local', 'ssh:dev']);
    } finally { await f.dispose(); }
  });

  it('keeps unknown, hidden, other-workspace and unjoined subagent targets out of registration and connection', async () => {
    const f = await approvedPreparationFixture();
    try {
      expect(await f.call()).toContain('not available');
      await f.writeInventory('other');
      expect(await f.call()).toContain('not available');
      await f.writeInventory('workspace', true);
      expect(await f.call()).toContain('not available');
      await f.writeInventory();
      f.setAgent('child');
      expect(await f.call()).toContain('subagent cannot connect');
      expect(f.registry.current('ssh:dev')).toBeUndefined();
      expect(f.connect).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it('does not prepare denied or disabled hosts or change the default binding for a local override', async () => {
    const f = await approvedPreparationFixture();
    try {
      await f.writeInventory();
      f.setDecision('rejected');
      expect(await f.call()).toContain('not approved');
      await expect(f.runtime.prepareFor!('dev')).rejects.toThrow('connection gate');
      expect(f.registry.current('ssh:dev')).toBeUndefined();
      f.setEnabled(false);
      await expect(f.runtime.prepareFor!('dev')).rejects.toThrow('Native SSH is disabled');
      f.setEnabled(true);
      f.binding.runtimeId = 'ssh:missing';
      expect((await f.runtime.prepareFor!('local')).identity.runtimeId).toBe('local');
      expect(f.binding.runtimeId).toBe('ssh:missing');
      expect(f.connect).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it('preserves an approved restored SSH binding while repairing registration but never restores approval implicitly', async () => {
    const f = await approvedPreparationFixture();
    try {
      await f.writeInventory();
      f.binding.runtimeId = 'ssh:dev';
      await expect(f.runtime.prepareFor!()).rejects.toThrow('connection gate');
      expect(f.registry.current('ssh:dev')).toBeUndefined();
      f.binding.runtimeId = 'local';
      expect(await f.approve()).toBeUndefined();
      f.binding.runtimeId = 'ssh:dev';
      expect((await f.runtime.prepareFor!()).identity.runtimeId).toBe('ssh:dev');
      expect(f.binding.runtimeId).toBe('ssh:dev');
      expect(f.exec).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it('refuses changed and deleted inventory between gate approval and preparation without running a process', async () => {
    const f = await approvedPreparationFixture();
    try {
      await f.writeInventory();
      expect(await f.approve()).toBeUndefined();
      await f.writeInventory('workspace', true);
      await expect(f.runtime.prepareFor!('dev')).rejects.toThrow('fixture target changed after approval');
      await f.removeInventory();
      await expect(f.runtime.prepareFor!('dev')).rejects.toThrow('runtime ssh:dev does not exist');
      expect(f.registry.current('ssh:dev')).toBeUndefined();
      expect(f.exec).not.toHaveBeenCalled();
      expect(f.binding.runtimeId).toBe('local');
    } finally { await f.dispose(); }
  });
});
