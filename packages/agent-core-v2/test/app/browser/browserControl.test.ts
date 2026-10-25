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
import { BridgeCodexBrowser, OfficialCodexBrowser, codexTurnMetadata, officialBrowserEmptyInventoryReason, resolveCodexBrowserCli, type BrowserRequestContext } from '#/app/browser/codexBrowser';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { isBrowserOperation } from '#/app/browser/browserControlService';
import { BrowserError } from '#/app/browser/errors';
import { BrowserConfigSchema, migrateKnownWebbridgePreset } from '#/app/browser/browserConfig';
import { browserElicitation } from '#/agent/tools/browser/browserElicitation';
import type { ISessionInteractionService } from '#/session/interaction/interaction';
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
  const factory = { _serviceBrand: undefined, open: vi.fn(async (config: BrowserResolvedConnection): Promise<BrowserBackend> => ({
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
  const allowed: { browsers?: readonly string[] } = {};
  const route = { enabled: true };
  ix.stub(IFlagService, flags);
  ix.stub(IBrowserConnectionStore, {
    _serviceBrand: undefined,
    list: async () => ({ connections: [...configs.values()].map(({ id, name, type, enabled }) => ({ id, name, type, enabled })), allowedBrowsers: allowed.browsers, ...(route.enabled ? {} : { webbridgePresetRoute: false }) }),
    resolve: async (id) => { const config = configs.get(id); if (config === undefined) throw new Error('Unknown browser'); return config; },
    upsert: async () => { throw new Error('not used'); }, remove: async (id) => { configs.delete(id); },
    setDefault: async () => undefined, revealEndpoint: async () => undefined,
  });
  ix.stub(IBrowserBackendFactory, factory);
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  return { ix, control: ix.get(IBrowserControlService), factory, calls, handlers, tabs, flags, configs, allowed, route };
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

  it('does not launch a browser when its allow set changes during driver startup', async () => {
    const f = fixture();
    let release!: () => void;
    try {
      const original = f.factory.open.getMockImplementation()!;
      f.factory.open.mockImplementationOnce(async (config) => {
        await new Promise<void>((resolve) => { release = resolve; });
        return original(config);
      });
      const connecting = f.control.connect('a');
      await vi.waitFor(() => expect(release).toBeDefined());
      f.allowed.browsers = [];
      release();
      expect(await connecting).toMatchObject({ failure: { code: 'browser.disabled' } });
      expect(f.calls).toHaveLength(0);
      expect((await f.control.disconnect('a')).state).toBe('disconnected');
    } finally { release?.(); await f.ix.dispose(); }
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

  it.each(['allow-set', 'master-off', 'connection-off', 'tool-deny'] as const)('rejects queued browser work after %s while retaining disconnect recovery', async (revocation) => {
    const f = fixture();
    let release!: () => void;
    let toolAllowed = true;
    try {
      await f.control.connect('a');
      f.handlers.set('a:agent_browser_fill', async () => { await new Promise<void>((resolve) => { release = resolve; }); return response({ done: true }); });
      const first = f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_fill', args: {} });
      await vi.waitFor(() => expect(release).toBeDefined());
      const queued: Promise<unknown>[] = [f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {},
        assertToolAllowed: () => { if (!toolAllowed) throw new BrowserError('browser.disabled', 'Tool was denied'); } })];
      if (revocation !== 'tool-deny') queued.push(f.control.connect('a'), f.control.tabs('a'), f.control.check('a'));
      if (revocation === 'allow-set') f.allowed.browsers = ['b'];
      else if (revocation === 'master-off') f.flags.enabled = () => false;
      else if (revocation === 'connection-off') f.configs.set('a', { ...f.configs.get('a')!, enabled: false });
      else toolAllowed = false;
      const rejected = Promise.all(queued.map((work) => expect(work).rejects.toMatchObject({ code: 'browser.disabled' })));
      release();
      await first;
      await rejected;
      expect(f.calls.filter((call) => call.name === 'agent_browser_click')).toHaveLength(0);
      expect((await f.control.list()).connections).toHaveLength(2);
      expect((await f.control.disconnect('a')).state).toBe('disconnected');
    } finally { release?.(); await f.ix.dispose(); }
  });

  it('reconnects changed or recreated configuration only after disconnect, with a fresh generation', async () => {
    const f = fixture();
    try {
      const original = await f.control.connect('b');
      f.configs.set('b', { ...f.configs.get('b')!, name: 'Renamed', enabled: false });
      await expect(f.control.tabs('b')).rejects.toMatchObject({ code: 'browser.disabled' });
      f.configs.set('b', { ...f.configs.get('b')!, enabled: true });
      expect((await f.control.connect('b')).generation).toBe(original.generation);
      f.configs.set('b', { id: 'b', type: 'agent-browser-cdp', name: 'Changed', enabled: true, endpointSecret: 'http://other.example.test' });
      await expect(f.control.connect('b')).rejects.toMatchObject({ code: 'browser.busy' });
      expect((await f.control.disconnect('b')).state).toBe('disconnected');
      const changed = await f.control.connect('b');
      expect(changed.state).toBe('ready');
      expect(changed.generation).toBeGreaterThan(original.generation);
      await expect(f.control.invoke({ browser: 'b', caller, tool: 'agent_browser_click', args: {}, generation: original.generation })).rejects.toMatchObject({ code: 'browser.target' });
      const saved = f.configs.get('b')!;
      await f.control.remove('b');
      f.configs.set('b', saved);
      const recreated = await f.control.connect('b');
      expect(recreated.generation).toBeGreaterThan(changed.generation);
      await expect(f.control.invoke({ browser: 'b', caller, tool: 'agent_browser_click', args: {}, generation: changed.generation })).rejects.toMatchObject({ code: 'browser.target' });
    } finally { await f.ix.dispose(); }
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

  it('keeps an unknown outcome after a timed-out state check without replaying the action', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    let hanging = true;
    vi.useFakeTimers();
    try {
      await f.control.connect('a');
      f.handlers.set('a:agent_browser_click', async () => { throw new Error('response lost after dispatch'); });
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {}, tab: 'a-tab' })).rejects.toThrow('response lost');
      f.handlers.set('a:agent_browser_session_info', async () => {
        if (hanging) return new Promise<MCPToolResult>((resolve) => { release = () => resolve(response({ active: true, pid: null, runtime: null })); });
        return response({ active: false, pid: null, runtime: null });
      });
      const checking = f.control.check('a');
      for (let turn = 0; turn < 8 && release === undefined; turn++) await Promise.resolve();
      expect(release).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(checking).resolves.toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' } });
      expect(f.calls.filter((call) => call.name === 'agent_browser_click')).toHaveLength(1);
      hanging = false;
      release?.();
      await vi.waitFor(() => expect(f.calls.filter((call) => call.name === 'agent_browser_session_info')).toHaveLength(2));
    } finally {
      hanging = false;
      release?.();
      vi.useRealTimers();
      await f.ix.dispose();
    }
  });

  it('does not let a late stopped confirmation clear a newer backend', async () => {
    const f = fixture();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const originalOpen = f.factory.open.getMockImplementation()!;
    let closeCalls = 0;
    const oldClose = vi.fn(async () => {
      closeCalls += 1;
      if (closeCalls === 1) await closeGate;
    });
    f.factory.open.mockImplementationOnce(async (config) => ({ ...(await originalOpen(config)), close: oldClose }));
    vi.useFakeTimers();
    try {
      await f.control.connect('a');
      f.handlers.set('a:agent_browser_click', async () => { throw new Error('response lost after dispatch'); });
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_click', args: {}, tab: 'a-tab' })).rejects.toThrow('response lost');
      f.handlers.set('a:agent_browser_session_info', async () => response({ active: false, pid: null, runtime: null }));
      const checking = f.control.check('a');
      for (let turn = 0; turn < 8 && closeCalls === 0; turn++) await Promise.resolve();
      expect(oldClose).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(checking).resolves.toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' } });
      expect((await f.control.disconnect('a')).state).toBe('disconnected');
      expect(oldClose).toHaveBeenCalledTimes(2);
      const fresh = await f.control.connect('a');
      expect(fresh.state).toBe('ready');
      releaseClose();
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(await f.control.status('a')).toMatchObject({ state: 'ready', generation: fresh.generation });
    } finally {
      releaseClose();
      vi.useRealTimers();
      await f.ix.dispose();
    }
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

  it('classifies a finished CDP rejection as a failed handshake and allows another connect', async () => {
    const f = fixture();
    const endpoint = 'http://browser.example.test';
    try {
      f.handlers.set('b:agent_browser_connect', async () => ({ isError: true, content: [], structuredContent: { exitCode: 1, response: { success: false, error: `CDP connection failed for ${endpoint}/devtools` } } }));
      const rejected = await f.control.connect('b');
      expect(f.calls.find((call) => call.name === 'agent_browser_connect')?.args).toMatchObject({ target: endpoint, pinTab: true, extraArgs: ['--pin-tab', '--cdp', endpoint] });
      expect(rejected.state).toBe('failed');
      expect(rejected.failure?.code).toBe('browser.execution_failed');
      expect(rejected.failure?.reason).toBeUndefined();
      expect(rejected.error).toContain('handshake was rejected');
      expect(rejected.error).not.toContain('browser.example.test');
      expect(rejected.error ?? '').not.toMatch(/outcome_unknown|timed out|timed-out/i);
      f.handlers.set('b:agent_browser_session_info', async () => response({ active: true, pid: null, runtime: null }));
      const checked = await f.control.check('b');
      expect(checked.state).toBe('idle');
      expect(checked.failure?.reason).toBeUndefined();
      expect(checked.error ?? '').not.toMatch(/timed out|timed-out|not replayed/i);
      f.handlers.delete('b:agent_browser_connect');
      expect((await f.control.connect('b')).state).toBe('ready');
    } finally { await f.ix.dispose(); }
  });

  it('routes only the saved Kimi preset over the HTTP bridge and leaves every other CDP connection on the driver', async () => {
    const f = fixture();
    f.configs.set('kimi-webbridge', { id: 'kimi-webbridge', type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true, endpointSecret: 'http://127.0.0.1' });
    f.configs.set('edge-kimi', { id: 'edge-kimi', type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true, endpointSecret: 'http://127.0.0.1:9222' });
    f.tabs.set('edge-kimi', [{ tabId: 't1', targetId: 'edge-tab' }]);
    const seen: { url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      seen.push({ url: String(url), body });
      if (String(url).endsWith('/status')) return new Response(JSON.stringify({ running: true, extension_connected: true, version: 'v2.0.23' }), { status: 200 });
      const action = body === undefined ? '' : (JSON.parse(body) as { action?: string }).action;
      if (action === 'list_tabs') return new Response(JSON.stringify({ ok: true, data: { success: true, tabs: [{ tabId: 7, url: 'https://example.test/page', title: 'Example', active: true }] } }), { status: 200 });
      if (action === 'find_tab') return new Response(JSON.stringify({ ok: true, data: { success: true, url: 'https://example.test/page', tabId: 7 } }), { status: 200 });
      if (action === 'snapshot') return new Response(JSON.stringify({ ok: true, data: { success: true, url: 'https://example.test/page', title: 'Example', tree: '@e1 button Example' } }), { status: 200 });
      if (action === 'click') return new Response(JSON.stringify({ ok: true, data: { success: true, tag: 'button', text: 'Example' } }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 200 });
    });
    try {
      const status = await f.control.connect('kimi-webbridge');
      expect(f.factory.open).not.toHaveBeenCalled();
      expect(status).toMatchObject({ state: 'ready', runtimeSession: 'kiki-kimi-webbridge', driverVersion: 'v2.0.23' });
      expect(status.failure?.reason).toBeUndefined();
      expect(seen.some((call) => call.body?.includes('komodo-bootstrap-20261024'))).toBe(false);
      expect((await f.control.tabs('kimi-webbridge')).map((tab) => tab.targetId)).toEqual(['7']);
      const shot = await f.control.invoke({ browser: 'kimi-webbridge', caller, tool: 'agent_browser_snapshot', args: {}, tab: '7', generation: status.generation });
      expect(shot.result.isError).toBe(false);
      const clicked = await f.control.invoke({ browser: 'kimi-webbridge', caller, tool: 'agent_browser_click', args: { selector: '@e1' }, tab: '7', generation: status.generation });
      expect(clicked.result.isError).toBe(false);
      expect((await f.control.connect('edge-kimi')).state).toBe('ready');
      expect((await f.control.connect('b')).state).toBe('ready');
      expect(f.factory.open).toHaveBeenCalledTimes(2);
      expect(f.calls.some((call) => call.browser === 'kimi-webbridge')).toBe(false);
    } finally { vi.unstubAllGlobals(); await f.ix.dispose(); }
  });

  it('keeps the saved Kimi preset on the CDP driver when the preset route is explicitly off', async () => {
    const f = fixture();
    f.route.enabled = false;
    f.configs.set('kimi-webbridge', { id: 'kimi-webbridge', type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true, endpointSecret: 'http://browser.example.test' });
    f.tabs.set('kimi-webbridge', [{ tabId: 't1', targetId: 'kimi-tab' }]);
    try {
      expect((await f.control.connect('kimi-webbridge')).state).toBe('ready');
      expect(f.factory.open).toHaveBeenCalledTimes(1);
      expect(f.calls.some((call) => call.name === 'agent_browser_connect')).toBe(true);
    } finally { await f.ix.dispose(); }
  });

  it('reattaches a live daemon after an unconfirmed close without opening, switching, or replaying', async () => {
    const f = fixture();
    f.tabs.set('a', [{ tabId: 't1', targetId: 'blank' }, { tabId: 't2', targetId: 'fixture' }, { tabId: 't3', targetId: 'window-tab' }]);
    try {
      expect((await f.control.connect('a')).generation).toBe(1);
      f.handlers.set('a:agent_browser_tab_close', async () => ({ isError: true, content: [{ type: 'text', text: 'timed out' }],
        structuredContent: { exitCode: null, stderr: 'timed out', response: { success: false, error: 'timed out' } } }));
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_tab_close', args: { tab: 'window-tab' }, tab: 'window-tab' })).rejects.toThrow(/not replayed/);
      const checked = await f.control.check('a');
      expect(checked).toMatchObject({ state: 'idle', generation: 2, failure: { reason: 'outcome_unknown' } });
      expect(checked.error).toContain('not replayed');
      const names = () => f.calls.map((call) => call.name);
      const before = names();
      const ready = await f.control.connect('a');
      expect(ready).toMatchObject({ state: 'ready', generation: 3, failure: undefined, error: undefined });
      expect(names().slice(before.length)).toEqual(['agent_browser_session_info', 'agent_browser_tab_list']);
      expect(f.calls.filter((call) => call.name === 'agent_browser_open')).toHaveLength(1);
      expect(f.calls.filter((call) => call.name === 'agent_browser_tab_close')).toHaveLength(1);
      expect(f.calls.some((call) => call.name === 'agent_browser_snapshot')).toBe(false);
      expect(names().filter((name) => name === 'agent_browser_tab_switch')).toEqual(before.filter((name) => name === 'agent_browser_tab_switch'));
      expect(f.tabs.get('a')?.map((tab) => tab.targetId)).toEqual(['blank', 'fixture', 'window-tab']);
    } finally { await f.ix.dispose(); }
  });

  it('opens a replacement only after the unconfirmed daemon is gone, still without replaying the command', async () => {
    const f = fixture();
    try {
      await f.control.connect('a');
      f.handlers.set('a:agent_browser_tab_close', async () => ({ isError: true, content: [],
        structuredContent: { exitCode: null, stderr: 'timed out', response: { success: false, error: 'timed out' } } }));
      await expect(f.control.invoke({ browser: 'a', caller, tool: 'agent_browser_tab_close', args: { tab: 'a-tab' }, tab: 'a-tab' })).rejects.toThrow(/not replayed/);
      await f.control.check('a');
      f.handlers.set('a:agent_browser_session_info', async () => response({ active: false, pid: null, runtime: null }));
      expect((await f.control.connect('a')).state).toBe('ready');
      expect(f.calls.filter((call) => call.name === 'agent_browser_open')).toHaveLength(2);
      expect(f.calls.filter((call) => call.name === 'agent_browser_tab_close')).toHaveLength(1);
      expect(f.calls.some((call) => call.name === 'agent_browser_snapshot')).toBe(false);
    } finally { await f.ix.dispose(); }
  });

  it('does not pin a live CDP browser again after an unconfirmed command', async () => {
    const f = fixture();
    try {
      await f.control.connect('b');
      f.handlers.set('b:agent_browser_snapshot', async () => ({ isError: true, content: [],
        structuredContent: { exitCode: null, stderr: 'timed out', response: { success: false, error: 'timed out' } } }));
      await expect(f.control.invoke({ browser: 'b', caller, tool: 'agent_browser_snapshot', args: {}, tab: 'b-tab' })).rejects.toThrow(/not replayed/);
      expect((await f.control.check('b')).failure?.reason).toBe('outcome_unknown');
      const connects = () => f.calls.filter((call) => call.name === 'agent_browser_connect').length;
      const snapshots = () => f.calls.filter((call) => call.name === 'agent_browser_snapshot').length;
      expect(connects()).toBe(1);
      expect(snapshots()).toBe(1);
      expect((await f.control.connect('b')).state).toBe('ready');
      expect(connects()).toBe(1);
      expect(snapshots()).toBe(1);
      expect(f.calls.filter((call) => call.name === 'agent_browser_connect').every((call) => call.args['pinTab'] === true)).toBe(true);
    } finally { await f.ix.dispose(); }
  });

  it('keeps a lost CDP connect response unconfirmed without replaying it', async () => {
    const f = fixture();
    try {
      f.handlers.set('b:agent_browser_connect', async () => { throw new Error('response lost after dispatch'); });
      const lost = await f.control.connect('b');
      expect(lost).toMatchObject({ state: 'unconfirmed', failure: { reason: 'outcome_unknown' } });
      expect(f.calls.filter((call) => call.name === 'agent_browser_connect')).toHaveLength(1);
      await expect(f.control.connect('b')).rejects.toMatchObject({ code: 'browser.busy' });
      expect(f.calls.filter((call) => call.name === 'agent_browser_connect')).toHaveLength(1);
      f.handlers.set('b:agent_browser_session_info', async () => response({ active: true, pid: null, runtime: null }));
      const checked = await f.control.check('b');
      expect(checked).toMatchObject({ state: 'idle', failure: { reason: 'outcome_unknown' } });
      expect(checked.error).toContain('not replayed');
    } finally { await f.ix.dispose(); }
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

describe('known Kimi preset migration', () => {
  it('rewrites only the saved preset record and keeps an explicit route switch', () => {
    const saved = BrowserConfigSchema.parse({ webbridgePresetRoute: false, connections: {
      'kimi-webbridge': { type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true, endpointSecret: 'http://127.0.0.1' },
      'edge-kimi': { type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true, endpointSecret: 'http://127.0.0.1:9222' },
    } });
    const migrated = migrateKnownWebbridgePreset(saved);
    expect(migrated.webbridgePresetRoute).toBe(false);
    expect(migrated.connections['kimi-webbridge']).toEqual({ type: 'kimi-webbridge', name: 'edge-kimi', enabled: true });
    expect(migrated.connections['edge-kimi']).toMatchObject({ type: 'agent-browser-cdp', endpointSecret: 'http://127.0.0.1:9222' });
    expect(migrateKnownWebbridgePreset(migrated)).toBe(migrated);
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


describe('official Codex browser launcher', () => {
  function host() {
    const fs = new HostFileSystem();
    const runtime = Object.assign(new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: 'official-launcher' }, { pathClass: 'win32' }), { fs });
    return { runtime, stat: vi.spyOn(fs, 'stat') };
  }

  it('resolves only the CLI beside the selected installed runtime', async () => {
    const f = host();
    f.stat.mockResolvedValue({ isFile: true, isDirectory: false, size: 1 });
    expect(await resolveCodexBrowserCli(f.runtime, 'C:\\Apps\\Codex\\resources\\cua_node')).toBe('C:\\Apps\\Codex\\resources\\codex.exe');
    expect(f.stat).toHaveBeenCalledExactlyOnceWith('C:\\Apps\\Codex\\resources\\codex.exe');
  });

  it('preserves inherited CLI discovery for standalone runtimes with no sibling executable', async () => {
    const f = host();
    f.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'os.fs.not_found' }));
    expect(await resolveCodexBrowserCli(f.runtime, 'C:\\Apps\\cua_node')).toBeUndefined();
    expect(f.stat).toHaveBeenCalledOnce();
  });

  it('reports installation access errors instead of silently selecting a different CLI', async () => {
    const f = host();
    f.stat.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(resolveCodexBrowserCli(f.runtime, 'C:\\Apps\\cua_node')).rejects.toMatchObject({ code: 'browser.requires_action' });
    expect(f.stat).toHaveBeenCalledOnce();
  });
});

describe('official Codex browser adapter', () => {
  const context: BrowserRequestContext = { caller, turnId: 7, toolCallId: 'fixture-call', elicit: async () => ({ action: 'cancel' }) };
  const catalog = [{ name: 'js', description: 'Official browser JavaScript', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
    { name: 'js_reset', description: '', inputSchema: {} }, { name: 'turn_ended', description: '', inputSchema: {} }];

  it('does not call browser discovery without caller approval and rejects a CDP substitute', async () => {
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const marker = /KIKI_BROWSER_RESULT_\d+:/.exec(String(args['code']))![0];
      return { isError: false, content: [{ type: 'text', text: `${marker}${JSON.stringify([{ id: 'official-fixture', type: 'cdp' }])}` }] };
    });
    const adapter = new OfficialCodexBrowser({ callTool, listTools: async () => catalog, ping: async () => undefined }, 'official-fixture', catalog);
    await expect(adapter.connect()).rejects.toMatchObject({ code: 'browser.requires_action' });
    expect(callTool).not.toHaveBeenCalled();
    await expect(adapter.connect(context)).rejects.toMatchObject({ code: 'browser.unsupported' });
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('keeps an empty extension list distinct from an app-server broker failure', async () => {
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const marker = /KIKI_BROWSER_RESULT_\d+:/.exec(String(args['code']))![0];
      return { isError: false, content: [{ type: 'text', text: `${marker}[]` }] };
    });
    const extension = new OfficialCodexBrowser({ callTool, listTools: async () => catalog, ping: async () => undefined }, 'missing', catalog, () => '');
    await expect(extension.connect(context)).rejects.toMatchObject({ code: 'browser.requires_action', details: { reason: 'no_connection' } });
    const broker = new OfficialCodexBrowser({ callTool, listTools: async () => catalog, ping: async () => undefined }, 'missing', catalog, () => 'auth_fetch_failure_reason=app_server_request_failed auth_method=missing');
    await expect(broker.connect(context)).rejects.toMatchObject({ code: 'browser.requires_action', details: { reason: 'broker_unavailable' } });
    expect(officialBrowserEmptyInventoryReason('')).toBe('no-connection');
    expect(officialBrowserEmptyInventoryReason('Codex auth token is unavailable')).toBe('no-connection');
    expect(officialBrowserEmptyInventoryReason('auth_method=missing')).toBe('no-connection');
    expect(officialBrowserEmptyInventoryReason('Codex app-server is unavailable')).toBe('broker-unavailable');
  });

  it('preserves official js schema, Kiki metadata, tab identity and image/raw result without replay', async () => {
    const result: MCPToolResult = { isError: false, content: [{ type: 'image', data: 'fixture-image', mimeType: 'image/png' }], _meta: { donor: true }, structuredContent: { raw: true } };
    const callTool = vi.fn(async () => result);
    const adapter = new OfficialCodexBrowser({ callTool, listTools: async () => catalog, ping: async () => undefined }, 'official-fixture', catalog);
    expect(await adapter.client.listTools()).toEqual([{ ...catalog[0], name: 'codex_browser_js' }, { ...catalog[1], name: 'codex_browser_js_reset' }]);
    expect(await adapter.invoke('codex_browser_js', { code: 'await kikiTab.getScreenshot()' }, 'tab-fixture', context)).toBe(result);
    expect(callTool).toHaveBeenCalledWith('js', { code: expect.stringContaining('cua.getTab("tab-fixture", { browser: "official-fixture" })') }, undefined,
      { meta: codexTurnMetadata(context), elicit: expect.any(Function) });
    expect(JSON.parse(String(codexTurnMetadata(context)['x-codex-turn-metadata']))).toEqual({ session_id: 'kiki:fixture-session:main', turn_id: 'kiki:7' });
    callTool.mockRejectedValueOnce(new Error('response lost'));
    await expect(adapter.invoke('codex_browser_js', { code: 'await kikiTab.getAXState()' }, 'tab-fixture', context)).rejects.toThrow('response lost');
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('drains a cancelled sent call, notifies the matching turn once, and resets bindings only on explicit reset or disconnect', async () => {
    let release!: () => void;
    const pending = new Promise<MCPToolResult>((resolve) => { release = () => resolve({ content: [], isError: false }); });
    const callTool = vi.fn(async (name: string) => name === 'js' ? pending : { content: [], isError: false });
    const adapter = new OfficialCodexBrowser({ callTool, listTools: async () => catalog, ping: async () => undefined }, 'official-fixture', catalog);
    const abort = new AbortController();
    const call = adapter.invoke('codex_browser_js', { code: 'fixture action' }, undefined, context, abort.signal);
    abort.abort(new Error('fixture cancelled'));
    await expect(call).rejects.toThrow('fixture cancelled');
    await adapter.endTurn({ ...caller, agentId: 'other' }, 7);
    await adapter.endTurn(caller, 8);
    const ended = adapter.endTurn(caller, 7);
    expect(callTool).toHaveBeenCalledTimes(1);
    release();
    await ended;
    await adapter.endTurn(caller, 7);
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(['js', 'turn_ended']);
    expect(callTool).toHaveBeenLastCalledWith('turn_ended', { hook_event_name: 'turn.ended', session_id: 'kiki:fixture-session:main', turn_id: 'kiki:7' }, undefined, expect.objectContaining({ meta: codexTurnMetadata(context) }));
    await adapter.invoke('codex_browser_js_reset', {}, undefined, { ...context, turnId: 8 });
    await adapter.prepareClose();
    await adapter.prepareClose();
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(['js', 'turn_ended', 'js_reset', 'turn_ended', 'js_reset']);
  });

  it('does not replay a lost turn cleanup or reset an indeterminate runtime', async () => {
    const callTool = vi.fn(async (name: string): Promise<MCPToolResult> => {
      if (name === 'turn_ended') throw new Error('cleanup response lost');
      return { content: [], isError: false };
    });
    const adapter = new OfficialCodexBrowser({ callTool, listTools: async () => catalog, ping: async () => undefined }, 'official-fixture', catalog);
    await adapter.invoke('codex_browser_js', { code: 'fixture action' }, undefined, context);
    await expect(adapter.endTurn(caller, 7)).rejects.toThrow('cleanup response lost');
    await adapter.endTurn(caller, 7);
    await adapter.prepareClose();
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(['js', 'turn_ended']);
  });

  it('keeps unavailable/unsupported separate from unknown outcome and closes only the official runtime', async () => {
    const f = fixture();
    f.configs.set('official', { id: 'official', type: 'codex-extension', name: 'Official', enabled: true, runtimeRoot: '/fixture/cua_node', browserId: 'official-fixture' });
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async (ctx?: BrowserRequestContext) => { if (ctx === undefined) throw new BrowserError('browser.requires_action', 'Approval requires a conversation'); });
    const invoke = vi.fn(async () => { throw new Error('response lost'); });
    f.factory.open.mockImplementationOnce(async () => ({ session: 'official-runtime', namespace: 'official-cua-repl', version: '0.1.0', runtime: {} as BrowserBackend['runtime'], close,
      client: { listTools: async () => [{ ...catalog[0]!, name: 'codex_browser_js' }], callTool: async () => { throw new Error('wrong backend'); }, ping: async () => undefined },
      official: { connect, tabs: async () => [{ tabId: 'official-tab', targetId: 'official-tab' }], invoke, endTurn: async () => undefined } }));
    try {
      expect((await f.control.connect('official')).state).toBe('requires_action');
      expect((await f.control.connect('official', undefined, context)).state).toBe('ready');
      await expect(f.control.invoke({ browser: 'official', caller, requestContext: context, tool: 'codex_browser_js', args: { code: '1' }, tab: 'official-tab' })).rejects.toThrow('response lost');
      expect((await f.control.status('official')).state).toBe('unconfirmed');
      expect(invoke).toHaveBeenCalledOnce();
      expect((await f.control.disconnect('official')).state).toBe('disconnected');
      expect(close).toHaveBeenCalledOnce();
      expect(f.calls).toEqual([]);
    } finally { await f.ix.dispose(); }
  });

  it('maps user allow/decline/cancel to MCP without Guardian or credential autoaccept', async () => {
    const request = vi.fn(async () => ({ decision: 'approved' as 'approved' | 'rejected' | 'cancelled', selectedOptionId: 'accept' }));
    const approvals = { request, respond: vi.fn(), hasConsumer: () => true } as unknown as ISessionInteractionService;
    const signal = new AbortController().signal;
    const form = { message: 'Allow the official browser action?', requestedSchema: { type: 'object' as const, properties: {} } };
    for (const [decision, action] of [['approved', 'accept'], ['rejected', 'decline'], ['cancelled', 'cancel']] as const) {
      request.mockResolvedValueOnce({ decision, selectedOptionId: action });
      expect((await browserElicitation(approvals, caller, 7, 'fixture', form, signal)).action).toBe(action);
    }
    expect(await browserElicitation(approvals, caller, 7, 'fixture', { ...form, _meta: { codex_strict_auto_review: true } }, signal)).toEqual({ action: 'cancel' });
    expect(await browserElicitation(approvals, caller, 7, 'fixture', { ...form, requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } }, signal)).toEqual({ action: 'cancel' });
    expect(request).toHaveBeenCalledTimes(3);
  });
});

const bridgePipe = 'codex-browser-use-selected';
const bridgePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function bridgeCatalog() {
  const schema = (fields: string[], required: string[]) => ({ type: 'object', properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])), required });
  const fields: Record<string, string[]> = {
    codex_navigate: ['tab_id', 'url'], codex_fill: ['tab_id', 'selector', 'value'], codex_click: ['tab_id', 'selector'],
    codex_screenshot: ['tab_id', 'format'], codex_cua_click: ['tab_id', 'x', 'y'],
  };
  return ['codex_list_tabs', 'codex_create_tab', 'codex_close_tab', 'codex_navigate', 'codex_dom_snapshot', 'codex_dom_get_visible', 'codex_fill', 'codex_click', 'codex_screenshot', 'codex_get_url', 'codex_get_title', 'codex_wait_for_load', 'codex_claim_tab', 'codex_user_tabs', 'codex_network_cookies', 'codex_execute_cdp', 'codex_cua_click', 'codex_finalize'].map((name) => ({
    name, description: name, inputSchema: schema(fields[name] ?? ['tab_id'], name === 'codex_navigate' ? ['tab_id', 'url'] : name === 'codex_click' ? ['tab_id', 'selector'] : name === 'codex_cua_click' ? ['tab_id', 'x', 'y'] : ['tab_id']),
  }));
}
function bridgeAdapter(callTool: (name: string, args: Record<string, unknown>) => Promise<MCPToolResult>, discover: () => Promise<readonly string[]> = async () => [bridgePipe]) {
  return new BridgeCodexBrowser({ callTool, listTools: async () => [], ping: async () => undefined }, bridgePipe, bridgeCatalog(), discover);
}

describe('Codex extension bridge adapter', () => {
  const context: BrowserRequestContext = { caller, turnId: 7, toolCallId: 'fixture-call', elicit: async () => ({ action: 'cancel' }) };

  it('publishes the donor catalog and keeps session-tab binding off claim', async () => {
    const adapter = bridgeAdapter(async () => { throw new Error('not called'); });
    const listed = await adapter.client.listTools();
    const names = listed.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['codex_navigate', 'codex_dom_snapshot', 'codex_fill', 'codex_click', 'codex_screenshot', 'codex_claim_tab', 'codex_user_tabs', 'codex_network_cookies', 'codex_execute_cdp', 'codex_cua_click']));
    expect(names.some((name) => isBrowserOperation(name))).toBe(true);
    expect(isBrowserOperation('codex_claim_tab')).toBe(true);
    expect(isBrowserOperation('codex_user_tabs')).toBe(true);
    expect(isBrowserOperation('codex_cua_click')).toBe(true);
    expect(isBrowserOperation('codex_list_tabs')).toBe(false);
    expect(isBrowserOperation('codex_finalize')).toBe(false);
    expect(listed.find((tool) => tool.name === 'codex_navigate')?.inputSchema).toMatchObject({ required: ['url'] });
    expect(listed.find((tool) => tool.name === 'codex_claim_tab')?.inputSchema).toMatchObject({ required: ['tab_id'] });
    const stub = { callTool: async () => { throw new Error('not called'); }, listTools: async () => [], ping: async () => undefined };
    expect(() => new BridgeCodexBrowser(stub, 'first-pipe', [], async () => [])).toThrow(/codex-browser-use-/);
    expect(() => new BridgeCodexBrowser(stub, 'codex-browser-use\\11111111-2222-4333-8444-555555555555', [], async () => [])).not.toThrow();
    expect(() => new BridgeCodexBrowser(stub, '\\\\.\\pipe\\codex-browser-use-11111111-2222-4333-8444-555555555555', [], async () => [])).toThrow(/codex-browser-use-/);
  });

  it('requires a conversation caller and the explicitly saved pipe before any bridge request', async () => {
    const callTool = vi.fn(async (_name: string): Promise<MCPToolResult> => ({ content: [{ type: 'text', text: '{}' }], isError: false }));
    const discover = vi.fn(async () => ['codex-browser-use-other']);
    const adapter = bridgeAdapter(callTool, discover);
    await expect(adapter.connect()).rejects.toMatchObject({ code: 'browser.requires_action' });
    expect(discover).not.toHaveBeenCalled();
    await expect(adapter.connect(context)).rejects.toMatchObject({ code: 'browser.requires_action' });
    expect(callTool).not.toHaveBeenCalled();
    discover.mockResolvedValueOnce([bridgePipe]);
    await adapter.connect(context);
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(['codex_get_info', 'codex_name_session']);
    expect(callTool).toHaveBeenLastCalledWith('codex_name_session', { name: 'kiki:fixture-session:main' }, undefined, expect.objectContaining({ meta: codexTurnMetadata(context) }));
  });

  it('reports native protocol rejection without exposing its payload or replaying discovery', async () => {
    const callTool = vi.fn(async (): Promise<MCPToolResult> => ({ isError: true, content: [{ type: 'text', text: 'json-rpc error -32600: Invalid request; private diagnostic payload' }] }));
    const adapter = bridgeAdapter(callTool);
    const error = await adapter.connect(context).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'browser.execution_failed', details: { reason: 'protocol_rejected', tool: 'codex_get_info', method: 'getInfo', failureStage: 'native_request', rpcCode: -32600, rpcClass: 'invalid_request' } });
    expect(String(error)).toContain('Check compatibility');
    expect(JSON.stringify(error)).not.toContain('private diagnostic payload');
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('classifies the native numeric code before message wording and leaves a code-free rejection unknown', async () => {
    const numbered = vi.fn(async (): Promise<MCPToolResult> => ({ isError: true, content: [{ type: 'text', text: 'json-rpc error -32602: Invalid request; private diagnostic payload' }] }));
    const codedError = await bridgeAdapter(numbered).connect(context).catch((cause: unknown) => cause);
    expect(codedError).toMatchObject({ details: { rpcCode: -32602, rpcClass: 'invalid_params' } });
    expect(numbered).toHaveBeenCalledOnce();
    const unnumbered = vi.fn(async (): Promise<MCPToolResult> => ({ isError: true, content: [{ type: 'text', text: 'Invalid request; private diagnostic payload' }] }));
    const unknownError = await bridgeAdapter(unnumbered).connect(context).catch((cause: unknown) => cause);
    expect(unknownError).toMatchObject({ details: { reason: 'bridge_rejected', tool: 'codex_get_info', failureStage: 'tool_call', rpcClass: 'unknown' } });
    expect(unknownError).not.toHaveProperty('details.rpcCode');
    expect(unknownError).not.toHaveProperty('details.method');
    expect(JSON.stringify(unknownError)).not.toContain('private diagnostic payload');
    expect(unnumbered).toHaveBeenCalledOnce();
  });

  it('creates an isolated tab, reads DOM, fills, clicks once, and accepts only a real image', async () => {
    const pngBytes = Buffer.from(bridgePng, 'base64').byteLength;
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>): Promise<MCPToolResult> => {
      if (name === 'codex_create_tab') return { content: [{ type: 'text', text: 'Created tab: 7' }], isError: false };
      if (name === 'codex_list_tabs') return { content: [{ type: 'text', text: JSON.stringify([{ id: 7, url: 'http://127.0.0.1:9/', title: 'local' }]) }], isError: false };
      if (name === 'codex_dom_snapshot') return { content: [{ type: 'text', text: '{"role":"textbox"}' }], isError: false };
      if (name === 'codex_screenshot') return { content: [{ type: 'image', data: bridgePng, mimeType: 'image/png' }, { type: 'text', text: 'Screenshot captured' }], isError: false };
      return { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }], isError: false };
    });
    const adapter = bridgeAdapter(callTool);
    const opened = await adapter.invoke('agent_browser_tab_new', { url: 'http://127.0.0.1:9/form' }, undefined, context);
    expect(opened.structuredContent).toMatchObject({ response: { success: true, data: { targetId: '7', tabId: '7' } } });
    expect(callTool).toHaveBeenNthCalledWith(2, 'codex_navigate', { tab_id: '7', url: 'http://127.0.0.1:9/form' }, undefined, expect.any(Object));
    expect(await adapter.tabs(context)).toEqual([{ tabId: '7', targetId: '7', url: 'http://127.0.0.1:9/', title: 'local' }]);
    expect(bridgeTextResult(await adapter.invoke('codex_dom_snapshot', {}, '7', context))).toContain('textbox');
    await adapter.invoke('codex_fill', { selector: '#q', value: 'local-value' }, '7', context);
    expect(callTool).toHaveBeenLastCalledWith('codex_fill', { tab_id: '7', selector: '#q', value: 'local-value' }, undefined, expect.any(Object));
    await adapter.invoke('codex_click', { selector: '#go' }, '7', context);
    expect(callTool.mock.calls.filter(([name]) => name === 'codex_click')).toHaveLength(1);
    const shot = await adapter.invoke('codex_screenshot', { format: 'png' }, '7', context);
    expect(shot.content.find((item) => item.type === 'image')?.data).toBe(bridgePng);
    expect(shot.structuredContent).toMatchObject({ response: { success: true, data: { mimeType: 'image/png', byteLength: pngBytes } } });
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Screenshot omitted because it is too large' }], isError: false });
    await expect(adapter.invoke('codex_screenshot', {}, '7', context)).rejects.toThrow('did not include an image');
    await expect(adapter.invoke('codex_navigate', { url: 'javascript:alert(1)' }, '7', context)).rejects.toMatchObject({ code: 'browser.invalid' });
    await expect(adapter.invoke('codex_navigate', { url: 'https://user:secret@127.0.0.1/' }, '7', context)).rejects.toMatchObject({ code: 'browser.invalid' });
    await adapter.invoke('codex_claim_tab', { tab_id: '99' }, '7', context);
    expect(callTool).toHaveBeenLastCalledWith('codex_claim_tab', { tab_id: '99' }, undefined, expect.any(Object));
    await adapter.invoke('codex_click', { selector: '#go', x: 1, y: 2 }, '7', context);
    expect(callTool).toHaveBeenLastCalledWith('codex_click', { tab_id: '7', selector: '#go' }, undefined, expect.any(Object));
    await adapter.invoke('codex_cua_click', { x: 1, y: 2 }, '7', context);
    expect(callTool).toHaveBeenLastCalledWith('codex_cua_click', { tab_id: '7', x: 1, y: 2 }, undefined, expect.any(Object));
    await expect(adapter.invoke('codex_click', { selector: '#go', tab_id: '8' }, '7', context)).rejects.toMatchObject({ code: 'browser.target' });
  });

  it('does not replay a lost click and finalizes only a confirmed disconnect', async () => {
    const thrown = vi.fn(async (): Promise<MCPToolResult> => { throw new Error('response channel closed'); });
    const adapter = bridgeAdapter(thrown);
    await expect(adapter.invoke('codex_click', { selector: '#go' }, '7', context)).rejects.toThrow('response channel closed');
    await expect(adapter.invoke('codex_click', { selector: '#go' }, '7', context)).rejects.toMatchObject({ code: 'browser.disconnected' });
    expect(thrown).toHaveBeenCalledTimes(1);
    await adapter.prepareClose();
    expect(thrown).toHaveBeenCalledTimes(1);
    const missed = vi.fn(async (name: string): Promise<MCPToolResult> => ({ content: [{ type: 'text', text: name === 'codex_click' ? 'Error: selector not found' : 'title' }], isError: name === 'codex_click' }));
    const readable = bridgeAdapter(missed);
    await expect(readable.invoke('codex_click', { selector: '#missing' }, '7', context)).rejects.toThrow('did not send it again');
    expect(await readable.invoke('codex_get_title', {}, '7', context)).toMatchObject({ isError: false });
    expect(missed).toHaveBeenCalledTimes(2);
    const lostCalls = vi.fn(async (name: string): Promise<MCPToolResult> => name === 'codex_finalize'
      ? { content: [{ type: 'text', text: 'Tabs finalized' }], isError: false }
      : { content: [{ type: 'text', text: 'Error: response channel closed for fill' }], isError: true });
    const lost = bridgeAdapter(lostCalls);
    await expect(lost.invoke('codex_fill', { selector: '#q', value: 'x' }, '7', context)).rejects.toThrow('did not confirm');
    await lost.prepareClose();
    await lost.endTurn(caller, 7);
    expect(lostCalls.mock.calls.map(([name]) => name)).toEqual(['codex_fill']);
    const clean = vi.fn(async (_name: string): Promise<MCPToolResult> => ({ content: [{ type: 'text', text: 'Tabs finalized' }], isError: false }));
    const discoveryOnly = bridgeAdapter(clean);
    await discoveryOnly.client.listTools();
    await discoveryOnly.prepareClose();
    expect(clean).not.toHaveBeenCalled();
    const confirmed = bridgeAdapter(clean);
    await confirmed.invoke('codex_get_title', {}, '7', context);
    await confirmed.endTurn(caller, 7);
    await confirmed.prepareClose();
    await confirmed.prepareClose();
    expect(clean.mock.calls.map(([name]) => name)).toEqual(['codex_get_title', 'codex_finalize']);
  });

  it('drains a cancelled bridge action before finalizing once and does not replay late success', async () => {
    let release!: () => void;
    const pending = new Promise<MCPToolResult>((resolve) => { release = () => resolve({ content: [], isError: false }); });
    const callTool = vi.fn(async (name: string) => name === 'codex_click' ? pending : { content: [], isError: false });
    const adapter = bridgeAdapter(callTool);
    const abort = new AbortController();
    const action = adapter.invoke('codex_click', { selector: '#go' }, '7', context, abort.signal);
    abort.abort(new Error('cancelled after send'));
    await expect(action).rejects.toThrow('cancelled after send');
    await expect(adapter.invoke('codex_click', { selector: '#go' }, '7', context)).rejects.toMatchObject({ code: 'browser.busy' });
    const closing = adapter.prepareClose();
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(['codex_click']);
    release();
    await closing;
    await adapter.prepareClose();
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(['codex_click', 'codex_finalize']);
    await expect(adapter.invoke('codex_click', { selector: '#go' }, '7', context)).rejects.toMatchObject({ code: 'browser.disconnected' });
  });

  it('keeps caller and tab ownership while a lost bridge click stays unconfirmed', async () => {
    const f = fixture();
    f.configs.set('bridge', { id: 'bridge', type: 'codex-extension', name: 'Bridge', enabled: true, runtimeRoot: 'C:/bridge/codex-browser-bridge.exe', browserId: bridgePipe });
    const callTool = vi.fn(async (name: string): Promise<MCPToolResult> => {
      if (name === 'codex_get_info' || name === 'codex_name_session') return { content: [{ type: 'text', text: '{}' }], isError: false };
      if (name === 'codex_list_tabs') return { content: [{ type: 'text', text: JSON.stringify([{ id: '7', url: 'http://127.0.0.1/', title: 'local' }]) }], isError: false };
      if (name === 'codex_click') throw new Error('response channel closed');
      return { content: [], isError: false };
    });
    const adapter = bridgeAdapter(callTool);
    const close = vi.fn(async () => { await adapter.prepareClose(); });
    f.factory.open.mockImplementationOnce(async () => ({ session: 'bridge-session', namespace: 'codex-browser-bridge', version: 'codex-browser-bridge 1.11.1 MIT',
      runtime: {} as BrowserBackend['runtime'], close, client: adapter.client, official: adapter }));
    try {
      expect((await f.control.connect('bridge', undefined, context)).state).toBe('ready');
      expect((await f.control.status('bridge')).currentCall).toBeUndefined();
      await expect(f.control.invoke({ browser: 'bridge', caller, requestContext: context, tool: 'codex_click', args: { selector: '#go' }, tab: '7', generation: 1 })).rejects.toThrow('response channel closed');
      expect(callTool.mock.calls.filter(([name]) => name === 'codex_click')).toHaveLength(1);
      expect(await f.control.status('bridge')).toMatchObject({ state: 'unconfirmed', currentCall: undefined, failure: { reason: 'outcome_unknown' } });
      await expect(f.control.invoke({ browser: 'bridge', caller, requestContext: context, tool: 'codex_click', args: { selector: '#go' }, tab: '7' })).rejects.toMatchObject({ code: 'browser.disconnected' });
      expect(callTool.mock.calls.filter(([name]) => name === 'codex_click')).toHaveLength(1);
      expect((await f.control.disconnect('bridge')).state).toBe('disconnected');
      expect(callTool.mock.calls.map(([name]) => name)).not.toContain('codex_finalize');
      expect(callTool.mock.calls.map(([name]) => name)).not.toContain('codex_claim_tab');
      expect(close).toHaveBeenCalledOnce();
    } finally { await f.ix.dispose(); }
  });
});

function bridgeTextResult(result: MCPToolResult): string {
  return result.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
}
