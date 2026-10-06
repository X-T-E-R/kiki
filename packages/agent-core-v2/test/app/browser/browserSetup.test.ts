import { describe, expect, it, vi, afterEach } from 'vitest';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IBrowserSetupService } from '#/app/browser/browserSetup';
import { BrowserSetupService } from '#/app/browser/browserSetupService';
import { IBrowserControlService } from '#/app/browser/browser';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { ICapabilityService } from '#/app/capability/capability';
import { IPluginService } from '#/app/plugin/plugin';
import { IFlagService } from '#/app/flag/flag';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { ILogService } from '#/_base/log/log';
import { stubLog } from '../../_base/log/stubs';
import type { BrowserConnectionRecord } from '#/app/browser/browserConfig';

const source = 'https://code.kimi.com/kimi-code/plugins/official/kimi-webbridge.zip';
const sha256 = 'a'.repeat(64);
const fixtures: TestInstantiationService[] = [];
afterEach(async () => { for (const ix of fixtures.splice(0)) await ix.dispose(); vi.unstubAllGlobals(); });
function fixture() {
  const ix = new TestInstantiationService(); fixtures.push(ix);
  let installed = false;
  let enabled = false;
  let extension = false;
  let daemon = false;
  let native = true;
  let forced: 'env' | 'memory' | undefined;
  const configSet = vi.fn<IConfigService['set']>(async () => { if (forced === undefined) native = true; });
  const rows: BrowserConnectionRecord[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'http://127.0.0.1:10086/status') return new Response(JSON.stringify({ running: daemon, version: 'v2.0.22', extension_connected: extension }));
    if (url === 'http://127.0.0.1:10086/command') {
      expect(JSON.parse(init!.body as string)).toEqual({ action: 'list_tabs', args: {}, session: 'kiki-browser-setup-check' });
      return new Response(JSON.stringify({ ok: extension, data: { success: extension, tabs: [] } }));
    }
    if (url === 'https://x-t-e-r.github.io/kiki-plugins/marketplace.json') return new Response(JSON.stringify({ name: 'fixture', plugins: [{ id: 'kimi-webbridge', source, sha256 }] }));
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const preview = vi.fn<IPluginService['previewPlugin']>(async () => ({ id: 'kimi-webbridge', fingerprint: 'current-package', unsupported: [], consentRequired: true, changes: [], contributions: ['skill:0'], contextTokens: 0 }));
  const installPlugin = vi.fn(async () => { installed = true; return {} as never; });
  const enablePlugin = vi.fn(async () => { enabled = true; });
  const installCapability = vi.fn(async () => { daemon = true; return {} as never; });
  const getCapability = vi.fn<ICapabilityService['getCapability']>(async (id) => ({
    id: id as 'kimi-webbridge' | 'kiki-browser', displayName: 'Fixture', description: 'fixture', supported: true, state: id === 'kiki-browser' ? 'ready' : daemon && installed && enabled && extension ? 'ready' : 'partial',
    steps: id === 'kiki-browser' ? [{ id: 'driver', state: 'ok' }, { id: 'chrome', state: 'ok' }] : [
      { id: 'daemon', state: daemon ? 'ok' : 'missing' }, { id: 'skill', state: installed && enabled ? 'ok' : 'missing' }, { id: 'extension', state: extension ? 'ok' : 'missing', reason: 'extension_not_connected' },
    ], install: { running: false }, plan: { artifact: { sha256, version: 'fixture', url: 'https://example.test/fixture', metadataUrl: 'https://example.test/metadata', maxBytes: 1024 }, destination: 'fixture', note: 'fixture' },
  }));
  const upsert = vi.fn<IBrowserControlService['upsert']>(async (id, input) => { const row = { id, ...input }; rows.push(row); return row; });
  const connect = vi.fn<IBrowserControlService['connect']>(async (id) => ({ browser: id, state: 'ready', executionHost: 'fixture', generation: 1 }));
  const setDefault = vi.fn(async () => {});
  const cancelCapability = vi.fn<ICapabilityService['cancelCapability']>(async () => ({} as never));
  ix.stub(ICapabilityService, { getCapability, installCapability, cancelCapability });
  ix.stub(IPluginService, { listPlugins: async () => installed ? [{ id: 'kimi-webbridge', enabled, state: 'ok' }] as never : [], previewPlugin: preview, installPlugin, setPluginEnabled: enablePlugin });
  ix.stub(IBrowserControlService, { upsert, connect, status: async (id) => ({ browser: id, state: 'idle', executionHost: 'fixture', generation: 0 }) });
  ix.stub(IBrowserConnectionStore, { list: async () => ({ connections: rows }), setDefault });
  ix.stub(IFlagService, { enabled: () => native, explain: () => ({ id: 'native_browser', title: 'Fixture', description: 'fixture', surface: 'both', env: 'KIKI_EXPERIMENTAL_NATIVE_BROWSER', defaultEnabled: false, enabled: native, source: forced === 'env' ? 'env' : 'config' }) });
  ix.stub(IConfigService, { set: configSet, inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: forced === 'memory' ? { native_browser: false } as never : undefined }) });
  ix.stub(ILogService, stubLog());
  ix.set(IBrowserSetupService, new SyncDescriptor(BrowserSetupService));
  return { setup: ix.get(IBrowserSetupService), configSet, preview, installPlugin, enablePlugin, installCapability, cancelCapability, getCapability, fetchMock, upsert, connect, setDefault, rows,
    extension: () => { extension = true; }, existing: () => { installed = true; enabled = true; daemon = true; }, disableNative: () => { native = false; }, forceOff: (source: 'env' | 'memory') => { native = false; forced = source; } };
}

it('reads presets without installing, enabling or connecting anything and keeps Codex external-only', async () => {
  const f = fixture();
  const result = await f.setup.list();
  expect(result.presets.map((preset) => preset.preset)).toEqual(['kimi-webbridge', 'independent-browser', 'codex-browser']);
  expect(result.presets[2]).toMatchObject({ state: 'external_only', controlSurface: 'external-app', reason: 'external_app_required' });
  expect(f.installPlugin).not.toHaveBeenCalled(); expect(f.enablePlugin).not.toHaveBeenCalled(); expect(f.installCapability).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
});

it('prepares the official pinned plugin and daemon with consent, then waits for browser authorization and probes only its own session', async () => {
  const f = fixture();
  await expect(f.setup.prepare('kimi-webbridge', { consent: false } as never)).rejects.toMatchObject({ code: 'browser.invalid' });
  await f.setup.prepare('kimi-webbridge', { consent: true });
  await vi.waitFor(() => expect(f.installCapability).toHaveBeenCalled());
  expect(f.preview).toHaveBeenCalledWith({ source, sha256 });
  expect(f.installPlugin).toHaveBeenCalledWith({ source, sha256, fingerprint: 'current-package', consent: true });
  expect(f.enablePlugin).toHaveBeenCalledWith({ id: 'kimi-webbridge', enabled: true });
  const waiting = await f.setup.connect('kimi-webbridge', {});
  expect(waiting).toMatchObject({ state: 'needs_user_action', controlSurface: 'plugin-skill' });
  expect(waiting.steps.find((step) => step.id === 'extension')?.state).toBe('user_action');
  expect(f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/command'))).toHaveLength(0);
  f.extension();
  expect(await f.setup.connect('kimi-webbridge', {})).toMatchObject({ state: 'connected', checkedAt: expect.any(String), skill: 'kimi-webbridge' });
});

it('reuses an installed plugin and does not replace it on preparation', async () => {
  const f = fixture(); f.existing(); f.extension();
  await f.setup.prepare('kimi-webbridge', { consent: true });
  await vi.waitFor(() => expect(f.enablePlugin).toHaveBeenCalled());
  expect(f.installPlugin).not.toHaveBeenCalled(); expect(f.preview).not.toHaveBeenCalled(); expect(f.installCapability).not.toHaveBeenCalled();
});

it('retains installation errors and permits explicit retry rather than making a failed package look ready', async () => {
  const f = fixture(); f.installPlugin.mockRejectedValueOnce(new Error('fixture HTTP 503'));
  await f.setup.prepare('kimi-webbridge', { consent: true });
  await vi.waitFor(async () => expect(await f.setup.status('kimi-webbridge')).toMatchObject({ state: 'failed', error: 'fixture HTTP 503' }));
  await f.setup.prepare('kimi-webbridge', { consent: true });
  await vi.waitFor(() => expect(f.installCapability).toHaveBeenCalled());
  expect(f.installPlugin).toHaveBeenCalledTimes(2);
});

it('creates and connects an independent named profile without a path form and sets default only on request', async () => {
  const f = fixture();
  expect(await f.setup.connect('independent-browser', { setDefault: true })).toMatchObject({ state: 'connected', connectionId: 'independent-browser' });
  expect(f.upsert).toHaveBeenCalledWith('independent-browser', { type: 'agent-browser-profile', name: 'Independent browser', enabled: true, headed: true });
  expect(f.setDefault).toHaveBeenCalledWith('independent-browser');
  await f.setup.connect('independent-browser', {});
  expect(f.upsert).toHaveBeenCalledOnce(); expect(f.setDefault).toHaveBeenCalledOnce();
});

it('keeps an existing CDP configuration intact and points to choosing a different connection', async () => {
  const f = fixture(); f.rows.push({ id: 'independent-browser', name: 'Existing CDP', enabled: true, type: 'agent-browser-cdp' });
  expect(await f.setup.connect('independent-browser', {})).toMatchObject({ state: 'needs_user_action', reason: 'connection_conflict' });
  expect(f.upsert).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
});

it('surfaces the feature switch rather than silently enabling it or starting a browser', async () => {
  const f = fixture(); f.disableNative();
  expect(await f.setup.connect('independent-browser', {})).toMatchObject({ state: 'needs_user_action' });
  expect(f.connect).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
});


it('reuses an explicitly configured browser executable without requiring a managed Chrome download or overwriting it', async () => {
  const f = fixture();
  const capability = await f.getCapability('kiki-browser');
  f.getCapability.mockResolvedValue({ ...capability, state: 'partial', steps: [{ id: 'driver', state: 'ok' }, { id: 'chrome', state: 'missing' }] });
  f.rows.push({ id: 'work', type: 'agent-browser-profile', name: 'Existing', enabled: true, executablePath: 'C:/fixture/chrome.exe', profilePath: 'C:/fixture/profile' });
  expect(await f.setup.connect('independent-browser', { connectionId: 'work' })).toMatchObject({ state: 'connected', connectionId: 'work' });
  expect((await f.setup.status('independent-browser')).connectionId).toBe('work');
  expect(f.upsert).not.toHaveBeenCalled(); expect(f.installCapability).not.toHaveBeenCalled(); expect(f.setDefault).not.toHaveBeenCalled();
});

it('keeps a failed browser start failed and allows a fresh explicit connection attempt', async () => {
  const f = fixture();
  f.connect.mockResolvedValueOnce({ browser: 'independent-browser', state: 'failed', executionHost: 'fixture', generation: 0, error: 'fixture browser start failed' });
  expect(await f.setup.connect('independent-browser', {})).toMatchObject({ state: 'failed', error: 'fixture browser start failed' });
  expect(await f.setup.connect('independent-browser', {})).toMatchObject({ state: 'connected' });
  expect(f.connect).toHaveBeenCalledTimes(2); expect(f.upsert).toHaveBeenCalledOnce();
});

it('joins concurrent preparation reads without installing a second copy of the plugin', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const implementation = f.preview.getMockImplementation()!;
  f.preview.mockImplementationOnce(async (input) => { await gate; return implementation(input); });
  await f.setup.prepare('kimi-webbridge', { consent: true });
  await f.setup.prepare('kimi-webbridge', { consent: true });
  expect((await f.setup.status('kimi-webbridge')).state).toBe('preparing');
  release();
  await vi.waitFor(() => expect(f.installCapability).toHaveBeenCalled());
  expect(f.installPlugin).toHaveBeenCalledOnce();
});

it('cancels through the browser component owner without starting or deleting a connection', async () => {
  const f = fixture();
  expect(await f.setup.cancel('independent-browser')).toMatchObject({ reason: 'cancelled' });
  expect(f.cancelCapability).toHaveBeenCalledWith('kiki-browser');
  expect(f.upsert).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.installPlugin).not.toHaveBeenCalled();
  await expect(f.setup.cancel('kimi-webbridge')).rejects.toMatchObject({ code: 'browser.invalid' });
});

it('requires a confirmed probe payload and does not mistake an explicit false mismatch for a warning', async () => {
  const f = fixture(); f.existing(); f.extension();
  const implementation = f.fetchMock.getMockImplementation()!;
  f.fetchMock.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/status')) return new Response(JSON.stringify({ running: true, extension_connected: true, version: 'v2.0.22', version_mismatch: false }));
    if (String(input).endsWith('/command')) return new Response(JSON.stringify({ ok: true, data: { success: true } }));
    return implementation(input, init);
  });
  const result = await f.setup.connect('kimi-webbridge', {});
  expect(result).toMatchObject({ state: 'failed', error: expect.stringContaining('did not confirm') });
  expect(result.checkedAt).toBeUndefined();
  expect(result.steps.some((step) => step.id === 'compatibility')).toBe(false);
});

it('prepares missing independent components and enables control only with consent before a separate connect', async () => {
  const f = fixture(); f.disableNative();
  const ready = await f.getCapability('kiki-browser');
  f.getCapability.mockResolvedValue({ ...ready, state: 'not_installed', steps: [{ id: 'driver', state: 'missing' }, { id: 'chrome', state: 'missing' }] });
  f.installCapability.mockImplementation(async () => { f.getCapability.mockResolvedValue(ready); return ready as never; });
  await expect(f.setup.prepare('independent-browser', { consent: false } as never)).rejects.toMatchObject({ code: 'browser.invalid' });
  expect(f.configSet).not.toHaveBeenCalled(); expect(f.installCapability).not.toHaveBeenCalled();
  await f.setup.prepare('independent-browser', { consent: true });
  await vi.waitFor(async () => expect(await f.setup.status('independent-browser')).toMatchObject({ state: 'ready' }));
  expect(f.installCapability).toHaveBeenCalledWith('kiki-browser', sha256, 'managed-browser');
  expect(f.configSet).toHaveBeenCalledWith('experimental', { native_browser: true }, ConfigTarget.User);
  expect(f.connect).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled(); expect(f.setDefault).not.toHaveBeenCalled();
  expect(await f.setup.connect('independent-browser', {})).toMatchObject({ state: 'connected' });
});

it('only enables control when components are already ready without reinstalling or changing connections', async () => {
  const f = fixture(); f.disableNative();
  f.rows.push({ id: 'work', type: 'agent-browser-profile', name: 'Existing', enabled: true });
  await f.setup.prepare('independent-browser', { consent: true });
  await vi.waitFor(async () => expect(await f.setup.status('independent-browser')).toMatchObject({ state: 'ready' }));
  expect(f.configSet).toHaveBeenCalledOnce(); expect(f.installCapability).not.toHaveBeenCalled();
  expect(f.upsert).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.setDefault).not.toHaveBeenCalled();
  expect(f.rows).toEqual([{ id: 'work', type: 'agent-browser-profile', name: 'Existing', enabled: true }]);
});

it.each(['env', 'memory'] as const)('respects a forced-off %s override and reports why preparation cannot enable control', async (source) => {
  const f = fixture(); f.forceOff(source);
  await f.setup.prepare('independent-browser', { consent: true });
  await vi.waitFor(async () => expect(await f.setup.status('independent-browser')).toMatchObject({ state: 'needs_user_action', reason: 'feature_forced_off', actions: [] }));
  const result = await f.setup.connect('independent-browser', {});
  expect(result.steps.find((step) => step.id === 'feature')).toMatchObject({ reason: 'feature_forced_off', detail: expect.stringContaining(source === 'env' ? 'KIKI_EXPERIMENTAL_NATIVE_BROWSER' : 'runtime configuration override') });
  expect(f.configSet).not.toHaveBeenCalled(); expect(f.installCapability).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
});

it('retains a configuration write failure rather than reporting successful enablement', async () => {
  const f = fixture(); f.disableNative(); f.configSet.mockRejectedValueOnce(new Error('fixture configuration is read-only'));
  await f.setup.prepare('independent-browser', { consent: true });
  await vi.waitFor(async () => expect(await f.setup.status('independent-browser')).toMatchObject({ state: 'failed', error: 'fixture configuration is read-only' }));
  expect(f.installCapability).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
});
