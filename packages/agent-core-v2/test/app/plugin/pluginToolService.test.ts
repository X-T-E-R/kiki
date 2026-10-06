import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentPluginToolService } from '#/agent/userTool/pluginToolService';
import type { IPluginService } from '#/app/plugin/plugin';
import type { IPluginHostService } from '#/app/plugin/pluginHostService';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
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

function setup(workspace: string) {
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
  const service = new AgentPluginToolService(plugin, hosts, registry, runtimeService, workspaceCtx, profile);
  return { service, tools, hosts, fs };
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
});
