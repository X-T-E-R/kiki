/**
 * Scenario: agent-profile loaders + session catalog — the Contribution /
 * Registry / Catalog extension point end to end. Exercises the real loader
 * services (builtin / user / plugin / workspace / extra / explicit), the
 * App-scope `AgentProfileRegistryService` fold, and the Session-scope
 * `SessionAgentProfileCatalogService` — the loaders and the fold are resolved
 * through one DI container (the `this.provide` collection-contribution path
 * requires container-constructed units) against real temp directories:
 * source-priority merge, the builtin-override rule, explicit fatal semantics,
 * config / plugin-reload / fs-watch driven reloads, and SYSTEM.md interplay.
 * Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceAgentProfileLoader/agentProfileLoader.test.ts`.
 */

import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { ILogService } from '#/_base/log/log';
import {
  DISABLED_BUILTIN_PROFILES_SECTION,
  EXTRA_AGENT_DIRS_SECTION,
} from '#/workspace/workspaceAgentProfileLoader/configSection';
import { UserAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoaderService';
import type { PluginAgentRoot, ReloadSummary } from '#/app/plugin/types';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { BuiltinAgentProfileLoaderService } from '#/app/agentProfileCatalog/builtinAgentProfileLoaderService';
import { AGENT_PROFILE_SOURCE_PRIORITY } from '#/app/agentProfileCatalog/agentProfileContribution';
import {
  _clearAgentProfileContributionsForTests,
  registerAgentProfile,
} from '#/app/agentProfileCatalog/contribution';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoaderService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
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
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { parseAgentRouteFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentRouteFile';

import { stubBootstrap } from '../../app/bootstrap/stubs';

function configStub(): IConfigService & {
  setExtraAgentDirs(dirs: readonly string[]): void;
  setDisabledBuiltinProfiles(names: readonly string[]): void;
  fireSectionChange(domain: string): void;
} {
  let extraAgentDirs: readonly string[] = [];
  let disabledBuiltinProfiles: readonly string[] = [];
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
      if (domain === DISABLED_BUILTIN_PROFILES_SECTION) return [...disabledBuiltinProfiles];
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
    setDisabledBuiltinProfiles: (names: readonly string[]) => {
      disabledBuiltinProfiles = [...names];
    },
    fireSectionChange: (domain: string) => {
      for (const listener of sectionChangeListeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    },
  } as unknown as IConfigService & {
    setExtraAgentDirs(dirs: readonly string[]): void;
    setDisabledBuiltinProfiles(names: readonly string[]): void;
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
    osBackendId: 'local',
    persistenceBackendId: 'local',
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
    await rm(root, { recursive: true, force: true });
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
  reloadEmitter?: Emitter<ReloadSummary>,
): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: reloadEmitter !== undefined ? reloadEmitter.event : () => ({ dispose: () => {} }),
    onDidMutate: () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    installPlugin: async () => ({ id: '' }) as never,
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
    enabledHooks: async () => [],
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

interface StackOptions {
  readonly extraAgentDirs?: readonly string[];
  readonly disabledBuiltinProfiles?: readonly string[];
  readonly explicitFiles?: readonly string[];
  readonly pluginAgentRoots?: readonly PluginAgentRoot[];
  readonly pluginReloadEmitter?: Emitter<ReloadSummary>;
  readonly hostFs?: HostFileSystem;
  readonly fsWatch?: IHostFsWatchService;
  readonly routesEnabled?: boolean;
  readonly userAgentProfileHomeDir?: string;
}

function makeStack(fixture: Fixture, opts?: StackOptions) {
  const warnings: string[] = [];
  const log = logStub(warnings);
  const config = configStub();
  if (opts?.extraAgentDirs !== undefined) config.setExtraAgentDirs(opts.extraAgentDirs);
  if (opts?.disabledBuiltinProfiles !== undefined) {
    config.setDisabledBuiltinProfiles(opts.disabledBuiltinProfiles);
  }
  const bootstrap: IBootstrapService = {
    ...stubBootstrap(fixture.homeDir, {}, { agentFiles: opts?.explicitFiles }),
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
      [IHostFsWatchService, opts?.fsWatch ?? fsWatchStub()],
      [IWorkspaceContext, workspaceContext],
      [IPluginService, pluginStub(opts?.pluginAgentRoots ?? [], opts?.pluginReloadEmitter)],
      [IFlagService, flags],
      [IAgentProfileRegistry, new SyncDescriptor(AgentProfileRegistryService)],
      [IBuiltinAgentProfileLoader, new SyncDescriptor(BuiltinAgentProfileLoaderService)],
      [IUserAgentProfileLoader, new SyncDescriptor(UserAgentProfileLoaderService)],
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
  const pluginLoader = get(IPluginAgentProfileLoader);
  const workspaceLoader = get(IWorkspaceAgentProfileLoader);
  const extraLoader = get(IExtraAgentProfileLoader);
  const explicitLoader = get(IExplicitAgentProfileLoader);
  const seed: ISessionAgentProfileCatalogSeed = {
    _serviceBrand: undefined,
    workspaceKey: workspaceContext.workspaceId,
  };
  const catalog = new SessionAgentProfileCatalogService(registry, seed, config, log, flags);

  return {
    registry,
    builtinLoader,
    userLoader,
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
    const builtinDefault: AgentProfile = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      description: 'builtin default',
      systemPrompt: () => 'BUILTIN PROMPT',
    });
    registerAgentProfile(builtinDefault);
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
    expect(() => parse('wrap', 'no base')).toThrow(/exactly once/);
    expect(() => parse('wrap', '${base_prompt} twice ${base_prompt}')).toThrow(/exactly once/);
    expect(() => parse('prepend', '${base_prompt}')).toThrow(/does not allow/);
    expect(() => parse('inherit', 'not empty')).toThrow(/empty body/);
  });

  it('lists builtin profiles when no agent directories exist', async () => {
    await withFixture(async (fixture) => {
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get(DEFAULT_AGENT_PROFILE_NAME)?.description).toBe('builtin default');
        expect(stack.catalog.getDefault().name).toBe(DEFAULT_AGENT_PROFILE_NAME);
        expect(stack.catalog.list().length).toBeGreaterThan(0);
        expect(stack.catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)?.sourceId).toBe('builtin');
      });
    });
  });

  it('loads and composes a named route without widening base authority', async () => {
    await withFixture(async (fixture) => {
      const root = join(fixture.homeDir, 'agents');
      await writeAgent(
        root,
        'reviewer.md',
        `---\nname: reviewer\ndescription: reviewer\ntools: [Read, Bash]\ndisallowedTools: [Write]\nsubagents: [explore, coder]\nservice_tier: priority\nrequest_params:\n  base: true\n  service_tier: auto\n---\n\nBASE REVIEWER`,
      );
      await writeAgent(
        join(root, '.routes', 'reviewer'),
        'ui-k3.md',
        routeMd(
          'reviewer.ui-k3',
          'reviewer',
          'ROUTE OVERLAY',
          `whenToUse: UI review\nmodel_alias: route-model\nthinking_effort: high\ntools: [Read]\ndisallowedTools: [Bash]\nsubagents: [explore, added]\nservice_tier: null\nrequest_params:\n  route: true\n  service_tier: flex\n`,
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
        expect(effective.subagents).toEqual(['explore']);
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

  it('narrows MCP and collaboration tools without widening the builtin base profile', async () => {
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
        expect(isToolActive(explore, 'send_message')).toBe(false);
        expect(isToolActive(explore, 'mcp__github__create_issue', 'mcp')).toBe(false);
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
      const workspaceRoot = join(fixture.workDir, '.kimi-code', 'agents');
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

  it('omits disabled builtin profiles and reprojects when the config changes', async () => {
    registerAgentProfile(
      normalizeAgentProfile({
        name: 'coder',
        description: 'builtin coder',
        systemPrompt: () => 'CODER',
      }),
    );
    await withFixture(async (fixture) => {
      await withStack(fixture, { disabledBuiltinProfiles: ['coder'] }, async (stack) => {
        await stack.ready();
        expect(stack.catalog.get('coder')).toBeUndefined();
        expect(stack.catalog.list().map((profile) => profile.name)).not.toContain('coder');

        stack.config.setDisabledBuiltinProfiles([]);
        const changed = waitForEvent(stack.catalog.onDidChange);
        stack.config.fireSectionChange(DISABLED_BUILTIN_PROFILES_SECTION);
        await changed;

        expect(stack.catalog.get('coder')?.description).toBe('builtin coder');
      });
    });
  });

  it('warns and keeps the required default builtin profile when its disable is configured', async () => {
    await withFixture(async (fixture) => {
      await withStack(
        fixture,
        { disabledBuiltinProfiles: [DEFAULT_AGENT_PROFILE_NAME] },
        async (stack) => {
          await stack.ready();

          expect(stack.catalog.getDefault().description).toBe('builtin default');
          expect(
            stack.warnings.some(
              (warning) =>
                warning.includes(DEFAULT_AGENT_PROFILE_NAME) && warning.includes('cannot be disabled'),
            ),
          ).toBe(true);
        },
      );
    });
  });

  it('merges user and workspace agents; workspace wins on name collision', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(join(fixture.homeDir, 'agents'), 'shared.md', agentMd('shared', 'from user'));
      await writeAgent(join(fixture.homeDir, 'agents'), 'user-only.md', agentMd('user-only', 'user agent'));
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
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
        join(fixture.workDir, '.kimi-code', 'agents'),
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
      const reloadEmitter = new Emitter<ReloadSummary>();
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
          reloadEmitter.fire({ added: [], removed: [], errors: [] });
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
        join(fixture.workDir, '.kimi-code', 'agents'),
        'bad.md',
        '---\nname: bad\n---\n\nbody\n',
      );
      await writeAgent(join(fixture.workDir, '.kimi-code', 'agents'), 'good.md', agentMd('good', 'valid'));
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

  it('keeps the builtin default when a same-name file does not opt in to override', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'agent.md',
        agentMd('agent', 'project default override'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.getDefault().description).toBe('builtin default');
        expect(stack.catalog.getDefault().description).not.toBe('project default override');
        const inspection = stack.catalog.inspect(DEFAULT_AGENT_PROFILE_NAME);
        expect(inspection?.sourceId).toBe('builtin');
        expect(inspection?.suppressed).toContainEqual({
          sourceId: 'workspace',
          priority: 30,
          reason: 'builtin-override-required',
        });
      });
    });
  });

  it('lets a file profile explicitly override the builtin default', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
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

  it('falls back to a valid lower-priority override when the higher candidate does not opt in', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'agent.md',
        agentMd('agent', 'user default override', true),
      );
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
        'agent.md',
        agentMd('agent', 'project default without override'),
      );
      await withStack(fixture, undefined, async (stack) => {
        await stack.ready();

        expect(stack.catalog.getDefault().description).toBe('user default override');
        expect(stack.catalog.getDefault().description).not.toBe('project default without override');
        expect(stack.catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)?.sourceId).toBe('user');
      });
    });
  });

  it('keeps builtin profiles and warns when a non-fatal loader fails its first load', async () => {
    await withFixture(async (fixture) => {
      await mkdir(join(fixture.homeDir, 'agents'), { recursive: true });
      const hostFs = failingReaddirFs(new HostFileSystem(), () => true);
      await withStack(fixture, { hostFs }, async (stack) => {
        await stack.ready();

        expect(stack.catalog.get(DEFAULT_AGENT_PROFILE_NAME)?.description).toBe('builtin default');
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

  it('replaces the builtin default system prompt with user-level SYSTEM.md', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        join(fixture.homeDir, 'SYSTEM.md'),
        'You are a custom main agent. cwd=${cwd} unknown=${nope}',
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

  it('lets SYSTEM.md win over a same-name scanned user agent file', async () => {
    await withFixture(async (fixture) => {
      await writeAgent(
        join(fixture.homeDir, 'agents'),
        'agent.md',
        agentMd('agent', 'user agents dir default', true),
      );
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), 'system md prompt');
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
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), 'system md prompt');
      await writeAgent(
        join(fixture.workDir, '.kimi-code', 'agents'),
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
      await writeFile(join(fixture.homeDir, 'SYSTEM.md'), 'system md prompt');
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
      await mkdir(join(fixture.workDir, '.kimi-code', 'agents'), { recursive: true });
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
          join(fixture.workDir, '.kimi-code', 'agents'),
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
          'builtin',
          'explicit',
          'extra',
          'plugin',
          'user',
          'workspace',
        ]);
        expect(bySourceId.get('builtin')?.workspaceKey).toBeUndefined();
        expect(bySourceId.get('builtin')?.priority).toBe(AGENT_PROFILE_SOURCE_PRIORITY.builtin);
        for (const sourceId of ['explicit', 'extra', 'plugin', 'user', 'workspace'] as const) {
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
        expect(stack.catalog.get(DEFAULT_AGENT_PROFILE_NAME)?.description).toBe('builtin default');
      });
    });
  });
});
