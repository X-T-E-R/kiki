import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { createServices, TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { AgentBrowserService, IAgentBrowserService, IBrowserConnectionsTool, BrowserConnectionsTool, IBrowserTabsTool, BrowserTabsTool, IBrowserEgoRunTool, BrowserEgoRunTool } from '#/agent/tools/browser/browserTools';
import { AgentToolActivationService } from '#/agent/toolActivation/toolActivationService';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { AgentToolContribution, getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IShippedAgentProfileManager } from '#/app/shippedAgentProfiles/shippedAgentProfileManager';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isToolActive, isToolActiveComposed } from '#/agent/toolPolicy/evaluate';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
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
import { BrowserError } from '#/app/browser/errors';
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

function selectionHarness(tabsFor: () => { tabId: string; targetId: string }[], generationFor: () => number, invoke: (input: BrowserInvocation) => Promise<BrowserInvocationResult>) {
  const ix = new TestInstantiationService();
  const browser = sameBrowserControl({ a: { type: 'agent-browser-profile', name: 'A', enabled: true } });
  const connect = vi.fn(async () => ({ browser: 'a', state: 'ready' as const, executionHost: 'fixture-host', generation: generationFor() }));
  ix.stub(IBrowserConnectionStore, browser.store);
  ix.stub(defaults, { ready: Promise.resolve(undefined) });
  ix.stub(IAgentScopeContext, { agentId: 'main' });
  ix.stub(ISessionContext, { sessionId: 'session', sessionDir: '/fixture/session' });
  ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
  ix.stub(IAgentRuntimeService, {});
  ix.stub(ISessionMediaStore, {});
  ix.stub(ISessionInteractionService, { hasConsumer: () => false });
  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IConfigService, browser.configService);
  ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.stub(IBrowserControlService, {
    endTurn: async () => undefined, catalog: async () => [], connect, invoke,
    status: async () => ({ browser: 'a', state: 'ready' as const, executionHost: 'fixture-host', generation: generationFor() }),
    tabs: async () => tabsFor(),
  });
  ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
  return { ix, service: ix.get(IAgentBrowserService), connect };
}

class BrowserContributionAssembly extends Service {
  constructor() {
    super();
    for (const record of getAgentToolContributions()) this.provide(AgentToolContribution, record);
  }
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
      expect(registry.list()[0]).toMatchObject({ source: 'builtin', disclosure: 'deferred' });
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
      discover: async () => [],
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
      discover: async () => [],
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

  it('describes Ego native-script control without inventing typed donor tools', async () => {
    const ix = new TestInstantiationService();
    const ego: BrowserConfig['connections'][string] = { type: 'ego-lite', name: 'Ego Lite', enabled: true, cliPath: 'C:/EgoLite/ego-browser.exe' };
    const browser = sameBrowserControl({ ego });
    ix.stub(IBrowserConnectionStore, browser.store);
    ix.stub(defaults, { ready: Promise.resolve('ego') });
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
    ix.stub(IBrowserControlService, {
      catalog: async () => [],
      status: async () => ({ browser: 'ego', state: 'ready' as const, executionHost: 'fixture-host', generation: 2 }),
      endTurn: async () => undefined,
    });
    ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
    try {
      const service = ix.get(IAgentBrowserService);
      const registry = ix.get(IAgentToolRegistryService);
      const described = JSON.parse((await service.connections({ action: 'tools', browser: 'ego', groups: ['page'] })).output as string) as Record<string, unknown>;
      expect(described).toMatchObject({ backend: 'ego-lite', namespace: 'ego-lite', backendToolCount: 0, nativeTool: 'browser__ego_run', executionMode: 'native-script', operations: [], loaded: [], allowed: true });
      expect(described).not.toHaveProperty('callable');
      expect(described['contextIsolation']).toEqual(expect.stringContaining('task'));
      expect(described['contextIsolation']).toEqual(expect.stringContaining('shotDir'));
      expect(described['note']).toEqual(expect.stringContaining('zero typed donor operations'));
      expect(registry.list()).toEqual([]);
    } finally { await ix.dispose(); }
  });

  it('keeps a loaded page operation registered until allow, source, or unload removes it', async () => {
    const modelName = 'browser__agent_browser_snapshot';
    const snapshot = { name: 'agent_browser_snapshot', description: 'snapshot', inputSchema: { type: 'object', properties: {} } };
    const ix = new TestInstantiationService();
    const profile: BrowserConfig['connections'][string] = { type: 'agent-browser-profile', name: 'Independent', enabled: true };
    const browser = sameBrowserControl({ independent: profile });
    let native = true;
    let layers: Parameters<typeof isToolActiveComposed>[0] = { profile: { tools: ['*'] } };
    const connect = vi.fn(async () => ({ browser: 'independent', state: 'ready' as const, executionHost: 'fixture-host', generation: 3 }));
    ix.stub(IBrowserConnectionStore, browser.store);
    ix.stub(defaults, { ready: Promise.resolve(undefined) });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { sessionId: 'session', sessionDir: '/fixture/session' });
    ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
    ix.stub(IAgentRuntimeService, {});
    ix.stub(ISessionMediaStore, {});
    ix.stub(ISessionInteractionService, { hasConsumer: () => false });
    ix.stub(IFlagService, { enabled: () => native });
    ix.stub(IConfigService, browser.configService);
    ix.stub(IAgentToolPolicyService, {
      isToolActiveForDisclosure: (toolName: string, source: 'builtin' | 'user' | 'mcp' | 'plugin' = 'builtin') => isToolActiveComposed(layers, toolName, source),
    });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IBrowserControlService, {
      endTurn: async () => undefined,
      catalog: async () => [snapshot],
      connect,
      status: async () => ({ browser: 'independent', state: 'ready' as const, executionHost: 'fixture-host', generation: 1 }),
      tabs: async () => [{ tabId: 't2', targetId: 'live-target' }],
    });
    ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
    const read = async () => JSON.parse((await ix.get(IAgentBrowserService).connections({ action: 'tools', browser: 'independent', groups: ['page'] })).output as string) as { loaded: string[]; callable?: boolean; allowed: boolean; note: string };
    try {
      const service = ix.get(IAgentBrowserService);
      const registry = ix.get(IAgentToolRegistryService);
      const main = await read();
      expect(main.loaded).toEqual([modelName]);
      expect(main.callable).toBe(false);
      expect(main.allowed).toBe(true);
      expect(main.note).toContain('registered names only');
      expect(registry.list()).toEqual([expect.objectContaining({ name: modelName, source: 'builtin', disclosure: 'deferred' })]);
      await service.connections({ action: 'connect', browser: 'independent' });
      expect(connect).toHaveBeenCalledOnce();
      expect(registry.list()).toEqual([expect.objectContaining({ name: modelName, source: 'builtin', disclosure: 'deferred' })]);

      layers = { profile: { tools: ['*'] }, subagent: { explicitProfileTools: ['*'] } };
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve(modelName)).toBeUndefined();
      const childStar = await read();
      expect(childStar.loaded).toEqual([]);
      expect(childStar.callable).toBe(false);
      expect(childStar.allowed).toBe(true);

      layers = { profile: { tools: ['*'] }, subagent: { explicitProfileTools: ['*', 'browser__*'] } };
      publishBrowser(browser.sections, browser.config);
      expect(registry.list()).toEqual([expect.objectContaining({ name: modelName, source: 'builtin', disclosure: 'deferred' })]);
      expect((await read()).loaded).toEqual([modelName]);

      layers = { profile: { tools: ['*'], disallowedTools: ['browser__*'] } };
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve(modelName)).toBeUndefined();
      expect((await read()).loaded).toEqual([]);

      layers = { profile: { tools: ['*'] } };
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve(modelName)).toBeDefined();
      browser.config.disabledSources = ['independent-browser'];
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve(modelName)).toBeUndefined();
      const sourceOff = await read();
      expect(sourceOff.allowed).toBe(false);
      expect(sourceOff.loaded).toEqual([]);
      expect(sourceOff.callable).toBe(false);
      expect(sourceOff.note).toContain('not in the allowed set');

      browser.config.disabledSources = undefined;
      browser.config.allowedBrowsers = ['other'];
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve(modelName)).toBeUndefined();
      expect((await read()).allowed).toBe(false);

      browser.config.allowedBrowsers = undefined;
      native = false;
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve(modelName)).toBeUndefined();
      expect((await read()).loaded).toEqual([]);
      native = true;
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve(modelName)).toBeDefined();
      const unloaded = JSON.parse((await service.connections({ action: 'tools', browser: 'independent', unload: ['agent_browser_snapshot'] })).output as string) as { loaded: string[]; callable?: boolean };
      expect(unloaded.loaded).toEqual([]);
      expect(unloaded.callable).toBe(false);
      expect(registry.resolve(modelName)).toBeUndefined();
    } finally { await ix.dispose(); }
  });

  it('keeps an explicitly selected discovered Ego connection for a later omitted-browser call', async () => {
    const ix = new TestInstantiationService();
    const sections = new Emitter<ConfigSectionChangedEvent>();
    const connections: BrowserConfig['connections'] = {
      other: { type: 'agent-browser-profile', name: 'Other', enabled: true },
    };
    const config: BrowserConfig = { connections };
    const store = {
      list: async () => ({ connections: Object.entries(connections).map(([id, entry]) => ({ ...entry, id })), defaultBrowser: 'other' }),
      resolve: async (id: string) => {
        const entry = connections[id];
        if (entry === undefined) throw new BrowserError('browser.not_found', `Unknown browser connection "${id}"`);
        return { ...entry, id };
      },
    };
    const runtime = Object.assign(new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: '1' }, { pathClass: process.platform === 'win32' ? 'win32' : 'posix' }), { fs: new HostFileSystem() });
    const invoke = vi.fn(async (input: BrowserInvocation): Promise<BrowserInvocationResult> => ({
      browser: input.browser, executionHost: 'fixture-host', runtimeSession: 'ego-space', generation: 1,
      result: { isError: false, content: [{ type: 'text', text: 'done' }], structuredContent: { response: { success: true, data: {} } } },
    }));
    const probeDiscovered = vi.fn(async () => {
      connections['ego-lite'] = { type: 'ego-lite', name: 'Ego Lite', enabled: true, cliPath: 'C:/EgoLite/ego-browser.exe' };
      return { browser: 'ego-lite', state: 'ready' as const, executionHost: 'fixture-host', generation: 1 };
    });
    ix.stub(IBrowserConnectionStore, store);
    ix.stub(defaults, { ready: Promise.resolve('other') });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(ISessionContext, { sessionId: 'fixture-session', sessionDir: '/fixture/session' });
    ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
    ix.stub(IAgentRuntimeService, { inspect: () => runtime });
    ix.stub(ISessionMediaStore, {});
    ix.stub(ISessionInteractionService, { hasConsumer: () => false });
    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IConfigService, { onDidSectionChange: sections.event, get: <T>() => config as T });
    ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IBrowserControlService, {
      endTurn: async () => undefined,
      discover: async () => [],
      probeDiscovered,
      status: async (id: string) => ({ browser: id, state: 'ready' as const, executionHost: 'fixture-host', generation: 1 }),
      invoke,
    });
    ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
    try {
      const service = ix.get(IAgentBrowserService);
      const signal = new AbortController().signal;
      const selected = await service.connections({ action: 'select', browser: 'ego-lite' }, signal);
      expect(selected.isError).not.toBe(true);
      expect(probeDiscovered).toHaveBeenCalledWith(true, signal);
      const execution = await service.egoExecution({ script: 'console.log(1)' });
      const result = await execute(execution);
      expect(result.isError).not.toBe(true);
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ browser: 'ego-lite', tool: 'browser__ego_run' }), expect.any(AbortSignal));
    } finally { await ix.dispose(); }
  });

  it('activates browser__ego_run for a custom enabled Ego id and withdraws it for source off or tool deny', async () => {
    const browser = sameBrowserControl({ customEgo: { type: 'ego-lite', name: 'Custom Ego', enabled: true, cliPath: 'C:/EgoLite/ego-browser.exe' } });
    browser.config.allowedBrowsers = ['customEgo'];
    const denied: string[] = [];
    const disposables = new DisposableStore();
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentProfileService, { data: () => ({ modelCapabilities: UNKNOWN_CAPABILITY, thinkingLevel: '', systemPrompt: '' }) });
        reg.definePartialInstance(IConfigService, browser.configService);
        reg.definePartialInstance(IFlagService, { enabled: () => true });
        reg.definePartialInstance(IAgentToolPolicyService, { isToolActiveForDisclosure: (name) => isToolActive({ tools: ['browser__ego_run'], disallowedTools: denied }, name) });
        reg.definePartialInstance(IAgentRuntimeService, { onDidChange: Event.None as Event<void>, isAvailable: () => true });
        reg.definePartialInstance(ISessionDeliveryService, { effectiveMode: () => 'reply', onDidChangeEffective: Event.None as Event<'reply'> });
        reg.definePartialInstance(IShippedAgentProfileManager, { ready: Promise.resolve(), onDidChange: Event.None as Event<void>, isCleanActivePath: () => false });
        reg.definePartialInstance(ISessionToolPolicyGate, { disabledTools: [], onDidChange: Event.None as Event<void> });
        reg.definePartialInstance(IAgentBrowserService, { connections: async () => ({ output: '' }), tabs: async () => ({ output: '' }), egoExecution: async () => ({ isError: true, output: '' }), egoRun: async () => ({ output: '' }) });
        reg.define(IBrowserConnectionsTool, BrowserConnectionsTool);
        reg.define(IBrowserTabsTool, BrowserTabsTool);
        reg.define(IBrowserEgoRunTool, BrowserEgoRunTool);
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.define(IAgentToolActivationService, AgentToolActivationService);
        reg.define(IEventBus, EventBusService);
      },
    });
    disposables.add(ix.createInstance(BrowserContributionAssembly));
    try {
      await ix.get(IAgentToolActivationService).activate();
      const registry = ix.get(IAgentToolRegistryService);
      expect(registry.resolve('browser__ego_run')).toBeInstanceOf(BrowserEgoRunTool);
      browser.config.disabledSources = ['ego-lite'];
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve('browser__ego_run')).toBeUndefined();
      browser.config.disabledSources = undefined;
      publishBrowser(browser.sections, browser.config);
      expect(registry.resolve('browser__ego_run')).toBeInstanceOf(BrowserEgoRunTool);
      denied.push('browser__ego_run');
      browser.sections.fire({ domain: 'tools', source: 'set', value: {}, previousValue: {} });
      expect(registry.resolve('browser__ego_run')).toBeUndefined();
      denied.length = 0;
      browser.sections.fire({ domain: 'tools', source: 'set', value: {}, previousValue: {} });
      expect(registry.resolve('browser__ego_run')).toBeInstanceOf(BrowserEgoRunTool);
    } finally { await disposables.dispose(); }
  });

  it('clears a dead selection after reconnect and does not replace it or replay the close', async () => {
    let generation = 1;
    let tabs = [{ tabId: 't1', targetId: 'blank' }, { tabId: 't2', targetId: 'fixture' }, { tabId: 't3', targetId: 'window-tab' }];
    const calls: string[] = [];
    const harness = selectionHarness(() => tabs, () => generation, async (input) => {
      calls.push(input.tool);
      if (input.tool === 'agent_browser_tab_close') throw new BrowserError('browser.execution_failed', 'The browser command timed out; its outcome is unknown and it was not replayed by Kiki');
      const tab = input.tool === 'agent_browser_window_new' ? 'window-tab' : 'fixture';
      return { browser: 'a', executionHost: 'fixture-host', runtimeSession: 'fixture-a', generation, tab,
        result: { isError: false, content: [], structuredContent: { response: { success: true, data: {} } } } };
    });
    try {
      expect((await harness.service.tabs({ action: 'open', browser: 'a', url: 'http://127.0.0.1/fixture' })).isError).not.toBe(true);
      expect((await harness.service.tabs({ action: 'window', browser: 'a' })).isError).not.toBe(true);
      const closed = await harness.service.tabs({ action: 'close', browser: 'a', target: 'window-tab' });
      expect(closed.isError).toBe(true);
      expect(String(closed.output)).toContain('not replayed');
      harness.connect.mockImplementation(async () => {
        generation = 3;
        tabs = [{ tabId: 't1', targetId: 'blank' }, { tabId: 't2', targetId: 'fixture' }];
        return { browser: 'a', state: 'ready' as const, executionHost: 'fixture-host', generation };
      });
      const reconnected = JSON.parse(String((await harness.service.connections({ action: 'connect', browser: 'a' })).output)) as { selectedTab?: unknown; selection?: string };
      expect(reconnected.selectedTab).toBeNull();
      expect(reconnected.selection).toContain('not replaced');
      const listed = JSON.parse(String((await harness.service.tabs({ action: 'list', browser: 'a' })).output)) as { selected: unknown; tabs: { targetId: string }[] };
      expect(listed.tabs.map((tab) => tab.targetId)).toEqual(['blank', 'fixture']);
      expect(listed.selected).toBeNull();
      expect(calls).toEqual(['agent_browser_tab_new', 'agent_browser_window_new', 'agent_browser_tab_close']);
    } finally { await harness.ix.dispose(); }
  });

  it('keeps a still-listed selection across reconnect without observing or switching tabs', async () => {
    let generation = 1;
    const tabs = [{ tabId: 't2', targetId: 'fixture' }, { tabId: 't9', targetId: 'user-tab' }];
    const calls: string[] = [];
    const harness = selectionHarness(() => tabs, () => generation, async (input) => {
      calls.push(input.tool);
      return { browser: 'a', executionHost: 'fixture-host', runtimeSession: 'fixture-a', generation, tab: 'fixture',
        result: { isError: false, content: [], structuredContent: { response: { success: true, data: {} } } } };
    });
    try {
      await harness.service.tabs({ action: 'open', browser: 'a', url: 'http://127.0.0.1/fixture' });
      harness.connect.mockImplementation(async () => {
        generation = 4;
        return { browser: 'a', state: 'ready' as const, executionHost: 'fixture-host', generation };
      });
      const reconnected = JSON.parse(String((await harness.service.connections({ action: 'connect', browser: 'a' })).output)) as { selectedTab?: { tab?: string; generation?: number; observed?: boolean; frame?: string } };
      expect(reconnected.selectedTab).toMatchObject({ tab: 'fixture', generation: 4 });
      expect(reconnected.selectedTab?.observed).toBeUndefined();
      expect(reconnected.selectedTab?.frame).toBeUndefined();
      expect(reconnected.selectedTab?.tab).not.toBe('user-tab');
      expect(calls).toEqual(['agent_browser_tab_new']);
    } finally { await harness.ix.dispose(); }
  });
});
