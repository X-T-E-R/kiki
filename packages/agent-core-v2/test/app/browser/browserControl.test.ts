import { describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IBrowserControlService } from '#/app/browser/browser';
import { BrowserControlService } from '#/app/browser/browserControlService';
import { IBrowserBackendFactory, type BrowserBackend } from '#/app/browser/browserBackend';
import type { BrowserResolvedConnection } from '#/app/browser/browserConfig';
import type { MCPToolResult } from '#/mcpCore/types';
import { projectBrowserToolSchema, validateBrowserValues } from '#/agent/tools/browser/browserTools';

function response(data: Record<string, unknown>, success = true): MCPToolResult {
  return { isError: !success, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { exitCode: 0, response: { success, data } } };
}
function fixture() {
  const configs = new Map<string, BrowserResolvedConnection>([
    ['a', { id: 'a', type: 'agent-browser-profile', name: 'A', enabled: true }],
    ['b', { id: 'b', type: 'agent-browser-cdp', name: 'B', enabled: true, endpointSecret: 'http://browser.example.test' }],
  ]);
  const calls: { browser: string; name: string; args: Record<string, unknown> }[] = [];
  const live = new Map<string, boolean>();
  const tabs = new Map<string, { tabId: string; targetId: string }[]>([
    ['a', [{ tabId: 't1', targetId: 'a-tab' }]], ['b', [{ tabId: 't1', targetId: 'b-tab' }]],
  ]);
  const handlers = new Map<string, () => Promise<MCPToolResult>>();
  const factory = { _serviceBrand: undefined, open: vi.fn(async (config: BrowserResolvedConnection) => ({
    session: `session-${config.id}`, namespace: 'fixture', version: '0.38.2', runtime: {} as BrowserBackend['runtime'],
    profilePath: config.type === 'agent-browser-profile' ? `/fixture/${config.id}` : undefined,
    close: vi.fn(async () => undefined), client: {
      ping: async () => undefined,
      listTools: async () => [{ name: 'agent_browser_snapshot', description: 'Snapshot', inputSchema: { type: 'object', properties: {} } }],
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ browser: config.id, name, args });
        const custom = handlers.get(`${config.id}:${name}`);
        if (custom !== undefined) return custom();
        if (name === 'agent_browser_open' || name === 'agent_browser_connect') { live.set(config.id, true); return response({ opened: true }); }
        if (name === 'agent_browser_session_info') return response({ active: live.get(config.id) === true, pid: null, runtime: null });
        if (name === 'agent_browser_close') { live.set(config.id, false); return response({ closed: true }); }
        if (name === 'agent_browser_tab_list') return response({ tabs: tabs.get(config.id) });
        if (name === 'agent_browser_tab_new') { const targetId = `${config.id}-new`; tabs.get(config.id)!.push({ tabId: 't2', targetId }); return response({ targetId, tabId: 't2' }); }
        return response({ done: true });
      },
    },
  })) };
  const ix = new TestInstantiationService();
  const flags = { enabled: () => true };
  ix.stub(IFlagService, flags);
  ix.stub(IBrowserConnectionStore, {
    _serviceBrand: undefined,
    list: async () => ({ connections: [...configs.values()].map(({ id, name, type, enabled }) => ({ id, name, type, enabled })) }),
    resolve: async (id) => { const config = configs.get(id); if (config === undefined) throw new Error('Unknown browser'); return config; },
    upsert: async () => { throw new Error('not used'); }, remove: async (id) => { configs.delete(id); },
    setDefault: async () => undefined, revealEndpoint: async () => undefined,
  });
  ix.stub(IBrowserBackendFactory, factory);
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  return { ix, control: ix.get(IBrowserControlService), factory, calls, handlers, tabs, flags, configs };
}
const caller = { sessionId: 'fixture-session', agentId: 'main' };

describe('browser connection execution ownership', () => {
  it('clears an old missing-driver failure after installation and a successful check without claiming connected', async () => {
    const f = fixture();
    try {
      f.factory.open.mockRejectedValueOnce(new Error('Browser components are not prepared'));
      expect((await f.control.check('a')).state).toBe('failed');
      expect(await f.control.check('a')).toMatchObject({ state: 'idle', driverVersion: '0.38.2', error: undefined, failure: undefined });
      expect(f.calls.map((call) => call.name)).toEqual(['agent_browser_session_info']);
    } finally { await f.ix.dispose(); }
  });
  it('retains failure when the prepared driver rejects its session probe', async () => {
    const f = fixture();
    try {
      f.factory.open.mockRejectedValueOnce(new Error('Browser components are not prepared'));
      expect((await f.control.check('a')).state).toBe('failed');
      f.handlers.set('a:agent_browser_session_info', async () => ({ isError: true, content: [], structuredContent: { exitCode: 1, response: { success: false, error: 'session probe refused' } } }));
      expect(await f.control.check('a')).toMatchObject({ state: 'failed', error: expect.stringContaining('session probe refused') });
      expect(f.calls.map((call) => call.name)).toEqual(['agent_browser_session_info']);
    } finally { await f.ix.dispose(); }
  });
  it('keeps saved management readable but prevents experimental execution while disabled', async () => {
    const f = fixture(); f.flags.enabled = () => false;
    try {
      expect((await f.control.list()).connections).toHaveLength(2);
      await expect(f.control.connect('a')).rejects.toMatchObject({ code: 'browser.disabled', details: { reason: 'feature_disabled' } });
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });
  it('distinguishes connection disabled from the feature gate without starting a driver', async () => {
    const f = fixture();
    f.configs.set('a', { ...f.configs.get('a')!, enabled: false });
    try {
      await expect(f.control.connect('a')).rejects.toMatchObject({ code: 'browser.disabled', details: { reason: 'connection_disabled' } });
      await expect(f.control.tabs('a')).rejects.toMatchObject({ code: 'browser.disabled', details: { reason: 'connection_disabled' } });
      expect(f.factory.open).not.toHaveBeenCalled();
    } finally { await f.ix.dispose(); }
  });
  it('lists configuration without starting a driver and checks without launching a browser', async () => {
    const f = fixture();
    try {
      expect((await f.control.list()).connections.map((item) => item.status.state)).toEqual(['idle', 'idle']);
      expect(f.factory.open).not.toHaveBeenCalled();
      expect((await f.control.check('a')).state).toBe('idle');
      expect(f.calls.map((call) => call.name)).toEqual(['agent_browser_session_info']);
    } finally { await f.ix.dispose(); }
  });

  it('drains a queued connect before deciding whether disconnect must close its daemon', async () => {
    const f = fixture();
    try {
      const original = f.factory.open.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      f.factory.open.mockImplementationOnce(async (config) => { await gate; return original(config); });
      const connecting = f.control.connect('a');
      await vi.waitFor(() => { expect(f.factory.open).toHaveBeenCalledOnce(); });
      const disconnecting = f.control.disconnect('a');
      release();
      await connecting;
      expect((await disconnecting).state).toBe('disconnected');
      expect(f.calls.filter((call) => call.name === 'agent_browser_close')).toHaveLength(1);
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {}, tab: 'a-tab' })).rejects.toMatchObject({ code: 'browser.disconnected' });
    } finally { await f.ix.dispose(); }
  });

  it('rejects queued cancelled operations and lifecycle work without disconnecting the active owner', async () => {
    const f = fixture();
    try {
      await f.control.connect('a');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      f.handlers.set('a:agent_browser_fill', async () => { await gate; return response({ done: true }); });
      const first = f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_fill', args: { text: 'first' } });
      await vi.waitFor(() => expect(f.calls.filter((call) => call.name === 'agent_browser_fill')).toHaveLength(1));
      const abort = new AbortController();
      const second = f.control.invoke({ browser: 'a', caller: { ...caller, agentId: 'other' }, tool: 'agent_browser_fill', args: { text: 'cancelled' } }, abort.signal);
      const disconnect = f.control.disconnect('a', abort.signal);
      const tabs = f.control.tabs('a', abort.signal);
      const check = f.control.check('a', abort.signal);
      const catalog = f.control.catalog('a', abort.signal);
      abort.abort(new Error('fixture cancelled before send'));
      const rejected = Promise.all([second, disconnect, tabs, check, catalog].map((work) => expect(work).rejects.toThrow('fixture cancelled before send')));
      expect((await f.control.status('a')).state).toBe('running');
      release();
      await first;
      await rejected;
      expect(f.calls.filter((call) => call.name === 'agent_browser_fill').map((call) => call.args['text'])).toEqual(['first']);
      expect(f.calls.filter((call) => call.name === 'agent_browser_close')).toHaveLength(0);
      expect((await f.control.status('a')).state).toBe('ready');
      await f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {} });
      expect(f.calls.filter((call) => call.name === 'agent_browser_click')).toHaveLength(1);
    } finally { await f.control.disconnect('a'); await f.ix.dispose(); }
  });

  it('checks cancellation after target discovery and drains already-sent work without replay', async () => {
    const f = fixture();
    try {
      await f.control.connect('a');
      const abort = new AbortController();
      f.handlers.set('a:agent_browser_tab_list', async () => { abort.abort(new Error('cancelled during discovery')); return response({ tabs: [{ tabId: 't1', targetId: 'a-tab' }] }); });
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {}, tab: 'a-tab' }, abort.signal)).rejects.toThrow('cancelled during discovery');
      expect(f.calls.filter((call) => call.name === 'agent_browser_click' || call.name === 'agent_browser_tab_switch')).toHaveLength(0);
      expect((await f.control.status('a')).state).toBe('ready');
      f.handlers.delete('a:agent_browser_tab_list');
      const sent = new AbortController();
      f.handlers.set('a:agent_browser_click', async () => { sent.abort(); return response({ done: true }); });
      await f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {} }, sent.signal);
      expect(f.calls.filter((call) => call.name === 'agent_browser_click')).toHaveLength(1);
      expect((await f.control.status('a')).state).toBe('ready');
    } finally { await f.control.disconnect('a'); await f.ix.dispose(); }
  });

  it('binds two same-tab-counter browsers to distinct session/target/frame/file provenance', async () => {
    const f = fixture();
    try {
      const a = await f.control.connect('a');
      const b = await f.control.connect('b');
      const first = await f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_download', args: { selector: '#file', path: '/fixture/a/report.json' }, tab: 'a-tab', frame: '#embedded', generation: a.generation });
      const second = await f.control.invoke({ browser: 'b', caller, tool: 'agent_browser_snapshot', args: {}, tab: 'b-tab', generation: b.generation });
      expect(first).toMatchObject({ browser: 'a', runtimeSession: 'session-a', tab: 'a-tab', frame: '#embedded' });
      expect(second).toMatchObject({ browser: 'b', runtimeSession: 'session-b', tab: 'b-tab' });
      expect(f.calls.filter((call) => call.name === 'agent_browser_tab_switch').map((call) => call.args['tab'])).toEqual(['a-tab', 'b-tab']);
      expect(f.calls.find((call) => call.name === 'agent_browser_download')?.args).toMatchObject({ session: 'session-a', namespace: 'fixture', path: '/fixture/a/report.json' });
      expect(f.calls.find((call) => call.name === 'agent_browser_connect')?.args).toMatchObject({ target: 'http://browser.example.test', pinTab: true });
      await expect(f.control.invoke({ browser: 'b', caller, tool: 'agent_browser_click', args: {}, tab: 'a-tab' })).rejects.toMatchObject({ code: 'browser.target' });
      f.tabs.set('a', []);
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {}, tab: 'a-tab' })).rejects.toMatchObject({ code: 'browser.target' });
    } finally { await f.ix.dispose(); }
  });

  it('never replays an indeterminate operation and requires a confirmed daemon terminal state', async () => {
    const f = fixture();
    try {
      await f.control.connect('a');
      f.handlers.set('a:agent_browser_click', async () => { throw new Error('response lost after dispatch'); });
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {}, tab: 'a-tab' })).rejects.toThrow('response lost');
      expect(f.calls.filter((call) => call.name === 'agent_browser_click')).toHaveLength(1);
      expect((await f.control.status('a')).state).toBe('unconfirmed');
      await expect(f.control.connect('a')).rejects.toMatchObject({ code: 'browser.busy' });
      expect((await f.control.disconnect('a')).state).toBe('disconnected');
      const fresh = await f.control.connect('a');
      expect(fresh.state).toBe('ready');
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_snapshot', args: {}, tab: 'a-tab', generation: 1 })).rejects.toMatchObject({ code: 'browser.target' });
    } finally { await f.ix.dispose(); }
  });

  it('rejects references from another agent, frame, or an overwritten snapshot before dispatch', async () => {
    const f = fixture();
    try {
      await f.control.connect('a');
      f.handlers.set('a:agent_browser_snapshot', async () => response({ refs: { e1: { role: 'button', name: 'A' } } }));
      const snapshot = { browser: 'a', caller, tool: 'agent_browser_snapshot', args: {}, tab: 'a-tab' };
      await f.control.invoke(snapshot);
      await expect(f.control.invoke({ ...snapshot, caller: { ...caller, agentId: 'child' }, tool: 'agent_browser_click', args: { selector: '@e1' } })).rejects.toMatchObject({ code: 'browser.target' });
      await expect(f.control.invoke({ ...snapshot, frame: '#other', tool: 'agent_browser_click', args: { selector: '@e1' } })).rejects.toMatchObject({ code: 'browser.target' });
      await expect(f.control.invoke({ ...snapshot, tool: 'agent_browser_click', args: { selector: '@e2' } })).rejects.toMatchObject({ code: 'browser.target' });
      await f.control.invoke({ ...snapshot, tool: 'agent_browser_click', args: { selector: '@e1' } });
      await expect(f.control.invoke({ ...snapshot, tool: 'agent_browser_click', args: { selector: '@e1' } })).rejects.toMatchObject({ code: 'browser.target' });
      await f.control.invoke(snapshot);
      await f.control.invoke({ ...snapshot, caller: { ...caller, agentId: 'child' } });
      await expect(f.control.invoke({ ...snapshot, tool: 'agent_browser_click', args: { selector: '@e1' } })).rejects.toMatchObject({ code: 'browser.target' });
      expect(f.calls.filter((call) => call.name === 'agent_browser_click')).toHaveLength(1);
      expect(f.calls.filter((call) => call.name === 'agent_browser_tab_switch')).toHaveLength(1);
    } finally { await f.ix.dispose(); }
  });

  it('retains capture ownership until its creating agent and frame finish it', async () => {
    const f = fixture();
    try {
      await f.control.connect('a');
      const input = { browser: 'a', caller, tab: 'a-tab', tool: 'agent_browser_trace_start', args: {} };
      await f.control.invoke(input);
      await expect(f.control.invoke({ ...input, caller: { ...caller, agentId: 'child' }, tool: 'agent_browser_trace_stop', args: { path: '/fixture/child.json' } })).rejects.toMatchObject({ code: 'browser.busy' });
      expect(f.calls.filter((call) => call.name === 'agent_browser_trace_stop')).toHaveLength(0);
      await f.control.invoke({ ...input, tool: 'agent_browser_trace_stop', args: { path: '/fixture/main.json' } });
      await f.control.invoke({ ...input, caller: { ...caller, agentId: 'child' } });
    } finally { await f.ix.dispose(); }
  });

  it('does not classify a missing backend as an in-flight unknown execution', async () => {
    const f = fixture();
    f.factory.open.mockRejectedValueOnce(new Error('driver unavailable'));
    try { expect((await f.control.connect('a')).state).toBe('failed'); }
    finally { await f.ix.dispose(); }
  });

  it('serializes tab+frame selection and the operation together on each connection', async () => {
    const f = fixture();
    try {
      await f.control.connect('a');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      f.handlers.set('a:agent_browser_click', async () => { await gate; return response({ clicked: true }); });
      const first = f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {}, tab: 'a-tab' });
      await vi.waitFor(() => expect(f.calls.some((call) => call.name === 'agent_browser_click')).toBe(true));
      const next = f.control.invoke({ browser: 'a', caller: { ...caller, agentId: 'child' }, tool: 'agent_browser_snapshot', args: {}, tab: 'a-tab' });
      expect(f.calls.filter((call) => call.name === 'agent_browser_snapshot')).toHaveLength(0);
      release();
      await Promise.all([first, next]);
      expect(f.calls.filter((call) => ['agent_browser_click', 'agent_browser_snapshot'].includes(call.name)).map((call) => call.name)).toEqual(['agent_browser_click', 'agent_browser_snapshot']);
    } finally { await f.ix.dispose(); }
  });
});

describe('donor schema projection', () => {
  it('keeps required typed operation fields while hiding managed identity and extra argv', () => {
    const schema = projectBrowserToolSchema({ name: 'agent_browser_fill', description: 'Fill', inputSchema: { type: 'object', required: ['selector', 'text'],
      properties: { selector: { type: 'string' }, text: { type: 'string' }, extraArgs: { type: 'array' }, session: { type: 'string' }, namespace: { type: 'string' } } } });
    expect(schema['required']).toEqual(['selector', 'text']);
    expect(schema['properties']).toEqual({ selector: { type: 'string' }, text: { type: 'string' }, browser: expect.any(Object), browserTab: expect.any(Object) });
    expect(() => validateBrowserValues({ session: 'other' })).toThrow('managed by Kiki');
    expect(() => validateBrowserValues({ text: '--profile' })).toThrow('does not escape');
    expect(() => validateBrowserValues({ script: 'document.body.textContent = "--profile"' })).not.toThrow();
  });
});
