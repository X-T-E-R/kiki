import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Event } from '#/_base/event';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { PluginHost } from '#/app/plugin/host';
import { _clearScopedRegistryForTests, registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IOAuthService } from '#/app/auth/auth';
import { IRequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginService } from '#/app/plugin/pluginService';
import { IPluginHostService, PluginHostService } from '#/app/plugin/pluginHostService';
import { IPluginSettingsService, PluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { PluginUsageService } from '#/app/pluginUsage/pluginUsageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IProviderService } from '#/kosong/provider/provider';
import { IModelCatalog } from '#/kosong/model/catalog';
import { LifecycleScope } from '#/app/scopes';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';

let root: string;
let host: ScopedTestHost;
beforeEach(async () => {
  _clearScopedRegistryForTests();
  registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginUsageService, PluginUsageService, ScopeActivation.OnDemand, 'plugin');
  await mkdir('../../.tmp/app-lifecycle-combo', { recursive: true });
  root = await mkdtemp(resolve('../../.tmp/app-lifecycle-combo/run-'));
  const docs = new Map<string, unknown>();
  const config: Record<string, unknown> = {};
  host = createScopedTestHost([
    stubPair(IFlagService, { enabled: () => true } as unknown as IFlagService),
    stubPair(IBootstrapService, { ...stubBootstrap(join(root, 'home')), osHomeDir: join(root, 'user') }),
    stubPair(IProviderService, stubProviderService()),
    stubPair(IModelCatalog, { _serviceBrand: undefined, listModels: async () => [], listProviders: async () => [] } as unknown as IModelCatalog),
    stubPair(IOAuthService, {} as IOAuthService),
    stubPair(IRequestIdentityCatalog, {} as IRequestIdentityCatalog),
    stubPair(ISessionManager, { list: () => [], get: () => undefined, onDidCreateSession: Event.None, onDidCloseSession: Event.None } as unknown as ISessionManager),
    stubPair(IConfigService, { ready: Promise.resolve(), get: (key: string) => config[key] ?? {}, replace: async (key: string, value: unknown) => { config[key] = value; }, onDidSectionChange: Event.None } as unknown as IConfigService),
    stubPair(IAtomicDocumentStore, { get: async (scope: string, key: string) => docs.get(`${scope}/${key}`), set: async (scope: string, key: string, value: unknown) => { docs.set(`${scope}/${key}`, value); } } as unknown as IAtomicDocumentStore),
    stubPair(ISkillDiscovery, { _serviceBrand: undefined, discover: async () => ({ skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }) } satisfies ISkillDiscovery),
  ]);
});
afterEach(async () => {
  if (host !== undefined) { await host.app.accessor.get(IPluginHostService).stopAll(); await host.dispose(); }
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
});
it('keeps a real resident App host alive when one workspace closes its contributions, and stops it through the home switch', async () => {
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({ name: 'fixture-resident', version: '1.0.0',
    'x-kiki': { engines: { kiki: '^0.4.0' }, entry: './entry.mjs', activation: 'app', permissions: { uiPanel: true },
      panels: [{ schemaVersion: 1, id: 'status', label: 'Status', slot: 'sidebar', path: './panel.html' }] } }));
  await writeFile(join(source, 'panel.html'), '<!doctype html><title>Status</title>');
  await writeFile(join(source, 'entry.mjs'), `let ticks=0;let timer;export function register(){};export function activate(){timer=setInterval(()=>ticks++,10);};export function deactivate(){clearInterval(timer);};export async function handlePanelRequest(action){if(action==='slow')await new Promise(resolve=>setTimeout(resolve,80));return {pid:process.pid,ticks};};`);
  const plugins = host.app.accessor.get(IPluginService);
  const hosts = host.app.accessor.get(IPluginHostService);
  const usage = host.app.accessor.get(IPluginUsageService);
  await hosts.ready;
  const plan = await plugins.previewPlugin({ source });
  await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
  expect((await plugins.listPlugins())[0]).toMatchObject({ enabled: true, globalEnabled: false });
  expect(hosts.running('fixture-resident')).toBe(true);
  expect(await usage.allows('workspace-a', 'fixture-resident')).toBe(false);
  await usage.set({ workspaceId: 'workspace-a', pluginId: 'fixture-resident', override: 'on' });
  await vi.waitFor(async () => expect((await usage.read('workspace-a')).applyState).toBe('applied'));
  const before = await hosts.requestPanel('fixture-resident', 'status', 'status', {}) as { pid: number; ticks: number };
  expect(hosts.running('fixture-resident')).toBe(true);
  const inFlight = hosts.requestPanel('fixture-resident', 'status', 'slow', {});
  await usage.set({ workspaceId: 'workspace-a', pluginId: 'fixture-resident', override: 'off' });
  await expect(inFlight).resolves.toMatchObject({ pid: before.pid });
  expect(await usage.allows('workspace-a', 'fixture-resident')).toBe(false);
  expect(await usage.allows('workspace-b', 'fixture-resident')).toBe(false);
  expect((await plugins.listPlugins())[0]?.enabled).toBe(true);
  const after = await hosts.requestPanel('fixture-resident', 'status', 'status', {}) as { pid: number; ticks: number };
  expect(after.pid).toBe(before.pid);
  expect(() => process.kill(after.pid, 0)).not.toThrow();
  await usage.set({ workspaceId: 'workspace-a', pluginId: 'fixture-resident', override: 'inherit' });
  expect(await usage.allows('workspace-a', 'fixture-resident')).toBe(false);
  await plugins.setPluginEnabled({ id: 'fixture-resident', enabled: false });
  expect(hosts.running('fixture-resident')).toBe(false);
  expect(() => process.kill(after.pid, 0)).toThrow();
});

const accountPluginId = 'fixture-harness-accounts';
const accountSourceId = `plugin:${accountPluginId}/accounts`;
const accountInput = { engineId: 'agy-cli', accountId: 'account-a', instanceId: 'instance-a', proxy: { mode: 'direct' as const } };

async function installAccountFixture(ignoreCancel = false) {
  const source = join(root, 'accounts');
  const audit = join(root, 'account-audit.jsonl');
  const gate = join(root, 'account-gate');
  await cp(join(import.meta.dirname, '../../fixtures/plugin-harness-accounts'), source, { recursive: true });
  await writeFile(audit, '');
  const plugins = host.app.accessor.get(IPluginService);
  const hosts = host.app.accessor.get(IPluginHostService);
  await hosts.ready;
  const plan = await plugins.previewPlugin({ source });
  expect(plan.contributions).toContain('harness-account-source:accounts');
  expect(plan.consentRequired).toBe(true);
  await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
  await host.app.accessor.get(IPluginSettingsService).update({ pluginId: accountPluginId, values: { audit, gate, ignoreCancel } });
  return {
    plugins, hosts, source, gate,
    events: async () => (await readFile(audit, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { action: string; pid: number; home: string; aborted: boolean; input?: typeof accountInput }),
  };
}

it('discovers explicit harness sources without starting the host and prepares only the selected account', async () => {
  const { hosts, events } = await installAccountFixture();
  const signal = new AbortController().signal;
  expect(await hosts.listHarnessAccountSources()).toEqual([{ id: accountSourceId, label: 'Fixture accounts', engineIds: ['agy-cli', 'codex'] }]);
  expect(hosts.running(accountPluginId)).toBe(false);
  await expect(hosts.prepareHarnessAccount(accountSourceId, { ...accountInput, engineId: 'other' }, signal)).rejects.toThrow(`${accountSourceId}: The source does not support engine other`);
  expect(hosts.running(accountPluginId)).toBe(false);
  expect(await hosts.listHarnessAccounts(accountSourceId, 'codex', signal)).toEqual([
    { id: 'account-a', label: 'Account A', status: 'ready' },
    { id: 'signed-out', label: 'Account B', status: 'signed_out' },
    { id: 'disabled', label: 'Account C', status: 'disabled' },
  ]);
  await expect(hosts.prepareHarnessAccount(accountSourceId, { ...accountInput, accountId: 'signed-out' }, signal)).rejects.toThrow(`${accountSourceId}: Error: Selected account is signed out`);
  const input = { ...accountInput, engineId: 'codex', proxy: { mode: 'custom' as const, url: 'socks5://127.0.0.1:23456' } };
  const lease = await hosts.prepareHarnessAccount(accountSourceId, input, signal);
  expect(lease).toEqual({ connection: { protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:12345/v1', apiKey: 'short-lived-fixture-key', modelIds: ['fixture-model'] }, release: expect.any(Function) });
  await Promise.all([lease.release(), lease.release()]);
  expect(await events()).toMatchObject([
    { action: 'list', engine: 'codex', home: join(root, 'home') },
    { action: 'prepare', input: { accountId: 'signed-out' } },
    { action: 'prepare', input },
    { action: 'release', input, aborted: false },
  ]);
});

it('pins a harness lease past the idle deadline and lets the host go idle after release', async () => {
  const { hosts, events } = await installAccountFixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const lease = await hosts.prepareHarnessAccount(accountSourceId, accountInput, new AbortController().signal);
    vi.advanceTimersByTime(90_001);
    expect(hosts.running(accountPluginId)).toBe(true);
    await lease.release();
    expect(await events()).toMatchObject([{ action: 'prepare' }, { action: 'release' }]);
    vi.advanceTimersByTime(90_001);
    expect(hosts.running(accountPluginId)).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('cancels an in-flight prepare and releases a connection returned after cancellation', async () => {
  const { hosts, events, gate } = await installAccountFixture(true);
  const abort = new AbortController();
  const reason = new Error('cancel fixture prepare');
  const input = { ...accountInput, accountId: 'slow' };
  const pending = hosts.prepareHarnessAccount(accountSourceId, input, abort.signal);
  const cancelled = expect(pending).rejects.toBe(reason);
  try {
    await vi.waitFor(async () => expect(await events()).toMatchObject([{ action: 'prepare', input }]));
    abort.abort(reason);
    await cancelled;
  } finally { await writeFile(gate, 'allow late result'); }
  await vi.waitFor(async () => expect(await events()).toMatchObject([{ action: 'prepare' }, { action: 'release', input, aborted: false }]));
  await expect(hosts.listHarnessAccounts(accountSourceId, 'agy-cli', new AbortController().signal)).resolves.toHaveLength(3);
});

it('releases invalid connections and revokes live leases on disable and removal', async () => {
  const { plugins, hosts, events } = await installAccountFixture();
  const signal = new AbortController().signal;
  await expect(hosts.prepareHarnessAccount(accountSourceId, { ...accountInput, accountId: 'invalid' }, signal)).rejects.toThrow(`${accountSourceId}: The adapter returned an invalid prepared connection`);
  const disabled = await hosts.prepareHarnessAccount(accountSourceId, accountInput, signal);
  await plugins.setPluginEnabled({ id: accountPluginId, enabled: false });
  expect(await hosts.listHarnessAccountSources()).toEqual([]);
  await expect(hosts.prepareHarnessAccount(accountSourceId, accountInput, signal)).rejects.toThrow(`${accountSourceId}: The source is not enabled`);
  await disabled.release();
  await plugins.setPluginEnabled({ id: accountPluginId, enabled: true });
  const removed = await hosts.prepareHarnessAccount(accountSourceId, accountInput, signal);
  await plugins.removePlugin({ id: accountPluginId });
  await expect(hosts.listHarnessAccounts(accountSourceId, 'agy-cli', signal)).rejects.toThrow(accountSourceId);
  await removed.release();
  expect((await events()).map(({ action }) => action)).toEqual(['prepare', 'release', 'prepare', 'release', 'prepare', 'release']);
});

it('releases outstanding harness leases before App shutdown', async () => {
  const { hosts, events } = await installAccountFixture();
  const lease = await hosts.prepareHarnessAccount(accountSourceId, accountInput, new AbortController().signal);
  await hosts.stopAll();
  await lease.release();
  expect(hosts.running(accountPluginId)).toBe(false);
  expect(await events()).toMatchObject([{ action: 'prepare' }, { action: 'release', input: accountInput }]);
});

it('drains the original harness prepare before replacing the plugin and admits later calls to the new host', async () => {
  const { plugins, hosts, events, source, gate } = await installAccountFixture();
  const signal = new AbortController().signal;
  const preparing = hosts.prepareHarnessAccount(accountSourceId, { ...accountInput, accountId: 'slow' }, signal);
  let mutation: Promise<unknown> | undefined;
  let subscription: { dispose(): void } | undefined;
  try {
    await vi.waitFor(async () => expect(await events()).toMatchObject([{ action: 'prepare' }]));
    const manifestPath = join(source, 'kimi.plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = '2.0.0';
    manifest['x-kiki'].harnessAccountSources[0].label = 'Updated fixture';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const plan = await plugins.previewPlugin({ source });
    expect(plan.changes).toContain('harness account source definitions changed');
    const changing = new Promise<void>((resolveChange) => { subscription = plugins.onWillChange(() => resolveChange()); });
    mutation = plugins.installPlugin({ source, fingerprint: plan.fingerprint });
    await changing;
    const abort = new AbortController();
    const cancelled = expect(hosts.listHarnessAccounts(accountSourceId, 'agy-cli', abort.signal)).rejects.toHaveProperty('name', 'AbortError');
    abort.abort();
    await cancelled;
    const later = hosts.listHarnessAccounts(accountSourceId, 'agy-cli', signal);
    expect(await events()).toMatchObject([{ action: 'prepare' }]);
    await writeFile(gate, 'prepare can finish');
    const lease = await preparing;
    await mutation;
    await expect(later).resolves.toHaveLength(3);
    await lease.release();
    expect(await hosts.listHarnessAccountSources()).toMatchObject([{ label: 'Updated fixture' }]);
    const [prepared, released, listed] = await events();
    expect([prepared?.action, released?.action, listed?.action]).toEqual(['prepare', 'release', 'list']);
    expect(released?.pid).toBe(prepared?.pid);
    expect(listed?.pid).not.toBe(prepared?.pid);
  } finally {
    subscription?.dispose();
    await writeFile(gate, 'allow test cleanup');
    await Promise.allSettled([preparing, mutation]);
  }
});

it('keeps release bound to the original host after an unexpected child exit', async () => {
  const { hosts, events } = await installAccountFixture();
  const signal = new AbortController().signal;
  const old = await hosts.prepareHarnessAccount(accountSourceId, { ...accountInput, accountId: 'exit' }, signal);
  await vi.waitFor(() => expect(hosts.running(accountPluginId)).toBe(false));
  const current = await hosts.prepareHarnessAccount(accountSourceId, accountInput, signal);
  await old.release();
  expect((await events()).map(({ action }) => action)).toEqual(['prepare', 'prepare']);
  await current.release();
  const [first, second, released] = await events();
  expect(released).toMatchObject({ action: 'release', pid: second?.pid, input: accountInput });
  expect(released?.pid).not.toBe(first?.pid);
});

it('backs off repeated RPC handshake timeouts and isolates background resident reload failures from onUnexpectedError', async () => {
  vi.useFakeTimers();
  const unexpected: unknown[] = [];
  setUnexpectedErrorHandler((error) => unexpected.push(error));
  let silentHost: PluginHost | undefined;
  try {
    const silentEntry = join(root, 'silent-entry.mjs');
    await writeFile(silentEntry, 'await new Promise(() => {});\n');
    silentHost = new PluginHost('fixture-silent', silentEntry, []);

    const firstAttempt = silentHost.activate({}, join(root, 'user'), join(root, 'data'));
    const firstHandled = firstAttempt.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    const firstError = await firstHandled;
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toContain('RPC handshake timed out');

    const immediateRetry = await silentHost.activate({}, join(root, 'user'), join(root, 'data')).catch((error: unknown) => error);
    expect(immediateRetry).toBe(firstError);

    await vi.advanceTimersByTimeAsync(15_000);
    const secondAttempt = silentHost.activate({}, join(root, 'user'), join(root, 'data'));
    const secondHandled = secondAttempt.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    const secondError = await secondHandled;
    expect(secondError).toBeInstanceOf(Error);
    expect(secondError).not.toBe(firstError);

    await vi.advanceTimersByTimeAsync(20_000);
    const stillCooling = await silentHost.activate({}, join(root, 'user'), join(root, 'data')).catch((error: unknown) => error);
    expect(stillCooling).toBe(secondError);

    vi.useRealTimers();
    silentHost.stop();
    silentHost = undefined;

    const brokenSource = join(root, 'broken-resident');
    await mkdir(brokenSource);
    await writeFile(join(brokenSource, 'kimi.plugin.json'), JSON.stringify({
      name: 'fixture-broken-resident',
      version: '1.0.0',
      'x-kiki': {
        engines: { kiki: '^0.4.0' },
        entry: './entry.mjs',
        activation: 'app',
      },
    }));
    await writeFile(join(brokenSource, 'entry.mjs'), 'export function register() {} export function activate() { throw new Error("resident boom"); }\n');
    const plugins = host.app.accessor.get(IPluginService);
    const hosts = host.app.accessor.get(IPluginHostService);
    await hosts.ready;
    const plan = await plugins.previewPlugin({ source: brokenSource });
    await plugins.installPlugin({ source: brokenSource, fingerprint: plan.fingerprint, consent: true });
    expect(unexpected).toEqual([]);
  } finally {
    vi.useRealTimers();
    silentHost?.stop();
    resetUnexpectedErrorHandler();
  }
});
