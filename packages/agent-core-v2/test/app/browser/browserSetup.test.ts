import { describe, expect, it, vi, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { BrowserError } from '#/app/browser/errors';
import { IBrowserSetupService } from '#/app/browser/browserSetup';
import { BrowserSetupService } from '#/app/browser/browserSetupService';
import { CODEX_BRIDGE_PIN, codexBridgeResource, codexBridgeSelection, verifiedCodexBridge } from '#/app/browser/codexBrowser';
import { CODEX_BRIDGE_FILE_SHA256, codexBridgeResourcePaths } from '#/app/capability/entries/browserResourceStore';
import { browserSetupStatusSchema } from '@kiki/protocol';
import { IBrowserControlService } from '#/app/browser/browser';
import { BrowserControlService, admitEgoAfterAllow } from '#/app/browser/browserControlService';
import type { BrowserRequestContext } from '#/app/browser/codexBrowser';
import { IBrowserBackendFactory, type BrowserBackend } from '#/app/browser/browserBackend';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { BrowserConnectionInputSchema, browserSourceOfConnection, type BrowserConnectionInput, type BrowserResolvedConnection, type BrowserSourceId } from '#/app/browser/browserConfig';
import { ICapabilityService } from '#/app/capability/capability';
import { IPluginService } from '#/app/plugin/plugin';
import { IFlagService } from '#/app/flag/flag';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { ILogService } from '#/_base/log/log';
import type { MCPToolResult } from '#/mcpCore/types';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { stubLog } from '../../_base/log/stubs';
import type { BrowserConnectionRecord } from '#/app/browser/browserConfig';

const source = 'https://code.kimi.com/kimi-code/plugins/official/kimi-webbridge.zip';
const sha256 = 'a'.repeat(64);
const fixtures: TestInstantiationService[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(async () => { for (const ix of fixtures.splice(0)) await ix.dispose(); vi.unstubAllGlobals(); Object.defineProperty(process, 'platform', platform); });
function fixture(options: { home?: string; hostProcess?: IHostProcessService; hostFs?: IHostFileSystem; realControl?: boolean; initialAllowed?: readonly string[] } = {}) {
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
  const updateCapability = vi.fn<ICapabilityService['updateCapability']>(async () => ({} as never));
  const getCapability = vi.fn<ICapabilityService['getCapability']>(async (id) => ({
    id: id as 'kimi-webbridge' | 'kiki-browser', displayName: 'Fixture', description: 'fixture', supported: true, state: id === 'kiki-browser' ? 'ready' : daemon && installed && enabled && extension ? 'ready' : 'partial',
    steps: id === 'kiki-browser' ? [{ id: 'driver', state: 'ok' }, { id: 'chrome', state: 'ok' }] : [
      { id: 'daemon', state: daemon ? 'ok' : 'missing' }, { id: 'skill', state: installed && enabled ? 'ok' : 'missing' }, { id: 'extension', state: extension ? 'ok' : 'missing', reason: 'extension_not_connected' },
    ], install: { running: false }, plan: { artifact: { sha256, version: 'fixture', url: 'https://example.test/fixture', metadataUrl: 'https://example.test/metadata', maxBytes: 1024 }, destination: 'fixture', note: 'fixture' },
  }));
  const upsert = vi.fn<IBrowserControlService['upsert']>(async (id, input) => {
    const row = { id, ...input };
    const index = rows.findIndex((item) => item.id === id);
    if (index >= 0) rows[index] = row; else rows.push(row);
    return row;
  });
  const connect = vi.fn<IBrowserControlService['connect']>(async (id) => ({ browser: id, state: 'ready', executionHost: 'fixture', generation: 1 }));
  const status = vi.fn<IBrowserControlService['status']>(async (id) => ({ browser: id, state: 'idle', executionHost: 'fixture', generation: 0 }));
  const invoke = vi.fn<IBrowserControlService['invoke']>(async () => ({
    browser: 'independent-browser', generation: 1, executionHost: 'fixture', runtimeSession: 'fixture',
    result: { isError: false, content: [], structuredContent: { response: { success: true, data: { opened: true } } } },
  }));
  const setDefault = vi.fn(async () => {});
  let allowed: readonly string[] | undefined = options.initialAllowed;
  let disabledSources: readonly BrowserSourceId[] | undefined;
  const setAllowed = vi.fn(async (next: readonly string[] | undefined) => { allowed = next; });
  const setDisabledSources = vi.fn(async (next: readonly BrowserSourceId[] | undefined) => { disabledSources = next; });
  const cancelCapability = vi.fn<ICapabilityService['cancelCapability']>(async () => ({} as never));
  const files = new Map<string, string>();
  const spawn = vi.fn(async () => ({
    stdout: Readable.from(['']), stderr: Readable.from(['']),
    wait: () => Promise.resolve(0), dispose: () => undefined,
  }));
  ix.stub(ICapabilityService, { getCapability, installCapability, updateCapability, cancelCapability });
  ix.stub(IPluginService, { listPlugins: async () => installed ? [{ id: 'kimi-webbridge', enabled, state: 'ok' }] as never : [], previewPlugin: preview, installPlugin, setPluginEnabled: enablePlugin });
  if (options.realControl === true) {
    ix.stub(IBrowserBackendFactory, { open: async () => { throw new Error('unused'); } });
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({
        connections: rows.map((row) => ({ id: row.id, name: row.name, type: row.type, enabled: row.enabled, ...(row.cliPath !== undefined ? { cliPath: row.cliPath } : {}) })),
        ...(allowed !== undefined ? { allowedBrowsers: allowed } : {}),
        ...(disabledSources !== undefined ? { disabledSources } : {}),
      }),
      resolve: async (id: string) => {
        const found = rows.find((row) => row.id === id);
        if (found === undefined) throw new BrowserError('browser.not_found', `Unknown browser connection "${id}"`);
        return found as unknown as BrowserResolvedConnection;
      },
      upsert, setDefault, setAllowed, setDisabledSources,
      remove: async () => undefined,
      revealEndpoint: async () => undefined,
    });
    ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  } else {
    ix.stub(IBrowserControlService, { upsert, connect, status, invoke });
    ix.stub(IBrowserConnectionStore, {
      list: async () => ({
        connections: rows,
        ...(disabledSources !== undefined ? { disabledSources } : {}),
      }),
      resolve: async (id) => (rows.find((r) => r.id === id) as unknown as BrowserResolvedConnection) ?? { id, type: 'agent-browser-profile' as const, name: id, enabled: true, executablePath: 'C:\\fake\\chrome.exe' },
      setDefault,
      setDisabledSources,
    });
  }
  ix.stub(IFlagService, { enabled: () => native, explain: () => ({ id: 'native_browser', title: 'Fixture', description: 'fixture', surface: 'both', env: 'KIKI_EXPERIMENTAL_NATIVE_BROWSER', defaultEnabled: false, enabled: native, source: forced === 'env' ? 'env' : 'config' }) });
  ix.stub(IConfigService, { set: configSet, inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: forced === 'memory' ? { native_browser: false } as never : undefined }) });
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, { homeDir: options.home ?? 'C:\\fake\\home', cwd: 'C:\\fake\\cwd' } as never);
  ix.stub(IHostProcessService, options.hostProcess ?? { spawn } as never);
  ix.stub(IHostFileSystem, options.hostFs ?? { mkdir: async () => undefined, writeText: async (file: string, data: string) => { files.set(file, data); }, stat: async () => ({ isFile: false, isDirectory: true, size: 0 }), remove: async () => undefined } as never);
  ix.set(IBrowserSetupService, new SyncDescriptor(BrowserSetupService));
  const setup = ix.get(IBrowserSetupService);
  const control = options.realControl === true ? ix.get(IBrowserControlService) : undefined;
  return { setup, control, configSet, preview, installPlugin, enablePlugin, installCapability, updateCapability, cancelCapability, getCapability, fetchMock, upsert, connect, invoke, status, spawn, files, setDefault, setAllowed, setDisabledSources, rows,
    extension: () => { extension = true; }, existing: () => { installed = true; enabled = true; daemon = true; }, disableNative: () => { native = false; }, forceOff: (source: 'env' | 'memory') => { native = false; forced = source; } };
}

it('reads presets without installing or connecting and reports a missing Codex release', async () => {
  const f = fixture();
  const result = await f.setup.list();
  expect(result.presets.map((preset) => preset.preset)).toEqual(['kimi-webbridge', 'independent-browser', 'codex-browser', 'ego-lite']);
  expect(result.presets[2]).toMatchObject({ state: 'not_prepared', controlSurface: 'browser-connection', reason: 'artifact_missing', supported: true, candidates: [] });
  expect(result.presets[3]).toMatchObject({ state: 'not_prepared', controlSurface: 'external-app', sourceUrl: 'https://lite.ego.app/download?auto=1', supported: true });
  expect(result.presets[3]?.actions.map((action) => action.id)).toEqual(['open_instructions']);
  expect(JSON.stringify(f.spawn.mock.calls)).not.toContain('nodejs');
  expect(result.presets[2]?.steps.find((step) => step.id === 'driver')?.detail).toContain('browserResourceStore.ts');
  expect(result.presets[2]?.steps.find((step) => step.id === 'driver')?.detail).not.toContain('.tmp');
  expect(f.installPlugin).not.toHaveBeenCalled(); expect(f.enablePlugin).not.toHaveBeenCalled(); expect(f.installCapability).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
});

it('lists discovered Codex pipes without selecting or opening one', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const pipe = 'codex-browser-use-11111111-2222-4333-8444-555555555555';
  const spawn = vi.fn(async () => ({ stdout: Readable.from([`${pipe}\r\nfirst-pipe\r\n`]), stderr: Readable.from(['']), wait: () => Promise.resolve(0), dispose: () => undefined }));
  const f = fixture({ hostProcess: { spawn } as never });
  const status = await f.setup.status('codex-browser');
  expect(status.candidates).toEqual([{ browserId: pipe }]);
  expect(status.browserId).toBeUndefined();
  expect(status.steps.some((step) => step.detail === pipe || step.detail === 'first-pipe')).toBe(false);
  expect(status.actions.map((action) => action.id)).toEqual(expect.arrayContaining(['prepare', 'choose_connection', 'open_instructions']));
  const connected = await f.setup.connect('codex-browser', { connectionId: pipe });
  expect(connected.state).toBe('not_prepared');
  expect(connected.reason).toBe('artifact_missing');
  expect(f.upsert).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
  expect(verifiedCodexBridge(undefined, { 'codex-browser-bridge.exe': 'abc' })).toBe(false);
  expect(verifiedCodexBridge(CODEX_BRIDGE_PIN, {})).toBe(false);
  expect(verifiedCodexBridge({ 'codex-browser-bridge.exe': 'abc' }, { 'codex-browser-bridge.exe': 'abc' })).toBe(true);
  expect(codexBridgeSelection(pipe, [pipe])).toBe(pipe);
  expect(codexBridgeSelection(undefined, [pipe])).toBeUndefined();
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

it('opens independent browser and ensures headed mode is enabled', async () => {
  const f = fixture();
  const opened = await f.setup.open('independent-browser', {});
  expect(opened).toMatchObject({ state: 'connected' });
  expect(f.upsert).toHaveBeenCalledWith('independent-browser', expect.objectContaining({ headed: true }));
  expect(f.connect).toHaveBeenCalledWith('independent-browser');
});

it('triggers capability update on explicit update request', async () => {
  const f = fixture();
  await f.setup.update('kimi-webbridge');
  expect(f.updateCapability).toHaveBeenCalledWith('kimi-webbridge');
  await f.setup.update('independent-browser');
  expect(f.updateCapability).toHaveBeenCalledWith('kiki-browser');
});

it('keeps shortcut values in a data file and rejects path separators before spawning', async () => {
  const f = fixture();
  const previous = process.env['KIKI_BROWSER_SHORTCUT_DESKTOP'];
  process.env['KIKI_BROWSER_SHORTCUT_DESKTOP'] = 'C:\\fixture\\desktop';
  const profile = "C:\\Users\\O'Brien\\My Profile";
  f.rows.push({ id: 'independent-browser', type: 'agent-browser-profile', name: 'Work', enabled: true, executablePath: 'C:\\Program Files\\Chrome\\chrome.exe', profilePath: profile });
  try {
    if (process.platform !== 'win32') {
      await expect(f.setup.createShortcut('independent-browser', { name: "O'Brien Browser" })).rejects.toMatchObject({ code: 'browser.unsupported' });
      expect(f.spawn).not.toHaveBeenCalled();
      return;
    }
    await f.setup.createShortcut('independent-browser', { name: "O'Brien Browser" });
    const args = f.spawn.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(args).toContain('-File');
    expect(args).not.toContain("O'Brien");
    expect(args).not.toContain('My Profile');
    expect(args).not.toContain('-Command');
    const payload = [...f.files.values()].find((text) => text.includes('user-data-dir'));
    expect(payload).toContain("O'Brien");
    expect(payload).toContain('My Profile');
    expect(payload).toContain('O\'Brien Browser');
    await expect(f.setup.createShortcut('independent-browser', { name: '..\\Outside' })).rejects.toMatchObject({ code: 'browser.invalid' });
    await expect(f.setup.createShortcut('independent-browser', { name: 'nested/name' })).rejects.toMatchObject({ code: 'browser.invalid' });
    expect(f.spawn).toHaveBeenCalledOnce();
  } finally {
    if (previous === undefined) delete process.env['KIKI_BROWSER_SHORTCUT_DESKTOP'];
    else process.env['KIKI_BROWSER_SHORTCUT_DESKTOP'] = previous;
  }
});

it('exposes open action on kimi-webbridge when ready and retains recovery actions on independent browser', async () => {
  const f = fixture();
  f.existing();
  f.extension();
  const webbridgeStatus = await f.setup.status('kimi-webbridge');
  expect(webbridgeStatus.actions).toEqual(expect.arrayContaining([{ id: 'open' }]));

  const independentStatus = await f.setup.status('independent-browser');
  expect(independentStatus.actions).toEqual(expect.arrayContaining([{ id: 'prepare' }, { id: 'open' }, { id: 'connect' }]));
});

it('reports a disk update without claiming the running daemon was switched', async () => {
  const f = fixture();
  const capability = await f.getCapability('kimi-webbridge');
  f.getCapability.mockResolvedValue({ ...capability, install: { running: false, note: 'webbridge-disk-updated-running-daemon-unchanged' } });
  const updated = await f.setup.update('kimi-webbridge');
  expect(updated.reason).toBe('disk_updated_running_unchanged');
  expect(updated.error).toBeUndefined();
  expect(updated.steps.find((step) => step.id === 'update')?.detail).toContain('not stopped or switched');
  expect(updated.steps.find((step) => step.id === 'update')?.detail).not.toContain('now running');
});

it('does not open a disabled connection or borrow another profile', async () => {
  const f = fixture();
  f.rows.push({ id: 'work', type: 'agent-browser-profile', name: 'Off', enabled: false, profilePath: 'C:/fixture/off' });
  f.rows.push({ id: 'other', type: 'agent-browser-profile', name: 'Other', enabled: true, headed: true, profilePath: 'C:/fixture/other' });
  const opened = await f.setup.open('independent-browser', { connectionId: 'work' });
  expect(opened).toMatchObject({ state: 'needs_user_action', reason: 'connection_disabled', connectionId: 'work', connection: undefined });
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.upsert).not.toHaveBeenCalled();
});

it('does not report success when activating an already ready browser fails', async () => {
  const f = fixture();
  f.rows.push({ id: 'independent-browser', type: 'agent-browser-profile', name: 'Work', enabled: true, headed: true, profilePath: "C:/fixture/O'Brien/Work Profile" });
  f.status.mockResolvedValue({ browser: 'independent-browser', state: 'ready', executionHost: 'fixture', generation: 2 });
  f.invoke.mockRejectedValueOnce(new Error('fixture open refused'));
  const opened = await f.setup.open('independent-browser', {});
  expect(opened).toMatchObject({ state: 'failed', connectionId: 'independent-browser', error: 'fixture open refused' });
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ tool: 'agent_browser_open', args: {} }));
});

it('does not open a browser when control is forced off', async () => {
  const f = fixture();
  f.forceOff('env');
  const opened = await f.setup.open('independent-browser', {});
  expect(opened.reason).toBe('feature_forced_off');
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.upsert).not.toHaveBeenCalled();
});

function toolResult(data: Record<string, unknown>, success = true): MCPToolResult {
  return { isError: !success, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { exitCode: 0, response: { success, data } } };
}

it('activates the headed selected profile through the browser control adapter', async () => {
  const ix = new TestInstantiationService();
  fixtures.push(ix);
  const profiles = {
    work: "C:/fixture/O'Brien/Work Profile",
    other: 'C:/fixture/other',
  };
  const rows = new Map<string, BrowserResolvedConnection>([
    ['work', { id: 'work', type: 'agent-browser-profile', name: 'Work', enabled: true, headed: true, profilePath: profiles.work }],
    ['other', { id: 'other', type: 'agent-browser-profile', name: 'Other', enabled: true, headed: true, profilePath: profiles.other }],
  ]);
  const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  let failOpen = false;
  const factory = { _serviceBrand: undefined, open: vi.fn(async (config: BrowserResolvedConnection): Promise<BrowserBackend> => ({
    session: `session-${config.id}`, namespace: 'fixture', version: '0.38.2', runtime: {} as BrowserBackend['runtime'],
    profilePath: config.type === 'agent-browser-profile' ? config.profilePath ?? `isolated/${config.id}` : undefined,
    close: vi.fn(async () => undefined),
    client: {
      ping: async () => undefined,
      listTools: async () => [],
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ id: config.id, name, args });
        if (name === 'agent_browser_open' && failOpen) return toolResult({ opened: false }, false);
        if (name === 'agent_browser_open') return toolResult({ opened: true });
        if (name === 'agent_browser_session_info') return toolResult({ active: true, pid: 1 });
        if (name === 'agent_browser_tab_list') return toolResult({ tabs: [{ tabId: 't1', targetId: `${config.id}-tab` }] });
        return toolResult({ done: true });
      },
    },
  })) };
  ix.stub(IFlagService, { enabled: () => true, explain: () => ({ id: 'native_browser', title: 'Fixture', description: 'fixture', surface: 'both', env: 'KIKI_EXPERIMENTAL_NATIVE_BROWSER', defaultEnabled: false, enabled: true, source: 'config' }) });
  ix.stub(IBrowserConnectionStore, {
    _serviceBrand: undefined,
    list: async () => ({ connections: [...rows.values()] }),
    resolve: async (id: string) => {
      const row = rows.get(id);
      if (row === undefined) throw new Error(`missing ${id}`);
      return row;
    },
    upsert: async (id: string, input: BrowserConnectionInput) => {
      const parsed = BrowserConnectionInputSchema.parse(input);
      if (parsed.type !== 'agent-browser-profile') throw new Error('unexpected connection type');
      const row: BrowserResolvedConnection = { id, ...parsed, enabled: parsed.enabled ?? true };
      rows.set(id, row);
      return row;
    },
    remove: async () => undefined,
    setDefault: async () => undefined,
    revealEndpoint: async () => undefined,
  });
  ix.stub(IBrowserBackendFactory, factory);
  ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
  const control = ix.get(IBrowserControlService);
  const getCapability = vi.fn<ICapabilityService['getCapability']>(async () => ({
    id: 'kiki-browser', displayName: 'Fixture', description: 'fixture', supported: true, state: 'ready',
    steps: [{ id: 'driver', state: 'ok' }, { id: 'chrome', state: 'ok' }], install: { running: false },
  }));
  ix.stub(ICapabilityService, { getCapability, installCapability: vi.fn(), updateCapability: vi.fn(), cancelCapability: vi.fn() });
  ix.stub(IPluginService, { listPlugins: async () => [], previewPlugin: vi.fn(), installPlugin: vi.fn(), setPluginEnabled: vi.fn() });
  ix.stub(IConfigService, { set: vi.fn(), inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined }) });
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, { homeDir: 'C:\\fake\\home', cwd: 'C:\\fake\\cwd' } as never);
  ix.stub(IHostProcessService, { spawn: vi.fn() } as never);
  ix.stub(IHostFileSystem, { mkdir: async () => undefined, writeText: async () => undefined, stat: async () => ({ isFile: false, isDirectory: true, size: 0 }), remove: async () => undefined } as never);
  ix.set(IBrowserSetupService, new SyncDescriptor(BrowserSetupService));
  const setup = ix.get(IBrowserSetupService);
  const opened = await setup.open('independent-browser', { connectionId: 'work' });
  expect(opened).toMatchObject({ state: 'connected', connectionId: 'work' });
  expect(factory.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'work', headed: true, profilePath: profiles.work }));
  const opens = calls.filter((call) => call.name === 'agent_browser_open');
  expect(opens).toHaveLength(1);
  expect(opens[0]?.id).toBe('work');
  expect(opens[0]?.args['extraArgs']).toEqual(expect.arrayContaining(['--pin-tab', '--profile', profiles.work]));
  expect(JSON.stringify(opens)).not.toContain(profiles.other);
  const again = await setup.open('independent-browser', { connectionId: 'work' });
  expect(again.state).toBe('connected');
  expect(calls.filter((call) => call.name === 'agent_browser_open')).toHaveLength(2);
  expect(calls.filter((call) => call.id === 'other')).toEqual([]);
  failOpen = true;
  const refused = await setup.open('independent-browser', { connectionId: 'work' });
  expect(refused).toMatchObject({ state: 'failed', connectionId: 'work' });
  expect(refused.error).toBeTruthy();
  expect(calls.filter((call) => call.name === 'agent_browser_open' && call.id === 'other')).toEqual([]);
});

it.skipIf(process.platform !== 'win32')('writes a desktop shortcut for a profile path with spaces and an apostrophe and leaves unrelated shortcuts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-shortcut-home-'));
  const desktop = await mkdtemp(join(tmpdir(), 'kiki-shortcut-desktop-'));
  const previous = process.env['KIKI_BROWSER_SHORTCUT_DESKTOP'];
  process.env['KIKI_BROWSER_SHORTCUT_DESKTOP'] = desktop;
  const profile = "C:\\Users\\O'Brien\\My Profile";
  const target = 'C:\\Windows\\System32\\notepad.exe';
  const f = fixture({ home, hostProcess: new HostProcessService(), hostFs: new HostFileSystem() });
  f.rows.push({ id: 'independent-browser', type: 'agent-browser-profile', name: 'Work', enabled: true, executablePath: target, profilePath: profile });
  const unrelated = join(desktop, 'Already There.lnk');
  const host = new HostProcessService();
  try {
    await writeShortcut(host, unrelated, 'C:\\Windows\\System32\\cmd.exe', '--user-data-dir="C:\\other"');
    await f.setup.createShortcut('independent-browser', { name: "O'Brien Browser" });
    const created = await readShortcut(host, join(desktop, "O'Brien Browser.lnk"));
    expect(created.target.toLowerCase()).toBe(target.toLowerCase());
    expect(created.arguments).toContain("O'Brien");
    expect(created.arguments).toContain('My Profile');
    await expect(f.setup.createShortcut('independent-browser', { name: 'Already There' })).rejects.toThrow(/unrelated shortcut/);
    const kept = await readShortcut(host, unrelated);
    expect(kept.target.toLowerCase()).toContain('cmd.exe');
    expect(kept.arguments).toContain('C:\\other');
    await expect(f.setup.createShortcut('independent-browser', { name: '..\\Outside' })).rejects.toMatchObject({ code: 'browser.invalid' });
    expect(await readdir(desktop)).toEqual(expect.arrayContaining(["O'Brien Browser.lnk", 'Already There.lnk']));
    expect(await readdir(join(desktop, '..'))).not.toContain('Outside.lnk');
  } finally {
    if (previous === undefined) delete process.env['KIKI_BROWSER_SHORTCUT_DESKTOP'];
    else process.env['KIKI_BROWSER_SHORTCUT_DESKTOP'] = previous;
    await rm(home, { recursive: true, force: true });
    await rm(desktop, { recursive: true, force: true });
  }
}, 20_000);

async function runPowerShell(host: HostProcessService, script: string, args: readonly string[]): Promise<string> {
  const file = join(tmpdir(), `kiki-shortcut-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
  await writeFile(file, script);
  try {
    const res = await host.spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { windowsHide: true });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    res.stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    res.stderr.on('data', (chunk: Buffer | string) => errors.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    const code = await res.wait();
    await res.dispose();
    if (code !== 0) throw new Error(Buffer.concat(errors).toString('utf8') || `powershell exited ${code}`);
    return Buffer.concat(chunks).toString('utf8').trim();
  } finally {
    await rm(file, { force: true });
  }
}

async function writeShortcut(host: HostProcessService, shortcutPath: string, target: string, args: string): Promise<void> {
  await runPowerShell(host, [
    "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject WScript.Shell',
    '$created = $shell.CreateShortcut($args[0])',
    '$created.TargetPath = $args[1]',
    '$created.Arguments = $args[2]',
    '$created.Save()',
  ].join('\r\n'), [shortcutPath, target, args]);
}

const codexVendor = join(fileURLToPath(new URL('../../../../../', import.meta.url)), 'apps/kimi-code/vendor/codex-browser-bridge/win32-x64');

async function seedCodexBridge(home: string): Promise<void> {
  const paths = codexBridgeResourcePaths(home);
  await mkdir(paths.directory, { recursive: true });
  for (const name of Object.keys(CODEX_BRIDGE_FILE_SHA256)) await cp(join(codexVendor, name), join(paths.directory, name));
}

it('saves an explicit Codex pipe and does not treat that as a connection or an approval', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const home = await mkdtemp(join(tmpdir(), 'kiki-codex-setup-'));
  try {
    await seedCodexBridge(home);
    const hyphen = 'codex-browser-use-11111111-2222-4333-8444-555555555555';
    const slash = 'codex-browser-use\\11111111-2222-4333-8444-555555555555';
    const spawn = vi.fn(async () => ({ stdout: Readable.from([`${hyphen}\r\n${slash}\r\nfirst-pipe\r\n`]), stderr: Readable.from(['']), wait: () => Promise.resolve(0), dispose: () => undefined }));
    const f = fixture({ home, hostProcess: { spawn } as never, hostFs: new HostFileSystem() });
    const status = browserSetupStatusSchema.parse(await f.setup.status('codex-browser'));
    expect(status.steps.find((step) => step.id === 'driver')?.state).toBe('ready');
    expect(status.candidates).toEqual([{ browserId: hyphen }, { browserId: slash }]);
    expect(status.browserId).toBeUndefined();
    expect(status.state).toBe('needs_user_action');
    expect(status.reason).toBe('choose_connection');
    expect(codexBridgeResource(home, join).binary).toBe(codexBridgeResourcePaths(home).binary);
    expect(await f.setup.connect('codex-browser', {})).toMatchObject({ reason: 'choose_connection' });
    expect(await f.setup.connect('codex-browser', { connectionId: 'codex-browser', browserId: 'codex-browser-use-99999999-2222-4333-8444-555555555555' })).toMatchObject({ reason: 'choose_connection' });
    expect(f.upsert).not.toHaveBeenCalled();
    const saved = browserSetupStatusSchema.parse(await f.setup.connect('codex-browser', { connectionId: 'codex-browser', browserId: slash, name: 'Desk' }));
    expect(saved).toMatchObject({ state: 'needs_user_action', reason: 'approval_unproven', connectionId: 'codex-browser', browserId: slash, connection: { state: 'idle' } });
    expect(saved.steps.find((step) => step.id === 'desktop-app')).toMatchObject({ state: 'warning', reason: 'external_pipe' });
    expect(saved.steps.find((step) => step.id === 'desktop-app')?.detail).toContain('shared');
    expect(saved.steps.find((step) => step.id === 'detect')).toMatchObject({ state: 'warning', reason: 'approval_unproven' });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.upsert).toHaveBeenCalledWith('codex-browser', expect.objectContaining({ type: 'codex-extension', browserId: slash, name: 'Desk', runtimeRoot: codexBridgeResourcePaths(home).binary }));
    const again = await f.setup.connect('codex-browser', { connectionId: 'codex-browser' });
    expect(again).toMatchObject({ state: 'needs_user_action', reason: 'approval_unproven', browserId: slash });
    expect(f.connect).not.toHaveBeenCalled();
    await writeFile(codexBridgeResourcePaths(home).binary, 'damaged');
    const damaged = await f.setup.status('codex-browser');
    expect(damaged).toMatchObject({ state: 'needs_user_action', reason: 'approval_unproven' });
    expect(damaged.steps.find((step) => step.id === 'driver')).toMatchObject({ state: 'warning', reason: 'artifact_unverified' });
    f.status.mockResolvedValue({ browser: 'codex-browser', state: 'failed', executionHost: 'fixture', generation: 1, error: 'Browser handshake failed' });
    const failed = browserSetupStatusSchema.parse(await f.setup.status('codex-browser'));
    expect(failed).toMatchObject({ state: 'failed', error: 'Browser handshake failed', connection: { state: 'failed' } });
    expect(failed.reason).not.toBe('approval_unproven');
    f.status.mockResolvedValue({ browser: 'codex-browser', state: 'ready', executionHost: 'fixture', generation: 1 });
    const confirmed = browserSetupStatusSchema.parse(await f.setup.status('codex-browser'));
    expect(confirmed).toMatchObject({ state: 'connected', connection: { state: 'ready', generation: 1 } });
    expect(confirmed.reason).toBeUndefined();
    expect(confirmed.steps.find((step) => step.id === 'detect')?.state).toBe('ready');
    const writes = f.upsert.mock.calls.length;
    f.rows[0] = { ...f.rows[0]!, enabled: false };
    expect(await f.setup.connect('codex-browser', { connectionId: 'codex-browser' })).toMatchObject({ state: 'needs_user_action', reason: 'connection_disabled' });
    expect(f.upsert).toHaveBeenCalledTimes(writes);
    expect(f.connect).not.toHaveBeenCalled();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('reports a ready Codex driver without a saved selection when the release lands during pipe discovery', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const home = await mkdtemp(join(tmpdir(), 'kiki-codex-status-race-'));
  const pipe = 'codex-browser-use-11111111-2222-4333-8444-555555555555';
  try {
    const spawn = vi.fn(async () => {
      await seedCodexBridge(home);
      return { stdout: Readable.from([`${pipe}\r\n`]), stderr: Readable.from(['']), wait: () => Promise.resolve(0), dispose: () => undefined };
    });
    const f = fixture({ home, hostProcess: { spawn } as never });
    const status = browserSetupStatusSchema.parse(await f.setup.status('codex-browser'));
    expect(status.steps.find((step) => step.id === 'driver')).toMatchObject({ state: 'ready' });
    expect(status).toMatchObject({ state: 'needs_user_action', reason: 'choose_connection', candidates: [{ browserId: pipe }] });
    expect(status.connectionId).toBeUndefined();
    expect(status.browserId).toBeUndefined();
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('prepares the pinned Codex files without marking the extension connected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-codex-prepare-'));
  try {
    await seedCodexBridge(home);
    const f = fixture({ home });
    f.disableNative();
    await f.setup.prepare('codex-browser', { consent: true });
    await vi.waitFor(async () => expect((await f.setup.status('codex-browser')).state).not.toBe('preparing'));
    const status = await f.setup.status('codex-browser');
    expect(status.steps.find((step) => step.id === 'driver')?.state).toBe('ready');
    expect(status).toMatchObject({ state: 'needs_user_action', reason: 'choose_connection' });
    expect(f.configSet).toHaveBeenCalled();
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('keeps a failed Codex prepare from saving a connection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-codex-prepare-fail-'));
  try {
    const f = fixture({ home });
    await f.setup.prepare('codex-browser', { consent: true });
    await vi.waitFor(async () => expect((await f.setup.status('codex-browser')).state).toBe('failed'));
    expect((await f.setup.status('codex-browser')).error).toEqual(expect.any(String));
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('checks Ego Lite from the installed CLI and does not launch nodejs while listing status', async () => {
  const exe = 'C:\\ego-fixture\\ego-browser.exe';
  const previous = process.env['PATH'];
  process.env['PATH'] = 'C:\\ego-fixture';
  const files = new Map<string, string>();
  let mode: 'ready' | 'onboarding' | 'both' | 'empty' = 'ready';
  const spawn = vi.fn(async (_command: string, args: readonly string[] = []) => {
    const node = args.includes('nodejs');
    const text = !node ? ''
      : mode === 'ready' ? 'kiki-ego-ready\n'
        : mode === 'onboarding' ? 'Please complete the onboarding process first\n'
          : mode === 'both' ? 'kiki-ego-ready\nPlease complete the onboarding process first\n'
            : '';
    return { stdout: Readable.from([text]), stderr: Readable.from(['']), wait: async () => 0, kill: async () => undefined, dispose: async () => undefined };
  });
  const nodeCalls = () => spawn.mock.calls.filter((call) => (call[1] as readonly string[] | undefined)?.includes('nodejs')).length;
  const f = fixture({
    hostProcess: { spawn } as never,
    hostFs: {
      mkdir: async () => undefined,
      writeText: async (file: string, data: string) => { files.set(file, data); },
      readText: async (file: string) => files.get(file) ?? '',
      stat: async (file: string) => ({ isFile: file.replaceAll('/', '\\').toLowerCase() === exe.toLowerCase(), isDirectory: false, size: 0 }),
      readdir: async () => [],
      remove: async () => undefined,
    } as never,
  });
  try {
    const installed = await f.setup.status('ego-lite');
    expect(installed).toMatchObject({ state: 'needs_user_action', reason: 'ego_installed', controlSurface: 'external-app', sourceUrl: 'https://lite.ego.app/download?auto=1' });
    expect(installed.actions.map((action) => action.id)).not.toContain('prepare');
    expect(nodeCalls()).toBe(0);
    const ready = await f.setup.connect('ego-lite', { name: 'Desk', setDefault: true });
    expect(ready.state).toBe('ready');
    expect(f.upsert).toHaveBeenCalledWith('ego-lite', { type: 'ego-lite', name: 'Desk', enabled: true, cliPath: 'C:/ego-fixture/ego-browser.exe' });
    expect(f.setDefault).not.toHaveBeenCalled();
    expect([...files.values()].join('\n')).toContain('console.log("kiki-ego-ready")');
    expect([...files.values()].join('\n')).not.toContain('taskSpace');
    const before = nodeCalls();
    expect((await f.setup.status('ego-lite')).state).toBe('ready');
    expect(nodeCalls()).toBe(before);
    mode = 'onboarding';
    expect(await f.setup.connect('ego-lite', {})).toMatchObject({ state: 'needs_user_action', reason: 'ego_onboarding' });
    mode = 'both';
    expect(await f.setup.connect('ego-lite', {})).toMatchObject({ reason: 'ego_onboarding', state: 'needs_user_action' });
    mode = 'empty';
    expect(await f.setup.connect('ego-lite', {})).toMatchObject({ state: 'failed' });
    await expect(f.setup.prepare('ego-lite', { consent: true })).rejects.toMatchObject({ code: 'browser.unsupported' });
    expect(f.upsert).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
});

it('reuses the chosen Ego Lite CLI when several programs are installed', async () => {
  const chosen = 'C:/ego-b/ego-browser.exe';
  const previous = process.env['PATH'];
  process.env['PATH'] = `C:\\ego-a${delimiter}C:\\ego-b`;
  let mode: 'onboarding' | 'ready' = 'onboarding';
  const spawn = vi.fn(async (_command: string, args: readonly string[] = []) => {
    const node = args.includes('nodejs');
    const text = !node ? '' : mode === 'ready' ? 'kiki-ego-ready\n' : 'Please complete the onboarding process first\n';
    return { stdout: Readable.from([text]), stderr: Readable.from(['']), wait: async () => 0, kill: async () => undefined, dispose: async () => undefined };
  });
  const nodeCalls = () => spawn.mock.calls.filter((call) => (call[1] as readonly string[] | undefined)?.includes('nodejs')).length;
  const known = new Set(['c:/ego-a/ego-browser.exe', 'c:/ego-b/ego-browser.exe']);
  const f = fixture({
    hostProcess: { spawn } as never,
    hostFs: {
      mkdir: async () => undefined,
      writeText: async () => undefined,
      readText: async () => '',
      stat: async (file: string) => ({ isFile: known.has(file.replaceAll('\\', '/').toLowerCase()), isDirectory: false, size: 0 }),
      readdir: async () => [],
      remove: async () => undefined,
    } as never,
  });
  try {
    const listed = browserSetupStatusSchema.parse(await f.setup.status('ego-lite'));
    expect(listed).toMatchObject({
      state: 'needs_user_action', reason: 'ego_choose_cli',
      cliPaths: ['C:/ego-a/ego-browser.exe', 'C:/ego-b/ego-browser.exe'],
    });
    expect(listed.connectionId).toBeUndefined();
    expect(nodeCalls()).toBe(0);
    expect(f.upsert).not.toHaveBeenCalled();
    const unanswered = browserSetupStatusSchema.parse(await f.setup.connect('ego-lite', {}));
    expect(unanswered).toMatchObject({ reason: 'ego_choose_cli', cliPaths: ['C:/ego-a/ego-browser.exe', 'C:/ego-b/ego-browser.exe'] });
    expect(unanswered.connectionId).toBeUndefined();
    expect(f.upsert).not.toHaveBeenCalled();
    expect(nodeCalls()).toBe(0);
    const onboarding = browserSetupStatusSchema.parse(await f.setup.connect('ego-lite', { cliPath: chosen }));
    expect(onboarding).toMatchObject({ state: 'needs_user_action', reason: 'ego_onboarding', connectionId: 'ego-lite' });
    expect(onboarding.cliPaths).toBeUndefined();
    expect(f.upsert).toHaveBeenCalledTimes(1);
    expect(f.upsert).toHaveBeenCalledWith('ego-lite', { type: 'ego-lite', name: 'Ego Lite', enabled: true, cliPath: chosen });
    expect(f.rows).toEqual([expect.objectContaining({ id: 'ego-lite', type: 'ego-lite', cliPath: chosen })]);
    expect(nodeCalls()).toBe(1);
    const again = await f.setup.status('ego-lite');
    expect(again).toMatchObject({ state: 'needs_user_action', reason: 'ego_onboarding', connectionId: 'ego-lite' });
    expect(again.cliPaths).toBeUndefined();
    expect(nodeCalls()).toBe(1);
    expect(f.upsert).toHaveBeenCalledTimes(1);
    expect(f.connect).not.toHaveBeenCalled();
    mode = 'ready';
    const ready = await f.setup.connect('ego-lite', {});
    expect(ready).toMatchObject({ state: 'ready', connectionId: 'ego-lite' });
    expect(f.upsert).toHaveBeenCalledTimes(1);
    expect(f.rows[0]).toMatchObject({ cliPath: chosen });
    expect(f.setDefault).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledWith('ego-lite');
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
});

it('opens Ego Lite admission after a ready check without changing the allow set', async () => {
  const exe = 'C:\\ego-fixture\\ego-browser.exe';
  const previous = process.env['PATH'];
  process.env['PATH'] = 'C:\\ego-fixture';
  let mode: 'ready' | 'onboarding' = 'ready';
  const spawn = vi.fn(async (_command: string, args: readonly string[] = []) => {
    const text = !args.includes('nodejs') ? '' : mode === 'ready' ? 'kiki-ego-ready\n' : 'Please complete the onboarding process first\n';
    return { stdout: Readable.from([text]), stderr: Readable.from(['']), wait: async () => 0, kill: async () => undefined, dispose: async () => undefined };
  });
  const f = fixture({
    hostProcess: { spawn } as never,
    hostFs: {
      mkdir: async () => undefined, writeText: async () => undefined, readText: async () => '', remove: async () => undefined, readdir: async () => [],
      stat: async (file: string) => ({ isFile: file.replaceAll('/', '\\').toLowerCase() === exe.toLowerCase(), isDirectory: false, size: 0 }),
    } as never,
  });
  try {
    const ready = await f.setup.connect('ego-lite', { name: 'Desk', setDefault: true });
    expect(ready.state).toBe('ready');
    expect(f.upsert).toHaveBeenCalledWith('ego-lite', { type: 'ego-lite', name: 'Desk', enabled: true, cliPath: 'C:/ego-fixture/ego-browser.exe' });
    expect(f.upsert.mock.calls[0]?.[1]).not.toHaveProperty('allowedBrowsers');
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledWith('ego-lite');
    expect(f.connect.mock.invocationCallOrder[0]).toBeGreaterThan(f.upsert.mock.invocationCallOrder[0] ?? 0);
    expect(f.setDefault).not.toHaveBeenCalled();
    mode = 'onboarding';
    expect(await f.setup.connect('ego-lite', {})).toMatchObject({ state: 'needs_user_action', reason: 'ego_onboarding' });
    expect(f.connect).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
});

it('keeps a ready Ego Lite check when the allow set does not include it yet', async () => {
  const exe = 'C:\\ego-fixture\\ego-browser.exe';
  const previous = process.env['PATH'];
  process.env['PATH'] = 'C:\\ego-fixture';
  const spawn = vi.fn(async (_command: string, args: readonly string[] = []) => ({
    stdout: Readable.from([args.includes('nodejs') ? 'kiki-ego-ready\n' : '']), stderr: Readable.from(['']),
    wait: async () => 0, kill: async () => undefined, dispose: async () => undefined,
  }));
  const f = fixture({
    hostProcess: { spawn } as never,
    hostFs: {
      mkdir: async () => undefined, writeText: async () => undefined, readText: async () => '', remove: async () => undefined, readdir: async () => [],
      stat: async (file: string) => ({ isFile: file.replaceAll('/', '\\').toLowerCase() === exe.toLowerCase(), isDirectory: false, size: 0 }),
    } as never,
  });
  f.connect.mockRejectedValueOnce(new BrowserError('browser.disabled', 'Browser "ego-lite" is not in the allowed set.', { details: { reason: 'not_allowed' } }));
  try {
    const ready = await f.setup.connect('ego-lite', {});
    expect(ready.state).toBe('ready');
    expect(f.connect).toHaveBeenCalledWith('ego-lite');
    expect(f.upsert.mock.calls[0]?.[1]).not.toHaveProperty('allowedBrowsers');
    expect(f.setDefault).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
});

it('admits Ego Lite when the user allows it, without a second check or an automatic allow write', async () => {
  const exe = 'C:\\ego-fixture\\ego-browser.exe';
  const previous = process.env['PATH'];
  process.env['PATH'] = 'C:\\ego-fixture';
  const spawn = vi.fn(async (_command: string, args: readonly string[] = []) => {
    const node = args.includes('nodejs');
    const index = spawn.mock.calls.filter((call) => (call[1] as readonly string[] | undefined)?.includes('nodejs')).length;
    const text = !node ? '' : index <= 2 ? 'kiki-ego-ready\n' : `KIKI_EGO_TABS ${JSON.stringify([{ label: 'p1', title: 'One', openedBy: 'agent' }])}\n`;
    return { stdout: Readable.from([text]), stderr: Readable.from(['']), wait: async () => 0, kill: async () => undefined, dispose: async () => undefined };
  });
  const nodeCalls = () => spawn.mock.calls.filter((call) => (call[1] as readonly string[] | undefined)?.includes('nodejs')).length;
  const f = fixture({
    realControl: true,
    initialAllowed: [],
    hostProcess: { spawn } as never,
    hostFs: {
      mkdir: async () => undefined, writeText: async () => undefined, readText: async () => '', remove: async () => undefined, readdir: async () => [],
      stat: async (file: string) => ({ isFile: file.replaceAll('/', '\\').toLowerCase() === exe.toLowerCase(), isDirectory: false, size: 0 }),
    } as never,
  });
  const control = f.control;
  if (control === undefined) throw new Error('missing control');
  const caller = { sessionId: 's', agentId: 'a' };
  const context = { caller, sessionDir: 'C:/session', turnId: 0, toolCallId: 't', elicit: async () => { throw new Error('unused'); } } satisfies BrowserRequestContext;
  try {
    const checked = await f.setup.connect('ego-lite', {});
    expect(checked).toMatchObject({ state: 'ready', reason: 'ego_ready' });
    expect(f.upsert).toHaveBeenCalledTimes(1);
    expect(f.upsert.mock.calls[0]?.[1]).not.toHaveProperty('allowedBrowsers');
    expect(f.setAllowed).not.toHaveBeenCalled();
    expect(f.setDefault).not.toHaveBeenCalled();
    expect((await control.status('ego-lite')).state).toBe('idle');
    expect(nodeCalls()).toBe(1);
    await f.setAllowed(['ego-lite']);
    await admitEgoAfterAllow(control, [], ['ego-lite']);
    expect((await control.status('ego-lite')).state).toBe('ready');
    expect(await f.setup.status('ego-lite')).toMatchObject({ state: 'connected', connectionId: 'ego-lite' });
    expect(nodeCalls()).toBe(2);
    expect((await control.tabs('ego-lite', undefined, context)).map((tab) => tab.tabId)).toEqual(['p1']);
    expect(nodeCalls()).toBe(3);
    f.disableNative();
    await expect(control.invoke({ browser: 'ego-lite', tool: 'browser__ego_run', args: { script: 'console.log(1)' }, caller, requestContext: context })).rejects.toMatchObject({ code: 'browser.disabled' });
    expect(nodeCalls()).toBe(3);
    expect(f.setDefault).not.toHaveBeenCalled();
    expect(f.upsert).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
});

it('auto-probes a real Citro Ego Lite install path on status read and gates disabled sources without losing allowed connections', async () => {
  const exe = 'C:\\Users\\fixture\\AppData\\Local\\Programs\\Citro\\ego-lite\\active_version_dir\\ego-browser.exe';
  const previous = process.env['PATH'];
  process.env['PATH'] = 'C:\\Users\\fixture\\AppData\\Local\\Programs\\Citro\\ego-lite\\active_version_dir';
  const end = vi.fn();
  const spawn = vi.fn(async (_command: string, args: readonly string[] = []) => ({
    stdin: { end },
    stdout: Readable.from(['']),
    stderr: Readable.from([args.includes('nodejs') ? 'kiki-ego-ready\n' : '']),
    wait: async () => 0,
    kill: async () => undefined,
    dispose: async () => undefined,
  }));
  const f = fixture({
    realControl: true,
    initialAllowed: ['ego-lite'],
    hostProcess: { spawn } as never,
    hostFs: {
      mkdir: async () => undefined, writeText: async () => undefined, readText: async () => '', remove: async () => undefined, readdir: async () => [],
      stat: async (file: string) => ({ isFile: file.replaceAll('/', '\\').toLowerCase() === exe.toLowerCase(), isDirectory: false, size: 0 }),
    } as never,
  });
  const control = f.control;
  if (control === undefined) throw new Error('missing control');
  const caller = { sessionId: 's', agentId: 'a' };
  const context = { caller, sessionDir: 'C:/session', turnId: 0, toolCallId: 't', elicit: async () => { throw new Error('unused'); } } satisfies BrowserRequestContext;
  try {
    const initial = await f.setup.status('ego-lite');
    expect(initial).toMatchObject({ state: 'ready', reason: 'ego_ready' });
    expect(end).toHaveBeenCalled();
    const connected = await f.setup.connect('ego-lite', {});
    expect(connected).toMatchObject({ state: 'connected', connectionId: 'ego-lite' });
    await f.setDisabledSources(['ego-lite']);
    expect(await f.setup.status('ego-lite')).toMatchObject({ state: 'needs_user_action', reason: 'source_disabled' });
    await expect(control.invoke({ browser: 'ego-lite', tool: 'browser__ego_run', args: { script: 'console.log(1)' }, caller, requestContext: context })).rejects.toMatchObject({ code: 'browser.disabled', message: 'This browser source is disabled', details: { reason: 'connection_disabled' } });
    await f.setDisabledSources([]);
    expect(await f.setup.status('ego-lite')).toMatchObject({ state: 'connected', connectionId: 'ego-lite' });
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
});

it('does not probe or install a source that is switched off', async () => {
  const f = fixture();
  await f.setDisabledSources(['kimi-webbridge', 'independent-browser']);
  f.fetchMock.mockClear();
  f.getCapability.mockClear();
  f.enablePlugin.mockClear();
  expect(await f.setup.status('kimi-webbridge')).toMatchObject({ state: 'needs_user_action', reason: 'source_disabled', actions: [] });
  expect(await f.setup.status('independent-browser')).toMatchObject({ state: 'needs_user_action', reason: 'source_disabled', actions: [] });
  expect(f.fetchMock).not.toHaveBeenCalled();
  expect(f.getCapability).not.toHaveBeenCalled();
  await f.setup.prepare('kimi-webbridge', { consent: true });
  expect(f.enablePlugin).not.toHaveBeenCalled();
  await f.setup.connect('independent-browser', {});
  expect(f.connect).not.toHaveBeenCalled();
});

it('keeps a CDP connection on the independent browser source', () => {
  expect(browserSourceOfConnection({ type: 'agent-browser-cdp' })).toBe('independent-browser');
  expect(browserSourceOfConnection({ type: 'agent-browser-profile' })).toBe('independent-browser');
  expect(browserSourceOfConnection({ type: 'ego-lite' })).toBe('ego-lite');
});

async function readShortcut(host: HostProcessService, shortcutPath: string): Promise<{ target: string; arguments: string }> {
  const output = await runPowerShell(host, [
    "$ErrorActionPreference = 'Stop'",
    '$created = (New-Object -ComObject WScript.Shell).CreateShortcut($args[0])',
    'Write-Output $created.TargetPath',
    'Write-Output $created.Arguments',
  ].join('\r\n'), [shortcutPath]);
  const [target = '', ...rest] = output.split(/\r?\n/);
  return { target, arguments: rest.join('\n') };
}
