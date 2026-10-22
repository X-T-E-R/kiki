import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';
import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { AgentBrowserService, IAgentBrowserService, IBrowserConnectionsTool, BrowserConnectionsTool, IBrowserTabsTool, BrowserTabsTool } from '#/agent/tools/browser/browserTools';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { TurnEnded } from '#/agent/loop/turnOps';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IBrowserControlService, type BrowserInvocation, type BrowserInvocationResult } from '#/app/browser/browser';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IConfigService, type ConfigSectionChangedEvent } from '#/app/config/config';
import { BROWSER_CONFIG_SECTION, type BrowserConfig } from '#/app/browser/browserConfig';
import { EXPERIMENTAL_SECTION, IFlagService } from '#/app/flag/flag';
import { Emitter } from '#/_base/event';
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

function sameBrowserControl(connections: BrowserConfig['connections']): { sections: Emitter<ConfigSectionChangedEvent>; config: BrowserConfig; store: { list: () => Promise<{ connections: Array<BrowserConfig['connections'][string] & { id: string }>; allowedBrowsers?: readonly string[]; disabledSources?: BrowserConfig['disabledSources'] }>; resolve: (id: string) => Promise<BrowserConfig['connections'][string] & { id: string }> }; configService: { onDidSectionChange: Emitter<ConfigSectionChangedEvent>['event']; get: <T>(domain: string) => T } } {
  const sections = new Emitter<ConfigSectionChangedEvent>();
  const config: BrowserConfig = { connections };
  return {
    sections,
    config,
    store: {
      list: async () => ({
        connections: Object.entries(config.connections).map(([id, entry]) => ({ ...entry, id })),
        ...(config.allowedBrowsers !== undefined ? { allowedBrowsers: config.allowedBrowsers } : {}),
        ...(config.disabledSources !== undefined ? { disabledSources: config.disabledSources } : {}),
      }),
      resolve: async (id: string) => {
        const entry = config.connections[id];
        if (entry === undefined) throw new Error('Unknown id');
        return { ...entry, id };
      },
    },
    configService: {
      onDidSectionChange: sections.event,
      get: <T>(domain: string) => (domain === BROWSER_CONFIG_SECTION ? config : undefined) as T,
    },
  };
}

function publishBrowser(sections: Emitter<ConfigSectionChangedEvent>, config: BrowserConfig): void {
  sections.fire({ domain: BROWSER_CONFIG_SECTION, source: 'set', value: config, previousValue: {} });
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
      expect(connections).toHaveBeenCalledWith({ action: 'connect', browser: 'a' }, signal, context);
      expect(tabs).toHaveBeenCalledWith({ action: 'window', browser: 'a' }, signal, context);
    } finally { await ix.dispose(); }
  });
  it('loads only requested schemas, rejects unobserved refs and transfers only the selected browser artifact through media', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiki-browser-agent-'));
    const ix = new TestInstantiationService();
    const calls: BrowserInvocation[] = [];
    const materialize = vi.fn(async () => 'fixture-media');
    const profile: BrowserConfig['connections'][string] = { type: 'agent-browser-profile', name: 'A', enabled: true };
    const browser = sameBrowserControl({ a: profile });
    const runtime = Object.assign(new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: '1' }, { pathClass: process.platform === 'win32' ? 'win32' : 'posix' }), { fs: new HostFileSystem() });
    ix.stub(IBrowserConnectionStore, browser.store);
    ix.stub(defaults, { ready: Promise.resolve(undefined) });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { sessionId: 'session', sessionDir: directory });
    ix.stub(ISessionWorkspaceContext, { workDir: directory, additionalDirs: [] });
    ix.stub(IAgentRuntimeService, { inspect: () => runtime, prepareFor: async (host) => { expect(host).toBe('local'); return runtime; } });
    ix.stub(ISessionMediaStore, { materialize });
    ix.stub(ISessionInteractionService, { hasConsumer: () => false });
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IConfigService, browser.configService);
    ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IBrowserControlService, {
      endTurn: async () => undefined,
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
      profile.enabled = false;
      publishBrowser(browser.sections, browser.config);
      expect(registry.list()).toEqual([]);
      profile.enabled = true;
      publishBrowser(browser.sections, browser.config);
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

  it('consumes the official js catalog with the real caller context and existing media output', async () => {
    const ix = new TestInstantiationService();
    const official: BrowserConfig['connections'][string] = { type: 'codex-extension', name: 'Official', enabled: true, runtimeRoot: '/fixture/cua_node', browserId: 'extension-fixture' };
    const browser = sameBrowserControl({ official });
    const js = { name: 'codex_browser_js', description: 'Official runtime JavaScript', inputSchema: { type: 'object', properties: { code: { type: 'string' }, title: { type: 'string' } }, required: ['code'] } };
    const invoke = vi.fn(async (input: BrowserInvocation): Promise<BrowserInvocationResult> => ({ browser: input.browser, executionHost: 'fixture-host', runtimeSession: 'official-runtime', generation: 1,
      tab: input.tab, result: { isError: false, content: [{ type: 'resource_link', uri: 'https://example.test/screenshot.png', mimeType: 'image/png' }], structuredContent: { official: true }, _meta: { donor: 'fixture' } } }));
    ix.stub(IBrowserConnectionStore, browser.store);
    ix.stub(defaults, { ready: Promise.resolve(undefined) });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { sessionId: 'fixture-session', sessionDir: '/fixture/session' });
    ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
    ix.stub(IAgentRuntimeService, {});
    ix.stub(ISessionMediaStore, {});
    ix.stub(ISessionInteractionService, { hasConsumer: () => false });
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IConfigService, browser.configService);
    ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    const endTurn = vi.fn(async () => undefined);
    const reset = { name: 'codex_browser_js_reset', description: 'Reset bindings, not browser tabs', inputSchema: { type: 'object', properties: {} } };
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IBrowserControlService, { catalog: async () => [js, reset], status: async () => ({ browser: 'official', state: 'ready', executionHost: 'fixture-host', generation: 1 }), invoke, endTurn });
    ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
    try {
      const service = ix.get(IAgentBrowserService);
      const loaded = await service.connections({ action: 'tools', browser: 'official', tools: ['codex_browser_js'] });
      expect(JSON.stringify(loaded.output)).toContain('official-cua-repl');
      const registry = ix.get(IAgentToolRegistryService);
      expect(registry.resolve('browser__codex_browser_js')?.parameters?.['required']).toEqual(['code']);
      browser.config.disabledSources = ['codex-browser'];
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve('browser__codex_browser_js')).toBeUndefined();
      browser.config.disabledSources = undefined;
      publishBrowser(browser.sections, browser.config);
      const tool = registry.resolve('browser__codex_browser_js')!;
      expect(tool.parameters?.['required']).toEqual(['code']);
      expect(tool.description).toContain('not a JavaScript sandbox');
      const output = await execute(tool.resolveExecution({ code: 'await cua.listBrowsers()', title: 'Browser inventory' }));
      expect(invoke).toHaveBeenCalledOnce();
      const call = invoke.mock.calls[0]![0];
      expect(call).toMatchObject({ caller: { sessionId: 'fixture-session', agentId: 'main' }, requestContext: { turnId: 1, toolCallId: 'test-call' }, args: { code: 'await cua.listBrowsers()', title: 'Browser inventory' } });
      expect(call.tab).toBeUndefined();
      expect(await call.requestContext!.elicit({ message: 'Allow?', requestedSchema: { type: 'object', properties: {} } }, new AbortController().signal)).toEqual({ action: 'cancel' });
      expect(output.output).toEqual(expect.arrayContaining([{ type: 'image_url', imageUrl: { url: 'https://example.test/screenshot.png' } }]));
      expect(JSON.stringify(output.output)).toContain('official-runtime');
      expect(JSON.stringify(output.output)).toContain('structuredContent');
      expect(JSON.stringify(output.output)).toContain('donor');
      await service.connections({ action: 'tools', tools: ['codex_browser_js_reset'] });
      await execute(registry.resolve('browser__codex_browser_js_reset')!.resolveExecution({}));
      expect(invoke.mock.calls[1]![0].tool).toBe('codex_browser_js_reset');
      for (const [turnId, reason] of [[1, 'completed'], [2, 'cancelled'], [3, 'failed'], [4, 'blocked']] as const) {
        ix.get(IEventBus).publish(new TurnEnded({ turnId, reason }));
        expect(endTurn).toHaveBeenLastCalledWith({ sessionId: 'fixture-session', agentId: 'main' }, turnId);
      }
      await (service as AgentBrowserService).dispose();
      await vi.waitFor(() => expect(endTurn).toHaveBeenLastCalledWith({ sessionId: 'fixture-session', agentId: 'main' }));
    } finally { await ix.dispose(); }
  });

  it('covers bridge discovery, connect, registration, DOM, fill, click, image, and unload through BrowserConnections', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const ix = new TestInstantiationService();
    const bridge: BrowserConfig['connections'][string] = { type: 'codex-extension', name: 'Bridge', enabled: true, runtimeRoot: 'C:/components/codex-browser-bridge.exe', browserId: 'codex-browser-use-selected' };
    const browser = sameBrowserControl({ bridge });
    const schema = (fields: string[], required: string[]) => ({ type: 'object', properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])), required });
    const catalog = [
      { name: 'codex_dom_snapshot', description: 'DOM', inputSchema: schema(['tab_id'], ['tab_id']) },
      { name: 'codex_fill', description: 'Fill', inputSchema: schema(['tab_id', 'selector', 'value'], ['tab_id', 'selector', 'value']) },
      { name: 'codex_click', description: 'Click', inputSchema: schema(['tab_id', 'selector'], ['tab_id', 'selector']) },
      { name: 'codex_screenshot', description: 'Shot', inputSchema: schema(['tab_id'], ['tab_id']) },
      { name: 'codex_claim_tab', description: 'Claim an existing user tab', inputSchema: schema(['tab_id'], ['tab_id']) },
      { name: 'codex_list_tabs', description: 'List', inputSchema: schema([], []) },
      { name: 'codex_finalize', description: 'Finalize', inputSchema: schema([], []) },
    ];
    const invoke = vi.fn(async (input: BrowserInvocation): Promise<BrowserInvocationResult> => ({
      browser: input.browser, executionHost: 'fixture-host', runtimeSession: 'bridge-runtime', generation: 1, tab: input.tab,
      result: input.tool === 'agent_browser_tab_switch'
        ? { isError: false, content: [], structuredContent: { response: { success: true, data: {} } } }
        : input.tool === 'codex_screenshot'
          ? { isError: false, content: [{ type: 'image', data: png, mimeType: 'image/png' }], structuredContent: { response: { success: true } } }
          : { isError: false, content: [{ type: 'text', text: input.tool === 'codex_dom_snapshot' ? '{"role":"textbox"}' : 'ok' }], structuredContent: { response: { success: true, data: {} } } },
    }));
    ix.stub(IBrowserConnectionStore, browser.store);
    ix.stub(defaults, { ready: Promise.resolve(undefined) });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { sessionId: 'fixture-session', sessionDir: '/fixture/session' });
    ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
    ix.stub(IAgentRuntimeService, {});
    ix.stub(ISessionMediaStore, {});
    ix.stub(ISessionInteractionService, { hasConsumer: () => false });
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IConfigService, browser.configService);
    ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    const connect = vi.fn(async () => ({ browser: 'bridge', state: 'ready' as const, executionHost: 'fixture-host', generation: 1 }));
    ix.stub(IBrowserControlService, {
      catalog: async () => catalog, status: async () => ({ browser: 'bridge', state: 'ready' as const, executionHost: 'fixture-host', generation: 1 }),
      tabs: async () => [{ tabId: '7', targetId: '7' }], invoke, endTurn: async () => undefined, connect,
      list: async () => ({ connections: [{ ...bridge, id: 'bridge', status: { browser: 'bridge', state: 'idle' as const, executionHost: 'fixture-host', generation: 0 } }] }),
    });
    ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
    try {
      const service = ix.get(IAgentBrowserService);
      const registry = ix.get(IAgentToolRegistryService);
      expect(JSON.stringify((await service.connections({ action: 'list' })).output)).toContain('codex-browser-use-selected');
      const context = { turnId: 1, toolCallId: 'bridge-connect', signal: new AbortController().signal };
      expect((await service.connections({ action: 'connect', browser: 'bridge' }, context.signal, context)).isError).not.toBe(true);
      expect(connect).toHaveBeenCalledOnce();
      const loaded = await service.connections({ action: 'tools', browser: 'bridge', tools: ['codex_dom_snapshot', 'codex_fill', 'codex_click', 'codex_screenshot', 'codex_claim_tab'] });
      const loadedText = JSON.stringify(loaded.output);
      expect(loadedText).toContain('codex-browser-bridge');
      expect(loadedText).not.toContain('official-cua-repl');
      expect(loadedText).toContain('codex_claim_tab');
      expect(loadedText).toContain('codex_finalize');
      expect(registry.resolve('browser__codex_finalize')).toBeUndefined();
      const bridgeTools = ['browser__codex_claim_tab', 'browser__codex_click', 'browser__codex_dom_snapshot', 'browser__codex_fill', 'browser__codex_screenshot'];
      expect(registry.list().map((tool) => tool.name).toSorted()).toEqual(bridgeTools);
      bridge.enabled = false;
      publishBrowser(browser.sections, browser.config);
      expect(registry.list()).toEqual([]);
      bridge.enabled = true;
      publishBrowser(browser.sections, browser.config);
      expect(registry.list().map((tool) => tool.name).toSorted()).toEqual(bridgeTools);
      await service.tabs({ action: 'select', browser: 'bridge', target: '7' });
      expect(JSON.stringify((await execute(registry.resolve('browser__codex_dom_snapshot')!.resolveExecution({}))).output)).toContain('textbox');
      expect((await execute(registry.resolve('browser__codex_fill')!.resolveExecution({ selector: '#q', value: 'local' }))).isError).not.toBe(true);
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ tool: 'codex_fill', tab: '7', args: { selector: '#q', value: 'local' }, caller: { sessionId: 'fixture-session', agentId: 'main' } }), expect.any(AbortSignal));
      expect((await execute(registry.resolve('browser__codex_click')!.resolveExecution({ selector: '#go', tab_id: 'other' }))).isError).toBe(true);
      expect(invoke.mock.calls.filter(([call]) => call.tool === 'codex_click')).toHaveLength(0);
      expect((await execute(registry.resolve('browser__codex_click')!.resolveExecution({ selector: '#go' }))).isError).not.toBe(true);
      expect(invoke.mock.calls.filter(([call]) => call.tool === 'codex_click')).toHaveLength(1);
      expect(JSON.stringify((await execute(registry.resolve('browser__codex_screenshot')!.resolveExecution({}))).output)).toContain(`data:image/png;base64,${png}`);
      expect((await execute(registry.resolve('browser__codex_claim_tab')!.resolveExecution({ tab_id: '99' }))).isError).not.toBe(true);
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ tool: 'codex_claim_tab', args: { tab_id: '99' }, tab: undefined }), expect.any(AbortSignal));
      await service.connections({ action: 'tools', unload: ['codex_dom_snapshot', 'codex_fill', 'codex_click', 'codex_screenshot', 'codex_claim_tab'] });
      expect(registry.resolve('browser__codex_click')).toBeUndefined();
      expect(registry.resolve('browser__codex_screenshot')).toBeUndefined();
    } finally { await ix.dispose(); }
  });

  it('keeps two same-source browsers distinct, leaves list available for an empty allow set, and restores SDK tools on the same scope', async () => {
    const ix = new TestInstantiationService();
    const root = 'C:/components/codex-browser-bridge.exe';
    const alpha = { id: 'alpha', type: 'codex-extension' as const, name: 'Alpha', enabled: true, runtimeRoot: root, browserId: 'codex-browser-use-alpha' };
    const beta = { id: 'beta', type: 'codex-extension' as const, name: 'Beta', enabled: true, runtimeRoot: root, browserId: 'codex-browser-use-beta' };
    const connections = [alpha, beta];
    let allowed: readonly string[] | undefined = ['alpha', 'beta'];
    let nativeBrowser = true;
    const sections = new Emitter<ConfigSectionChangedEvent>();
    const schema = { type: 'object', properties: { tab_id: { type: 'string' }, url: { type: 'string' } }, required: ['tab_id'] };
    const catalog = ['codex_navigate', 'codex_dom_snapshot', 'codex_screenshot'].map((name) => ({ name, description: name, inputSchema: schema }));
    const invoke = vi.fn(async (input: BrowserInvocation): Promise<BrowserInvocationResult> => ({
      browser: input.browser, executionHost: 'fixture-host', runtimeSession: input.browser, generation: 1, tab: input.tab,
      result: { isError: false, content: [{ type: 'text', text: `${input.browser}:${input.tool}` }], structuredContent: { response: { success: true, data: {} } } },
    }));
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({ connections, ...(allowed === undefined ? {} : { allowedBrowsers: allowed }) }),
      resolve: async (id: string) => {
        const found = connections.find((item) => item.id === id);
        if (found === undefined) throw new Error('Unknown id');
        return found;
      },
    });
    ix.stub(defaults, { ready: Promise.resolve(undefined) });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { sessionId: 'fixture-session', sessionDir: '/fixture/session' });
    ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
    ix.stub(IAgentRuntimeService, {});
    ix.stub(ISessionMediaStore, {});
    ix.stub(ISessionInteractionService, { hasConsumer: () => false });
    ix.stub(IFlagService, { enabled: () => nativeBrowser });
    ix.stub(IConfigService, { onDidSectionChange: sections.event, get: <T>() => ({ allowedBrowsers: allowed, connections: Object.fromEntries(connections.map((entry) => [entry.id, entry])) }) as T });
    const denied: string[] = [];
    ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: (name) => isToolActive({ tools: ['browser__*'], disallowedTools: denied }, name) });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    const readCatalog = vi.fn(async (id: string) => { expect(['alpha', 'beta']).toContain(id); return catalog; });
    ix.stub(IBrowserControlService, {
      catalog: readCatalog,
      status: async (id: string) => ({ browser: id, state: 'ready' as const, executionHost: 'fixture-host', generation: 1 }),
      tabs: async () => [{ tabId: '7', targetId: '7' }],
      invoke, endTurn: async () => undefined, connect: async (id: string) => ({ browser: id, state: 'ready' as const, executionHost: 'fixture-host', generation: 1 }),
      list: async () => ({ connections: connections.map((item) => ({ ...item, status: { browser: item.id, state: 'idle' as const, executionHost: 'fixture-host', generation: 0 } })), allowedBrowsers: allowed }),
    });
    ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
    try {
      const service = ix.get(IAgentBrowserService);
      const registry = ix.get(IAgentToolRegistryService);
      const listed = JSON.parse((await service.connections({ action: 'list' })).output as string) as { connections: { id: string }[]; defaultBrowser?: string };
      expect(listed.connections.map((item) => item.id)).toEqual(['alpha', 'beta']);
      expect(listed.defaultBrowser).toBeUndefined();
      await service.connections({ action: 'tools', browser: 'alpha', tools: ['codex_navigate', 'codex_dom_snapshot', 'codex_screenshot'] });
      expect((await execute(registry.resolve('browser__codex_navigate')!.resolveExecution({ browser: 'beta', browserTab: '7', url: 'http://127.0.0.1/' }))).isError).toBe(true);
      expect(invoke).not.toHaveBeenCalled();
      await service.connections({ action: 'tools', browser: 'beta', tools: ['codex_navigate', 'codex_dom_snapshot', 'codex_screenshot'] });
      await service.tabs({ action: 'select', browser: 'alpha', target: '7' });
      await service.tabs({ action: 'select', browser: 'beta', target: '7' });
      for (const browser of ['alpha', 'beta'] as const) {
        for (const tool of ['codex_navigate', 'codex_dom_snapshot', 'codex_screenshot']) {
          const result = await execute(registry.resolve(`browser__${tool}`)!.resolveExecution({ browser, url: 'http://127.0.0.1/' }));
          expect(result.isError, JSON.stringify(result.output)).not.toBe(true);
        }
      }
      const seen = invoke.mock.calls.map(([call]) => `${call.browser}:${call.tool}`).filter((item) => !item.endsWith(':agent_browser_tab_switch'));
      expect(seen.filter((item) => item.startsWith('alpha:'))).toEqual(['alpha:codex_navigate', 'alpha:codex_dom_snapshot', 'alpha:codex_screenshot']);
      expect(seen.filter((item) => item.startsWith('beta:'))).toEqual(['beta:codex_navigate', 'beta:codex_dom_snapshot', 'beta:codex_screenshot']);
      const pendingAlpha = await registry.resolve('browser__codex_navigate')!.resolveExecution({ browser: 'alpha', url: 'http://127.0.0.1/' });
      const unloaded = await service.connections({ action: 'tools', browser: 'alpha', unload: ['codex_navigate'] });
      expect(JSON.parse(unloaded.output as string).loaded).not.toContain('browser__codex_navigate');
      expect(registry.resolve('browser__codex_navigate')).toBeDefined();
      expect((await execute(pendingAlpha)).isError).toBe(true);
      expect((await execute(registry.resolve('browser__codex_navigate')!.resolveExecution({ browser: 'alpha', url: 'http://127.0.0.1/' }))).isError).toBe(true);
      expect((await execute(registry.resolve('browser__codex_navigate')!.resolveExecution({ browser: 'beta', url: 'http://127.0.0.1/' }))).isError).not.toBe(true);
      allowed = [];
      expect(JSON.parse((await service.connections({ action: 'list' })).output as string).connections).toHaveLength(2);
      expect((await service.connections({ action: 'status', browser: 'alpha' })).isError).not.toBe(true);
      expect((await service.connections({ action: 'connect', browser: 'alpha' })).output).toContain('not in the allowed set');
      expect((await execute(registry.resolve('browser__codex_dom_snapshot')!.resolveExecution({ browser: 'beta' }))).isError).toBe(true);
      expect(invoke.mock.calls.filter(([call]) => call.tool === 'codex_dom_snapshot')).toHaveLength(2);
      sections.fire({ domain: BROWSER_CONFIG_SECTION, source: 'set', value: { allowedBrowsers: [] }, previousValue: {} });
      expect(registry.list()).toHaveLength(0);
      nativeBrowser = false;
      sections.fire({ domain: EXPERIMENTAL_SECTION, source: 'set', value: { native_browser: false }, previousValue: {} });
      expect(registry.resolve('browser__codex_navigate')).toBeUndefined();
      expect(registry.resolve('browser__codex_dom_snapshot')).toBeUndefined();
      expect(registry.resolve('browser__codex_screenshot')).toBeUndefined();
      nativeBrowser = true;
      sections.fire({ domain: EXPERIMENTAL_SECTION, source: 'set', value: { native_browser: true }, previousValue: { native_browser: false } });
      expect(registry.resolve('browser__codex_navigate')).toBeUndefined();
      allowed = ['alpha', 'beta'];
      sections.fire({ domain: BROWSER_CONFIG_SECTION, source: 'set', value: { allowedBrowsers: allowed }, previousValue: { allowedBrowsers: [] } });
      expect(registry.resolve('browser__codex_navigate')).toBeDefined();
      expect(registry.resolve('browser__codex_dom_snapshot')).toBeDefined();
      expect(registry.resolve('browser__codex_screenshot')).toBeDefined();
      const restored = await execute(registry.resolve('browser__codex_dom_snapshot')!.resolveExecution({ browser: 'beta' }));
      expect(restored.isError, JSON.stringify(restored.output)).not.toBe(true);
      expect(invoke.mock.calls.filter(([call]) => call.tool === 'codex_dom_snapshot').at(-1)?.[0].browser).toBe('beta');
      const pendingBeta = await registry.resolve('browser__codex_navigate')!.resolveExecution({ browser: 'beta', url: 'http://127.0.0.1/' });
      denied.push('browser__codex_navigate');
      sections.fire({ domain: 'tools', source: 'set', value: {}, previousValue: {} });
      expect(registry.resolve('browser__codex_navigate')).toBeUndefined();
      expect(registry.resolve('browser__codex_dom_snapshot')).toBeDefined();
      expect((await execute(pendingBeta)).isError).toBe(true);
      const queuedGuard = invoke.mock.calls.find(([call]) => call.browser === 'beta' && call.tool === 'codex_navigate')![0].assertToolAllowed;
      expect(queuedGuard).toBeTypeOf('function');
      expect(() => queuedGuard!()).toThrow('disabled');
      denied.length = 0;
      sections.fire({ domain: 'tools', source: 'set', value: {}, previousValue: {} });
      expect(registry.resolve('browser__codex_navigate')).toBeDefined();
      beta.enabled = false;
      sections.fire({ domain: BROWSER_CONFIG_SECTION, source: 'set', value: {}, previousValue: {} });
      expect(registry.resolve('browser__codex_navigate')).toBeUndefined();
      expect(registry.resolve('browser__codex_dom_snapshot')).toBeDefined();
      beta.enabled = true;
      let release!: () => void;
      readCatalog.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return catalog; });
      const late = service.connections({ action: 'tools', browser: 'beta', tools: ['codex_navigate'] });
      await vi.waitFor(() => expect(release).toBeDefined());
      nativeBrowser = false;
      sections.fire({ domain: EXPERIMENTAL_SECTION, source: 'set', value: {}, previousValue: {} });
      release();
      await late;
      expect(registry.list()).toHaveLength(0);
      nativeBrowser = true;
      sections.fire({ domain: EXPERIMENTAL_SECTION, source: 'set', value: {}, previousValue: {} });
      await service.connections({ action: 'tools', browser: 'alpha', unload: ['codex_screenshot'] });
      await service.connections({ action: 'tools', browser: 'beta', unload: ['codex_screenshot'] });
      expect(registry.resolve('browser__codex_screenshot')).toBeUndefined();
      let releaseCancelled!: () => void;
      readCatalog.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { releaseCancelled = resolve; }); return catalog; });
      const abort = new AbortController();
      const cancelled = service.connections({ action: 'tools', browser: 'alpha', tools: ['codex_screenshot'] }, abort.signal);
      await vi.waitFor(() => expect(releaseCancelled).toBeDefined());
      abort.abort(new Error('catalog cancelled'));
      releaseCancelled();
      expect((await cancelled).isError).toBe(true);
      expect(registry.resolve('browser__codex_screenshot')).toBeUndefined();
      let releaseClosed!: () => void;
      readCatalog.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { releaseClosed = resolve; }); return catalog; });
      const closed = service.connections({ action: 'tools', browser: 'alpha', tools: ['codex_screenshot'] });
      await vi.waitFor(() => expect(releaseClosed).toBeDefined());
      await (service as AgentBrowserService).dispose();
      releaseClosed();
      expect((await closed).isError).toBe(true);
      expect(registry.list()).toHaveLength(0);
    } finally { await ix.dispose(); }
  });
});
