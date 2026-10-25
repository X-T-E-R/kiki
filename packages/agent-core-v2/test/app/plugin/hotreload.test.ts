import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { _clearScopedRegistryForTests, registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IOAuthService } from '#/app/auth/auth';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { PluginUsageService } from '#/app/pluginUsage/pluginUsageService';
import { PluginService } from '#/app/plugin/pluginService';
import { IPluginHostService, PluginHostService } from '#/app/plugin/pluginHostService';
import { IPluginSettingsService, PluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { IProviderService } from '#/kosong/provider/provider';
import { IRequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { LifecycleScope } from '#/app/scopes';
import { IAgentPluginToolService, AgentPluginToolService } from '#/agent/userTool/pluginToolService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPluginMediaService } from '#/agent/pluginMedia/pluginMedia';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { RunnableToolExecution } from '#/tool/toolContract';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function pluginDefinition(version: number) {
  return {
    schemaVersion: 1 as const,
    name: 'echo',
    description: `Echo v${version}`,
    parameters: {
      type: 'object',
      properties: { [version === 1 ? 'value' : 'message']: { type: 'string' } },
    },
    accesses: [{ kind: 'all' as const }],
    disclosure: 'inline' as const,
  };
}

async function writePlugin(root: string, id: string, version: number): Promise<void> {
  const definition = pluginDefinition(version);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify({
    name: id,
    version: `${version}.0.0`,
    'x-kiki': {
      engines: { kiki: '^0.4.0' },
      permissions: {},
      entry: './entry.mjs',
      tools: [definition],
    },
  }), 'utf8');
  await writeFile(path.join(root, 'entry.mjs'), `
export function register(api) {
  api.registerTool(${JSON.stringify(definition)}, async (args) => ({
    output: JSON.stringify({ version: ${version}, value: args.${version === 1 ? 'value' : 'message'}, pid: process.pid }),
  }));
}
`, 'utf8');
}

async function install(plugins: IPluginService, source: string, consent?: boolean): Promise<void> {
  const plan = await plugins.previewPlugin({ source });
  await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent });
}

function configStub(): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: () => ({}),
    replace: async () => {},
    onDidSectionChange: Event.None,
  } as unknown as IConfigService;
}

function makeHost(home: string): { readonly host: ScopedTestHost; readonly root: string } {
  const runtime = new FakeRuntime(
    { workspaceId: 'fixture', runtimeId: 'local', generation: '1' },
    { pathClass: process.platform === 'win32' ? 'win32' : 'posix' },
  );
  Object.assign(runtime, { fs: new HostFileSystem() });
  const root = path.dirname(home);
  const documents = new Map<string, unknown>();
  const host = createScopedTestHost([
    stubPair(IAtomicDocumentStore, {
      get: async <T>(scope: string, key: string) => documents.get(`${scope}:${key}`) as T | undefined,
      set: async <T>(scope: string, key: string, value: T) => { documents.set(`${scope}:${key}`, value); },
    } as IAtomicDocumentStore),
    stubPair(IBootstrapService, stubBootstrap(home)),
    stubPair(IConfigService, configStub()),
    stubPair(IFlagService, { enabled: () => true } as unknown as IFlagService),
    stubPair(IOAuthService, {} as IOAuthService),
    stubPair(IProviderService, stubProviderService()),
    stubPair(ISessionManager, { list: () => [], get: () => undefined } as unknown as ISessionManager),
    stubPair(IRequestIdentityCatalog, {} as IRequestIdentityCatalog),
    stubPair(ISkillDiscovery, { _serviceBrand: undefined, discover: async () => ({ skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }) } satisfies ISkillDiscovery),
    stubPair(IAgentRuntimeService, { inspect: () => runtime, acquire: () => ({ runtime, dispose() {} }) } as unknown as IAgentRuntimeService),
    stubPair(ISessionWorkspaceContext, { workDir: root, additionalDirs: [] } as unknown as ISessionWorkspaceContext),
    stubPair(IAgentProfileService, { getModelCapabilities: () => ({ image_in: true }) } as unknown as IAgentProfileService),
  ]);
  return { host, root };
}

async function execute(registry: IAgentToolRegistryService, id: string, args: unknown, callId: string) {
  const tool = registry.resolve(`plugin__${id.replaceAll('-', '_')}__echo`);
  if (tool === undefined) throw new Error('plugin tool is not registered');
  const execution = await tool.resolveExecution(args) as RunnableToolExecution;
  return execution.execute({ turnId: 1, toolCallId: callId, signal: new AbortController().signal });
}

describe('plugin hot reload lifecycle', () => {
  const directories: string[] = [];
  let host: ScopedTestHost | undefined;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand, 'plugin');
    registerScopedService(LifecycleScope.App, IPluginUsageService, PluginUsageService, ScopeActivation.OnDemand, 'pluginUsage');
    registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnDemand, 'plugin');
    registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnDemand, 'plugin');
    registerScopedService(LifecycleScope.Agent, IAgentToolRegistryService, AgentToolRegistryService, ScopeActivation.OnDemand, 'toolRegistry');
    registerScopedService(LifecycleScope.Agent, IAgentPluginToolService, AgentPluginToolService, ScopeActivation.OnDemand, 'plugin');
  });

  afterEach(async () => {
    await host?.dispose();
    host = undefined;
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    vi.restoreAllMocks();
  });

  it('keeps the plugin change gate closed until the current session registry refresh completes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kiki-hot-reload-home-'));
    directories.push(home);
    const source = path.join(home, 'source');
    await writePlugin(source, 'hot-demo', 1);
    const created = makeHost(path.join(home, 'kiki-home'));
    host = created.host;
    const plugins = host.app.accessor.get(IPluginService);
    const session = host.child(LifecycleScope.Session, 'session', [
      stubPair(ISessionContext, makeSessionContext({ sessionId: 'session', workspaceId: 'fixture', sessionDir: created.root, sessionScope: 'fixture/session', cwd: created.root })),
      stubPair(ISessionMediaStore, { _serviceBrand: undefined, pathFor: () => undefined, resolveDisplayPath: async () => undefined,
        read: async () => undefined, open: async () => undefined, materialize: async () => undefined }),
      stubPair(IAgentPluginMediaService, { api: () => undefined } as unknown as IAgentPluginMediaService),
    ]);
    const agent = host.childOf(session, LifecycleScope.Agent, 'agent');
    const registry = agent.accessor.get(IAgentToolRegistryService);
    const pluginTools = agent.accessor.get(IAgentPluginToolService);
    await pluginTools.ready();
    await install(plugins, source, true);
    await plugins.setPluginEnabled({ id: 'hot-demo', enabled: true });
    await expect(execute(registry, 'hot-demo', { value: 'before' }, 'before')).resolves.toMatchObject({ output: expect.stringContaining('"version":1') });

    const stale = await registry.resolve('plugin__hot_demo__echo')!.resolveExecution({ value: 'stale' }) as RunnableToolExecution;
    await writePlugin(source, 'hot-demo', 2);
    const hosts = host.app.accessor.get(IPluginHostService);
    const originalList = hosts.list.bind(hosts);
    const listStarted = deferred<void>();
    const releaseList = deferred<void>();
    const reloadStarted = deferred<void>();
    let finished = false;
    plugins.onWillChange((event) => { void event.finished.then(() => { finished = true; }); });
    plugins.onDidReload((event) => { reloadStarted.resolve(undefined); event.waitUntil(Promise.resolve()); });
    vi.spyOn(hosts, 'list').mockImplementation(async () => {
      listStarted.resolve(undefined);
      await releaseList.promise;
      return originalList();
    });

    const update = install(plugins, source);
    await Promise.all([listStarted.promise, reloadStarted.promise]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    let staleSettled = false;
    const staleCall = stale.execute({ turnId: 1, toolCallId: 'stale', signal: new AbortController().signal })
      .then(() => { staleSettled = true; }, () => { staleSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(staleSettled).toBe(false);

    releaseList.resolve(undefined);
    await update;
    await staleCall;
    expect(registry.resolve('plugin__hot_demo__echo')?.parameters).toEqual(pluginDefinition(2).parameters);
    await expect(execute(registry, 'hot-demo', { message: 'after' }, 'after')).resolves.toMatchObject({ output: expect.stringContaining('"version":2') });
  }, 30_000);

  it('holds the change gate through enable and disable subscriber delivery', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kiki-plugin-gate-home-'));
    directories.push(home);
    const source = path.join(home, 'source');
    await writePlugin(source, 'gate-demo', 1);
    const created = makeHost(path.join(home, 'kiki-home'));
    host = created.host;
    const plugins = host.app.accessor.get(IPluginService);
    await install(plugins, source, true);
    await plugins.setPluginEnabled({ id: 'gate-demo', enabled: true });

    const delivery = deferred<void>();
    const reloadStarted = deferred<void>();
    const changeFinished = deferred<void>();
    let finished = false;
    plugins.onWillChange((event) => {
      void event.finished.then(changeFinished.resolve);
    });
    plugins.onDidReload((event) => {
      reloadStarted.resolve(undefined);
      event.waitUntil(delivery.promise);
    });
    const mutation = plugins.setPluginEnabled({ id: 'gate-demo', enabled: false });
    void changeFinished.promise.then(() => { finished = true; });
    await reloadStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    delivery.resolve(undefined);
    await mutation;
    await changeFinished.promise;
    expect(finished).toBe(true);
  }, 30_000);
});
