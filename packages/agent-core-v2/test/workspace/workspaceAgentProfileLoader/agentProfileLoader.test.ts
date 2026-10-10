import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { dirname, join } from 'pathe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncEmitter, Emitter, Event } from '#/_base/event';
import { atomicWrite } from '#/_base/utils/fs';
import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { ILogService } from '#/_base/log/log';
import { EXTRA_AGENT_DIRS_SECTION } from '#/workspace/workspaceAgentProfileLoader/configSection';
import { UserAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoaderService';
import type { PluginAgentRoot, PluginReloadEvent } from '#/app/plugin/types';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IShippedAgentProfileSource } from '#/app/shippedAgentProfiles/shippedAgentProfileSource';
import { ShippedAgentProfileSourceService } from '#/app/shippedAgentProfiles/shippedAgentProfileSourceService';
import { EXAMPLE_AGENT_PROFILE_TEMPLATES } from '#/app/shippedAgentProfiles/examples/exampleAgentProfiles';
import { IShippedAgentProfileManager } from '#/app/shippedAgentProfiles/shippedAgentProfileManager';
import { BuiltinAgentProfileLoaderService } from '#/app/agentProfileCatalog/builtinAgentProfileLoaderService';
import { AGENT_PROFILE_SOURCE_PRIORITY } from '#/app/agentProfileCatalog/agentProfileContribution';
import { _clearAgentProfileContributionsForTests } from '#/app/agentProfileCatalog/contribution';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { AgentExecutorRegistryService } from '#/app/agentExecutor/agentExecutorRegistryService';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoaderService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAtomicDocumentStore, IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { createUnscopedAgentProfileCatalog } from '#/workspace/workspaceAgentProfileLoader/unscopedAgentProfileCatalog';
import { IAppStateService } from '#/app/state/appState';
import { AppStateService } from '#/app/state/appStateService';
import { BuiltinSkillSource, IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { encodeLegacyWorkDirKey, encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import {
  IHostFsWatchService,
  type HostFsChange,
  type IHostFsWatchHandle,
} from '#/os/interface/hostFsWatch';
import { SessionAgentProfileCatalogService } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalogService';
import type { ISessionAgentProfileCatalogSeed } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogSeed';
import { ExplicitAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoaderService';
import { ExtraAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoaderService';
import { WorkspaceAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoaderService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IInheritedAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/inheritedAgentProfileLoader';
import { InheritedAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/inheritedAgentProfileLoaderService';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { resolveSubagentDispatch, resolveSubagentTarget } from '#/app/agentProfileCatalog/subagentDispatch';
import { IModelService } from '#/kosong/model/model';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { createTestAgent } from '../../harness';
import { parseAgentRouteFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentRouteFile';
import { resolveAgentSourceGraph } from '#/workspace/workspaceAgentProfileLoader/internal/agentSourceGraph';
import type { AgentFileDefinition } from '#/workspace/workspaceAgentProfileLoader/internal/types';
import { AgentProfileWriterService } from '#/workspace/workspaceAgentProfileLoader/agentProfileWriterService';
import { AgentProfileWriteErrors } from '#/workspace/workspaceAgentProfileLoader/errors';

import { stubBootstrap, type StubSpaceOptions } from '../../app/bootstrap/stubs';
import type { SpaceHome } from '#/app/bootstrap/spaceHome';

function configStub(): IConfigService & {
  setExtraAgentDirs(dirs: readonly string[]): void;
  fireSectionChange(domain: string): void;
} {
  let extraAgentDirs: readonly string[] = [];
  const sectionChangeListeners: Array<(event: unknown) => void> = [];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: (listener: (event: unknown) => void) => {
      sectionChangeListeners.push(listener);
      return { dispose: () => {} };
    },
    get: (domain: string) => {
      if (domain === EXTRA_AGENT_DIRS_SECTION) return [...extraAgentDirs];
      return undefined;
    },
    inspect: () => ({
      value: undefined,
      defaultValue: undefined,
      userValue: undefined,
      memoryValue: undefined,
    }),
    getAll: () => ({}),
    set: async () => {},
    replace: async () => {},
    reload: async () => {},
    diagnostics: () => [],
    setExtraAgentDirs: (dirs: readonly string[]) => {
      extraAgentDirs = [...dirs];
    },
    fireSectionChange: (domain: string) => {
      for (const listener of sectionChangeListeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    },
  } as unknown as IConfigService & {
    setExtraAgentDirs(dirs: readonly string[]): void;
    fireSectionChange(domain: string): void;
  };
}

function workspaceContextStub(workDir: string): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'wd_test',
    cwd: workDir,
    source: 'local',
    meta: { id: 'wd_test', root: workDir, name: 'test', createdAt: 0, lastOpenedAt: 0 },
    persistenceScope: 'sessions/wd_test',
  };
}

function workspaceTrustStub(trusted: boolean): IWorkspaceTrust {
  const changes = new Emitter<{ trusted: boolean }>();
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: async () => trusted,
    isTrusted: () => trusted,
    trust: async () => { trusted = true; changes.fire({ trusted }); },
    untrust: async () => { trusted = false; changes.fire({ trusted }); },
    onDidChange: changes.event,
  };
}

function fsWatchStub(): IHostFsWatchService {
  return {
    _serviceBrand: undefined,
    watch: (): IHostFsWatchHandle => ({
      ready: Promise.resolve(),
      onDidChange: Event.None as Event<HostFsChange>,
      dispose: () => {},
    }),
  };
}

function recordingFsWatchStub(): {
  readonly service: IHostFsWatchService;
  readonly handles: Array<{ disposed: boolean }>;
} {
  const handles: Array<{ disposed: boolean }> = [];
  return {
    service: {
      _serviceBrand: undefined,
      watch: (): IHostFsWatchHandle => {
        const state = { disposed: false };
        handles.push(state);
        return {
          ready: Promise.resolve(),
          onDidChange: Event.None as Event<HostFsChange>,
          dispose: () => {
            state.disposed = true;
          },
        };
      },
    },
    handles,
  };
}

function agentMd(name: string, description: string, override = false): string {
  const overrideLine = override ? 'override: true\n' : '';
  return `---\nname: ${name}\ndescription: ${description}\n${overrideLine}---\n\nYou are ${name}.\n`;
}

function sourceParentMd(
  name: string,
  alias: string,
  source: string,
  extraLease = '',
  extraProfile = '',
): string {
  return `---\nname: ${name}\ndescription: ${name}\n${extraProfile}allowed_subagents:\n  - "*"\n  - name: ${alias}\n    source: ${source}\n${extraLease}---\n\nYou are ${name}.\n`;
}

function privateAgentMd(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\nprivate: true\n${extra}---\n\nYou are ${description}.\n`;
}

function routeMd(
  id: string,
  profile: string,
  body: string,
  extra = '',
): string {
  return `---\nid: ${id}\nprofile: ${profile}\ndescription: ${id} route\nprompt_mode: prepend\n${extra}---\n\n${body}\n`;
}

interface Fixture {
  readonly homeDir: string;
  readonly osHomeDir: string;
  readonly workDir: string;
  readonly extraDir: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-profile-loader-'));
  try {
    const make = async (dir: string): Promise<string> => {
      const p = join(root, dir);
      await mkdir(p, { recursive: true });
      return realpath(p);
    };
    const [homeDir, osHomeDir, workDir, extraDir] = await Promise.all([
      make('kimi-home'),
      make('os-home'),
      make('work'),
      make('extra-agents'),
    ]);
    await run({ homeDir, osHomeDir, workDir, extraDir });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

async function writeAgent(dir: string, fileName: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, content);
  return filePath;
}

function logStub(warnings?: string[]): ILogService {
  return {
    _serviceBrand: undefined,
    warn: (message: unknown) => {
      warnings?.push(String(message));
    },
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    setLevel: () => {},
  } as unknown as ILogService;
}

function pluginStub(
  agentRoots: readonly PluginAgentRoot[] = [],
  reloadEmitter?: Emitter<PluginReloadEvent>,
): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: reloadEmitter !== undefined ? reloadEmitter.event : () => ({ dispose: () => {} }),
    onWillChange: () => ({ dispose: () => {} }),
    onDidMutate: () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    previewPlugin: async () => { throw new Error('unused'); },
    installPlugin: async () => ({ id: '' }) as never,
    rollbackPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async () => {
      throw new Error('getPluginInfo is not used by these tests');
    },
    listPluginCommands: async () => [],
    checkUpdates: async () => [],
    pluginSkillRoots: async () => [],
    pluginAgentRoots: async () => agentRoots,
    enabledSessionStarts: async () => [],
    enabledSystemPrompts: async () => [],
    enabledMcpServers: async () => ({}),
    mcpServerEntries: async () => [],
    enabledHooks: async () => [],
    enabledHookRules: async () => [],
    hasLoadedSnapshot: () => true,
  };
}

function waitForEvent(event: Event<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const disposable = event(() => {
      disposable.dispose();
      resolve();
    });
  });
}

function failingReaddirFs(
  hostFs: HostFileSystem,
  shouldFail: (path: string) => boolean,
): HostFileSystem {
  const failing = Object.create(hostFs) as HostFileSystem;
  failing.readdir = async (path: string) => {
    if (shouldFail(path)) {
      throw new HostFsError(
        OsFsErrors.codes.OS_FS_UNAVAILABLE,
        `injected readdir failure for ${path}`,
      );
    }
    return hostFs.readdir(path);
  };
  return failing;
}

function inMemoryDocuments(): IAtomicTomlDocumentStore {
  const values = new Map<string, unknown>();
  const address = (scope: string, key: string): string => `${scope}/${key}`;
  return {
    _serviceBrand: undefined,
    getText: async (scope, key) => values.get(address(scope, key)) as string | undefined,
    setText: async (scope, key, text) => { values.set(address(scope, key), text); },
    compareAndSetText: async (scope, key, expected, next) => {
      const path = address(scope, key);
      if (values.get(path) !== expected) return false;
      if (next === undefined) values.delete(path);
      else values.set(path, next);
      return true;
    },
    get: async <T>(scope: string, key: string) => values.get(address(scope, key)) as T | undefined,
    set: async (scope, key, value) => { values.set(address(scope, key), value); },
    update: async <T>(scope: string, key: string, updater: (current: T | undefined) => T | undefined) => {
      const path = address(scope, key);
      const next = updater(values.get(path) as T | undefined);
      if (next === undefined) values.delete(path);
      else values.set(path, next);
      return next;
    },
    delete: async (scope, key) => { values.delete(address(scope, key)); },
    list: async (scope, prefix = '') => [...values.keys()]
      .filter((path) => path.startsWith(`${scope}/${prefix}`))
      .map((path) => path.slice(scope.length + 1)),
    watch: () => Event.None as Event<void>,
    acquire: () => ({ dispose: () => {} }),
  };
}

interface StackOptions {
  readonly extraAgentDirs?: readonly string[];
  readonly explicitFiles?: readonly string[];
  readonly pluginAgentRoots?: readonly PluginAgentRoot[];
  readonly pluginReloadEmitter?: Emitter<PluginReloadEvent>;
  readonly hostFs?: HostFileSystem;
  readonly fsWatch?: IHostFsWatchService;
  readonly routesEnabled?: boolean;
  readonly workspaceTrusted?: boolean;
  readonly workspaceTrust?: IWorkspaceTrust;
  readonly executors?: IAgentExecutorRegistry;
  readonly documents?: IAtomicTomlDocumentStore;
  readonly userAgentProfileHomeDir?: string;
  readonly atomicTextWriter?: (path: string, text: string) => Promise<void>;
  readonly space?: StubSpaceOptions;
}

function makeStack(fixture: Fixture, opts?: StackOptions) {
  const warnings: string[] = [];
  const log = logStub(warnings);
  const config = configStub();
  if (opts?.extraAgentDirs !== undefined) config.setExtraAgentDirs(opts.extraAgentDirs);
  const bootstrap: IBootstrapService = {
    ...stubBootstrap(fixture.homeDir, {}, { agentFiles: opts?.explicitFiles }, opts?.space),
    osHomeDir: fixture.osHomeDir,
    userAgentProfileHomeDir: opts?.userAgentProfileHomeDir ?? fixture.homeDir,
  };
  const hostFs = opts?.hostFs ?? new HostFileSystem();
  const workspaceContext = workspaceContextStub(fixture.workDir);
  const flags = {
    _serviceBrand: undefined,
    enabled: (id: string) => id === AGENT_PROFILE_ROUTES_FLAG_ID && opts?.routesEnabled === true,
  } as IFlagService;

  const container = new InstantiationService(
    new ServiceCollection(
      [ILogService, log],
      [IConfigService, config],
      [IBootstrapService, bootstrap],
      [IHostFileSystem, hostFs],
      [IHostProcessService, { _serviceBrand: undefined }],
      [IAppStateService, new SyncDescriptor(AppStateService)],
      [IAtomicTomlDocumentStore, opts?.documents ?? inMemoryDocuments()],
      [IAtomicDocumentStore, opts?.documents ?? inMemoryDocuments()],
      [IHostFsWatchService, opts?.fsWatch ?? fsWatchStub()],
      [IWorkspaceContext, workspaceContext],
      [IWorkspaceTrust, opts?.workspaceTrust ?? workspaceTrustStub(opts?.workspaceTrusted ?? true)],
      [IPluginService, pluginStub(opts?.pluginAgentRoots ?? [], opts?.pluginReloadEmitter)],
      [IFlagService, flags],
      [IBuiltinSkillSource, new SyncDescriptor(BuiltinSkillSource)],
      [IAgentExecutorRegistry, opts?.executors ?? new SyncDescriptor(AgentExecutorRegistryService)],
      [IAgentProfileRegistry, new SyncDescriptor(AgentProfileRegistryService)],
      [IShippedAgentProfileSource, new SyncDescriptor(ShippedAgentProfileSourceService)],
      [
        IShippedAgentProfileManager,
        {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          onDidChange: Event.None as Event<void>,
          status: async () => [],
          isCleanActivePath: () => false,
          restoreOriginal: async () => {
            throw new Error('restoreOriginal is not available in this harness');
          },
        } satisfies IShippedAgentProfileManager,
      ],
      [IBuiltinAgentProfileLoader, new SyncDescriptor(BuiltinAgentProfileLoaderService)],
      [IUserAgentProfileLoader, new SyncDescriptor(UserAgentProfileLoaderService)],
      [IInheritedAgentProfileLoader, new SyncDescriptor(InheritedAgentProfileLoaderService)],
      [IPluginAgentProfileLoader, new SyncDescriptor(PluginAgentProfileLoaderService)],
      [IWorkspaceAgentProfileLoader, new SyncDescriptor(WorkspaceAgentProfileLoaderService)],
      [IExtraAgentProfileLoader, new SyncDescriptor(ExtraAgentProfileLoaderService)],
      [IExplicitAgentProfileLoader, new SyncDescriptor(ExplicitAgentProfileLoaderService)],
    ),
    true,
  );
  const get = <T>(id: ServiceIdentifier<T>): T =>
    container.invokeFunction((accessor) => accessor.get(id));
  const registry = get(IAgentProfileRegistry);
  const builtinLoader = get(IBuiltinAgentProfileLoader);
  const userLoader = get(IUserAgentProfileLoader);
  const inheritedLoader = get(IInheritedAgentProfileLoader);
  const pluginLoader = get(IPluginAgentProfileLoader);
  const workspaceLoader = get(IWorkspaceAgentProfileLoader);
  const extraLoader = get(IExtraAgentProfileLoader);
  const explicitLoader = get(IExplicitAgentProfileLoader);
  const seed: ISessionAgentProfileCatalogSeed = {
    _serviceBrand: undefined,
    workspaceKey: workspaceContext.workspaceId,
  };
  const catalog = new SessionAgentProfileCatalogService(registry, seed, config, log, flags);
  const writer = new AgentProfileWriterService(
    hostFs,
    registry,
    workspaceContext,
    userLoader,
    workspaceLoader,
    extraLoader,
    bootstrap,
    get(IAgentExecutorRegistry),
    opts?.atomicTextWriter,
  );

  return {
    container,
    registry,
    writer,
    builtinLoader,
    userLoader,
    inheritedLoader,
    pluginLoader,
    workspaceLoader,
    extraLoader,
    explicitLoader,
    catalog,
    config,
    warnings,
    async ready(): Promise<void> {
      await Promise.all([
        userLoader.ready,
        inheritedLoader.ready,
        pluginLoader.ready,
        workspaceLoader.ready,
        extraLoader.ready,
        explicitLoader.ready,
      ]);
      await catalog.ready;
    },
    dispose(): void {
      catalog.dispose();
      container.dispose();
    },
  };
}

type Stack = ReturnType<typeof makeStack>;

async function withStack(
  fixture: Fixture,
  opts: StackOptions | undefined,
  run: (stack: Stack) => Promise<void>,
): Promise<void> {
  const stack = makeStack(fixture, opts);
  try {
    await run(stack);
  } finally {
    stack.dispose();
  }
}

describe('agent profile loaders + session catalog', () => {
  beforeEach(() => {
    _clearAgentProfileContributionsForTests();
  });

  it('refreshes external selections on trust changes without reviving revoked last-good profiles', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.workDir, '.kiki', 'agents');
      const externalMd = '---\nname: helper\ndescription: external helper\nexecutor: sample-acp\n---\n\nhelper';
      const external = await writeAgent(root, 'helper.md', externalMd);
      const native = await writeAgent(root, 'native-helper.md', agentMd('native-helper', 'native helper'));
      const parent = await writeAgent(root, 'team.md', sourceParentMd('team', 'private-helper', './_private/helper.md'));
      await writeAgent(join(root, '_private'), 'helper.md', externalMd);
      await writeAgent(join(root, '.routes', 'helper'), 'brief.md', routeMd('helper.brief', 'helper', 'Brief'));
      await writeAgent(join(fixture.homeDir, 'agents'), 'user-helper.md', externalMd.replace('name: helper', 'name: user-helper'));
      const trust = workspaceTrustStub(false);
      const executors = { validateBinding: () => ({ ok: true, binding: {} }) } as unknown as IAgentExecutorRegistry;
      await withStack(fixture, { workspaceTrust: trust, executors, routesEnabled: true }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('helper')).toBeUndefined();
        await trust.trust();
        await stack.workspaceLoader.ready;
        expect(stack.catalog.resolveSelection({ profile: 'helper' }).profile.executor).toBe('sample-acp');
        expect(stack.catalog.resolveSelection({ route: 'helper.brief' }).profile.executor).toBe('sample-acp');
        const team = stack.catalog.get('team')!;
        expect(stack.catalog.getScopedBinding(team.definitionId, 'private-helper')?.status).toBe('ready');
        const frozen = stack.catalog.snapshot();
        const caller = {
          profileName: 'team', profileDefinitionId: team.definitionId, allowedSubagents: ['helper', 'private-helper', 'native-helper', 'user-helper'],
        };
        await rm(external);
        await stack.workspaceLoader.reload();
        expect(stack.catalog.get('helper')).toBeUndefined();
        expect(resolveSubagentDispatch(stack.catalog, caller, { profileName: 'helper', snapshot: frozen }).selection.profile).toBe(frozen.resolvableProfiles?.get('helper'));
        expect(resolveSubagentDispatch(stack.catalog, caller, { routeId: 'helper.brief', snapshot: frozen }).selection.route).toBe(frozen.routes.get('helper.brief'));
        await writeFile(external, externalMd);
        await stack.workspaceLoader.reload();
        await writeFile(external, 'invalid frontmatter');
        await writeFile(native, 'invalid frontmatter');
        await writeFile(parent, 'invalid frontmatter');
        await stack.workspaceLoader.reload();
        expect(stack.catalog.get('helper')?.executor).toBe('sample-acp');
        expect(stack.catalog.get('native-helper')).toBeDefined();
        await trust.untrust();
        expect(stack.catalog.get('helper')).toBeUndefined();
        expect(() => stack.catalog.resolveSelection({ profile: 'helper' })).toThrow();
        expect(() => stack.catalog.resolveSelection({ route: 'helper.brief' })).toThrow();
        expect(stack.catalog.getScopedBinding(team.definitionId, 'private-helper')?.status).toBe('unavailable');
        expect(frozen.resolvableProfiles?.get('helper')?.executor).toBe('sample-acp');
        expect(() => resolveSubagentDispatch(stack.catalog, caller, { profileName: 'private-helper', snapshot: frozen })).toThrow(/trusted workspace profile source/);
        expect(() => resolveSubagentDispatch(stack.catalog, caller, { profileName: 'helper', snapshot: frozen })).toThrow(/trusted workspace profile source/);
        expect(() => resolveSubagentDispatch(stack.catalog, caller, { routeId: 'helper.brief', snapshot: frozen })).toThrow(/trusted workspace profile source/);
        expect(resolveSubagentDispatch(stack.catalog, caller, { profileName: 'native-helper', snapshot: frozen }).selection.profile).toBe(frozen.resolvableProfiles?.get('native-helper'));
        expect(resolveSubagentDispatch(stack.catalog, caller, { profileName: 'user-helper', snapshot: frozen }).selection.profile.executor).toBe('sample-acp');
        await stack.workspaceLoader.ready;
        await stack.workspaceLoader.reload();
        expect(stack.catalog.get('helper')).toBeUndefined();
        expect(stack.catalog.get('native-helper')).toBeDefined();
        expect(() => resolveSubagentDispatch(stack.catalog, caller, { profileName: 'private-helper', snapshot: frozen })).toThrow(/trusted workspace profile source/);
        expect(() => resolveSubagentDispatch(stack.catalog, caller, { profileName: 'helper', snapshot: frozen })).toThrow(/trusted workspace profile source/);
        expect(() => resolveSubagentDispatch(stack.catalog, caller, { routeId: 'helper.brief', snapshot: frozen })).toThrow(/trusted workspace profile source/);
        await writeFile(external, externalMd);
        await stack.workspaceLoader.reload();
        expect(stack.registry.entries().find((entry) => entry.sourceId === 'workspace')?.contribution.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: external, code: 'agent_executor.source_not_allowed' })]));
        expect(stack.catalog.get('helper')).toBeUndefined();
        await trust.trust();
        await stack.workspaceLoader.ready;
        expect(stack.catalog.resolveSelection({ profile: 'helper' }).profile.executor).toBe('sample-acp');
        expect(resolveSubagentDispatch(stack.catalog, caller, { profileName: 'helper', snapshot: frozen }).selection.profile).toBe(frozen.resolvableProfiles?.get('helper'));
        expect(resolveSubagentDispatch(stack.catalog, caller, { profileName: 'private-helper', snapshot: frozen }).selection.profile.executor).toBe('sample-acp');
        expect(resolveSubagentDispatch(stack.catalog, caller, { routeId: 'helper.brief', snapshot: frozen }).selection.route).toBe(frozen.routes.get('helper.brief'));
      });
    });
  });

  it('keeps legacy trust preview read-only in a disposable draft catalog', async () => {
    await withFixture(async (fixture) => {
      const documents = inMemoryDocuments();
      const legacyKey = encodeLegacyWorkDirKey(fixture.workDir);
      const canonicalKey = encodeWorkDirKey(fixture.workDir);
      await documents.set('workspace-trust', legacyKey, { root: fixture.workDir, trustedAt: 1 });
      const writes = vi.spyOn(documents, 'set');
      const deletes = vi.spyOn(documents, 'delete');
      await writeAgent(join(fixture.workDir, '.kiki', 'agents'), 'helper.md', '---\nname: helper\ndescription: helper\nexecutor: sample-acp\n---\n\nhelper');
      const executors = { validateBinding: () => ({ ok: true, binding: {} }) } as unknown as IAgentExecutorRegistry;
      await withStack(fixture, { documents, executors }, async (stack) => {
        const draft = createUnscopedAgentProfileCatalog(stack.container, fixture.workDir);
        try {
          await Promise.all([draft.catalog.ready, draft.skills?.ready]);
          expect(draft.catalog.get('helper')?.executor, JSON.stringify({ entries: draft.registry.entries(), warnings: stack.warnings })).toBe('sample-acp');
          expect(writes).not.toHaveBeenCalled();
          expect(deletes).not.toHaveBeenCalled();
          if (legacyKey !== canonicalKey) expect(await documents.get('workspace-trust', canonicalKey)).toBeUndefined();
        } finally {
          draft.dispose();
        }
      });
    });
  });

  it('strictly validates route prompt composition modes', () => {
    const parse = (mode: string, body: string) =>
      parseAgentRouteFileText({
        path: '/agents/.routes/reviewer/wrapped.md',
        expectedProfile: 'reviewer',
        expectedRouteName: 'wrapped',
        text: `---\nid: reviewer.wrapped\nprofile: reviewer\ndescription: wrapped\nprompt_mode: ${mode}\n---\n\n${body}`,
      });
    expect(parse('wrap', 'before ${base_prompt} after').promptMode).toBe('wrap');
    expect(parse('wrap', 'before ${parent_prompt} after').promptMode).toBe('wrap');
    expect(() => parse('wrap', 'no base')).toThrow(/exactly once/);
    expect(() => parse('wrap', '${base_prompt} twice ${base_prompt}')).toThrow(/exactly once/);
    expect(() => parse('wrap', '${parent_prompt} and ${base_prompt}')).toThrow(/exactly once/);
    expect(() => parse('prepend', '${base_prompt}')).toThrow(/does not allow/);
    expect(() => parse('prepend', '${parent_prompt}')).toThrow(/does not allow/);
    expect(() => parse('inherit', 'not empty')).toThrow(/empty body/);
  });

  it('rejects recommended_models as an unknown route sidecar field', () => {
    expect(() =>
      parseAgentRouteFileText({
        path: '/agents/.routes/reviewer/fast.md',
        expectedProfile: 'reviewer',
        expectedRouteName: 'fast',
        text: [
          '---',
          'id: reviewer.fast',
          'profile: reviewer',
          'description: fast',
          'prompt_mode: inherit',
          'recommended_models:',
          '  - alias: other-model',
          '    when: now',
          '---',
          '',
        ].join('\n'),
      }),
    ).toThrow(/Unknown frontmatter field "recommended_models"/);
  });

  it.each(['allowed_models', 'deny_models'])(
    'rejects %s as an unknown route sidecar field',
    (field) => {
      expect(() =>
        parseAgentRouteFileText({
          path: '/agents/.routes/reviewer/fast.md',
          expectedProfile: 'reviewer',
          expectedRouteName: 'fast',
          text: [
            '---',
            'id: reviewer.fast',
            'profile: reviewer',
            'description: fast',
            'prompt_mode: inherit',
            `${field}: [fast-model]`,
            '---',
            '',
          ].join('\n'),
        }),
      ).toThrow(new RegExp(`Unknown frontmatter field "${field}"`));
    },
  );

  it('atomically patches profile and route frontmatter, preserves the body, and echoes reload', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      const profilePath = await writeAgent(
        root,
        'reviewer.md',
        [
          '---',
          'name: reviewer',
          'description: Old description',
          'tools: [Read, Bash]',
          'whenToUse: keep this field',
          '---',
          '',
          'Keep this prompt body exactly.',
          '',
        ].join('\r\n'),
      );
      const routePath = await writeAgent(
        join(root, '.routes', 'reviewer'),
        'fast.md',
        routeMd('reviewer.fast', 'reviewer', 'KEEP ROUTE BODY'),
      );
      const writes: string[] = [];
      await withStack(
        fixture,
        {
          routesEnabled: true,
          atomicTextWriter: async (path, text) => {
            writes.push(path);
            await atomicWrite(path, text);
          },
        },
        async (stack) => {
          await stack.ready();
          const result = await stack.writer.update({
            name: 'reviewer',
            scope: 'user',
            description: 'Updated description',
            modelAlias: 'provider/profile',
            routes: [{
              id: 'reviewer.fast',
              description: 'Updated route',
              modelAlias: 'provider/route',
            }],
          });

          expect(result.profile.description).toBe('Updated description');
          expect(result.profile.modelAlias).toBe('provider/profile');
          expect(result.routes).toMatchObject([{
            id: 'reviewer.fast',
            description: 'Updated route',
            modelAlias: 'provider/route',
          }]);
          expect(stack.catalog.get('reviewer')).toMatchObject({
            description: 'Updated description',
            modelAlias: 'provider/profile',
          });

          const profileText = await readFile(profilePath, 'utf8');
          expect(profileText).toContain('description: "Updated description"\r\n');
          expect(profileText).toContain('model_alias: "provider/profile"\r\n');
          expect(profileText).not.toContain('model_preference:');
          expect(profileText).toContain('tools: [Read, Bash]\r\nwhenToUse: keep this field\r\n');
          expect(profileText.endsWith('\r\nKeep this prompt body exactly.\r\n')).toBe(true);

          const routeText = await readFile(routePath, 'utf8');
          expect(routeText).toContain('description: "Updated route"\n');
          expect(routeText).toContain('model_alias: "provider/route"\n');
          expect(routeText).not.toContain('model_preference:');
          expect(routeText.endsWith('\n\nKEEP ROUTE BODY\n')).toBe(true);
          expect(writes).toEqual([profilePath, routePath]);
          expect((await readdir(root)).some((name) => name.includes('.tmp.'))).toBe(false);
          expect((await readdir(join(root, '.routes', 'reviewer'))).some((name) => name.includes('.tmp.'))).toBe(false);
        },
      );
    });
  });

  it('loads a Recipe frontmatter reference through whole Markdown save and preserves it during ordinary GUI field patches', async () => {
    await withFixture(async (fixture) => {
      const profilePath = await writeAgent(join(fixture.homeDir, 'agents'), 'reviewer.md', agentMd('reviewer', 'original'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const rawText = (await readFile(profilePath, 'utf8')).replace('description:', 'recipe: installation:example-installed-id\ndescription:');
        const saved = await stack.writer.update({ name: 'reviewer', scope: 'user', rawText });
        expect(saved.profile.recipe).toBe('installation:example-installed-id');
        const patched = await stack.writer.update({ name: 'reviewer', scope: 'user', description: 'Edited description' });
        expect(patched.profile.recipe).toBe('installation:example-installed-id');
        expect(await readFile(profilePath, 'utf8')).toContain('recipe: installation:example-installed-id');
        await stack.writer.update({ name: 'reviewer', scope: 'user', rawText: rawText.replace('installation:example-installed-id', 'off') });
        expect(await readFile(profilePath, 'utf8')).toContain('recipe: off');
      });
    });
  });

  it('patches common profile fields using parser-compatible frontmatter values', async () => {
    await withFixture(async (fixture) => {
      const profilePath = await writeAgent(
        join(fixture.homeDir, 'agents'),
        'reviewer.md',
        agentMd('reviewer', 'original'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const result = await stack.writer.update({
          name: 'reviewer',
          scope: 'user',
          whenToUse: 'Use for focused reviews',
          thinkingEffort: 'high',
          serviceTier: 'priority',
          tools: ['Read', 'Bash'],
          disallowedTools: ['Write'],
        });

        expect(result.profile).toMatchObject({
          whenToUse: 'Use for focused reviews',
          thinkingEffort: 'high',
          serviceTier: 'priority',
          tools: ['Read', 'Bash'],
          disallowedTools: ['Write'],
        });
        const text = await readFile(profilePath, 'utf8');
        expect(text).toContain('whenToUse: "Use for focused reviews"');
        expect(text).toContain('thinking_effort: "high"');
        expect(text).toContain('service_tier: "priority"');
        expect(text).toContain('tools: ["Read","Bash"]');
        expect(text).toContain('disallowedTools: ["Write"]');

        const cleared = await stack.writer.update({
          name: 'reviewer',
          scope: 'user',
          whenToUse: null,
          thinkingEffort: null,
          serviceTier: null,
          tools: null,
          disallowedTools: null,
        });
        expect(cleared.profile.whenToUse).toBeUndefined();
        expect(cleared.profile.thinkingEffort).toBeUndefined();
        expect(cleared.profile.serviceTier).toBeUndefined();
        expect(cleared.profile.tools).toBeUndefined();
        expect(cleared.profile.disallowedTools).toBeUndefined();
      });
    });
  });

  it('patches spawn constraints, reloads them and clears the mapping without changing the prompt', async () => {
    await withFixture(async (fixture) => {
      const path = await writeAgent(join(fixture.homeDir, 'agents'), 'reviewer.md', agentMd('reviewer', 'Inspect changes.'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const updated = await stack.writer.update({
          name: 'reviewer', scope: 'user', spawnConstraints: {
            allowedModels: ['provider/model'], denyModels: ['provider/unsafe'],
            allowedEfforts: ['high'], disallowedTools: ['Bash'],
          },
        });
        expect(updated.profile.spawnConstraints).toEqual({
          allowedModels: ['provider/model'], denyModels: ['provider/unsafe'],
          allowedEfforts: ['high'], disallowedTools: ['Bash'],
        });
        expect(await readFile(path, 'utf8')).toContain('spawn_constraints:');
        const before = await readFile(path, 'utf8');
        await expect(stack.writer.update({ name: 'reviewer', scope: 'user', spawnConstraints: {
          allowedModels: ['provider/model'], unexpected: ['bad'],
        } as never })).rejects.toMatchObject({ code: 'validation.failed' });
        expect(await readFile(path, 'utf8')).toBe(before);
        const cleared = await stack.writer.update({ name: 'reviewer', scope: 'user', spawnConstraints: null });
        expect(cleared.profile.spawnConstraints).toBeUndefined();
        expect(await readFile(path, 'utf8')).not.toContain('spawn_constraints:');
      });
    });
  });

  it('writes identity branches and lease preservation and clears paired model prompts without losing omitted fields', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.homeDir, 'agents'), 'lead.md', agentMd('lead', 'Lead'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const fields = { fields: { 'system.language': 'COMMON' }, main: { fields: { 'system.shared': 'MAIN' } } };
        const first = await stack.writer.update({ name: 'lead', scope: 'user', promptOverrides: fields, modelProfiles: [{ alias: 'fixture/a', promptMode: 'append', prompt: 'COMMON MODEL', main: { promptMode: 'prepend', prompt: 'MAIN MODEL' }, independent: 'off', promptOverrides: fields }], allowedSubagents: [{ name: 'explore', modelPrompts: 'replace', modelProfiles: [{ alias: 'fixture/a', promptMode: 'append', prompt: 'LEASE', promptOverrides: { fields: { 'system.shared': 'LEASE FIELD' } } }] }] });
        expect(first.profile.promptOverrides).toEqual(fields);
        expect(first.profile.modelProfiles?.[0]?.main).toEqual({ promptMode: 'prepend', prompt: 'MAIN MODEL' });
        expect(first.profile.subagentLeases?.['explore']?.modelPrompts).toBe('replace');
        const untouched = await stack.writer.update({ name: 'lead', scope: 'user', modelProfiles: [{ alias: 'fixture/a', when: 'edited' }], allowedSubagents: [{ name: 'explore', thinkingEffort: 'high' }] });
        expect(untouched.profile.modelProfiles?.[0]?.main).toEqual(first.profile.modelProfiles?.[0]?.main);
        expect(untouched.profile.subagentLeases?.['explore']?.modelPrompts).toBe('replace');
        const same = await stack.writer.update({ name: 'lead', scope: 'user', modelProfiles: [{ alias: 'fixture/a', main: null, independent: null, promptOverrides: null }] });
        expect(same.profile.modelProfiles?.[0]).toMatchObject({ prompt: 'COMMON MODEL', promptMode: 'append' });
        expect(same.profile.modelProfiles?.[0]?.main).toBeUndefined();
        expect(same.profile.modelProfiles?.[0]?.promptOverrides).toBeUndefined();
        await expect(stack.writer.update({ name: 'lead', scope: 'user', modelProfiles: [{ alias: 'fixture/a', prompt: null }] })).rejects.toMatchObject({ code: 'validation.failed' });
        const cleared = await stack.writer.update({ name: 'lead', scope: 'user', promptOverrides: null, modelProfiles: [{ alias: 'fixture/a', prompt: null, promptMode: null }], allowedSubagents: [{ name: 'explore', modelPrompts: 'preserve' }] });
        expect(cleared.profile.modelProfiles?.[0]?.prompt).toBeUndefined();
        expect(cleared.profile.modelProfiles?.[0]?.promptMode).toBeUndefined();
        expect(cleared.profile.promptOverrides).toBeUndefined();
        expect(cleared.profile.subagentLeases?.['explore']?.modelPrompts).toBe('preserve');
      });
    });
  });

  it('patches main, executor, role models, subagents and model profiles while keeping untouched lease keys', async () => {
    await withFixture(async (fixture) => {
      const original = [
        '---',
        'name: lead',
        'description: Lead',
        'allowed_subagents:',
        '  - explore',
        '  - name: worker',
        '    model_alias: fixture/a',
        '    source: ./_private/worker.md',
        'model_profiles:',
        '  - alias: fixture/a',
        '    when: long tasks',
        '    request_params: { temperature: 0.2 }',
        'tools: [Read,',
        '  Bash]',
        '---',
        '',
        'Lead body.',
        '',
      ].join('\n');
      const profilePath = await writeAgent(join(fixture.homeDir, 'agents'), 'lead.md', original);
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const result = await stack.writer.update({
          name: 'lead',
          scope: 'user',
          main: true,
          allowedModels: ['fixture/a', 'fixture/b'],
          allowedEfforts: ['high', 'max'],
          canSpawnSubagents: true,
          preferredSubagents: ['explore'],
          denySubagents: ['blocked'],
          allowedSubagents: ['worker', { name: 'explore', thinkingEffort: 'max' }, { name: 'review', modelAlias: 'fixture/b' }],
          modelProfiles: [
            { alias: 'fixture/b', when: 'short reviews', thinkingEffort: 'high' },
            { alias: 'fixture/a', when: 'very long tasks' },
          ],
          disallowedTools: ['Write'],
        });
        expect(result.profile).toMatchObject({
          main: true,
          allowedModels: ['fixture/a', 'fixture/b'],
          allowedEfforts: ['high', 'max'],
          canSpawnSubagents: true,
          preferredSubagents: ['explore'],
          denySubagents: ['blocked'],
          allowedSubagents: ['worker', 'explore', 'review'],
        });
        expect(result.profile.subagentLeases?.['explore']).toMatchObject({ thinkingEffort: 'max' });
        expect(result.profile.subagentLeases?.['review']).toMatchObject({ modelAlias: 'fixture/b' });
        expect(result.profile.modelProfiles?.map((entry) => [entry.alias, entry.when, entry.thinkingEffort]))
          .toEqual([['fixture/b', 'short reviews', 'high'], ['fixture/a', 'very long tasks', undefined]]);
        expect(result.profile.modelProfiles?.[1]?.requestParams).toEqual({ temperature: 0.2 });
        const text = await readFile(profilePath, 'utf8');
        expect(text).toContain('"source":"./_private/worker.md"');
        expect(text).toContain('main: true');
        expect(text.endsWith('\nLead body.\n')).toBe(true);

        const cleared = await stack.writer.update({
          name: 'lead', scope: 'user', main: null, allowedModels: null, allowedEfforts: null,
          canSpawnSubagents: null, preferredSubagents: null, denySubagents: null, allowedSubagents: null, modelProfiles: null,
        });
        expect(cleared.profile.main).toBeUndefined();
        expect(cleared.profile.allowedModels).toBeUndefined();
        expect(cleared.profile.allowedSubagents).toBeUndefined();
        expect(cleared.profile.preferredSubagents).toBeUndefined();
        expect(cleared.profile.denySubagents).toBeUndefined();
        expect(cleared.profile.canSpawnSubagents).toBeUndefined();
        expect(cleared.profile.modelProfiles).toBeUndefined();
        expect(cleared.profile.disallowedTools).toEqual(['Write']);
        expect(cleared.profile.tools).toEqual(['Read', 'Bash']);
      });
    });
  });

  it('keeps complete leases through GUI draft opening, reordering, writer merge and reload', async () => {
    const { fileURLToPath } = await import('node:url');
    const guiDraftModule = fileURLToPath(new URL('../../../../../apps/kiki-gui/src/components/settings/profileEditor/profileDraft.ts', import.meta.url));
    const { draftFromProfile, openAllowedSubagents, patchBody } = await import(guiDraftModule);
    const { namedAgentProfileSchema } = await import('@kiki/protocol');
    const { parseFrontmatter } = await import('#/_base/text/frontmatter');
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      const leases = [
        { name: 'research', source: './_private/research.md' },
        { name: 'leaf', can_spawn_subagents: false },
        { name: 'scoped', allowed_subagents: [], preferred_subagents: ['explore'], deny_subagents: ['worker'] },
        { name: 'guarded', deny_models: ['fixture/blocked'], tools: [], disallowed_tools: ['Bash'] },
        { name: 'pinned', model_alias: 'fixture/a', thinking_effort: 'high', model_prompts: 'replace', model_profiles: [{ alias: 'fixture/a', prompt_mode: 'append', prompt: 'LEASE MODEL PROMPT' }] },
      ];
      const authorLeases = leases.map((lease) => lease.name === 'guarded'
        ? { name: 'guarded', deny_models: ['fixture/blocked'], tools: [], disallowedTools: ['Bash'] } : lease);
      const path = await writeAgent(root, 'lead.md', `---\nname: lead\ndescription: Lead\nallowed_subagents: ${JSON.stringify([...authorLeases, 'reviewer'])}\n---\nLead body.`);
      await writeAgent(join(root, '_private'), 'research.md', '---\nname: researcher\ndescription: Research\nprivate: true\n---\nSOURCE BODY');
      const profile = namedAgentProfileSchema.parse({
        name: 'lead', description: 'Lead', main: false, source: 'user', disabled: false,
        source_file: path, workspace_id: 'fixture', routes: [], allowed_subagents: [...leases, 'reviewer'],
      });
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const baseline = draftFromProfile(profile);
        const opened: readonly { name: string }[] = openAllowedSubagents(baseline.subagentPolicy.allowedSubagents);
        for (const rows of [opened, [opened[0]!, ...opened.slice(1).toReversed()]]) {
          const patch = patchBody(profile, baseline, {
            ...baseline, subagentPolicy: { ...baseline.subagentPolicy, allowedSubagents: rows },
          });
          expect(patch.allowed_subagents).toEqual(rows.map((entry) => entry.name));
          const allowedSubagents = (patch.allowed_subagents as readonly unknown[]).map((entry) => {
            if (typeof entry !== 'string') throw new Error('Expected unchanged leases to use sparse names');
            return entry;
          });
          await stack.writer.update({ name: 'lead', scope: 'user', allowedSubagents });
          const data = parseFrontmatter(await readFile(path, 'utf8')).data;
          expect(data).toMatchObject({ allowed_subagents: ['*', ...rows.slice(1).map((entry) => authorLeases.find((lease) => lease.name === entry.name))] });
          await stack.userLoader.reload();
          await stack.ready();
          const loaded = stack.catalog.get('lead')!;
          expect(loaded.allowedSubagents).toBeUndefined();
          expect(Object.keys(loaded.subagentLeases!)).toEqual(rows.slice(1).map((entry) => entry.name));
          expect(loaded.subagentLeases!['research']).toMatchObject({ source: './_private/research.md' });
          expect(loaded.subagentLeases!['leaf']).toMatchObject({ canSpawnSubagents: false });
          expect(loaded.subagentLeases!['scoped']).toMatchObject({ allowedSubagents: [], preferredSubagents: ['explore'], denySubagents: ['worker'] });
          expect(loaded.subagentLeases!['guarded']).toMatchObject({ denyModels: ['fixture/blocked'], tools: [], disallowedTools: ['Bash'] });
          expect(loaded.subagentLeases!['pinned']).toMatchObject({ modelAlias: 'fixture/a', thinkingEffort: 'high', modelPrompts: 'replace', modelProfiles: [{ alias: 'fixture/a', prompt: 'LEASE MODEL PROMPT' }] });
        }
      });
    });
  });

  it('round-trips sparse permission edits through loading, scoped dispatch, binding and cold replay', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      await writeAgent(root, 'agent.md', agentMd('agent', 'Default'));
      await writeAgent(root, 'lead.md', agentMd('lead', 'Lead'));
      await writeAgent(join(root, '_private'), 'research.md', '---\nname: researcher\ndescription: Research\nprivate: true\nmodel_alias: mock-model\n---\nFROZEN SOURCE BODY');
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        await stack.writer.update({ name: 'lead', scope: 'user', canSpawnSubagents: true,
          preferredSubagents: ['explore'], denySubagents: ['reviewer'],
          allowedSubagents: ['*', 'research', { name: 'research', source: './_private/research.md',
            canSpawnSubagents: false, preferredSubagents: ['explore'], promptMode: 'append', prompt: 'LEASE BODY' }] });
        const updated = await stack.writer.update({ name: 'lead', scope: 'user',
          allowedSubagents: ['*', { name: 'research', description: 'Edited', preferredSubagents: null }] });
        expect(updated.profile).toMatchObject({ canSpawnSubagents: true, preferredSubagents: ['explore'], denySubagents: ['reviewer'] });
        expect(updated.profile.allowedSubagents).toBeUndefined();
        expect(updated.profile.subagentLeases?.['research']).toMatchObject({ source: './_private/research.md', canSpawnSubagents: false, prompt: 'LEASE BODY' });
        expect(updated.profile.subagentLeases?.['research']?.preferredSubagents).toBeUndefined();
        await stack.ready();
        const caller = stack.catalog.get('lead')!;
        const ctx = createTestAgent();
        try {
          await ctx.get(ISessionMetadata).registerAgent('main', { type: 'main' });
          const target = resolveSubagentTarget(stack.catalog, { ...caller, profileName: 'lead', profileDefinitionId: caller.definitionId },
            { profileName: 'research' }, ctx.get(IModelService));
          expect(target.scoped).toBe(true);
          expect(target.decision).toMatchObject({ allowed: true, recommendationStatus: 'allowed_nonpreferred' });
          expect(target.effectiveProfile.canSpawnSubagents).toBe(false);
          const svc = ctx.get(IAgentProfileService);
          await svc.bind({ resolvedProfile: target.effectiveProfile, model: 'mock-model', delegationPosition: 'sub',
            lease: target.lease, spawnPolicy: target.spawnPolicy, dispatchDecision: target.decision });
          expect(svc.data()).toMatchObject({ modelAlias: 'mock-model', canSpawnSubagents: false });
          expect(svc.data().systemPrompt).toContain('FROZEN SOURCE BODY');
          expect(svc.data().systemPrompt).toContain('LEASE BODY');
          await ctx.expectResumeMatches();
        } finally {
          await ctx.dispose();
        }
      });
    });
  });

  it('writes the boolean menu switch and preserves it through unrelated edits and menu expansion', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.homeDir, 'agents'), 'lead.md', agentMd('lead', 'Lead'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const enabled = await stack.writer.update({ name: 'lead', scope: 'user', restrictModelsToMenu: true });
        expect(enabled.profile.restrictModelsToMenu).toBe(true);
        const expanded = await stack.writer.update({ name: 'lead', scope: 'user', modelAlias: 'new-default', modelProfiles: [{ alias: 'added' }] });
        expect(expanded.profile).toMatchObject({ restrictModelsToMenu: true, modelAlias: 'new-default', modelProfiles: [{ alias: 'added' }] });
        expect((await stack.writer.update({ name: 'lead', scope: 'user', description: 'Edited' })).profile.restrictModelsToMenu).toBe(true);
        expect((await stack.writer.update({ name: 'lead', scope: 'user', restrictModelsToMenu: false })).profile.restrictModelsToMenu).toBe(false);
        await expect(stack.writer.update({ name: 'lead', scope: 'user', restrictModelsToMenu: true, rawText: agentMd('lead', 'Lead') })).rejects.toMatchObject({ code: 'validation.failed' });
        const created = await stack.writer.create({ name: 'created', scope: 'user', description: 'Created', prompt: 'body', restrictModelsToMenu: true });
        expect(created.profile.restrictModelsToMenu).toBe(true);
      });
    });
  });

  it('writes and clears soft recommendations while preserving nested advice on structured edits', async () => {
    await withFixture(async (fixture) => {
      const original = '---\nname: lead\ndescription: Lead\nspawn_constraints:\n  preferred_models: [fast]\nallowed_subagents:\n  - name: explore\n    preferred_efforts: [max]\nmodel_profiles:\n  - alias: fast\n    preferred_efforts: [max]\n---\nLead body.';
      await writeAgent(join(fixture.homeDir, 'agents'), 'lead.md', original);
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const result = await stack.writer.update({ name: 'lead', scope: 'user', preferredModels: ['fast'],
          discouragedModels: ['premium'], preferredEfforts: ['max'], spawnConstraints: { allowedModels: ['fast', 'premium'] },
          allowedSubagents: [{ name: 'explore', thinkingEffort: 'high' }], modelProfiles: [{ alias: 'fast', when: 'Small tasks' }] });
        expect(result.profile).toMatchObject({ preferredModels: ['fast'], discouragedModels: ['premium'], preferredEfforts: ['max'],
          spawnConstraints: { allowedModels: ['fast', 'premium'], preferredModels: ['fast'] },
          subagentLeases: { explore: { preferredEfforts: ['max'] } }, modelProfiles: [{ alias: 'fast', preferredEfforts: ['max'] }] });
        const cleared = await stack.writer.update({ name: 'lead', scope: 'user', preferredModels: null, discouragedModels: null, preferredEfforts: null });
        expect(cleared.profile.preferredModels).toBeUndefined();
        expect(cleared.profile.discouragedModels).toBeUndefined();
        expect(cleared.profile.preferredEfforts).toBeUndefined();
        await expect(stack.writer.update({ name: 'lead', scope: 'user', preferredModels: ['fast'], rawText: original })).rejects.toMatchObject({ code: 'validation.failed' });
      });
    });
  });

  it('rejects malformed subagent and model-profile updates before writing', async () => {
    await withFixture(async (fixture) => {
      const profilePath = await writeAgent(join(fixture.homeDir, 'agents'), 'lead.md', agentMd('lead', 'Lead'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const before = await readFile(profilePath, 'utf8');
        await expect(stack.writer.update({ name: 'lead', scope: 'user', allowedSubagents: [{ name: 'explore', modelAlias: 'one' }, { name: 'explore', modelAlias: 'two' }] }))
          .rejects.toMatchObject({ code: 'validation.failed' });
        await expect(stack.writer.update({ name: 'lead', scope: 'user', modelProfiles: [{ alias: 'has space' }] }))
          .rejects.toMatchObject({ code: 'validation.failed' });
        expect(await readFile(profilePath, 'utf8')).toBe(before);
        const updated = await stack.writer.update({ name: 'lead', scope: 'user', executor: 'grok-acp', main: true });
        expect(updated.profile).toMatchObject({ main: true, executor: 'grok-acp' });
        expect(await readFile(profilePath, 'utf8')).toContain('main: true');
      });
    });
  });

  it('creates scoped profiles without overwriting and duplicates a loaded template', async () => {
    await withFixture(async (fixture) => {
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const created = await stack.writer.create({
          name: 'new-reviewer', scope: 'user', description: 'New reviewer', main: false,
          tools: ['Read'], prompt: 'Inspect changes carefully.',
        });
        expect(created.profile).toMatchObject({ name: 'new-reviewer', description: 'New reviewer', tools: ['Read'] });
        expect(created.profile.fileDefinition?.prompt).toBe('Inspect changes carefully.');
        expect(stack.catalog.get('new-reviewer')?.name).toBe('new-reviewer');
        const underscore = await stack.writer.create({
          name: 'new_reviewer', scope: 'user', description: 'Underscore reviewer', main: false,
          prompt: 'Inspect with an underscore name.',
        });
        expect(underscore.profile.name).toBe('new_reviewer');
        const path = join(fixture.homeDir, 'agents', 'new-reviewer.md');
        expect(await readFile(path, 'utf8')).toContain('main: false');
        await expect(stack.writer.create({
          name: 'new-reviewer', scope: 'user', description: 'Overwritten', prompt: 'No.',
        })).rejects.toMatchObject({ code: AgentProfileWriteErrors.codes.PROFILE_ALREADY_EXISTS });
        await expect(stack.writer.create({
          name: '../bad', scope: 'user', description: 'Bad', prompt: 'No.',
        })).rejects.toMatchObject({ code: 'validation.failed' });
        expect(await readFile(path, 'utf8')).toContain('New reviewer');
        const unindexedPath = join(fixture.homeDir, 'agents', 'unindexed.md');
        await writeFile(unindexedPath, 'not a valid profile');
        await expect(stack.writer.create({
          name: 'unindexed', scope: 'user', description: 'No overwrite', prompt: 'No.',
        })).rejects.toMatchObject({ code: AgentProfileWriteErrors.codes.PROFILE_ALREADY_EXISTS });
        expect(await readFile(unindexedPath, 'utf8')).toBe('not a valid profile');

        const copy = await stack.writer.create({
          name: 'new-reviewer-copy', scope: 'project', template: 'duplicate:new-reviewer',
          description: 'Duplicated reviewer',
        });
        expect(copy.profile.fileDefinition?.prompt).toBe('Inspect changes carefully.');
        expect(copy.profile.description).toBe('Duplicated reviewer');
        expect(await readFile(join(fixture.workDir, '.kiki', 'agents', 'new-reviewer-copy.md'), 'utf8'))
          .toContain('tools: ["Read"]');
        const example = await stack.writer.create({
          name: 'example-reviewer', scope: 'project', template: 'reviewer',
        });
        expect(example.profile.fileDefinition?.prompt).toContain('You are the `reviewer` subagent.');
        expect(example.profile.modelAlias).toBe('inherit');
        const shippedCopy = await stack.writer.create({
          name: 'copy-explore', scope: 'project', template: 'duplicate:explore',
        });
        expect(shippedCopy.profile.fileDefinition?.prompt).toBeTruthy();
        expect(shippedCopy.profile.name).toBe('copy-explore');
      });
    });
  });

  it('updates the prompt body without changing frontmatter and rejects an invalid empty body', async () => {
    await withFixture(async (fixture) => {
      const original = '---\r\nname: body-test\r\ndescription: Body test\r\nwhenToUse: Keep this field\r\ntools: [Read]\r\n---\r\n\r\nOriginal prompt.\r\n';
      const path = await writeAgent(join(fixture.homeDir, 'agents'), 'body-test.md', original);
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const result = await stack.writer.update({ name: 'body-test', scope: 'user', prompt: 'New first line.\nNew second line.' });
        expect(result.profile.fileDefinition?.prompt).toBe('New first line.\nNew second line.');
        expect(await readFile(path, 'utf8')).toBe(original.slice(0, original.indexOf('Original prompt.')) + 'New first line.\nNew second line.\r\n');
        await expect(stack.writer.update({ name: 'body-test', scope: 'user', prompt: ' ' }))
          .rejects.toMatchObject({ code: 'validation.failed' });
        expect(stack.catalog.get('body-test')?.fileDefinition?.prompt).toBe('New first line.\nNew second line.');
      });
    });
  });

  it('replaces a profile with validated raw text and rejects mixed or invalid raw updates', async () => {
    await withFixture(async (fixture) => {
      const profilePath = await writeAgent(
        join(fixture.homeDir, 'agents'),
        'reviewer.md',
        agentMd('reviewer', 'original'),
      );
      const writes: string[] = [];
      await withStack(
        fixture,
        {
          atomicTextWriter: async (path, text) => {
            writes.push(path);
            await atomicWrite(path, text);
          },
        },
        async (stack) => {
          await stack.ready();
          const rawText = [
            '---',
            'name: reviewer',
            'description: Raw replacement',
            'thinking_effort: medium',
            'tools: [Read]',
            '---',
            '',
            'Raw prompt body.',
            '',
          ].join('\n');
          const result = await stack.writer.update({
            name: 'reviewer',
            scope: 'user',
            rawText,
          });
          expect(result.profile).toMatchObject({
            description: 'Raw replacement',
            thinkingEffort: 'medium',
            tools: ['Read'],
          });
          expect(await readFile(profilePath, 'utf8')).toBe(rawText);
          expect(writes).toEqual([profilePath]);

          await expect(stack.writer.update({
            name: 'reviewer',
            scope: 'user',
            rawText,
            description: 'mixed',
          })).rejects.toMatchObject({ code: 'validation.failed' });
          await expect(stack.writer.update({
            name: 'reviewer',
            scope: 'user',
            rawText: rawText.replace('name: reviewer', 'name: renamed'),
          })).rejects.toMatchObject({ code: 'validation.failed' });
          await expect(stack.writer.update({
            name: 'reviewer',
            scope: 'user',
            rawText: 'not frontmatter',
          })).rejects.toMatchObject({ code: 'validation.failed' });
          expect(writes).toEqual([profilePath]);
        },
      );
    });
  });

  it('routes project and extra writes through their owning loaders', async () => {
    await withFixture(async (fixture) => {
      const projectPath = await writeAgent(
        join(fixture.workDir, '.kiki', 'agents'),
        'project-profile.md',
        agentMd('project-profile', 'project original'),
      );
      const extraPath = await writeAgent(
        fixture.extraDir,
        'extra-profile.md',
        agentMd('extra-profile', 'extra original'),
      );
      await withStack(
        fixture,
        { extraAgentDirs: [fixture.extraDir] },
        async (stack) => {
          await stack.ready();
          const project = await stack.writer.update({
            name: 'project-profile',
            scope: 'project',
            description: 'project updated',
          });
          const extra = await stack.writer.update({
            name: 'extra-profile',
            scope: 'extra',
            description: 'extra updated',
          });

          expect(project.sourceId).toBe('workspace');
          expect(project.profile.description).toBe('project updated');
          expect(extra.sourceId).toBe('extra');
          expect(extra.profile.description).toBe('extra updated');
          expect(await readFile(projectPath, 'utf8')).toContain('description: "project updated"');
          expect(await readFile(extraPath, 'utf8')).toContain('description: "extra updated"');
        },
      );
    });
  });

  it('validates the whole write request before replacing any file', async () => {
    await withFixture(async (fixture) => {
      const profilePath = await writeAgent(
        join(fixture.homeDir, 'agents'),
        'reviewer.md',
        agentMd('reviewer', 'original'),
      );
      const writes: string[] = [];
      await withStack(
        fixture,
        {
          atomicTextWriter: async (path, text) => {
            writes.push(path);
            await atomicWrite(path, text);
          },
        },
        async (stack) => {
          await stack.ready();
          await expect(stack.writer.update({
            name: 'reviewer',
            scope: 'user',
            description: 'would be partial',
            routes: [{ id: 'reviewer.missing', modelAlias: 'provider/route' }],
          })).rejects.toMatchObject({ code: 'validation.failed' });
          expect(writes).toEqual([]);
          expect(await readFile(profilePath, 'utf8')).toBe(agentMd('reviewer', 'original'));
        },
      );
    });
  });

  it('rejects malformed spawn constraints and aliases, and read-only sources', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'reviewer.md',
        agentMd('reviewer', 'original'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        await expect(stack.writer.update({
          name: 'reviewer',
          scope: 'user',
          spawnConstraints: { allowedModels: [''] },
        } as never)).rejects.toMatchObject({ code: 'validation.failed' });
        await expect(stack.writer.update({
          name: 'reviewer',
          scope: 'user',
          modelAlias: 'provider / invalid',
        })).rejects.toMatchObject({ code: 'validation.failed' });
        await expect(stack.writer.update({
          name: DEFAULT_AGENT_PROFILE_NAME,
          scope: 'user',
          description: 'not allowed',
        })).rejects.toMatchObject({ code: AgentProfileWriteErrors.codes.PROFILE_NOT_FOUND });
      });
    });
  });

  it('reports an empty catalog when no agent directories exist', async () => {
    await withFixture(async (fixture) => {
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeUndefined();
        expect(() => stack.catalog.getDefault()).toThrow(/not available/);
        expect(stack.catalog.list()).toEqual([]);
      });
    });
  });

  it('recognizes the unchanged optional examples copied into a temporary user home', async () => {
    await withFixture(async (fixture) => {
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        for (const { id } of EXAMPLE_AGENT_PROFILE_TEMPLATES) {
          expect(stack.catalog.get(id), id).toBeUndefined();
        }
        for (const { fileName, text } of EXAMPLE_AGENT_PROFILE_TEMPLATES) {
          await writeAgent(join(fixture.homeDir, 'agents'), fileName, text);
        }
        await stack.userLoader.reload();
        for (const { id } of EXAMPLE_AGENT_PROFILE_TEMPLATES) {
          expect(stack.catalog.get(id)?.name, id).toBe(id);
          expect(stack.catalog.inspect(id)?.sourceId, id).toBe('user');
          expect(stack.catalog.get(id)?.modelAlias, id).toBe('inherit');
          expect(stack.catalog.get(id)?.thinkingEffort, id).toBeUndefined();
        }
        expect(stack.warnings).toEqual([]);
      });
    });
  });

  it('loads and composes a named route, replacing declared tools, disallowedTools, and subagents', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      await writeAgent(
        root,
        'reviewer.md',
        `---\nname: reviewer\ndescription: reviewer\ntools: [Read, Bash]\ndisallowedTools: [Write]\nallowed_subagents: [explore, coder]\nservice_tier: priority\nrequest_params:\n  base: true\n  service_tier: auto\n---\n\nBASE REVIEWER`,
      );
      await writeAgent(
        join(root, '.routes', 'reviewer'),
        'ui-k3.md',
        routeMd(
          'reviewer.ui-k3',
          'reviewer',
          'ROUTE OVERLAY',
          `whenToUse: UI review\nmodel_alias: route-model\nthinking_effort: high\ntools: [Read]\ndisallowedTools: [Bash]\nallowed_subagents: [explore, added]\nservice_tier: null\nrequest_params:\n  route: true\n  service_tier: flex\n`,
        ),
      );

      await withStack(fixture, { routesEnabled: true }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.listRoutes()).toMatchObject([
          {
            id: 'reviewer.ui-k3',
            profile: 'reviewer',
            modelAlias: 'route-model',
            thinkingEffort: 'high',
          },
        ]);
        const selection = stack.catalog.resolveSelection({ route: 'reviewer.ui-k3' });
        const effective = selection.profile;
        expect(effective.renderSystemPrompt({}).text).toBe('ROUTE OVERLAY\n\nBASE REVIEWER');
        expect(isToolActive(effective, 'Read')).toBe(true);
        expect(isToolActive(effective, 'Bash')).toBe(false);
        expect(isToolActive(effective, 'Write')).toBe(false);
        expect(effective.disallowedTools).toEqual(['Bash']);
        expect(effective.allowedSubagents).toEqual(['explore']);
        expect(effective.serviceTier).toBeUndefined();
        expect(effective.requestParams).toEqual({ base: true, route: true });
        expect(
          stack.warnings.some(
            (warning) =>
              warning.includes('service_tier') &&
              warning.includes('overrides request_params.service_tier'),
          ),
        ).toBe(true);
        expect(() =>
          stack.catalog.resolveSelection({ profile: 'coder', route: 'reviewer.ui-k3' }),
        ).toThrow(expect.objectContaining({ code: 'agent_profile_route.base_mismatch' }));
      });
    });
  });

  it('replaces declared route tools even when that widens the base allowlist', async () => {
    await withFixture(async (fixture) => {
      const agentsRoot = join(fixture.homeDir, 'agents');
      await writeAgent(
        agentsRoot,
        'coder.md',
        `---\nname: coder\ndescription: coder\ntools: [Read, list_agents, send_message, mcp__*]\n---\n\nCODER`,
      );
      await writeAgent(
        agentsRoot,
        'explore.md',
        `---\nname: explore\ndescription: explore\ntools: [Read]\n---\n\nEXPLORE`,
      );
      const root = join(agentsRoot, '.routes');
      await writeAgent(
        join(root, 'coder'),
        'review.md',
        routeMd(
          'coder.review',
          'coder',
          'CODER ROUTE',
          'tools: [Read, send_message, mcp__github__*]\n',
        ),
      );
      await writeAgent(
        join(root, 'explore'),
        'review.md',
        routeMd(
          'explore.review',
          'explore',
          'EXPLORE ROUTE',
          'tools: [Read, send_message, mcp__github__*]\n',
        ),
      );

      await withStack(fixture, { routesEnabled: true }, async (stack) => {
        await stack.ready();
        const coder = stack.catalog.resolveSelection({ route: 'coder.review' }).profile;
        expect(isToolActive(coder, 'Read')).toBe(true);
        expect(isToolActive(coder, 'send_message')).toBe(true);
        expect(isToolActive(coder, 'list_agents')).toBe(false);
        expect(isToolActive(coder, 'mcp__github__create_issue', 'mcp')).toBe(true);
        expect(isToolActive(coder, 'mcp__other__ping', 'mcp')).toBe(false);

        const explore = stack.catalog.resolveSelection({ route: 'explore.review' }).profile;
        expect(isToolActive(explore, 'Read')).toBe(true);
        expect(isToolActive(explore, 'send_message')).toBe(true);
        expect(isToolActive(explore, 'mcp__github__create_issue', 'mcp')).toBe(true);
      });
    });
  });

  it('reloads route creation and removal without retaining a stale catalog entry', async () => {
    await withFixture(async (fixture) => {
      const agentsRoot = join(fixture.homeDir, 'agents');
      await writeAgent(agentsRoot, 'coder.md', agentMd('coder', 'coder'));
      const routeDir = join(agentsRoot, '.routes', 'coder');
      const routePath = await writeAgent(
        routeDir,
        'temporary.md',
        routeMd('coder.temporary', 'coder', 'TEMPORARY ROUTE'),
      );
      await withStack(fixture, { routesEnabled: true }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.listRoutes().map((route) => route.id)).toContain('coder.temporary');

        await rm(routePath);
        await stack.userLoader.reload();

        expect(stack.catalog.listRoutes().map((route) => route.id)).not.toContain('coder.temporary');
        expect(() => stack.catalog.resolveSelection({ route: 'coder.temporary' })).toThrow(
          expect.objectContaining({ code: 'agent_profile_route.unknown' }),
        );
      });
    });
  });

  it('keeps route discovery flag-off and isolates invalid or missing-base sidecars', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      await writeAgent(root, 'reviewer.md', agentMd('reviewer', 'reviewer'));
      await writeAgent(
        join(root, '.routes', 'reviewer'),
        'good.md',
        routeMd('reviewer.good', 'reviewer', 'GOOD'),
      );
      await writeAgent(
        join(root, '.routes', 'reviewer'),
        'bad.md',
        routeMd('reviewer.bad', 'reviewer', 'BAD', 'unknown_field: true\n'),
      );
      await writeAgent(
        join(root, '.routes', 'missing'),
        'orphan.md',
        routeMd('missing.orphan', 'missing', 'ORPHAN'),
      );

      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        expect(stack.catalog.listRoutes()).toEqual([]);
        expect(stack.catalog.routeDiagnostics()).toEqual([]);
        expect(() => stack.catalog.resolveSelection({ route: 'reviewer.good' })).toThrow(
          expect.objectContaining({ code: 'agent_profile_route.feature_disabled' }),
        );
      });
      await withStack(fixture, { routesEnabled: true }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.listRoutes().map((route) => route.id)).toEqual(['reviewer.good']);
        expect(stack.catalog.routeDiagnostics().map((item) => item.code)).toEqual(
          expect.arrayContaining([
            'agent_profile_route.invalid_sidecar',
            'agent_profile_route.base_missing',
          ]),
        );
      });
    });
  });

  it('uses profile source precedence for route ID collisions', async () => {
    await withFixture(async (fixture) => {
      const userRoot = join(fixture.homeDir, 'agents');
      const genericUserRoot = join(fixture.osHomeDir, '.agents', 'agents');
      const workspaceRoot = join(fixture.workDir, '.kiki', 'agents');
      await writeAgent(userRoot, 'reviewer.md', agentMd('reviewer', 'reviewer'));
      await writeAgent(
        join(userRoot, '.routes', 'reviewer'),
        'shared.md',
        routeMd('reviewer.shared', 'reviewer', 'USER ROUTE'),
      );
      await writeAgent(
        join(genericUserRoot, '.routes', 'reviewer'),
        'shared.md',
        routeMd('reviewer.shared', 'reviewer', 'GENERIC USER ROUTE'),
      );
      await writeAgent(
        join(workspaceRoot, '.routes', 'reviewer'),
        'shared.md',
        routeMd('reviewer.shared', 'reviewer', 'WORKSPACE ROUTE'),
      );
      await withStack(fixture, { routesEnabled: true }, async (stack) => {
        await stack.ready();
        expect(
          stack.catalog.resolveSelection({ route: 'reviewer.shared' }).profile
            .renderSystemPrompt({}).text,
        ).toBe('WORKSPACE ROUTE\n\nYou are reviewer.');
        expect(stack.catalog.routeDiagnostics()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'agent_profile_route.duplicate' }),
          ]),
        );
      });
    });
  });

  it('merges user and workspace agents; workspace wins on name collision', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.homeDir, 'agents'), 'shared.md', agentMd('shared', 'from user'));
      await writeAgent(join(fixture.homeDir, 'agents'), 'user-only.md', agentMd('user-only', 'user agent'));
      await writeAgent(
        join(fixture.workDir, '.kiki', 'agents'),
        'shared.md',
        agentMd('shared', 'from project'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get('shared')?.description).toBe('from project');
        expect(stack.catalog.get('user-only')?.description).toBe('user agent');
        const inspection = stack.catalog.inspect('shared');
        expect(inspection?.sourceId).toBe('workspace');
        expect(inspection?.suppressed).toContainEqual({
          sourceId: 'user',
          priority: 10,
          reason: 'priority',
        });
      });
    });
  });

  it('loads user profiles from an independent runtime source instead of the persistence home', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.homeDir, 'agents'), 'isolated.md', agentMd('isolated', 'isolated'));
      await writeAgent(join(fixture.extraDir, 'agents'), 'active.md', agentMd('active', 'active GUI'));

      await withStack(
        fixture,
        { userAgentProfileHomeDir: fixture.extraDir },
        async (stack) => {
          await stack.ready();
          expect(stack.catalog.get('active')?.description).toBe('active GUI');
          expect(stack.catalog.get('isolated')).toBeUndefined();
        },
      );
    });
  });

  it('orders sources user < extra < workspace < explicit', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.homeDir, 'agents'), 'shared.md', agentMd('shared', 'from user'));
      await writeAgent(join(fixture.homeDir, 'agents'), 'user-extra.md', agentMd('user-extra', 'from user'));
      await writeAgent(fixture.extraDir, 'shared.md', agentMd('shared', 'from extra'));
      await writeAgent(fixture.extraDir, 'user-extra.md', agentMd('user-extra', 'from extra'));
      await writeAgent(
        join(fixture.workDir, '.kiki', 'agents'),
        'shared.md',
        agentMd('shared', 'from project'),
      );
      const explicitFile = await writeAgent(
        fixture.workDir,
        'explicit.md',
        agentMd('shared', 'from explicit'),
      );
      await withStack(
        fixture,
        { extraAgentDirs: [fixture.extraDir], explicitFiles: [explicitFile] },
        async (stack) => {
          await stack.ready();

          expect(stack.catalog.get('shared')?.description).toBe('from explicit');
          expect(stack.catalog.get('user-extra')?.description).toBe('from extra');
          expect(stack.catalog.inspect('shared')?.sourceId).toBe('explicit');
        },
      );
    });
  });

  it('merges plugin agents below user; user wins on name collision', async () => {
    await withFixture(async (fixture) => {
      const pluginAgentsDir = join(fixture.extraDir, 'plugin-agents');
      await writeAgent(pluginAgentsDir, 'shared.md', agentMd('shared', 'from plugin'));
      await writeAgent(pluginAgentsDir, 'plugin-only.md', agentMd('plugin-only', 'from plugin'));
      await writeAgent(join(fixture.homeDir, 'agents'), 'shared.md', agentMd('shared', 'from user'));
      await withStack(
        fixture,
        { pluginAgentRoots: [{ path: pluginAgentsDir, source: 'plugin' }] },
        async (stack) => {
          await stack.ready();

          expect(stack.catalog.get('shared')?.description).toBe('from user');
          expect(stack.catalog.get('plugin-only')?.description).toBe('from plugin');
        },
      );
    });
  });

  it('reloads the plugin loader when plugins reload', async () => {
    await withFixture(async (fixture) => {
      const pluginAgentsDir = join(fixture.extraDir, 'plugin-agents');
      await mkdir(pluginAgentsDir, { recursive: true });
      const reloadEmitter = new AsyncEmitter<PluginReloadEvent>();
      await withStack(
        fixture,
        {
          pluginAgentRoots: [{ path: pluginAgentsDir, source: 'plugin' }],
          pluginReloadEmitter: reloadEmitter,
        },
        async (stack) => {
          await stack.ready();
          expect(stack.catalog.get('late')).toBeUndefined();

          await writeAgent(pluginAgentsDir, 'late.md', agentMd('late', 'late plugin agent'));
          const changed = waitForEvent(stack.catalog.onDidChange);
          await reloadEmitter.fireAsyncConcurrent(
            { added: [], removed: [], errors: [] },
            new AbortController().signal,
          );
          await changed;

          expect(stack.catalog.get('late')?.description).toBe('late plugin agent');
        },
      );
    });
  });

  it('fails ready when an explicit agent file is invalid', async () => {
    await withFixture(async (fixture) => {
      const bad = await writeAgent(
        fixture.workDir,
        'bad.md',
        '---\nname: bad\n---\n\nbody\n',
      );
      await withStack(fixture, { explicitFiles: [bad] }, async (stack) => {
        await expect(stack.explicitLoader.ready).rejects.toThrow(/description/i);
      });
    });
  });

  it('fails ready when an explicit agent file does not exist', async () => {
    await withFixture(async (fixture) => {
      await withStack(
        fixture,
        { explicitFiles: [join(fixture.workDir, 'missing.md')] },
        async (stack) => {
          await expect(stack.explicitLoader.ready).rejects.toMatchObject({
            code: 'os.fs.not_found',
          });
        },
      );
    });
  });

  it('recovers ready after a reload fixes a previously fatal explicit file', async () => {
    await withFixture(async (fixture) => {
      const bad = await writeAgent(
        fixture.workDir,
        'bad.md',
        '---\nname: bad\n---\n\nbody\n',
      );
      await withStack(fixture, { explicitFiles: [bad] }, async (stack) => {
        await expect(stack.explicitLoader.ready).rejects.toThrow(/description/i);

        await writeFile(bad, agentMd('fixed', 'fixed agent'));
        await stack.explicitLoader.reload();

        await expect(stack.explicitLoader.ready).resolves.toBeUndefined();
        expect(stack.catalog.get('fixed')?.description).toBe('fixed agent');
      });
    });
  });

  it('surfaces request-param conflicts from explicit agent files', async () => {
    await withFixture(async (fixture) => {
      const file = await writeAgent(
        fixture.workDir,
        'explicit-warning.md',
        '---\nname: explicit-warning\ndescription: explicit warning\nservice_tier: priority\nrequest_params:\n  service_tier: flex\n  seed: 42\n---\n\nbody\n',
      );
      await withStack(fixture, { explicitFiles: [file] }, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get('explicit-warning')?.requestParams).toEqual({ seed: 42 });
        expect(
          stack.warnings.some((warning) =>
            warning.includes('overrides request_params.service_tier'),
          ),
        ).toBe(true);
      });
    });
  });

  it('loads a profile whose model_alias is excluded by its own constraints and warns', async () => {
    await withFixture(async (fixture) => {
      const file = await writeAgent(
        fixture.workDir,
        'pinned-incoherent.md',
        '---\nname: pinned-incoherent\ndescription: incoherent pin\nmodel_alias: k3-review\nallowed_models: [fast-model]\n---\n\nbody\n',
      );
      await withStack(fixture, { explicitFiles: [file] }, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get('pinned-incoherent')).toMatchObject({
          modelAlias: 'k3-review',
          allowedModels: ['fast-model'],
        });
        expect(
          stack.warnings.some((warning) => warning.includes('not in allowed_models')),
        ).toBe(true);
      });
    });
  });

  it('resolves relative explicit files against the workspace root', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, 'agents'),
        'solo.md',
        agentMd('solo', 'relative explicit'),
      );
      await withStack(fixture, { explicitFiles: ['agents/solo.md'] }, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get('solo')?.description).toBe('relative explicit');
      });
    });
  });

  it('reloads the extra loader when extraAgentDirs changes', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(fixture.extraDir, 'from-extra.md', agentMd('from-extra', 'extra agent'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('from-extra')).toBeUndefined();

        stack.config.setExtraAgentDirs([fixture.extraDir]);
        const changed = waitForEvent(stack.catalog.onDidChange);
        stack.config.fireSectionChange(EXTRA_AGENT_DIRS_SECTION);
        await changed;

        expect(stack.catalog.get('from-extra')?.description).toBe('extra agent');
      });
    });
  });

  it('skips invalid workspace files and still loads valid ones', async () => {
    await withFixture(async (fixture) => {
      const badPath = await writeAgent(
        join(fixture.workDir, '.kiki', 'agents'),
        'bad.md',
        '---\nname: bad\n---\n\nbody\n',
      );
      await writeAgent(join(fixture.workDir, '.kiki', 'agents'), 'good.md', agentMd('good', 'valid'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get('good')?.description).toBe('valid');
        expect(stack.catalog.get('bad')).toBeUndefined();
        const workspaceEntry = stack.registry.entries().find((e) => e.sourceId === 'workspace');
        expect(workspaceEntry?.contribution.skipped).toHaveLength(1);
        expect(workspaceEntry?.contribution.skipped?.[0]?.path).toBe(badPath);
      });
    });
  });

  it('lets a same-name file take over the default agent name without opting in to override', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, '.kiki', 'agents'),
        'agent.md',
        agentMd('agent', 'project default override'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.getDefault().description).toBe('project default override');
        expect(stack.catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)?.sourceId).toBe('workspace');
      });
    });
  });

  it('lets a file profile explicitly override the builtin default', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, '.kiki', 'agents'),
        'agent.md',
        agentMd('agent', 'project default override', true),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.getDefault().description).toBe('project default override');
        expect(stack.catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)?.sourceId).toBe('workspace');
      });
    });
  });

  it('resolves the default agent name by source priority regardless of the override flag', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'agent.md',
        agentMd('agent', 'user default', true),
      );
      await writeAgent(
        join(fixture.workDir, '.kiki', 'agents'),
        'agent.md',
        agentMd('agent', 'project default without override'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.getDefault().description).toBe('project default without override');
        expect(stack.catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)?.sourceId).toBe('workspace');
        expect(stack.catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)?.suppressed).toContainEqual({
          sourceId: 'user',
          priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
          reason: 'priority',
        });
      });
    });
  });

  it('warns and leaves the catalog empty when a non-fatal loader fails its first load', async () => {
    await withFixture(async (fixture) => {
      await mkdir(join(fixture.homeDir, 'agents'), { recursive: true });
      const hostFs = failingReaddirFs(new HostFileSystem(), () => true);
      await withStack(fixture, { hostFs }, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeUndefined();
        expect(stack.warnings.some((w) => w.includes('"user"') && w.includes('load failed'))).toBe(
          true,
        );
        expect(stack.registry.entries().some((e) => e.sourceId === 'user')).toBe(false);
      });
    });
  });

  it('keeps the previous contribution when a non-fatal loader reload fails', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'file-agent.md',
        agentMd('file-agent', 'from file'),
      );
      let fail = false;
      const hostFs = failingReaddirFs(new HostFileSystem(), () => fail);
      await withStack(fixture, { hostFs }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('file-agent')?.description).toBe('from file');

        fail = true;
        await stack.userLoader.reload();

        expect(stack.warnings.some((w) => w.includes('load failed'))).toBe(true);
        expect(stack.catalog.get('file-agent')?.description).toBe('from file');
        const userEntry = stack.registry.entries().find((e) => e.sourceId === 'user');
        expect(userEntry?.contribution.profiles.map((p) => p.name)).toContain('file-agent');
      });
    });
  });

  it('warns and keeps stale data when a fatal loader reload fails', async () => {
    await withFixture(async (fixture) => {
      const explicitFile = await writeAgent(
        fixture.workDir,
        'explicit.md',
        agentMd('exp-agent', 'explicit'),
      );
      await withStack(fixture, { explicitFiles: [explicitFile] }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('exp-agent')?.description).toBe('explicit');

        await rm(explicitFile, { force: true });
        void stack.explicitLoader
          .reload()
          .catch((error) =>
            stack.warnings.push(`agent profile loader "explicit" reload failed: ${String(error)}`),
          );
        await vi.waitFor(() => {
          expect(stack.warnings.some((w) => w.includes('reload failed'))).toBe(true);
        });

        expect(stack.catalog.get('exp-agent')?.description).toBe('explicit');
        const explicitEntry = stack.registry.entries().find((e) => e.sourceId === 'explicit');
        expect(explicitEntry?.contribution.profiles.map((p) => p.name)).toContain('exp-agent');
      });
    });
  });

  it('keeps the last good SYSTEM.md on YAML errors while refreshing sibling files', async () => {
    await withFixture(async (fixture) => {
      const systemPath = join(fixture.homeDir, 'SYSTEM.md');
      const siblingPath = await writeAgent(join(fixture.homeDir, 'agents'), 'sibling.md', agentMd('sibling', 'before'));
      await writeAgent(join(fixture.homeDir, 'agents', 'builtin'), 'agent.md', agentMd('agent', 'managed fallback'));
      await writeFile(systemPath, '---\nmodel_alias: pinned\ntools: []\n---\nGOOD SYSTEM');
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        await writeFile(systemPath, '---\nmodel_alias: [broken\n---\nBAD SYSTEM');
        await writeFile(siblingPath, agentMd('sibling', 'after'));
        await stack.userLoader.reload();
        expect(stack.catalog.getDefault().modelAlias).toBe('pinned');
        expect(stack.catalog.getDefault().tools).toEqual([]);
        expect(stack.catalog.getDefault().systemPrompt({})).toBe('GOOD SYSTEM');
        expect(stack.userLoader.getDefaultProfile().systemPrompt({})).toBe('GOOD SYSTEM');
        expect(stack.catalog.get('sibling')?.description).toBe('after');
        expect(stack.registry.entries().find((entry) => entry.sourceId === 'user')?.contribution.skipped).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: systemPath, code: 'agent_profile.system_invalid' })]),
        );
        expect(stack.warnings.some((warning) => warning.includes('last good') && warning.includes('SYSTEM.md'))).toBe(true);
        await writeFile(systemPath, '---\nmodel_alias: repaired\n---\nREPAIRED SYSTEM');
        await stack.userLoader.reload();
        expect(stack.catalog.getDefault().modelAlias).toBe('repaired');
        await rm(systemPath);
        await stack.userLoader.reload();
        expect(stack.catalog.getDefault().description).toBe('managed fallback');
      });
    });
  });

  it('lets ordinary user definitions shadow materialized files regardless of filename order', async () => {
    await withFixture(async (fixture) => {
      const managed = await writeAgent(join(fixture.homeDir, 'agents', 'builtin'), 'aaa.md', agentMd('general', 'managed'));
      const user = await writeAgent(join(fixture.homeDir, 'agents'), 'zzz.md', agentMd('general', 'user'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('general')?.description).toBe('user');
        expect(stack.warnings.some((warning) => warning.includes(managed) && warning.includes(user))).toBe(true);
        await rm(user);
        await stack.userLoader.reload();
        expect(stack.catalog.get('general')?.description).toBe('managed');
      });
    });
  });

  it('replaces the builtin default system prompt with user-level SYSTEM.md', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        join(fixture.homeDir, 'SYSTEM.md'),
        '---\nname: agent\ndescription: Custom main agent\n---\nYou are a custom main agent. cwd=${cwd} unknown=${nope}',
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        const prompt = stack.catalog.getDefault().systemPrompt({ cwd: '/work/dir' });
        expect(prompt).toContain('You are a custom main agent.');
        expect(prompt).toContain('cwd=/work/dir');
        expect(prompt).toContain('unknown=${nope}');
      });
    });
  });

  it('inherits the default system prompt and appends operator instructions from profile frontmatter', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        join(fixture.homeDir, 'SYSTEM.md'),
        [
          '---',
          'system_prompt_mode: append',
          '---',
          '',
          'OPERATOR cwd=${cwd}',
          '${plugin_sections}',
          '${delegation_context}',
          'unknown=${operator_token}',
        ].join('\n'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        const profile = stack.catalog.getDefault();
        const prompt = profile.systemPrompt({
          cwd: '/work/dir',
          pluginSections: 'PLUGIN_A',
        });
        expect(profile.systemPromptMode).toBe('append');
        expect(prompt).toContain('You are Kiki');
        expect(prompt.indexOf('You are Kiki')).toBeLessThan(prompt.indexOf('OPERATOR cwd=/work/dir'));
        expect(prompt).toContain('# Plugin Instructions');
        expect(prompt).toContain('PLUGIN_A');
        expect(prompt).toContain('${delegation_context}');
        expect(prompt).toContain('unknown=${operator_token}');
      });
    });
  });

  it('inherits the default system prompt and prepends operator instructions from profile frontmatter', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        join(fixture.homeDir, 'SYSTEM.md'),
        ['---', 'system_prompt_mode: prepend', '---', '', 'OPERATOR FIRST'].join('\n'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        const prompt = stack.catalog.getDefault().systemPrompt({});
        expect(prompt.startsWith('OPERATOR FIRST')).toBe(true);
        expect(prompt).toContain('You are Kiki');
      });
    });
  });


  it('rejects an invalid system prompt composition mode', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        join(fixture.homeDir, 'SYSTEM.md'),
        ['---', 'system_prompt_mode: merge', '---', '', 'OPERATOR'].join('\n'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(() => stack.catalog.getDefault()).toThrow(/not available/);
        expect(stack.warnings.some((warning) =>
          warning.includes('system_prompt_mode') &&
          warning.includes('replace, prepend, append, or inherit')
        )).toBe(true);
      });
    });
  });

  it('lets SYSTEM.md win over a same-name scanned user agent file', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'agent.md',
        agentMd('agent', 'user agents dir default', true),
      );
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), '---\nname: agent\ndescription: System default\n---\nsystem md prompt');
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        const defaultProfile = stack.catalog.getDefault();
        expect(defaultProfile.systemPrompt({})).toContain('system md prompt');
        expect(defaultProfile.systemPrompt({})).not.toContain('You are agent.');
      });
    });
  });

  it('lets a same-name workspace agent file win over user-level SYSTEM.md', async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), '---\nname: agent\ndescription: System default\n---\nsystem md prompt');
      await writeAgent(
        join(fixture.workDir, '.kiki', 'agents'),
        'agent.md',
        agentMd('agent', 'project default override', true),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.getDefault().description).toBe('project default override');
        expect(stack.catalog.getDefault().systemPrompt({})).not.toContain('system md prompt');
      });
    });
  });

  it('lets an explicit agent file win over user-level SYSTEM.md', async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), '---\nname: agent\ndescription: System default\n---\nsystem md prompt');
      const explicitFile = await writeAgent(
        fixture.workDir,
        'explicit.md',
        agentMd('agent', 'explicit default override', true),
      );
      await withStack(fixture, { explicitFiles: [explicitFile] }, async (stack) => {
        await stack.ready();

        expect(stack.catalog.getDefault().description).toBe('explicit default override');
        expect(stack.catalog.getDefault().systemPrompt({})).not.toContain('system md prompt');
      });
    });
  });

  it('rescans the user source when a user agent file changes on disk', async () => {
    await withFixture(async (fixture) => {
      await mkdir(join(fixture.homeDir, 'agents'), { recursive: true });
      await withStack(fixture, { fsWatch: new HostFsWatchService() }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('watched-user-agent')).toBeUndefined();

        const refreshed = new Promise<string>((resolvePromise) => {
          const d = stack.catalog.onDidChange((sourceId) => {
            if (sourceId !== 'user') return;
            d.dispose();
            resolvePromise(sourceId);
          });
        });
        const timedOut = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('watch-driven refresh timed out')), 10000);
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await writeAgent(
          join(fixture.homeDir, 'agents'),
          'watched-user-agent.md',
          agentMd('watched-user-agent', 'from user watch'),
        );

        await expect(Promise.race([refreshed, timedOut])).resolves.toBe('user');
        expect(stack.catalog.get('watched-user-agent')?.description).toBe('from user watch');
      });
    });
  }, 15000);

  it('rescans the extra source when a configured agent file changes on disk', async () => {
    await withFixture(async (fixture) => {
      await withStack(
        fixture,
        { extraAgentDirs: [fixture.extraDir], fsWatch: new HostFsWatchService() },
        async (stack) => {
          await stack.ready();
          expect(stack.catalog.get('watched-extra-agent')).toBeUndefined();

          const refreshed = new Promise<string>((resolvePromise) => {
            const d = stack.catalog.onDidChange((sourceId) => {
              if (sourceId !== 'extra') return;
              d.dispose();
              resolvePromise(sourceId);
            });
          });
          const timedOut = new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('watch-driven refresh timed out')), 10000);
          });
          await new Promise((resolve) => setTimeout(resolve, 300));
          await writeAgent(
            fixture.extraDir,
            'watched-extra-agent.md',
            agentMd('watched-extra-agent', 'from extra watch'),
          );

          await expect(Promise.race([refreshed, timedOut])).resolves.toBe('extra');
          expect(stack.catalog.get('watched-extra-agent')?.description).toBe('from extra watch');
        },
      );
    });
  }, 15000);

  it('rescans the workspace source when a project agent file changes on disk', async () => {
    await withFixture(async (fixture) => {
      await mkdir(join(fixture.workDir, '.kiki', 'agents'), { recursive: true });
      await withStack(fixture, { fsWatch: new HostFsWatchService() }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('watched-agent')).toBeUndefined();

        const refreshed = new Promise<string>((resolvePromise) => {
          const d = stack.catalog.onDidChange((sourceId) => {
            if (sourceId !== 'workspace') return;
            d.dispose();
            resolvePromise(sourceId);
          });
        });
        const timedOut = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('watch-driven refresh timed out')), 10000);
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await writeAgent(
          join(fixture.workDir, '.kiki', 'agents'),
          'watched-agent.md',
          agentMd('watched-agent', 'from watch'),
        );

        await expect(Promise.race([refreshed, timedOut])).resolves.toBe('workspace');
        expect(stack.catalog.get('watched-agent')?.description).toBe('from watch');
      });
    });
  }, 15000);

  it('lands every loader’s provided record in the registry entries', async () => {
    await withFixture(async (fixture) => {
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        const bySourceId = new Map(stack.registry.entries().map((entry) => [entry.sourceId, entry]));
        expect([...bySourceId.keys()].toSorted()).toEqual([
          'explicit',
          'extra',
          'inherited',
          'plugin',
          'user',
          'workspace',
        ]);
        for (const sourceId of ['explicit', 'extra', 'inherited', 'plugin', 'user', 'workspace'] as const) {
          expect(bySourceId.get(sourceId)?.workspaceKey).toBe('wd_test');
          expect(bySourceId.get(sourceId)?.priority).toBe(AGENT_PROFILE_SOURCE_PRIORITY[sourceId]);
        }
      });
    });
  });

  it('disposes user, extra, and workspace watch handles with the loader scope', async () => {
    await withFixture(async (fixture) => {
      const watch = recordingFsWatchStub();
      const stack = makeStack(fixture, {
        extraAgentDirs: [fixture.extraDir],
        fsWatch: watch.service,
      });
      try {
        await stack.ready();
        expect(watch.handles.length).toBeGreaterThanOrEqual(4);
        expect(watch.handles.some((handle) => handle.disposed)).toBe(false);
      } finally {
        stack.dispose();
      }

      expect(watch.handles.every((handle) => handle.disposed)).toBe(true);
    });
  });

  it('does not recanonicalize a contribution root while resolving one source binding', async () => {
    await withFixture(async (fixture) => {
      const agentsDir = join(fixture.homeDir, 'agents');
      await mkdir(agentsDir, { recursive: true });
      const root = (await realpath(agentsDir)).replaceAll('\\', '/');
      const privateDir = join(root, '_private');
      await mkdir(privateDir, { recursive: true });
      await writeFile(
        join(privateDir, 'writer.md'),
        privateAgentMd('writer', 'private writer'),
      );
      const parent: AgentFileDefinition = {
        name: 'parent',
        definitionId: join(root, 'parent.md'),
        contributionRoot: root,
        private: false,
        description: 'parent',
        override: false,
        allowedSubagents: undefined,
        subagentLeases: {
          writer: {
            name: 'writer',
            source: './_private/writer.md',
          },
        },
        prompt: 'parent',
        path: join(root, 'parent.md'),
        source: 'user',
      };
      const base = new HostFileSystem();
      let rootRealpathCalls = 0;
      const hostFs = new Proxy(base, {
        get(target, property) {
          if (property === 'realpath') {
            return async (path: string) => {
              if (path === root) {
                rootRealpathCalls += 1;
                throw new Error('contribution root disappeared');
              }
              return target.realpath(path);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const graph = await resolveAgentSourceGraph(hostFs, [parent]);

      expect(rootRealpathCalls).toBe(0);
      expect(graph.scopedBindings.get(parent.definitionId)?.get('writer')?.status).toBe('ready');
    });
  });

  it('withdraws a loader’s record (and re-projects the catalog) when the loader is disposed', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'user-only.md',
        agentMd('user-only', 'user agent'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('user-only')).toBeDefined();

        (stack.userLoader as unknown as { dispose(): void }).dispose();

        expect(stack.registry.entries().some((entry) => entry.sourceId === 'user')).toBe(false);
        expect(stack.catalog.get('user-only')).toBeUndefined();
        expect(stack.catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeUndefined();
      });
    });
  });

  it('hides private profiles from listings while preserving named and frozen resolution', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      const profilePath = await writeAgent(root, 'm3-worker.md', agentMd('m3-worker', 'public worker'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const frozen = stack.catalog.snapshot();
        const caller = { profileName: 'tester', allowedSubagents: ['m3-worker'] };
        expect(stack.catalog.list().map((profile) => profile.name)).toContain('m3-worker');

        await writeFile(profilePath, privateAgentMd('m3-worker', 'private worker'));
        await stack.userLoader.reload();

        expect(stack.catalog.get('m3-worker')).toMatchObject({
          description: 'private worker',
          private: true,
        });
        expect(stack.catalog.resolveSelection({ profile: 'm3-worker' }).profile.name).toBe('m3-worker');
        expect(() => resolveSubagentDispatch(stack.catalog, caller, { profileName: 'm3-worker' }))
          .toThrow(/private and cannot be dispatched/);
        expect(stack.catalog.list().map((profile) => profile.name)).not.toContain('m3-worker');
        expect(stack.catalog.snapshot().publicProfiles.has('m3-worker')).toBe(false);

        await writeFile(profilePath, 'invalid frontmatter');
        await stack.userLoader.reload();

        expect(stack.catalog.get('m3-worker')?.description).toBe('private worker');
        expect(stack.catalog.list().map((profile) => profile.name)).not.toContain('m3-worker');
        expect(
          stack.warnings.some(
            (warning) => warning.includes('last good profile') && warning.includes('m3-worker'),
          ),
        ).toBe(true);

        await rm(profilePath);
        await stack.userLoader.reload();

        expect(stack.catalog.get('m3-worker')).toBeUndefined();
        expect(() => stack.catalog.list()).not.toThrow();
        expect(() => resolveSubagentDispatch(stack.catalog, caller, {
          profileName: 'm3-worker',
          snapshot: frozen,
        })).toThrow(/Unknown agent profile/);
      });
    });
  });

  it('warns once per unchanged duplicate across profile reloads and warns again if it reappears', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      await writeAgent(join(root, 'based_on_model'), 'example.md', agentMd('example', 'older'));
      const duplicate = await writeAgent(root, 'example.md', agentMd('example', 'newer'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const warnings = () => stack.warnings.filter((message) => message.includes('Duplicate agent profile "example"'));
        expect(warnings()).toHaveLength(1);
        await stack.userLoader.reload();
        await stack.userLoader.reload();
        expect(warnings()).toHaveLength(1);
        await rm(duplicate);
        await stack.userLoader.reload();
        await writeAgent(root, 'example.md', agentMd('example', 'returned'));
        await stack.userLoader.reload();
        expect(warnings()).toHaveLength(2);
      });
    });
  });

  it('keeps private aliases scoped to each winning parent while wildcard remains public-only', async () => {
    await withFixture(async (fixture) => {
      const userRoot = join(fixture.homeDir, 'agents');
      const workspaceRoot = join(fixture.workDir, '.kiki', 'agents');
      await writeAgent(userRoot, 'user-team.md', sourceParentMd('user-team', 'writer', './_private/writer.md', '    model_alias: user-model\n'));
      await writeAgent(join(userRoot, '_private'), 'writer.md', agentMd('shared-child-name', 'user writer'));
      await writeAgent(workspaceRoot, 'workspace-team.md', sourceParentMd('workspace-team', 'writer', './_private/writer.md', '    model_alias: workspace-model\n'));
      await writeAgent(join(workspaceRoot, '_private'), 'writer.md', agentMd('shared-child-name', 'workspace writer'));
      await writeAgent(userRoot, 'public-helper.md', agentMd('public-helper', 'public helper'));

      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const snapshot = stack.catalog.snapshot();
        const userParent = stack.catalog.get('user-team')!;
        const workspaceParent = stack.catalog.get('workspace-team')!;
        const userWriter = stack.catalog.getScopedBinding(userParent.definitionId, 'writer')!;
        const workspaceWriter = stack.catalog.getScopedBinding(workspaceParent.definitionId, 'writer')!;

        expect(stack.catalog.list().map((profile) => profile.name)).toContain('public-helper');
        expect(stack.catalog.get('writer')).toBeUndefined();
        expect(stack.catalog.get('shared-child-name')).toBeUndefined();
        expect(userWriter.profile?.description).toBe('user writer');
        expect(workspaceWriter.profile?.description).toBe('workspace writer');
        expect(userWriter.lease.modelAlias).toBe('user-model');
        expect(workspaceWriter.lease.modelAlias).toBe('workspace-model');
        expect(snapshot.scopedBindings.get(userParent.definitionId!)?.has('writer')).toBe(true);
        expect(snapshot.scopedBindings.get(workspaceParent.definitionId!)?.has('writer')).toBe(true);
        expect(stack.catalog.getScopedBinding(stack.catalog.get('public-helper')?.definitionId, 'writer')).toBeUndefined();
      });
    });
  });

  it('switches the entire private graph when a workspace profile overrides a user profile', async () => {
    await withFixture(async (fixture) => {
      const userRoot = join(fixture.homeDir, 'agents');
      const workspaceRoot = join(fixture.workDir, '.kiki', 'agents');
      await writeAgent(userRoot, 'team.md', sourceParentMd('team', 'user-writer', './_private/user-writer.md'));
      await writeAgent(join(userRoot, '_private'), 'user-writer.md', privateAgentMd('writer', 'user writer'));
      await writeAgent(workspaceRoot, 'team.md', sourceParentMd('team', 'workspace-writer', './_private/workspace-writer.md'));
      await writeAgent(join(workspaceRoot, '_private'), 'workspace-writer.md', privateAgentMd('writer', 'workspace writer'));

      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const winner = stack.catalog.get('team')!;
        expect(winner.description).toBe('team');
        expect(stack.catalog.getScopedBinding(winner.definitionId, 'workspace-writer')?.status).toBe('ready');
        expect(stack.catalog.getScopedBinding(winner.definitionId, 'user-writer')).toBeUndefined();
        expect(
          [...stack.catalog.snapshot().scopedBindings.keys()].some((definitionId) =>
            definitionId.includes('user-writer.md'),
          ),
        ).toBe(false);
      });
    });
  });

  it('fails closed for missing, invalid, non-private, forbidden, renamed, and orphaned source files', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.workDir, '.kiki', 'agents');
      const parentPath = await writeAgent(root, 'team.md', sourceParentMd('team', 'writer', './_private/writer.md'));
      const childPath = await writeAgent(join(root, '_private'), 'writer.md', 'not yaml');
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        let parent = stack.catalog.get('team')!;
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer')?.status).toBe('unavailable');
        expect(stack.catalog.get('writer')).toBeUndefined();

        await writeFile(childPath, agentMd('writer', 'valid private by path'));
        await stack.workspaceLoader.reload();
        parent = stack.catalog.get('team')!;
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer')?.status).toBe('ready');

        await rename(childPath, join(root, '_private', 'renamed.md'));
        await stack.workspaceLoader.reload();
        parent = stack.catalog.get('team')!;
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer')?.status).toBe('unavailable');
        expect(stack.catalog.get('writer')).toBeUndefined();

        await writeFile(parentPath, 'invalid parent');
        await stack.workspaceLoader.reload();
        expect(stack.catalog.get('team')).toBe(parent);
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer')?.status).toBe('unavailable');
        expect(stack.catalog.get('writer')).toBeUndefined();
      });

      await writeAgent(root, 'outside.md', sourceParentMd('outside', 'writer', './writer.md'));
      await writeAgent(root, 'writer.md', agentMd('writer', 'public writer'));
      await writeAgent(root, 'forbidden.md', sourceParentMd('forbidden', 'writer', './_private/forbidden-writer.md'));
      await writeAgent(join(root, '_private'), 'forbidden-writer.md', privateAgentMd('writer', 'forbidden', 'main: true\n'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        expect(stack.catalog.getScopedBinding(stack.catalog.get('outside')?.definitionId, 'writer')?.status).toBe('unavailable');
        expect(stack.catalog.getScopedBinding(stack.catalog.get('forbidden')?.definitionId, 'writer')?.status).toBe('unavailable');
        expect(stack.catalog.diagnostics().map((diagnostic) => diagnostic.code)).toEqual(
          expect.arrayContaining(['agent_profile_source.not_private', 'agent_profile_source.invalid_profile']),
        );
      });
    });
  });

  it('rejects lexical and symlink escapes and deduplicates repeated canonical sources', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.workDir, '.kiki', 'agents');
      const outside = await writeAgent(fixture.workDir, 'outside-writer.md', privateAgentMd('writer', 'outside'));
      await writeAgent(root, 'escape.md', sourceParentMd('escape', 'writer', '../../outside-writer.md'));
      await writeAgent(root, 'repeat.md', `---\nname: repeat\ndescription: repeat\nallowed_subagents:\n  - name: writer-a\n    source: ./_private/writer.md\n    model_alias: model-a\n  - name: writer-b\n    source: ./_private/writer.md\n    model_alias: model-b\n---\n\nrepeat\n`);
      await writeAgent(root, 'repeat-two.md', sourceParentMd('repeat-two', 'writer', './_private/writer.md', '    model_alias: model-c\n'));
      await writeAgent(join(root, '_private'), 'writer.md', privateAgentMd('writer', 'shared'));
      await mkdir(join(root, '_private'), { recursive: true });
      const linkPath = join(root, '_private', 'linked.md');
      try {
        await symlink(outside, linkPath, 'file');
      } catch {}
      if (await readFile(linkPath, 'utf8').catch(() => undefined)) {
        await writeAgent(root, 'symlink-parent.md', sourceParentMd('symlink-parent', 'linked', './_private/linked.md'));
      }

      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const repeat = stack.catalog.get('repeat')!;
        const repeatTwo = stack.catalog.get('repeat-two')!;
        const snapshot = stack.catalog.snapshot();
        expect(stack.catalog.getScopedBinding(repeat.definitionId, 'writer-a')?.lease.modelAlias).toBe('model-a');
        expect(stack.catalog.getScopedBinding(repeat.definitionId, 'writer-b')?.lease.modelAlias).toBe('model-b');
        expect(stack.catalog.getScopedBinding(repeatTwo.definitionId, 'writer')?.lease.modelAlias).toBe('model-c');
        expect(snapshot.sourceDefinitions.size).toBe(1);
        expect(stack.catalog.getScopedBinding(stack.catalog.get('escape')?.definitionId, 'writer')?.status).toBe('unavailable');
        if (stack.catalog.get('symlink-parent') !== undefined) {
          expect(stack.catalog.getScopedBinding(stack.catalog.get('symlink-parent')?.definitionId, 'linked')?.status).toBe('unavailable');
        }
      });
    });
  });

  it('detects source cycles and depth beyond eight edges', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      const privateRoot = join(root, '_private');
      await writeAgent(root, 'cycle-parent.md', sourceParentMd('cycle-parent', 'a', './_private/a.md'));
      await writeAgent(privateRoot, 'a.md', sourceParentMd('a', 'b', './b.md', '', 'private: true\n'));
      await writeAgent(privateRoot, 'b.md', sourceParentMd('b', 'a', './a.md', '', 'private: true\n'));
      await writeAgent(root, 'deep-parent.md', sourceParentMd('deep-parent', 'level-1', './_private/level-1.md'));
      for (let level = 1; level <= 9; level += 1) {
        const next = level === 9 ? '' : `allowed_subagents:\n  - name: level-${String(level + 1)}\n    source: ./level-${String(level + 1)}.md\n`;
        await writeAgent(privateRoot, `level-${String(level)}.md`, `---\nname: level-${String(level)}\ndescription: level ${String(level)}\nprivate: true\n${next}---\n\nlevel ${String(level)}\n`);
      }

      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        expect(stack.catalog.diagnostics().map((diagnostic) => diagnostic.code)).toEqual(
          expect.arrayContaining(['agent_profile_source.cycle', 'agent_profile_source.depth_exceeded']),
        );
      });
    });
  });

  it('atomically refreshes a private child while an older snapshot keeps the prior definition', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.workDir, '.kiki', 'agents');
      await writeAgent(root, 'team.md', sourceParentMd('team', 'writer', './_private/writer.md'));
      const childPath = await writeAgent(join(root, '_private'), 'writer.md', privateAgentMd('writer', 'before'));
      await withStack(fixture, { fsWatch: new HostFsWatchService() }, async (stack) => {
        await stack.ready();
        const parent = stack.catalog.get('team')!;
        const previous = stack.catalog.snapshot();
        const refreshed = waitForEvent(stack.catalog.onDidChange);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await writeFile(childPath, privateAgentMd('writer', 'after'));
        await Promise.race([
          refreshed,
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('private refresh timed out')), 10000)),
        ]);
        expect(previous.scopedBindings.get(parent.definitionId!)?.get('writer')?.profile?.description).toBe('before');
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer')?.profile?.description).toBe('after');
      });
    });
  }, 15000);

  it('resolves private:true sources after moving an intact bundle to a new contribution root', async () => {
    await withFixture(async (fixture) => {
      const firstRoot = join(fixture.extraDir, 'bundle-a');
      const secondRoot = join(fixture.extraDir, 'bundle-b');
      await writeAgent(firstRoot, 'team.md', sourceParentMd('team', 'writer', './writer.md'));
      await writeAgent(firstRoot, 'writer.md', privateAgentMd('writer', 'portable writer'));
      await withStack(fixture, { extraAgentDirs: [firstRoot] }, async (stack) => {
        await stack.ready();
        const parent = stack.catalog.get('team')!;
        expect(stack.catalog.get('writer')?.description).toBe('portable writer');
        expect(stack.catalog.list().map((profile) => profile.name)).not.toContain('writer');
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer')?.profile?.description).toBe('portable writer');
      });

      await rename(firstRoot, secondRoot);
      await withStack(fixture, { extraAgentDirs: [secondRoot] }, async (stack) => {
        await stack.ready();
        const parent = stack.catalog.get('team')!;
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer')?.status).toBe('ready');
      });
    });
  });

  it.runIf(process.platform === 'win32')('deduplicates source paths across Windows casing', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.workDir, '.kiki', 'agents');
      await writeAgent(root, 'team.md', `---\nname: team\ndescription: team\nallowed_subagents:\n  - name: writer-lower\n    source: ./_private/writer.md\n  - name: writer-upper\n    source: ./_PRIVATE/WRITER.md\n---\n\nteam\n`);
      await writeAgent(join(root, '_Private'), 'writer.md', agentMd('writer', 'writer'));
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        const parent = stack.catalog.get('team')!;
        expect(stack.catalog.get('writer')).toBeUndefined();
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer-lower')?.status).toBe('ready');
        expect(stack.catalog.getScopedBinding(parent.definitionId, 'writer-upper')?.status).toBe('ready');
        expect(stack.catalog.snapshot().sourceDefinitions.size).toBe(1);
      });
    });
  });

  it('keeps private files unavailable by name while explicit file loading remains an escape hatch', async () => {
    await withFixture(async (fixture) => {
      const privatePath = await writeAgent(
        join(fixture.homeDir, 'agents', '_private'),
        'detached.md',
        privateAgentMd('detached', 'detached private'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('detached')).toBeUndefined();
      });
      await withStack(fixture, { explicitFiles: [privatePath] }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('detached')?.description).toBe('detached private');
      });
    });
  });
});

describe('agent profile space inheritance', () => {
  function spaceHome(baseHomeDir: string, overrides: Partial<SpaceHome['inherit']> = {}): SpaceHome {
    return {
      id: 'h-b2test',
      name: 'B2 Space',
      baseHomeDir,
      inherit: {
        config: true,
        credentials: 'shared',
        agents: true,
        instructions: true,
        skills: true,
        mcp: true,
        appearance: true,
        plugins: false,
        genericRoots: true,
        ...overrides,
      },
    };
  }

  function baseHomeOf(fixture: Fixture): string {
    return join(dirname(fixture.homeDir), 'main-home');
  }

  it('registers base-home profiles as the inherited source and lets a space profile win same names', async () => {
    await withFixture(async (fixture) => {
      const baseHome = baseHomeOf(fixture);
      await writeAgent(join(baseHome, 'agents'), 'base-only.md', agentMd('base-only', 'base only'));
      await writeAgent(join(baseHome, 'agents'), 'shared.md', agentMd('shared', 'base shared'));
      await writeAgent(join(fixture.homeDir, 'agents'), 'shared.md', agentMd('shared', 'space shared'));

      await withStack(
        fixture,
        { space: { baseHomeDir: baseHome, space: spaceHome(baseHome) } },
        async (stack) => {
          await stack.ready();

          expect(stack.catalog.get('shared')?.description).toBe('space shared');
          expect(stack.catalog.inspect('shared')?.sourceId).toBe('user');

          const inherited = stack.catalog.inspect('base-only');
          expect(inherited?.sourceId).toBe('inherited');
          expect(inherited?.profile.description).toBe('base only');
          const sourcePath = inherited?.profile.sourcePath;
          expect(sourcePath?.replaceAll('\\', '/').endsWith('/main-home/agents/base-only.md')).toBe(true);

          const inheritedEntry = stack.registry.entries().find((entry) => entry.sourceId === 'inherited');
          expect(inheritedEntry?.priority).toBe(AGENT_PROFILE_SOURCE_PRIORITY.inherited);
        },
      );
    });
  });

  it('lets an inherited profile win over a same-name plugin profile', async () => {
    await withFixture(async (fixture) => {
      const baseHome = baseHomeOf(fixture);
      const pluginAgentsDir = join(fixture.extraDir, 'plugin-agents');
      await writeAgent(pluginAgentsDir, 'collision.md', agentMd('collision', 'from plugin'));
      await writeAgent(join(baseHome, 'agents'), 'collision.md', agentMd('collision', 'from base'));

      await withStack(
        fixture,
        {
          pluginAgentRoots: [{ path: pluginAgentsDir, source: 'plugin' }],
          space: { baseHomeDir: baseHome, space: spaceHome(baseHome) },
        },
        async (stack) => {
          await stack.ready();

          expect(stack.catalog.get('collision')?.description).toBe('from base');
          expect(stack.catalog.inspect('collision')?.sourceId).toBe('inherited');
          expect(stack.catalog.inspect('collision')?.suppressed).toContainEqual(
            expect.objectContaining({ sourceId: 'plugin' }),
          );
        },
      );
    });
  });

  it('falls back to the base home SYSTEM.md for the default profile', async () => {
    await withFixture(async (fixture) => {
      const baseHome = baseHomeOf(fixture);
      await mkdir(baseHome, { recursive: true });
      await writeFile(
        join(baseHome, 'SYSTEM.md'),
        '---\nname: agent\ndescription: Base system\n---\nBASE SYSTEM PROMPT',
      );

      await withStack(
        fixture,
        { space: { baseHomeDir: baseHome, space: spaceHome(baseHome) } },
        async (stack) => {
          await stack.ready();
          expect(stack.catalog.getDefault().description).toBe('Base system');
          expect(stack.catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)?.sourceId).toBe('inherited');
          expect(stack.catalog.getDefault().systemPrompt({})).toContain('BASE SYSTEM PROMPT');
        },
      );
    });
  });

  it('lets the space SYSTEM.md replace the base home one', async () => {
    await withFixture(async (fixture) => {
      const baseHome = baseHomeOf(fixture);
      await mkdir(baseHome, { recursive: true });
      await writeFile(
        join(baseHome, 'SYSTEM.md'),
        '---\nname: agent\ndescription: Base system\n---\nBASE SYSTEM PROMPT',
      );
      await writeFile(
        join(fixture.homeDir, 'SYSTEM.md'),
        '---\nname: agent\ndescription: Space system\n---\nSPACE SYSTEM PROMPT',
      );

      await withStack(
        fixture,
        { space: { baseHomeDir: baseHome, space: spaceHome(baseHome) } },
        async (stack) => {
          await stack.ready();
          expect(stack.catalog.getDefault().description).toBe('Space system');
          expect(stack.catalog.getDefault().systemPrompt({})).toContain('SPACE SYSTEM PROMPT');
          expect(stack.catalog.getDefault().systemPrompt({})).not.toContain('BASE SYSTEM PROMPT');
        },
      );
    });
  });

  it('ignores the base home when inherit.agents is false', async () => {
    await withFixture(async (fixture) => {
      const baseHome = baseHomeOf(fixture);
      await writeAgent(join(baseHome, 'agents'), 'base-only.md', agentMd('base-only', 'base only'));
      await writeFile(
        join(baseHome, 'SYSTEM.md'),
        '---\nname: agent\ndescription: Base system\n---\nBASE SYSTEM PROMPT',
      );

      await withStack(
        fixture,
        {
          space: {
            baseHomeDir: baseHome,
            space: spaceHome(baseHome, { agents: false }),
          },
        },
        async (stack) => {
          await stack.ready();
          expect(stack.catalog.get('base-only')).toBeUndefined();
          expect(stack.registry.entries().some((entry) => entry.sourceId === 'inherited')).toBe(true);
          expect(
            stack.registry
              .entries()
              .find((entry) => entry.sourceId === 'inherited')?.contribution.profiles,
          ).toEqual([]);
          expect(() => stack.catalog.getDefault()).toThrow(/not available/);
        },
      );
    });
  });

  it('hides the OS-home generic root when inherit.generic_roots is false', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.osHomeDir, '.agents/agents'), 'generic.md', agentMd('generic', 'generic root'));

      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('generic')?.description).toBe('generic root');
      });

      const baseHome = baseHomeOf(fixture);
      await mkdir(baseHome, { recursive: true });
      await withStack(
        fixture,
        {
          space: {
            baseHomeDir: baseHome,
            space: spaceHome(baseHome, { genericRoots: false }),
          },
        },
        async (stack) => {
          await stack.ready();
          expect(stack.catalog.get('generic')).toBeUndefined();
        },
      );
    });
  });
});
