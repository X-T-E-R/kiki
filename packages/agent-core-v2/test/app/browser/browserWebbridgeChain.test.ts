import { describe, expect, it, vi } from 'vitest';
import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { IConfigService, type ConfigSectionChangedEvent } from '#/app/config/config';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { AgentBrowserService, IAgentBrowserService } from '#/agent/tools/browser/browserTools';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IBrowserControlService } from '#/app/browser/browser';
import { BrowserControlService } from '#/app/browser/browserControlService';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IBrowserBackendFactory } from '#/app/browser/browserBackend';
import { BROWSER_CONFIG_SECTION, type BrowserConfig } from '#/app/browser/browserConfig';
import { webbridgeTransportUnconfirmed } from '#/app/browser/browserWebbridge';
import type { ExecutableTool, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const defaults = createDecorator<{ readonly _serviceBrand: undefined; ready: Promise<string | undefined> }>('sessionBrowserDefault');

async function execute(work: ToolExecution | Promise<ToolExecution>, signal?: AbortSignal): Promise<ExecutableToolResult> {
  const execution = await work;
  if (!('execute' in execution)) return execution;
  return execution.execute({ turnId: 1, toolCallId: 'webbridge-chain', signal: signal ?? new AbortController().signal });
}

async function run(tool: ExecutableTool, args: Record<string, unknown>, signal: AbortSignal): Promise<ExecutableToolResult> {
  return execute(tool.resolveExecution(args), signal);
}

function textOf(result: ExecutableToolResult): string {
  if (typeof result.output === 'string') return result.output;
  return result.output.map((part) => part.type === 'text' ? part.text : '').join('\n');
}

describe('native Kimi WebBridge chain', () => {
  it('classifies a lost write separately from a refused connection', () => {
    expect(webbridgeTransportUnconfirmed(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true);
    expect(webbridgeTransportUnconfirmed(new DOMException('The operation was aborted', 'AbortError'))).toBe(false);
    expect(webbridgeTransportUnconfirmed(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(webbridgeTransportUnconfirmed(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(false);
    expect(webbridgeTransportUnconfirmed(new Error('WebBridge click was not confirmed'))).toBe(false);
  });

  it('opens, selects, reads, clicks and closes through BrowserTabs on the product session', async () => {
    const seen: { action?: string; args?: Record<string, unknown>; session?: string }[] = [];
    const bridge = await harness(seen);
    try {
      const connected = JSON.parse(textOf(await bridge.service.connections({ action: 'connect', browser: 'kimi-webbridge' })));
      expect(connected).toMatchObject({ state: 'ready', runtimeSession: 'kiki-kimi-webbridge', driverVersion: 'v2.0.23' });
      expect(bridge.factory.open).not.toHaveBeenCalled();
      const opened = await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/a', label: 'Fixture group' });
      expect(opened.isError).not.toBe(true);
      const first = /"targetId":"(\d+)"/.exec(textOf(opened))?.[1];
      expect(first).toBeDefined();
      expect(seen.some((call) => call.session === 'komodo-bootstrap-20261024' || call.args?.['active'] === true)).toBe(false);
      expect(seen.at(-1)).toMatchObject({ action: 'navigate', session: 'kiki-kimi-webbridge', args: { url: 'https://example.test/a', newTab: true, group_title: 'Fixture group' } });
      const listed = JSON.parse(textOf(await bridge.service.tabs({ action: 'list', browser: 'kimi-webbridge' })));
      expect(listed.tabs.map((tab: { targetId: string }) => tab.targetId)).toContain(first);
      const secondOpen = await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/b' });
      const second = /"targetId":"(\d+)"/.exec(textOf(secondOpen))?.[1];
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      const selected = await bridge.service.tabs({ action: 'select', browser: 'kimi-webbridge', target: first! });
      expect(selected.isError).not.toBe(true);
      expect(seen.filter((call) => call.action === 'find_tab')).toEqual([{ action: 'find_tab', session: 'kiki-kimi-webbridge', args: { url: 'https://example.test/a' } }]);
      const tools = JSON.parse(textOf(await bridge.service.connections({ action: 'tools', browser: 'kimi-webbridge', tools: ['agent_browser_snapshot', 'agent_browser_click', 'agent_browser_fill'] })));
      expect(tools).toMatchObject({ backend: 'kimi-webbridge', namespace: 'kimi-webbridge', contextIsolation: 'Kimi WebBridge operates on the main frame of the selected tab. BrowserTabs window and non-main frames are unsupported.',
        operations: [{ name: 'agent_browser_snapshot' }, { name: 'agent_browser_click' }, { name: 'agent_browser_fill' }] });
      const registry = bridge.ix.get(IAgentToolRegistryService);
      const shot = await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}));
      expect(shot.isError).not.toBe(true);
      expect(textOf(shot)).toContain(`"targetId":"${first}"`);
      const clicked = await execute(registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector: '@e1' }));
      expect(clicked.isError).not.toBe(true);
      const filled = await execute(registry.resolve('browser__agent_browser_fill')!.resolveExecution({ selector: '#field', value: 'local' }));
      expect(filled.isError).not.toBe(true);
      const framed = await bridge.service.tabs({ action: 'frame', browser: 'kimi-webbridge', frame: 'child' });
      expect(framed.isError).toBe(true);
      expect(textOf(framed)).toContain('main frame');
      const duplicate = await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/a' });
      const third = /"targetId":"(\d+)"/.exec(textOf(duplicate))?.[1];
      const rejected = await bridge.service.tabs({ action: 'select', browser: 'kimi-webbridge', target: first! });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain('more than once');
      expect(seen.filter((call) => call.action === 'find_tab')).toHaveLength(4);
      expect(third).toBeDefined();
      const closed = await bridge.service.tabs({ action: 'close', browser: 'kimi-webbridge', target: third! });
      expect(closed.isError).toBe(true);
      expect(textOf(closed)).toContain('more than once');
      expect(seen.some((call) => call.action === 'close_tab')).toBe(false);
      expect(bridge.factory.open).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await bridge.ix.dispose(); }
  });

  it('keeps a timed-out write unconfirmed and does not replay it or open the CDP driver', async () => {
    const seen: { action?: string; args?: Record<string, unknown>; session?: string }[] = [];
    const bridge = await harness(seen, { failAction: 'click' });
    try {
      await bridge.service.connections({ action: 'connect', browser: 'kimi-webbridge' });
      await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/a' });
      await bridge.service.connections({ action: 'tools', browser: 'kimi-webbridge', tools: ['agent_browser_snapshot', 'agent_browser_click'] });
      const registry = bridge.ix.get(IAgentToolRegistryService);
      expect((await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}))).isError).not.toBe(true);
      const before = seen.length;
      const clicked = await execute(registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector: '@e1' }));
      expect(clicked.isError).toBe(true);
      const status = JSON.parse(textOf(await bridge.service.connections({ action: 'status', browser: 'kimi-webbridge' })));
      expect(status).toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' } });
      expect((await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}))).isError).toBe(true);
      expect(seen.slice(before).map((call) => call.action)).toEqual(['list_tabs', 'find_tab', 'click']);
      const checked = JSON.parse(textOf(await bridge.service.connections({ action: 'check', browser: 'kimi-webbridge' })));
      expect(checked).toMatchObject({ state: 'idle', failure: { reason: 'outcome_unknown' } });
      expect(String(checked.error)).toContain('not replayed');
      expect(seen.slice(before).map((call) => call.action)).toEqual(['list_tabs', 'find_tab', 'click']);
      expect(bridge.factory.open).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await bridge.ix.dispose(); }
  });

  it('records an explicit WebBridge rejection as a finished failure', async () => {
    const seen: { action?: string; args?: Record<string, unknown>; session?: string }[] = [];
    const bridge = await harness(seen, { rejectAction: 'click' });
    try {
      await bridge.service.connections({ action: 'connect', browser: 'kimi-webbridge' });
      await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/a' });
      await bridge.service.connections({ action: 'tools', browser: 'kimi-webbridge', tools: ['agent_browser_snapshot', 'agent_browser_click'] });
      const registry = bridge.ix.get(IAgentToolRegistryService);
      expect((await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}))).isError).not.toBe(true);
      const clicked = await execute(registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector: '@e1' }));
      expect(clicked.isError).toBe(true);
      const status = JSON.parse(textOf(await bridge.service.connections({ action: 'status', browser: 'kimi-webbridge' })));
      expect(status.state).toBe('failed');
      expect(status.failure?.reason).toBeUndefined();
      expect(bridge.factory.open).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await bridge.ix.dispose(); }
  });

  it('keeps a write aborted after it was sent unconfirmed and does not replay it', async () => {
    const seen: { action?: string; args?: Record<string, unknown>; session?: string }[] = [];
    const sent = new AbortController();
    const bridge = await harness(seen, { abortAction: 'click', abort: () => sent.abort() });
    try {
      await bridge.service.connections({ action: 'connect', browser: 'kimi-webbridge' });
      await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/a' });
      await bridge.service.connections({ action: 'tools', browser: 'kimi-webbridge', tools: ['agent_browser_snapshot', 'agent_browser_click'] });
      const registry = bridge.ix.get(IAgentToolRegistryService);
      expect((await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}))).isError).not.toBe(true);
      const early = new AbortController();
      early.abort();
      const before = seen.length;
      const skipped = await run(registry.resolve('browser__agent_browser_click')!, { selector: '@e1' }, early.signal);
      expect(skipped.isError).toBe(true);
      expect(seen.slice(before).map((call) => call.action)).toEqual([]);
      expect(JSON.parse(textOf(await bridge.service.connections({ action: 'status', browser: 'kimi-webbridge' }))).state).toBe('ready');
      const clicked = await run(registry.resolve('browser__agent_browser_click')!, { selector: '@e1' }, sent.signal);
      expect(clicked.isError).toBe(true);
      const status = JSON.parse(textOf(await bridge.service.connections({ action: 'status', browser: 'kimi-webbridge' })));
      expect(status).toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' } });
      expect((await execute(registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector: '@e1' }))).isError).toBe(true);
      expect(seen.slice(before).map((call) => call.action)).toEqual(['list_tabs', 'find_tab', 'click']);
      expect(bridge.factory.open).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await bridge.ix.dispose(); }
  });

  it('does not operate or close the tab marked active when command current is another tab', async () => {
    const seen: { action?: string; args?: Record<string, unknown>; session?: string }[] = [];
    const fault: ChainFault = {};
    const bridge = await harness(seen, fault);
    try {
      await bridge.service.connections({ action: 'connect', browser: 'kimi-webbridge' });
      const opened = await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/a' });
      const first = /"targetId":"(\d+)"/.exec(textOf(opened))?.[1];
      await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/b' });
      fault.reportActiveTabId = Number(first);
      await bridge.service.connections({ action: 'tools', browser: 'kimi-webbridge', tools: ['agent_browser_snapshot', 'agent_browser_click', 'agent_browser_fill'] });
      const registry = bridge.ix.get(IAgentToolRegistryService);
      const selected = await bridge.service.tabs({ action: 'select', browser: 'kimi-webbridge', target: first! });
      expect(selected.isError).not.toBe(true);
      const shot = await execute(registry.resolve('browser__agent_browser_snapshot')!.resolveExecution({}));
      const clicked = await execute(registry.resolve('browser__agent_browser_click')!.resolveExecution({ selector: '@e1' }));
      const filled = await execute(registry.resolve('browser__agent_browser_fill')!.resolveExecution({ selector: '#field', value: 'local' }));
      expect(shot.isError).not.toBe(true);
      expect(clicked.isError).not.toBe(true);
      expect(filled.isError).not.toBe(true);
      expect(bridge.effects.filter((effect) => effect.action === 'snapshot' || effect.action === 'click' || effect.action === 'fill').map((effect) => effect.tabId)).toEqual([1, 1, 1]);
      const closed = await bridge.service.tabs({ action: 'close', browser: 'kimi-webbridge', target: first! });
      expect(closed.isError).not.toBe(true);
      expect(bridge.effects.filter((effect) => effect.action === 'close_tab').map((effect) => effect.tabId)).toEqual([1]);
      const remaining = JSON.parse(textOf(await bridge.service.tabs({ action: 'list', browser: 'kimi-webbridge' }))).tabs as { targetId: string }[];
      expect(remaining.map((tab) => tab.targetId)).toEqual(['2']);
      const duplicated = await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/dup' });
      const again = await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/dup' });
      const dup = /"targetId":"(\d+)"/.exec(textOf(duplicated))?.[1];
      fault.reportActiveTabId = Number(dup);
      const before = seen.length;
      const rejected = await bridge.service.tabs({ action: 'close', browser: 'kimi-webbridge', target: dup! });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain('more than once');
      expect(seen.slice(before).some((call) => call.action === 'close_tab' || call.action === 'find_tab')).toBe(false);
      expect(/"targetId":"(\d+)"/.exec(textOf(again))?.[1]).toBeDefined();
      expect(bridge.factory.open).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await bridge.ix.dispose(); }
  });

  it('keeps a write with a truncated acknowledgement unconfirmed', async () => {
    const seen: { action?: string; args?: Record<string, unknown>; session?: string }[] = [];
    const bridge = await harness(seen, { truncateAction: 'fill' });
    try {
      await bridge.service.connections({ action: 'connect', browser: 'kimi-webbridge' });
      await bridge.service.tabs({ action: 'open', browser: 'kimi-webbridge', url: 'https://example.test/a' });
      await bridge.service.connections({ action: 'tools', browser: 'kimi-webbridge', tools: ['agent_browser_fill'] });
      const registry = bridge.ix.get(IAgentToolRegistryService);
      const before = seen.length;
      const filled = await execute(registry.resolve('browser__agent_browser_fill')!.resolveExecution({ selector: '#field', value: 'local' }));
      expect(filled.isError).toBe(true);
      const status = JSON.parse(textOf(await bridge.service.connections({ action: 'status', browser: 'kimi-webbridge' })));
      expect(status).toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' } });
      expect((await execute(registry.resolve('browser__agent_browser_fill')!.resolveExecution({ selector: '#field', value: 'local' }))).isError).toBe(true);
      expect(seen.slice(before).map((call) => call.action)).toEqual(['list_tabs', 'find_tab', 'fill']);
      expect(bridge.factory.open).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await bridge.ix.dispose(); }
  });
});

interface ChainFault { failAction?: string; rejectAction?: string; abortAction?: string; truncateAction?: string; abort?: () => void; reportActiveTabId?: number }

async function harness(seen: { action?: string; args?: Record<string, unknown>; session?: string }[], fault?: ChainFault) {
  const planned: ChainFault = fault ?? {};
  const effects: { action: string; tabId?: number }[] = [];
  const tabs: { tabId: number; url: string; title: string; active: boolean; groupTitle?: string }[] = [];
  let next = 0;
  let current: number | undefined;
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/status')) return new Response(JSON.stringify({ running: true, extension_connected: true, version: 'v2.0.23' }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { action?: string; args?: Record<string, unknown>; session?: string };
    if (body.action === planned.failAction) {
      seen.push(body);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    if (body.action === planned.abortAction) {
      seen.push(body);
      planned.abort?.();
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    if (body.action === planned.truncateAction) {
      seen.push(body);
      return new Response('{"ok":true,"data":', { status: 200 });
    }
    seen.push(body);
    if (body.action === planned.rejectAction) return new Response(JSON.stringify({ ok: true, data: { success: false, error: 'no such element' } }), { status: 200 });
    if (body.action === 'navigate' && body.args?.['newTab'] === true && typeof body.args['url'] === 'string') {
      next += 1;
      for (const tab of tabs) tab.active = false;
      tabs.push({ tabId: next, url: body.args['url'], title: 'Example', active: true, ...(typeof body.args['group_title'] === 'string' ? { groupTitle: body.args['group_title'] } : {}) });
      current = next;
      return new Response(JSON.stringify({ ok: true, data: { success: true, url: body.args['url'], tabId: next } }), { status: 200 });
    }
    if (body.action === 'list_tabs') {
      const rows = planned.reportActiveTabId === undefined ? tabs : tabs.map((tab) => ({ ...tab, active: tab.tabId === planned.reportActiveTabId }));
      return new Response(JSON.stringify({ ok: true, data: { success: true, tabs: rows } }), { status: 200 });
    }
    if (body.action === 'find_tab' && typeof body.args?.['url'] === 'string') {
      const matches = tabs.filter((tab) => tab.url === body.args?.['url']);
      const match = matches.length === 1 ? matches[0] : undefined;
      if (match === undefined) return new Response(JSON.stringify({ ok: true, data: { success: false, error: 'no single tab' } }), { status: 200 });
      for (const tab of tabs) tab.active = tab.tabId === match.tabId;
      current = match.tabId;
      return new Response(JSON.stringify({ ok: true, data: { success: true, url: match.url, tabId: match.tabId } }), { status: 200 });
    }
    if (body.action === 'snapshot' || body.action === 'click' || body.action === 'fill' || body.action === 'close_tab') effects.push({ action: body.action, tabId: current });
    if (body.action === 'snapshot') return new Response(JSON.stringify({ ok: true, data: { success: true, tree: '@e1 button Example' } }), { status: 200 });
    if (body.action === 'click' || body.action === 'fill') return new Response(JSON.stringify({ ok: true, data: { success: true } }), { status: 200 });
    if (body.action === 'close_tab') {
      const closed = tabs.find((tab) => tab.tabId === current);
      if (closed !== undefined) tabs.splice(tabs.indexOf(closed), 1);
      current = tabs.find((tab) => tab.active)?.tabId;
      return new Response(JSON.stringify({ ok: true, data: { success: true, closed: closed !== undefined } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 200 });
  });
  const config: BrowserConfig = { connections: { 'kimi-webbridge': { type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true, endpointSecret: 'http://127.0.0.1' } } };
  const sections = new Emitter<ConfigSectionChangedEvent>();
  const ix = new TestInstantiationService();
  const factory = { _serviceBrand: undefined, open: vi.fn(async () => { throw new Error('CDP driver must stay closed'); }) };
  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IBrowserConnectionStore, {
    _serviceBrand: undefined,
    list: async () => ({ connections: [{ id: 'kimi-webbridge', name: 'edge-kimi', type: 'agent-browser-cdp' as const, enabled: true }] }),
    resolve: async () => ({ id: 'kimi-webbridge', type: 'agent-browser-cdp' as const, name: 'edge-kimi', enabled: true, endpointSecret: 'http://127.0.0.1' }),
    upsert: async () => { throw new Error('config write is not part of this chain'); },
    remove: async () => undefined, setDefault: async () => undefined, revealEndpoint: async () => undefined,
  });
  ix.stub(IBrowserBackendFactory, factory);
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  ix.stub(defaults, { ready: Promise.resolve(undefined) });
  ix.stub(IAgentScopeContext, { agentId: 'main' });
  ix.stub(ISessionContext, { sessionId: 'fixture-session', sessionDir: '/fixture/session' });
  ix.stub(ISessionWorkspaceContext, { workDir: '/fixture', additionalDirs: [] });
  ix.stub(IAgentRuntimeService, {});
  ix.stub(ISessionMediaStore, {});
  ix.stub(ISessionInteractionService, { hasConsumer: () => false });
  ix.stub(IConfigService, { onDidSectionChange: sections.event, get: <T>(domain: string) => (domain === BROWSER_CONFIG_SECTION ? config : undefined) as T });
  ix.stub(IAgentToolPolicyService, { isToolActiveForDisclosure: () => true });
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentBrowserService, new SyncDescriptor(AgentBrowserService));
  return { ix, service: ix.get(IAgentBrowserService), factory, effects };
}
