import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Event } from '#/_base/event';
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
  host = createScopedTestHost([
    stubPair(IFlagService, { enabled: () => true } as unknown as IFlagService),
    stubPair(IBootstrapService, { ...stubBootstrap(join(root, 'home')), osHomeDir: join(root, 'user') }),
    stubPair(IProviderService, stubProviderService()),
    stubPair(IOAuthService, {} as IOAuthService),
    stubPair(IRequestIdentityCatalog, {} as IRequestIdentityCatalog),
    stubPair(ISessionManager, { list: () => [], get: () => undefined, onDidCreateSession: Event.None, onDidCloseSession: Event.None } as unknown as ISessionManager),
    stubPair(IConfigService, { ready: Promise.resolve(), get: () => ({}), onDidSectionChange: Event.None } as unknown as IConfigService),
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
  expect(hosts.running('fixture-resident')).toBe(false);
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
