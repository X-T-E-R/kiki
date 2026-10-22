import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { AgentPluginToolService, IAgentPluginToolService } from '#/agent/userTool/pluginToolService';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService, type PluginUsageChange } from '#/app/pluginUsage/pluginUsage';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { TestInstantiationService } from '#/_base/di/testInstantiationService';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { ExecutableTool, RunnableToolExecution } from '#/tool/toolContract';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function dir() {
  const created = await mkdtemp(path.join(tmpdir(), 'kiki-plugin-path-'));
  directories.push(created);
  return created;
}

function setup(workspace: string, usage?: IPluginUsageService, workspaceId = 'workspace-a') {
  const plugin = { onDidReload: () => ({ dispose() {} }) } as unknown as IPluginService;
  const hosts = { list: vi.fn(async () => [{ pluginId: 'kiki-office', definition: {
    schemaVersion: 1 as const, name: 'office_create', description: 'Create a document',
    accesses: [{ kind: 'file' as const, operation: 'write' as const, path: '$.file' }, { kind: 'all' as const }],
    disclosure: 'deferred' as const,
  } }]), execute: vi.fn(async () => ({ output: 'created' })) } as unknown as IPluginHostService;
  const registry = new AgentToolRegistryService();
  const tools = { get: (name: string) => registry.resolve(name), has: (name: string) => registry.resolve(name) !== undefined };
  const runtime = new FakeRuntime({ workspaceId: 'w', runtimeId: 'local', generation: '1' },
    { pathClass: process.platform === 'win32' ? 'win32' : 'posix' });
  const fs = new HostFileSystem();
  Object.assign(runtime, { fs });
  const runtimeService = { inspect: () => runtime, acquire: () => ({ runtime, dispose() {} }) } as unknown as IAgentRuntimeService;
  const workspaceCtx = { workDir: workspace, additionalDirs: [] } as unknown as ISessionWorkspaceContext;
  const profile = { getModelCapabilities: () => ({ image_in: true }) } as unknown as IAgentProfileService;
  const container = new TestInstantiationService();
  container.set(IPluginService, plugin);
  container.set(IPluginHostService, hosts);
  container.set(IAgentToolRegistryService, registry);
  container.set(IAgentRuntimeService, runtimeService);
  container.set(ISessionWorkspaceContext, workspaceCtx);
  container.set(IAgentProfileService, profile);
  if (usage !== undefined) container.set(IPluginUsageService, usage);
  container.set(ISessionContext, { workspaceId, sessionId: 'session-old' } as ISessionContext);
  container.set(IAgentPluginToolService, new SyncDescriptor(AgentPluginToolService));
  const service = container.get(IAgentPluginToolService);
  return { service: { ready: () => service.ready(), dispose: () => container.dispose() }, tools, hosts, fs, registry };
}

function usageState(): {
  readonly usage: IPluginUsageService;
  readonly fire: (workspaceId: string) => Promise<void>;
} {
  const changed = new Emitter<PluginUsageChange>();
  return {
    usage: {
      enabled: () => true,
      allows: async () => true,
      onDidChange: changed.event,
    } as unknown as IPluginUsageService,
    fire: async (workspaceId) => {
      const waits: Promise<unknown>[] = [];
      changed.fire({
        workspaceId,
        pluginId: 'kiki-office',
        revision: 1,
        waitUntil: (promise) => waits.push(promise),
      });
      await Promise.all(waits);
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const context = { turnId: 1, toolCallId: 'one', signal: new AbortController().signal };

describe('plugin file target admission', () => {
  it('prepares a hot catalog before a safe boundary and keeps unchanged registrations stable', async () => {
    const state = usageState();
    const h = setup(await dir(), state.usage);
    try {
      await h.service.ready();
      const original = h.tools.get('plugin__kiki_office__office_create');
      const loading = deferred<void>();
      const entered = deferred<void>();
      const list = h.hosts.list.bind(h.hosts);
      vi.mocked(h.hosts.list).mockImplementationOnce(async () => {
        entered.resolve();
        await loading.promise;
        return list();
      });
      const change = state.fire('workspace-a');
      await entered.promise;
      let prepared = false;
      const preparation = h.registry.prepare().then(() => { prepared = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      try {
        expect(prepared).toBe(false);
        expect(h.tools.get('plugin__kiki_office__office_create')).toBe(original);
      } finally { loading.resolve(); }
      await Promise.all([change, preparation]);
      expect(prepared).toBe(true);
      expect(h.tools.get('plugin__kiki_office__office_create')).toBe(original);
    } finally { await h.service.dispose(); }
  });

  it('never lands a stale on snapshot after a newer off while catalog loading is in flight', async () => {
    const state = usageState();
    let allowed = false;
    let gate: ReturnType<typeof deferred<boolean>> | undefined;
    const h = setup(await dir(), { ...state.usage, allows: async () => gate === undefined ? allowed : gate.promise });
    try {
      await h.service.ready();
      gate = deferred<boolean>();
      const stale = gate;
      const enabling = state.fire('workspace-a');
      await vi.waitFor(() => { expect(h.hosts.list).toHaveBeenCalledTimes(2); });
      gate = undefined;
      allowed = false;
      const disabling = state.fire('workspace-a');
      stale.resolve(true);
      await Promise.all([enabling, disabling, h.registry.prepare()]);
      expect(h.tools.has('plugin__kiki_office__office_create')).toBe(false);
    } finally { await h.service.dispose(); }
  });

  it('withdraws an off tool even when the catalog fails and leaves ordinary preparation usable', async () => {
    const state = usageState();
    let allowed = true;
    const h = setup(await dir(), { ...state.usage, allows: async () => allowed });
    try {
      await h.service.ready();
      expect(h.tools.has('plugin__kiki_office__office_create')).toBe(true);
      allowed = false;
      vi.mocked(h.hosts.list).mockRejectedValueOnce(new Error('fixture catalog unavailable'));
      await expect(state.fire('workspace-a')).rejects.toThrow('fixture catalog unavailable');
      expect(h.tools.has('plugin__kiki_office__office_create')).toBe(false);
      await expect(h.registry.prepare()).resolves.toBeUndefined();
      await state.fire('workspace-a');
      await h.registry.prepare();
      expect(h.tools.has('plugin__kiki_office__office_create')).toBe(false);
    } finally { await h.service.dispose(); }
  });

  it('resolves $.file into a real target and only passes the approved outside target to its own host', async () => {
    const workspace = await dir();
    const outside = await dir();
    const { service, tools, hosts } = setup(workspace);
    try {
      await service.ready();
      const tool = tools.get('plugin__kiki_office__office_create')!;
      const local = await tool.resolveExecution({ file: 'draft.docx' }) as RunnableToolExecution;
      expect(local.accesses?.[0]).toMatchObject({ kind: 'file', path: path.join(workspace, 'draft.docx').replaceAll('\\', '/') });
      expect(local.approvalRule).toContain('draft.docx');
      await local.execute(context);
      expect(vi.mocked(hosts.execute).mock.lastCall?.[5]).toMatchObject({ workspaceRoot: workspace, approvedPaths: [], imageIn: true });
      const external = path.join(outside, 'draft.docx');
      const execution = await tool.resolveExecution({ file: external }) as RunnableToolExecution;
      expect(execution.accesses?.[0]).toMatchObject({ path: external.replaceAll('\\', '/') });
      await execution.execute(context);
      const scope = vi.mocked(hosts.execute).mock.lastCall?.[5];
      expect(scope?.approvedPaths).toEqual([outside.replaceAll('\\', '/')]);
      expect(vi.mocked(hosts.execute).mock.lastCall?.[2]).toEqual({ file: external.replaceAll('\\', '/') });
    } finally { await service.dispose(); }
  });

  it('rejects target replacement between approval and execution', async () => {
    const workspace = await dir();
    const { service, tools, hosts, fs } = setup(workspace);
    try {
      await service.ready();
      const target = path.join(workspace, 'document.docx');
      const execution = await tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: target }) as RunnableToolExecution;
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, 'realpath').mockImplementation((candidate) =>
        candidate.replaceAll('\\', '/') === target.replaceAll('\\', '/')
          ? Promise.resolve(path.join(workspace, 'replaced.docx').replaceAll('\\', '/')) : realpath(candidate));
      await expect(execution.execute(context)).resolves.toMatchObject({ isError: true, output: expect.stringContaining('changed') });
      expect(hosts.execute).not.toHaveBeenCalled();
    } finally { await service.dispose(); }
  });

  it('keeps workspace usage admission isolated and lets started calls complete after an off', async () => {
    const workspace = await dir();
    const state = usageState();
    let workspaceAAllowed = true;
    const sharedUsage = {
      ...state.usage,
      allows: async (workspaceId: string | undefined) => workspaceId !== 'workspace-a' || workspaceAAllowed,
    } as unknown as IPluginUsageService;
    const a = setup(workspace, sharedUsage, 'workspace-a');
    const b = setup(workspace, sharedUsage, 'workspace-b');
    try {
      await Promise.all([a.service.ready(), b.service.ready()]);
      const toolA = a.tools.get('plugin__kiki_office__office_create')!;
      const toolB = b.tools.get('plugin__kiki_office__office_create')!;
      const prepared = await toolA.resolveExecution({ file: path.join(workspace, 'late.docx') });
      if (prepared.isError === true) throw new Error('expected runnable workspace-A tool');

      workspaceAAllowed = false;
      await expect(prepared.execute(context)).resolves.toMatchObject({
        isError: true,
        output: expect.stringContaining('disabled in this session'),
      });
      expect(a.hosts.execute).not.toHaveBeenCalled();
      await state.fire('workspace-a');
      expect(a.tools.has('plugin__kiki_office__office_create')).toBe(false);
      expect(b.tools.has('plugin__kiki_office__office_create')).toBe(true);

      const bExecution = await toolB.resolveExecution({ file: path.join(workspace, 'b.docx') });
      if (bExecution.isError === true) throw new Error('expected runnable workspace-B tool');
      await expect(bExecution.execute(context)).resolves.toMatchObject({ output: 'created' });
      expect(b.hosts.execute).toHaveBeenCalledTimes(1);
      expect(vi.mocked(b.hosts.execute).mock.calls[0]?.[6]).toMatchObject({ name: 'office_create' });

      workspaceAAllowed = true;
      const started = deferred<void>();
      const released = deferred<{ readonly output: string }>();
      vi.mocked(a.hosts.execute).mockImplementation(async () => {
        started.resolve();
        return released.promise;
      });
      const active = await toolA.resolveExecution({ file: path.join(workspace, 'active.docx') });
      if (active.isError === true) throw new Error('expected active runnable workspace-A tool');
      const result = active.execute(context);
      await started.promise;
      workspaceAAllowed = false;
      released.resolve({ output: 'completed after off' });
      await expect(result).resolves.toEqual({ output: 'completed after off' });
      expect(a.hosts.execute).toHaveBeenCalledTimes(1);
    } finally {
      await a.service.dispose();
      await b.service.dispose();
    }
  });
});
