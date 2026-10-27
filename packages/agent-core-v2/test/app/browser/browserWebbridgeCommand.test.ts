import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IBrowserControlService } from '#/app/browser/browser';
import { BrowserControlService, browserManagedLifecycle, browserResponse, isBrowserOperation } from '#/app/browser/browserControlService';
import { IBrowserBackendFactory, type BrowserBackend } from '#/app/browser/browserBackend';
import { BrowserConnectionInputSchema, BrowserStoredConnectionSchema, browserSourceOfConnection, type BrowserResolvedConnection } from '#/app/browser/browserConfig';
import { commandTabIdFromToken, commandTabsFromData, sendWebbridgeCommand, webbridgeCommandForTool } from '#/app/browser/browserWebbridge';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import type { MCPToolResult } from '#/mcpCore/types';

const caller = { sessionId: 'fixture-session', agentId: 'main' };
const browser = 'webbridge-command';
const url = 'https://example.test/invoice';
const tab = 'wb:1622118901';
interface Posted { action: string; args: Record<string, unknown>; session: string }
const tool = (data: Record<string, unknown>): MCPToolResult => ({ isError: false, content: [], structuredContent: { response: { success: true, data } } });
const json = (value: unknown) => new Response(JSON.stringify(value));
const envelope = (data: Record<string, unknown>) => json({ ok: true, data: { success: true, ...data } });
afterEach(() => { vi.unstubAllGlobals(); });

function fixture(failCdp = false) {
  const configs = new Map<string, BrowserResolvedConnection>([
    ['kimi-webbridge', { id: 'kimi-webbridge', type: 'agent-browser-cdp', name: 'Existing CDP', enabled: true, endpointSecret: 'http://127.0.0.1:9222' }],
    ['json-version', { id: 'json-version', type: 'agent-browser-cdp', name: 'CDP', enabled: true, endpointSecret: 'http://127.0.0.1:10086/json/version' }],
    ['command-port', { id: 'command-port', type: 'agent-browser-cdp', name: 'CDP', enabled: true, endpointSecret: 'http://127.0.0.1:10086/command' }],
    ['command-other', { id: 'command-other', type: 'agent-browser-cdp', name: 'CDP', enabled: true, endpointSecret: 'http://127.0.0.1:9222/command' }],
    [browser, { id: browser, type: 'webbridge-command', name: 'Kimi browser extension', enabled: true }],
  ]);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const open = vi.fn(async (config: BrowserResolvedConnection): Promise<BrowserBackend> => ({
    session: `session-${config.id}`, namespace: 'fixture', version: '0.38.2', runtime: {} as BrowserBackend['runtime'], close: async () => undefined,
    client: { ping: async () => undefined, listTools: async () => [], callTool: async (name, args) => {
      calls.push({ name, args });
      if (failCdp && name === 'agent_browser_connect') throw new Error('cdp socket failed');
      if (name === 'agent_browser_tab_list') return tool({ tabs: [{ tabId: 't1', targetId: 'target-1' }] });
      if (name === 'agent_browser_session_info') return tool({ active: true, pid: 1, runtime: 'fixture' });
      return tool({ opened: true });
    } },
  }));
  const ix = new TestInstantiationService();
  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IHostProcessService, {});
  ix.stub(IHostFileSystem, {});
  ix.stub(IBrowserConnectionStore, {
    list: async () => ({ connections: [...configs.values()], webbridgePresetRoute: false }),
    resolve: async (id) => { const row = configs.get(id); if (row === undefined) throw new Error('Unknown browser'); return row; },
  });
  ix.stub(IBrowserBackendFactory, { open });
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  return { ix, control: ix.get(IBrowserControlService), open, configs, calls };
}

function installPeer(mode: 'ok' | 'lost-snapshot' | 'lost-list' | 'reject' | 'unreachable' = 'ok') {
  const requests: Posted[] = [];
  const status = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith('/status')) { status(); return json({ running: true, extension_connected: true, version: '1.11.4' }); }
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON command body');
    const body = JSON.parse(init.body) as Posted;
    requests.push(body);
    if (mode === 'unreachable') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (mode === 'reject') return json({ ok: false, error: 'extension refused' });
    if (mode === 'lost-snapshot' && body.action === 'snapshot') throw Object.assign(new Error('lost'), { name: 'AbortError' });
    if (mode === 'lost-list' && requests.filter((r) => r.action === 'list_tabs').length > 1) throw Object.assign(new Error('lost'), { name: 'TimeoutError' });
    if (body.action === 'list_tabs') return envelope({ tabs: [1622118901, 1622118902].map((tabId) => ({ tabId, url, title: 'Invoice', active: tabId === 1622118901 })) });
    if (body.action === 'navigate') return envelope({ tabId: 1622118901, url: body.args['url'] });
    if (body.action === 'snapshot') return envelope({ tree: 'button @e12' });
    return envelope({ closed: true });
  }));
  return { requests, status, posts: (action: string) => requests.filter((r) => r.action === action) };
}

async function opened(f: ReturnType<typeof fixture>) {
  await f.control.connect(browser);
  return f.control.invoke({ browser, caller, tool: 'agent_browser_tab_new', args: { url } });
}

describe('webbridge command control', () => {
  it('preserves CDP with the existing preset route explicitly off', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('CDP must not call WebBridge'); }));
    try {
      expect((await f.control.connect('kimi-webbridge')).state).toBe('ready');
      expect(f.open).toHaveBeenCalledOnce();
      expect(f.calls.find((c) => c.name === 'agent_browser_connect')?.args).toMatchObject({ target: 'http://127.0.0.1:9222', pinTab: true });
      expect(f.configs.get('kimi-webbridge')?.type).toBe('agent-browser-cdp');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });
  it('explains only a stored /command misuse without rewriting the CDP row', async () => {
    const f = fixture(true);
    try {
      expect(await f.control.connect('json-version')).toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' }, error: 'The CDP operation failed; endpoint details are withheld. Check the driver and explicitly reveal/edit the endpoint in settings.' });
      for (const id of ['command-port', 'command-other']) {
        const result = await f.control.connect(id);
        expect(result.error).toBe('This CDP address is a WebBridge /command endpoint, not a DevTools endpoint. Add a WebBridge command connection; this CDP row was not changed.');
        expect(result.error).not.toContain('127.0.0.1');
        expect(f.configs.get(id)?.type).toBe('agent-browser-cdp');
      }
      await expect(f.control.connect('command-port')).rejects.toMatchObject({ code: 'browser.busy' });
    } finally { await f.ix.dispose(); }
  });
  it('adds a strict endpoint-free command type while preserving source and CDP contracts', () => {
    expect(BrowserStoredConnectionSchema.parse({ type: 'webbridge-command', name: 'Kimi' })).toEqual({ type: 'webbridge-command', name: 'Kimi', enabled: true });
    for (const extra of [{ endpoint: { action: 'keep' } }, { driverPath: 'C:/driver.exe' }]) expect(BrowserConnectionInputSchema.safeParse({ type: 'webbridge-command', name: 'Kimi', ...extra }).success).toBe(false);
    for (const value of ['http://127.0.0.1:10086', 'http://127.0.0.1:10086/command', 'http://127.0.0.1:10086/json/version', 'http://127.0.0.1:9222/command']) expect(BrowserConnectionInputSchema.safeParse({ type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value } }).success).toBe(true);
    expect(browserSourceOfConnection({ type: 'webbridge-command' })).toBe('kimi-webbridge');
    expect(browserSourceOfConnection({ type: 'kimi-webbridge' })).toBe('kimi-webbridge');
    expect(browserSourceOfConnection({ type: 'agent-browser-cdp' })).toBe('independent-browser');
  });
  it('connects once using list_tabs, exposes all mapped tools, and never opens agent-browser', async () => {
    const f = fixture(); const peer = installPeer();
    try {
      expect(await f.control.connect(browser)).toMatchObject({ state: 'ready', generation: 1 });
      await f.control.connect(browser);
      expect(peer.requests).toEqual([{ action: 'list_tabs', args: {}, session: expect.stringMatching(/^kiki-cmd-[0-9a-f]{24}$/) }]);
      const names = (await f.control.catalog(browser)).map((t) => t.name);
      expect(names).toHaveLength(15);
      expect(names).toEqual(expect.arrayContaining(['agent_browser_open', 'agent_browser_tab_new', 'agent_browser_tab_list', 'agent_browser_tab_switch', 'agent_browser_tab_close', 'agent_browser_snapshot', 'agent_browser_click', 'agent_browser_fill', 'agent_browser_eval', 'agent_browser_screenshot', 'agent_browser_network', 'agent_browser_upload', 'agent_browser_pdf', 'agent_browser_cdp_action', 'agent_browser_end_session']));
      expect(names.some((name) => /frame_|window_/.test(name))).toBe(false);
      expect(isBrowserOperation('agent_browser_end_session')).toBe(true);
      expect(browserManagedLifecycle('agent_browser_end_session')).toBe(false);
      expect(f.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });
  it('keeps same-URL tabs on distinct command tokens and refuses selection or close of another tab', async () => {
    const f = fixture(); const peer = installPeer();
    try {
      expect((await opened(f)).tab).toBe(tab);
      const tabs = await f.control.tabs(browser);
      expect(tabs.map((t) => t.targetId)).toEqual([tab, 'wb:1622118902']);
      expect(commandTabIdFromToken(tab)).toBe(1622118901);
      expect(commandTabIdFromToken('1622118901')).toBeUndefined();
      expect(() => commandTabsFromData({ tabs: [{ tabId: 1 }, { tabId: 1 }] })).toThrow(/invalid tab identities/);
      for (const name of ['agent_browser_tab_switch', 'agent_browser_tab_close']) await expect(f.control.invoke({ browser, caller, tool: name, args: { tab: 'wb:1622118902', url }, tab: 'wb:1622118902' })).rejects.toMatchObject({ code: 'browser.unsupported' });
      await expect(f.control.invoke({ browser, caller, tool: 'agent_browser_snapshot', args: {}, tab: 'wb:1622118902' })).rejects.toMatchObject({ code: 'browser.target' });
      expect(browserResponse((await f.control.invoke({ browser, caller, tool: 'agent_browser_tab_switch', args: { tab }, tab })).result).data).toEqual({ tabId: 1622118901 });
      await f.control.invoke({ browser, caller, tool: 'agent_browser_tab_close', args: { tab }, tab });
      expect(peer.posts('close_tab')).toHaveLength(1);
      expect(peer.posts('find_tab')).toHaveLength(0);
    } finally { await f.ix.dispose(); }
  });
  it('binds snapshot refs to caller, tab and observation and consumes used refs', async () => {
    const f = fixture(); const peer = installPeer();
    try {
      await opened(f);
      const click = (agentId: string, selector: string, target = tab) => f.control.invoke({ browser, caller: { ...caller, agentId }, tool: 'agent_browser_click', args: { selector }, tab: target });
      await expect(click('main', '@e12')).rejects.toMatchObject({ code: 'browser.target' });
      const shot = await f.control.invoke({ browser, caller, tool: 'agent_browser_snapshot', args: {}, tab });
      expect(browserResponse(shot.result).data?.['refs']).toEqual({ e12: true });
      await expect(click('main', '@e99')).rejects.toMatchObject({ code: 'browser.target' });
      await expect(click('other', '@e12')).rejects.toMatchObject({ code: 'browser.target' });
      await expect(click('main', '@e12', 'wb:1622118902')).rejects.toMatchObject({ code: 'browser.target' });
      await click('main', '@e12');
      await expect(click('main', '@e12')).rejects.toMatchObject({ code: 'browser.target' });
      expect(peer.posts('click')).toHaveLength(1);
      expect(peer.posts('click')[0]?.args).toEqual({ selector: '@e12' });
    } finally { await f.ix.dispose(); }
  });
  it('never replays a lost snapshot; check reads only status and clears targets', async () => {
    const f = fixture(); const peer = installPeer('lost-snapshot');
    try {
      await opened(f);
      await expect(f.control.invoke({ browser, caller, tool: 'agent_browser_snapshot', args: {}, tab })).rejects.toMatchObject({ code: 'browser.execution_failed', details: { reason: 'outcome_unknown' } });
      expect(await f.control.status(browser)).toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' } });
      await expect(f.control.connect(browser)).rejects.toMatchObject({ code: 'browser.busy' });
      expect(await f.control.check(browser)).toMatchObject({ state: 'idle', generation: 2, failure: { reason: 'outcome_unknown' } });
      expect(peer.status).toHaveBeenCalledOnce();
      expect(peer.requests).toHaveLength(3);
      await expect(f.control.invoke({ browser, caller, tool: 'agent_browser_snapshot', args: {}, tab })).rejects.toMatchObject({ code: 'browser.disconnected' });
      expect(peer.posts('snapshot')).toHaveLength(1);
    } finally { await f.ix.dispose(); }
  });
  it('does not call find_tab or retry when list_tabs is lost', async () => {
    const f = fixture(); const peer = installPeer('lost-list');
    try {
      await f.control.connect(browser);
      await expect(f.control.tabs(browser)).rejects.toMatchObject({ code: 'browser.execution_failed' });
      expect((await f.control.status(browser)).state).toBe('unconfirmed');
      expect(peer.posts('list_tabs')).toHaveLength(2);
      expect(peer.posts('find_tab')).toHaveLength(0);
    } finally { await f.ix.dispose(); }
  });
  it.each(['reject', 'unreachable'] as const)('records definite %s as failed without retry', async (mode) => {
    const f = fixture(); const peer = installPeer(mode);
    try {
      expect(await f.control.connect(browser)).toMatchObject({ state: 'failed', failure: { reason: undefined } });
      expect(peer.requests).toHaveLength(1);
      expect(f.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });
  it('reports an unavailable local status instead of a stale ready state and recovers through a healthy check', async () => {
    const f = fixture(); const peer = installPeer();
    try {
      expect(await f.control.connect(browser)).toMatchObject({ state: 'ready', generation: 1 });
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
      expect(await f.control.check(browser)).toMatchObject({ state: 'disconnected', generation: 2,
        failure: { code: 'browser.disconnected' }, error: expect.stringContaining('HTTP status is unavailable') });
      expect(peer.requests).toHaveLength(1);
      installPeer();
      expect(await f.control.check(browser)).toMatchObject({ state: 'idle', generation: 2, error: undefined, failure: undefined });
      expect(f.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });
  it('checks idle using status only and rejects frames/windows without a command', async () => {
    const f = fixture(); const peer = installPeer();
    try {
      expect((await f.control.check(browser)).state).toBe('idle');
      expect(peer.requests).toHaveLength(0);
      await f.control.connect(browser);
      for (const name of ['agent_browser_window_new', 'agent_browser_frame_switch']) await expect(f.control.invoke({ browser, caller, tool: name, args: {} })).rejects.toMatchObject({ code: 'browser.unsupported' });
      await expect(f.control.invoke({ browser, caller, tool: 'agent_browser_snapshot', args: {}, frame: 'child' })).rejects.toMatchObject({ code: 'browser.unsupported' });
      expect((await f.control.disconnect(browser)).state).toBe('disconnected');
      expect(peer.requests).toHaveLength(1);
      expect(peer.posts('close_session')).toHaveLength(0);
    } finally { await f.ix.dispose(); }
  });
  it.each([
    ['agent_browser_open', { url }, 'navigate', { url, newTab: false }],
    ['agent_browser_eval', { script: 'document.title' }, 'evaluate', { code: 'document.title' }],
    ['agent_browser_fill', { selector: '#input', value: '' }, 'fill', { selector: '#input', value: '' }],
    ['agent_browser_screenshot', { format: 'png' }, 'screenshot', { format: 'png' }],
    ['agent_browser_network', { cmd: 'detail', requestId: 'r1' }, 'network', { cmd: 'detail', requestId: 'r1' }],
    ['agent_browser_upload', { selector: '#file', files: ['C:/fixture.txt'] }, 'upload', { selector: '#file', files: ['C:/fixture.txt'] }],
    ['agent_browser_pdf', { landscape: true }, 'save_as_pdf', { landscape: true }],
    ['agent_browser_cdp_action', { method: 'Page.enable', params: {} }, 'cdp', { method: 'Page.enable', params: {} }],
    ['agent_browser_end_session', {}, 'close_session', {}],
  ])('maps %s to the command protocol', (name, args, action, expected) => {
    expect(webbridgeCommandForTool(name as string, args as Record<string, unknown>)).toEqual({ kind: 'command', action, args: expected });
  });
  it('retains unknown outcome when reading and cancelling the response stream both fail', async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream lost')); } })));
    await expect(sendWebbridgeCommand({ action: 'click', args: {}, session: 'fixture', fetchImpl })).rejects.toMatchObject({ kind: 'lost' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(['reset', 'malformed'] as const)('keeps %s after POST outcome unknown without replay', async (mode) => {
    const fetchImpl = vi.fn(async () => { if (mode === 'reset') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); return new Response('invalid json'); });
    await expect(sendWebbridgeCommand({ action: 'click', args: {}, session: 'fixture', fetchImpl })).rejects.toMatchObject({ kind: 'lost' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
