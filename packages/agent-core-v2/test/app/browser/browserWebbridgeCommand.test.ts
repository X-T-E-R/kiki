import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IBrowserControlService } from '#/app/browser/browser';
import { BrowserControlService, browserManagedLifecycle, isBrowserOperation } from '#/app/browser/browserControlService';
import { IBrowserBackendFactory, type BrowserBackend } from '#/app/browser/browserBackend';
import { BrowserConnectionInputSchema, BrowserStoredConnectionSchema, type BrowserResolvedConnection } from '#/app/browser/browserConfig';
import { browserResponse } from '#/app/browser/browserControlService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import type { MCPToolResult } from '#/mcpCore/types';

const MISUSE = 'This CDP address is a WebBridge /command endpoint, not a DevTools endpoint. Add a WebBridge command connection; this CDP row was not changed.';
const WITHHELD = 'The CDP operation failed; endpoint details are withheld. Check the driver and explicitly reveal/edit the endpoint in settings.';
const caller = { sessionId: 'fixture-session', agentId: 'main' };

interface Posted { url: string; method: string; body?: { action?: string; args?: Record<string, unknown>; session?: string } }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function envelope(data: Record<string, unknown>, ok = true): Response {
  return json(ok ? { ok: true, data: { success: true, ...data } } : { ok: false, error: data['error'] ?? 'refused' });
}

afterEach(() => { vi.unstubAllGlobals(); });

function controlFixture(options: { failCdp?: boolean } = {}) {
  const rows: BrowserResolvedConnection[] = [
    { id: 'kimi-webbridge', type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true, endpointSecret: 'http://127.0.0.1:9222' },
    { id: 'json-version', type: 'agent-browser-cdp', name: 'JSON version', enabled: true, endpointSecret: 'http://127.0.0.1:10086/json/version' },
    { id: 'command-port', type: 'agent-browser-cdp', name: 'Command on 10086', enabled: true, endpointSecret: 'http://127.0.0.1:10086/command' },
    { id: 'command-other', type: 'agent-browser-cdp', name: 'Command on 9222', enabled: true, endpointSecret: 'http://127.0.0.1:9222/command' },
    { id: 'webbridge-command', type: 'webbridge-command', name: 'Kimi browser extension', enabled: true },
  ];
  const configs = new Map(rows.map((row) => [row.id, row]));
  const calls: { browser: string; name: string; args: Record<string, unknown> }[] = [];
  const factory = { _serviceBrand: undefined, open: vi.fn(async (config: BrowserResolvedConnection): Promise<BrowserBackend> => ({
    session: `session-${config.id}`, namespace: 'fixture', version: '0.38.2', runtime: {} as BrowserBackend['runtime'],
    close: vi.fn(async () => undefined), client: {
      ping: async () => undefined, listTools: async () => [],
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ browser: config.id, name, args });
        if (options.failCdp === true && name === 'agent_browser_connect') throw new Error('cdp socket failed');
        if (name === 'agent_browser_connect' || name === 'agent_browser_open') return tool({ opened: true });
        if (name === 'agent_browser_tab_list') return tool({ tabs: [{ tabId: 't1', targetId: 'target-1' }] });
        if (name === 'agent_browser_session_info') return tool({ active: true, pid: 1, runtime: 'fixture' });
        return tool({ done: true });
      },
    },
  })) };
  const ix = new TestInstantiationService();
  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IHostProcessService, { spawn: async () => { throw new Error('unused'); } } as never);
  ix.stub(IHostFileSystem, {} as never);
  ix.stub(IBrowserConnectionStore, {
    _serviceBrand: undefined,
    list: async () => ({ connections: [...configs.values()].map(({ id, name, type, enabled }) => ({ id, name, type, enabled })) }),
    resolve: async (id: string) => {
      const config = configs.get(id);
      if (config === undefined) throw new Error('Unknown browser');
      return config;
    },
    upsert: async () => { throw new Error('not used'); }, remove: async () => undefined,
    setDefault: async () => undefined, revealEndpoint: async () => undefined,
  });
  ix.stub(IBrowserBackendFactory, factory);
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  return { ix, control: ix.get(IBrowserControlService), factory, calls, configs };
}

function tool(data: Record<string, unknown>): MCPToolResult {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { response: { success: true, data } } };
}

function installPeer(mode: 'ok' | 'lost-snapshot' | 'lost-list' | 'reject' | 'unreachable' = 'ok') {
  const requests: Posted[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Posted['body'] : undefined;
    const posted = { url, method: init?.method ?? 'GET', body };
    requests.push(posted);
    if (url.endsWith('/status')) return json({ running: mode === 'unreachable' ? false : true, extension_connected: true, version: '1.11.4' });
    if (mode === 'unreachable') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (mode === 'reject') return json({ ok: false, error: 'extension refused' });
    if (mode === 'lost-snapshot' && body?.action === 'snapshot') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    if (mode === 'lost-list' && requests.filter((item) => item.body?.action === 'list_tabs').length > 1) throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    if (body?.action === 'list_tabs') return envelope({ tabs: [{ tabId: 1622118901, url: 'https://example.test/invoice', title: 'Invoice', active: true }] });
    if (body?.action === 'find_tab') return envelope({ url: body.args?.['url'], tabId: 1622118901 });
    if (body?.action === 'snapshot') return envelope({ url: 'https://example.test/invoice', title: 'Invoice', tree: 'button @e12' });
    if (body?.action === 'click') return envelope({ tag: 'button', text: 'ok' });
    if (body?.action === 'close_tab') return envelope({ closed: true });
    return envelope({});
  }));
  return requests;
}

function posts(requests: readonly Posted[], action?: string): Posted[] {
  return requests.filter((item) => item.url.endsWith('/command') && (action === undefined || item.body?.action === action));
}

describe('webbridge command control', () => {
  it('keeps an existing CDP row on agent-browser connect, including a kimi id', async () => {
    const f = controlFixture();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('CDP connect must not call WebBridge'); }));
    try {
      const status = await f.control.connect('kimi-webbridge');
      expect(status.state).toBe('ready');
      expect(f.factory.open).toHaveBeenCalledTimes(1);
      expect(f.calls.find((call) => call.name === 'agent_browser_connect')?.args).toMatchObject({ target: 'http://127.0.0.1:9222', pinTab: true });
      expect(f.configs.get('kimi-webbridge')?.type).toBe('agent-browser-cdp');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });

  it('uses the misuse sentence only for a stored /command path and leaves the CDP row unchanged', async () => {
    const f = controlFixture({ failCdp: true });
    try {
      const port = await f.control.connect('json-version');
      expect(port).toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' }, error: WITHHELD });
      expect(port.error).not.toContain('127.0.0.1');
      const commandPort = await f.control.connect('command-port');
      const other = await f.control.connect('command-other');
      expect(commandPort.error).toBe(MISUSE);
      expect(other.error).toBe(MISUSE);
      expect(commandPort.error).not.toContain('127.0.0.1');
      await expect(f.control.connect('command-port')).rejects.toMatchObject({ code: 'browser.busy' });
      expect(f.configs.get('json-version')?.type).toBe('agent-browser-cdp');
      expect(f.configs.get('command-port')?.type).toBe('agent-browser-cdp');
      expect(f.configs.get('command-other')?.type).toBe('agent-browser-cdp');
    } finally { await f.ix.dispose(); }
  });

  it('admits a command URL and a DevTools URL as CDP, and a command row without an endpoint', () => {
    for (const value of ['http://127.0.0.1:10086', 'http://127.0.0.1:10086/json/version', 'http://127.0.0.1:10086/command', 'http://127.0.0.1:9222/command']) {
      expect(BrowserConnectionInputSchema.safeParse({ type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value } }).success).toBe(true);
    }
    expect(BrowserConnectionInputSchema.safeParse({ type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value: 'file:///private' } }).success).toBe(false);
    expect(BrowserStoredConnectionSchema.parse({ type: 'webbridge-command', name: 'Kimi browser extension', enabled: true })).toEqual({
      type: 'webbridge-command', name: 'Kimi browser extension', enabled: true,
    });
    expect(BrowserConnectionInputSchema.safeParse({ type: 'webbridge-command', name: 'Kimi', endpoint: { action: 'keep' } }).success).toBe(false);
  });

  it('connects with one list_tabs and does not open agent-browser', async () => {
    const f = controlFixture();
    const requests = installPeer();
    try {
      const status = await f.control.connect('webbridge-command');
      expect(status).toMatchObject({ state: 'ready', generation: 1 });
      expect(f.factory.open).not.toHaveBeenCalled();
      expect(posts(requests)).toHaveLength(1);
      expect(posts(requests)[0]?.body).toMatchObject({ action: 'list_tabs', args: {} });
      expect(posts(requests)[0]?.body?.session).toMatch(/^kiki-cmd-[0-9a-f]{24}$/);
      expect(posts(requests)[0]?.body?.session).not.toBe('kiki-browser-setup-check');
      await f.control.connect('webbridge-command');
      expect(posts(requests)).toHaveLength(1);
      const names = (await f.control.catalog('webbridge-command')).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        'agent_browser_open', 'agent_browser_tab_new', 'agent_browser_tab_list', 'agent_browser_tab_switch', 'agent_browser_tab_close',
        'agent_browser_snapshot', 'agent_browser_click', 'agent_browser_fill', 'agent_browser_eval', 'agent_browser_screenshot',
        'agent_browser_network', 'agent_browser_upload', 'agent_browser_pdf', 'agent_browser_cdp_action', 'agent_browser_end_session',
      ]));
      expect(names.some((name) => /frame_|window_/.test(name))).toBe(false);
      expect(isBrowserOperation('agent_browser_end_session')).toBe(true);
      expect(isBrowserOperation('agent_browser_cdp_action')).toBe(true);
      expect(browserManagedLifecycle('agent_browser_end_session')).toBe(false);
      expect(browserManagedLifecycle('agent_browser_tab_list')).toBe(true);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });

  it('projects numeric tab ids and an @e snapshot into the existing ref gate', async () => {
    const f = controlFixture();
    const requests = installPeer();
    try {
      await f.control.connect('webbridge-command');
      const tabs = await f.control.tabs('webbridge-command');
      expect(tabs).toEqual([{ tabId: '1622118901', targetId: '1622118901', title: 'Invoice', url: 'https://example.test/invoice', active: true, label: undefined }]);
      const tab = '1622118901';
      await expect(f.control.invoke({ browser: 'webbridge-command', caller, tool: 'agent_browser_click', args: { selector: '@e12' }, tab })).rejects.toMatchObject({ code: 'browser.target' });
      expect(posts(requests, 'click')).toHaveLength(0);
      const shot = await f.control.invoke({ browser: 'webbridge-command', caller, tool: 'agent_browser_snapshot', args: {}, tab });
      expect(browserResponse(shot.result).data?.['refs']).toMatchObject({ e12: true });
      const clicked = await f.control.invoke({ browser: 'webbridge-command', caller, tool: 'agent_browser_click', args: { selector: '@e12' }, tab });
      expect(browserResponse(clicked.result).success).toBe(true);
      expect(posts(requests, 'click')[0]?.body?.args).toEqual({ selector: '@e12' });
      const selected = await f.control.invoke({ browser: 'webbridge-command', caller, tool: 'agent_browser_tab_switch', args: { tab, url: 'https://example.test/invoice' }, tab });
      expect(browserResponse(selected.result).success).toBe(true);
      expect(posts(requests, 'find_tab')).toEqual([expect.objectContaining({ body: expect.objectContaining({ action: 'find_tab', args: { url: 'https://example.test/invoice' } }) })]);
      expect(posts(requests, 'list_tabs')).toHaveLength(2);
    } finally { await f.ix.dispose(); }
  });

  it('does not replay a lost snapshot, and check reads status only', async () => {
    const f = controlFixture();
    const requests = installPeer('lost-snapshot');
    try {
      await f.control.connect('webbridge-command');
      await expect(f.control.invoke({ browser: 'webbridge-command', caller, tool: 'agent_browser_snapshot', args: {}, tab: '1622118901' })).rejects.toMatchObject({ code: 'browser.execution_failed' });
      expect(posts(requests, 'snapshot')).toHaveLength(1);
      const lost = await f.control.status('webbridge-command');
      expect(lost).toMatchObject({ state: 'unconfirmed', failure: { code: 'browser.execution_failed', reason: 'outcome_unknown' } });
      const checked = await f.control.check('webbridge-command');
      expect(posts(requests)).toHaveLength(2);
      expect(requests.filter((item) => item.url.endsWith('/status'))).toHaveLength(1);
      expect(checked).toMatchObject({ state: 'idle', generation: lost.generation + 1, failure: { reason: 'outcome_unknown' } });
      expect(checked.error).toContain('not replayed');
      await expect(f.control.invoke({ browser: 'webbridge-command', caller, tool: 'agent_browser_snapshot', args: {}, tab: '1622118901' })).rejects.toMatchObject({ code: 'browser.disconnected' });
      expect(posts(requests, 'snapshot')).toHaveLength(1);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });

  it('does not call find_tab when list_tabs is lost', async () => {
    const f = controlFixture();
    const requests = installPeer('lost-list');
    try {
      await f.control.connect('webbridge-command');
      await expect(f.control.tabs('webbridge-command')).rejects.toMatchObject({ code: 'browser.execution_failed' });
      expect(posts(requests, 'list_tabs')).toHaveLength(2);
      expect(posts(requests, 'find_tab')).toHaveLength(0);
      expect((await f.control.status('webbridge-command')).state).toBe('unconfirmed');
    } finally { await f.ix.dispose(); }
  });

  it('records a definite command rejection as failed and does not retry', async () => {
    const f = controlFixture();
    const requests = installPeer('reject');
    try {
      const status = await f.control.connect('webbridge-command');
      expect(status.state).toBe('failed');
      expect(status.failure?.reason).toBeUndefined();
      expect(status.error).toBe('extension refused');
      expect(posts(requests)).toHaveLength(1);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });

  it('records an unreachable bridge as failed', async () => {
    const f = controlFixture();
    installPeer('unreachable');
    try {
      const status = await f.control.connect('webbridge-command');
      expect(status.state).toBe('failed');
      expect(status.failure?.reason).toBeUndefined();
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });

  it('rejects window and frame without a command and disconnects without close_session', async () => {
    const f = controlFixture();
    const requests = installPeer();
    try {
      await f.control.connect('webbridge-command');
      await expect(f.control.invoke({ browser: 'webbridge-command', caller, tool: 'agent_browser_window_new', args: {} })).rejects.toMatchObject({ code: 'browser.unsupported' });
      await expect(f.control.invoke({ browser: 'webbridge-command', caller, tool: 'agent_browser_frame_switch', args: { frame: 'child' } })).rejects.toMatchObject({ code: 'browser.unsupported' });
      expect(posts(requests)).toHaveLength(1);
      const disconnected = await f.control.disconnect('webbridge-command');
      expect(disconnected.state).toBe('disconnected');
      expect(posts(requests, 'close_session')).toHaveLength(0);
      expect(posts(requests)).toHaveLength(1);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });

  it('checks an idle command connection with status only', async () => {
    const f = controlFixture();
    const requests = installPeer();
    try {
      const checked = await f.control.check('webbridge-command');
      expect(checked.state).toBe('idle');
      expect(posts(requests)).toHaveLength(0);
      expect(requests.filter((item) => item.url.endsWith('/status'))).toHaveLength(1);
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });
});
