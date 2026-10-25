import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { PLUGIN_IM_DIGEST_MAX_UTF8_BYTES, type PluginImBridge, type PluginImSendRequest } from '#/app/plugin/pluginImBridge';
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
  await mkdir('../../.tmp/plugin-im-bridge', { recursive: true });
  root = await mkdtemp(resolve('../../.tmp/plugin-im-bridge/run-'));
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

describe('plugin IM digest bridge', () => {
  it('awaits adapter withdrawal on disposal and shares it with concurrent shutdown', async () => {
    const hosts = host.app.accessor.get(IPluginHostService) as PluginHostService;
    await hosts.ready;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let withdrawals = 0;
    await hosts.attachImAdapters({
      replace: async () => undefined,
      withdraw: async () => { withdrawals++; enter(); await blocked; },
    });
    const disposal = hosts.dispose();
    try {
      expect(disposal).toBeInstanceOf(Promise);
      await entered;
      const shutdown = hosts.stopAll();
      expect(withdrawals).toBe(1);
      release();
      await Promise.all([disposal, shutdown]);
      await hosts.stopAll();
      expect(withdrawals).toBe(1);
    } finally {
      release();
      await disposal;
    }
  });

  it('does not reconcile adapters again when explicit shutdown is followed by disposal', async () => {
    const hosts = host.app.accessor.get(IPluginHostService) as PluginHostService;
    await hosts.ready;
    let withdrawals = 0;
    await hosts.attachImAdapters({ replace: async () => undefined, withdraw: async () => { withdrawals++; } });
    await hosts.stopAll();
    await hosts.dispose();
    expect(withdrawals).toBe(1);
  });

  it('retracts only owned adapter connections on hot changes and enforces declared plugin dependencies', async () => {
    const plugins = host.app.accessor.get(IPluginService);
    const hosts = host.app.accessor.get(IPluginHostService);
    await hosts.ready;
    const registrations = new Map<string, import('#/app/plugin/imAdapter').PluginImAdapterRegistration>();
    const connections = new Map<string, import('#/app/plugin/imAdapter').PluginImConnection>();
    await hosts.attachImAdapters({
      replace: async (items) => { registrations.clear(); for (const item of items) registrations.set(item.pluginId, item); },
      withdraw: async (ids) => { for (const id of [...registrations.keys()]) if (ids === undefined || ids.includes(id)) { await connections.get(id)?.stop(); connections.delete(id); registrations.delete(id); } },
    });
    const create = async (id: string, dependencies?: Record<string, string>) => {
      const source = join(root, id);
      await mkdir(source);
      const definition = { schemaVersion: 1, id: 'account', label: 'Fixture', inbound: true, outbound: true, listenerRealm: 'fixture', maxInboundBytes: 1024, mediaCapabilities: [] };
      const tool = { schemaVersion: 1, name: 'state', description: 'State', accesses: [{ kind: 'all' }], disclosure: 'deferred' };
      await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({ name: id, version: '1.0.0', 'x-kiki': { engines: { kiki: '^0.4.0' }, entry: './entry.mjs', tools: [tool], imAdapters: [definition], dependencies } }));
      await writeFile(join(source, 'entry.mjs'), `export function register(api) { api.registerTool(${JSON.stringify(tool)}, async () => ({ output: 'ok' })); api.registerImAdapter(${JSON.stringify(definition)}, { start: async () => ({ accountId: 'fixture-account' }), stop: async () => {}, sendText: async () => ({ status: 'delivered' }) }); }`);
      const plan = await plugins.previewPlugin({ source });
      expect(plan.contributions).toContain('im-adapter:account');
      await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
    };
    await create('fixture-independent');
    await create('fixture-dependent', { 'fixture-provider': '^1.0.0' });
    expect(registrations.has('fixture-dependent')).toBe(false);
    await expect(hosts.execute('fixture-dependent', 'state', {}, new AbortController().signal)).rejects.toThrow('requires enabled plugin fixture-provider');
    await create('fixture-provider');
    expect(registrations.has('fixture-dependent')).toBe(true);
    await create('fixture-version-mismatch', { 'fixture-provider': '^2.0.0' });
    expect(registrations.has('fixture-version-mismatch')).toBe(false);
    await expect(hosts.execute('fixture-version-mismatch', 'state', {}, new AbortController().signal)).rejects.toThrow('requires fixture-provider ^2.0.0; installed version is 1.0.0');
    for (const id of ['fixture-independent', 'fixture-dependent']) connections.set(id, await registrations.get(id)!.connect(async () => undefined));
    await plugins.setPluginEnabled({ id: 'fixture-provider', enabled: false });
    expect(registrations.has('fixture-dependent')).toBe(false);
    expect(hosts.running('fixture-dependent')).toBe(false);
    expect(hosts.running('fixture-independent')).toBe(true);
    expect((await hosts.execute('fixture-independent', 'state', {}, new AbortController().signal)).output).toBe('ok');
    await plugins.setPluginEnabled({ id: 'fixture-provider', enabled: true });
    expect(registrations.has('fixture-dependent')).toBe(true);
    const connection = await registrations.get('fixture-dependent')!.connect(async () => undefined);
    connections.set('fixture-dependent', connection);
    await plugins.removePlugin({ id: 'fixture-dependent' });
    expect(registrations.has('fixture-dependent')).toBe(false);
    expect(hosts.running('fixture-independent')).toBe(true);
  });
  it('reports the bridge as unsupported until attached, then strips secrets from the live route and receipt', async () => {
    const source = join(root, 'source');
    await mkdir(source);
    await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({ name: 'fixture-im', version: '1.0.0',
      'x-kiki': { engines: { kiki: '^0.4.0' }, entry: './entry.mjs', activation: 'app', permissions: { uiPanel: true },
        panels: [{ schemaVersion: 1, id: 'status', label: 'Status', slot: 'sidebar', path: './panel.html' }] } }));
    await writeFile(join(source, 'panel.html'), '<!doctype html><title>Status</title>');
    await writeFile(join(source, 'entry.mjs'), `
      let bridge;
      export function register() {}
      export function activate(context) { bridge = context.im; }
      export function deactivate() {}
      export function handlePanelRequest(action, args) {
        if (bridge === undefined) return { missing: true };
        const signal = new AbortController().signal;
        if (action === 'caps') return bridge.capabilities(signal);
        if (action === 'routes') return bridge.listRoutes(signal);
        if (action === 'send') return bridge.send(args, signal);
        if (action === 'cancel-send') {
          const controller = new AbortController();
          controller.abort();
          return bridge.send(args, controller.signal);
        }
        return { missing: true };
      }
    `);
    const plugins = host.app.accessor.get(IPluginService);
    const hosts = host.app.accessor.get(IPluginHostService);
    await hosts.ready;
    const plan = await plugins.previewPlugin({ source });
    await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
    const panel = (action: string, args?: unknown) => hosts.requestPanel('fixture-im', 'status', action, args);
    expect(await panel('caps')).toEqual({ outbound: false, inbound: false });
    expect(await panel('routes')).toEqual([]);
    const secret = 'super-secret-token-value';
    const digest = 'New mail from ada@example.test';
    const calls: string[] = [];
    const callers: string[] = [];
    const bridge = {
      capabilities: async () => ({ outbound: true, inbound: true }),
      listRoutes: async () => [{ channelId: 'ops', providerId: 'http', routeRevision: 'ab'.repeat(32), label: 'Ops', token: secret }],
      send: async (request: PluginImSendRequest, _signal: AbortSignal, caller: { readonly pluginId: string }) => {
        expect(Object.hasOwn(request, 'pluginId')).toBe(false);
        callers.push(caller.pluginId);
        calls.push(request.text);
        return { status: 'unknown', retryable: true, diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown', text: request.text };
      },
    };
    hosts.attachOutboundIm(bridge as unknown as PluginImBridge);
    expect(await panel('caps')).toEqual({ outbound: true, inbound: false });
    const routes = await panel('routes');
    expect(routes).toEqual([{ channelId: 'ops', providerId: 'http', label: 'Ops', routeRevision: 'ab'.repeat(32) }]);
    expect(JSON.stringify(routes)).not.toContain(secret);
    const request = { channelId: 'ops', routeRevision: 'ab'.repeat(32), idempotencyKey: 'mail-1', accountRef: 'account-a', text: digest };
    const receipt = await panel('send', request);
    expect(receipt).toEqual({ status: 'unknown', retryable: false, diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' });
    expect(JSON.stringify(receipt)).not.toContain(digest);
    expect(calls).toEqual([digest]);
    expect(callers).toEqual(['fixture-im']);
    expect(await panel('send', { ...request, pluginId: 'other-plugin' })).toMatchObject({ status: 'unknown', retryable: false });
    expect(callers).toEqual(['fixture-im', 'fixture-im']);
    expect(calls).toEqual([digest, digest]);
    expect(await panel('cancel-send', request)).toEqual({ status: 'cancelled', retryable: false, diagnosticCode: 'cancelled' });
    expect(calls).toEqual([digest, digest]);
    const limit = 'x'.repeat(PLUGIN_IM_DIGEST_MAX_UTF8_BYTES);
    expect(await panel('send', { ...request, text: limit })).toMatchObject({ status: 'unknown', retryable: false });
    expect(calls.at(-1)).toBe(limit);
    expect(await panel('send', { ...request, text: `${limit}y` })).toMatchObject({
      status: 'failed', diagnosticCode: 'too_long', errorKind: 'too_long', retryable: true,
    });
    const cjk = '你'.repeat(Math.floor(PLUGIN_IM_DIGEST_MAX_UTF8_BYTES / Buffer.byteLength('你')) + 1);
    expect(cjk.length).toBeLessThan(PLUGIN_IM_DIGEST_MAX_UTF8_BYTES);
    expect(Buffer.byteLength(cjk)).toBeGreaterThan(PLUGIN_IM_DIGEST_MAX_UTF8_BYTES);
    expect(await panel('send', { ...request, text: cjk })).toMatchObject({ diagnosticCode: 'too_long', errorKind: 'too_long' });
    expect(calls.at(-1)).toBe(limit);
  });
});
