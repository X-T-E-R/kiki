import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { AgentPluginToolService } from '#/agent/userTool/pluginToolService';
import type { IPluginService } from '#/app/plugin/plugin';
import type { IPluginUsageService, PluginUsageChange } from '#/app/pluginUsage/pluginUsage';
import type { IPluginHostService } from '#/app/plugin/pluginHostService';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { IAgentProfileService } from '#/agent/profile/profile';
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
  const tools = new Map<string, ExecutableTool>();
  const registry = { register: (tool: ExecutableTool) => { tools.set(tool.name, tool); return { dispose: () => { tools.delete(tool.name); } }; },
    resolve: (name: string) => tools.get(name) } as unknown as IAgentToolRegistryService;
  const runtime = new FakeRuntime({ workspaceId: 'w', runtimeId: 'local', generation: '1' },
    { pathClass: process.platform === 'win32' ? 'win32' : 'posix' });
  const fs = new HostFileSystem();
  Object.assign(runtime, { fs });
  const runtimeService = { inspect: () => runtime, acquire: () => ({ runtime, dispose() {} }) } as unknown as IAgentRuntimeService;
  const workspaceCtx = { workDir: workspace, additionalDirs: [] } as unknown as ISessionWorkspaceContext;
  const profile = { getModelCapabilities: () => ({ image_in: true }) } as unknown as IAgentProfileService;
  const service = new AgentPluginToolService(
    plugin,
    hosts,
    registry,
    runtimeService,
    workspaceCtx,
    profile,
    undefined,
    usage,
    { workspaceId } as ISessionContext,
  );
  return { service, tools, hosts, fs };
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
        output: expect.stringContaining('disabled in this workspace'),
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
