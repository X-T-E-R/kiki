import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';
import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { AgentBrowserService, IAgentBrowserService, IBrowserConnectionsTool, BrowserConnectionsTool, IBrowserTabsTool, BrowserTabsTool } from '#/agent/tools/browser/browserTools';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IBrowserControlService, type BrowserInvocation, type BrowserInvocationResult } from '#/app/browser/browser';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const defaults = createDecorator<{ readonly _serviceBrand: undefined; ready: Promise<string | undefined> }>('sessionBrowserDefault');
const tools = ['snapshot', 'fill', 'download', 'upload'].map((name) => ({ name: `agent_browser_${name}`, description: name,
  inputSchema: { type: 'object', properties: name === 'snapshot' ? {} : name === 'upload' ? { selector: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }
    : { selector: { type: 'string' }, ...(name === 'fill' ? { text: { type: 'string' } } : { path: { type: 'string' } }) },
    required: name === 'snapshot' ? [] : name === 'upload' ? ['selector', 'files'] : name === 'fill' ? ['selector', 'text'] : ['selector', 'path'] } }));

async function execute(work: ToolExecution | Promise<ToolExecution>): Promise<ExecutableToolResult> {
  const execution = await work;
  return 'execute' in execution ? execution.execute({ turnId: 1, toolCallId: 'test-call', signal: new AbortController().signal }) : execution;
}

describe('native browser agent selection, schema and local file channel', () => {
  it('forwards the execution context signal for connection and tab lifecycle tools', async () => {
    const ix = new TestInstantiationService();
    const connections = vi.fn(async () => ({ output: 'connection fixture' }));
    const tabs = vi.fn(async () => ({ output: 'tab fixture' }));
    ix.stub(IAgentBrowserService, { connections, tabs });
    ix.set(IBrowserConnectionsTool, new SyncDescriptor(BrowserConnectionsTool));
    ix.set(IBrowserTabsTool, new SyncDescriptor(BrowserTabsTool));
    const signal = new AbortController().signal;
    const context = { turnId: 1, toolCallId: 'fixture', signal };
    try {
      const connect = await ix.get(IBrowserConnectionsTool).resolveExecution({ action: 'connect', browser: 'a' });
      const window = await ix.get(IBrowserTabsTool).resolveExecution({ action: 'window', browser: 'a' });
      if (!('execute' in connect) || !('execute' in window)) throw new Error('Expected lifecycle executions');
      await connect.execute(context);
      await window.execute(context);
      expect(connections).toHaveBeenCalledWith({ action: 'connect', browser: 'a' }, signal);
      expect(tabs).toHaveBeenCalledWith({ action: 'window', browser: 'a' }, signal);
    } finally { await ix.dispose(); }
  });
  it('loads only requested schemas, rejects unobserved refs and transfers only the selected browser artifact through media', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiki-browser-agent-'));
    const ix = new TestInstantiationService();
    const calls: BrowserInvocation[] = [];
    const materialize = vi.fn(async () => 'fixture-media');
    const config = { id: 'a', type: 'agent-browser-profile' as const, name: 'A', enabled: true };
    const runtime = Object.assign(new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: '1' }, { pathClass: process.platform === 'win32' ? 'win32' : 'posix' }), { fs: new HostFileSystem() });
    ix.stub(IBrowserConnectionStore, { list: async () => ({ connections: [config] }), resolve: async (id) => { if (id !== 'a') throw new Error('Unknown id'); return config; } });
    ix.stub(defaults, { ready: Promise.resolve(undefined) });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { sessionId: 'session', sessionDir: directory });
    ix.stub(ISessionWorkspaceContext, { workDir: directory, additionalDirs: [] });
    ix.stub(IAgentRuntimeService, { inspect: () => runtime, prepareFor: async (host) => { expect(host).toBe('local'); return runtime; } });
    ix.stub(ISessionMediaStore, { materialize });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.stub(IBrowserControlService, {
      catalog: async () => tools,
      status: async () => ({ browser: 'a', state: 'ready', executionHost: 'fixture-host', generation: 1 }),
      tabs: async () => [{ tabId: 't1', targetId: 'a-target' }],
      invoke: async (input, signal): Promise<BrowserInvocationResult> => {
        if (input.tool === 'agent_browser_fill' || input.tool === 'agent_browser_snapshot' || input.tool === 'agent_browser_download') expect(signal).toBeInstanceOf(AbortSignal);
        calls.push(input);
        if (input.tool === 'agent_browser_download') await writeFile(String(input.args['path']), 'download-from-a');
        const data = input.tool === 'agent_browser_download' ? { path: input.args['path'] } : input.tool === 'agent_browser_snapshot' ? { refs: { e1: { name: 'A' } } } : {};
        return { browser: input.browser, executionHost: 'fixture-host', runtimeSession: 'fixture-a', generation: 1, tab: input.tab, frame: input.frame,
          result: { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { response: { success: true, data } } } };
      },
    });
    ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
    try {
      const service = ix.get(IAgentBrowserService);
      const registry = ix.get(IAgentToolRegistryService);
      expect((await service.connections({ action: 'tools' })).isError).toBe(true);
      expect(registry.list()).toHaveLength(0);
      await service.connections({ action: 'tools', browser: 'a', tools: ['agent_browser_fill'] });
      expect(registry.list().map((tool) => tool.name)).toEqual(['browser__agent_browser_fill']);
      expect(registry.list()[0]?.parameters?.['required']).toEqual(['selector', 'text']);
      await service.tabs({ action: 'select', browser: 'a', target: 'a-target' });
      const fill = registry.resolve('browser__agent_browser_fill')!;
      expect((await execute(fill.resolveExecution({ selector: '@e1', text: 'A' }))).isError).toBe(true);
      expect((await execute(fill.resolveExecution({ selector: '#field', text: 'A', session: 'other' }))).isError).toBe(true);
      expect(calls.filter((call) => call.tool === 'agent_browser_fill')).toHaveLength(0);
      await service.connections({ action: 'tools', tools: ['agent_browser_snapshot', 'agent_browser_download', 'agent_browser_upload'] });
      await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}));
      expect((await execute(fill.resolveExecution({ selector: '@e1', text: 'A' }))).isError).not.toBe(true);
      const path = join(directory, 'report.txt');
      const download = registry.resolve('browser__agent_browser_download')!;
      const execution = await download.resolveExecution({ selector: '#file', path });
      expect('execute' in execution && execution.accesses).toEqual(expect.arrayContaining([{ kind: 'file', operation: 'write', path: expect.any(String), implicitExternal: false }]));
      const output = await execute(execution);
      expect(JSON.stringify(output.output)).toContain('fixture-a');
      expect(JSON.stringify(output.output)).toContain('kimi-file');
      expect(await readFile(path, 'utf8')).toBe('download-from-a');
      expect(materialize).toHaveBeenCalledOnce();
      expect((await execute(registry.resolve('browser__agent_browser_upload')!.resolveExecution({ selector: '#upload', files: ['ssh://other/report.txt'] }))).isError).toBe(true);
      await service.connections({ action: 'tools', unload: ['agent_browser_fill', 'agent_browser_download'] });
      expect(registry.resolve('browser__agent_browser_fill')).toBeUndefined();
      expect(registry.resolve('browser__agent_browser_download')).toBeUndefined();
    } finally { await ix.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});
