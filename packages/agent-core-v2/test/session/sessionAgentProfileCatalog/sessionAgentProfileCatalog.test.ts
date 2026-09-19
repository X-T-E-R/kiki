import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { InstantiationService } from '#/_base/di/instantiationService';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { BUILTIN_AGENT_PROFILE_SOURCE_ID } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import { SessionAgentProfileCatalogService } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalogService';
import {
  DISABLED_BUILTIN_PROFILES_SECTION,
  DISABLED_NAMED_PROFILES_SECTION,
} from '#/workspace/workspaceAgentProfileLoader/configSection';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  AgentProfileContribution,
  type AgentProfileContributionRecord,
} from '#/app/agentProfileCatalog/agentProfileContribution';

import { stubLog } from '../../_base/log/stubs';

const WORKSPACE_KEY = 'wd_a';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

interface IContributor {
  readonly record: AgentProfileContributionRecord;
}
const IContributor = createDecorator<IContributor>('test-session-profile-contributor');

class Contributor extends Service implements IContributor {
  declare readonly _serviceBrand: undefined;

  constructor(readonly record: AgentProfileContributionRecord) {
    super();
    this.provide(AgentProfileContribution, record);
  }
}

function profile(name: string, options?: { readonly override?: boolean }): AgentProfile {
  return normalizeAgentProfile({
    name,
    override: options?.override,
    systemPrompt: () => `prompt:${name}`,
  });
}

function configStub(
  initialDisabled: readonly string[] = [],
  initialDisabledNamed: readonly string[] = [],
): {
  readonly service: IConfigService;
  setDisabled(names: readonly string[]): void;
  setDisabledNamed(names: readonly string[]): void;
} {
  let disabled = [...initialDisabled];
  let disabledNamed = [...initialDisabledNamed];
  const sectionChanges = new Emitter<{ readonly domain: string }>();
  return {
    service: {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
      onDidSectionChange: sectionChanges.event,
      get: (domain: string) => {
        if (domain === DISABLED_BUILTIN_PROFILES_SECTION) return [...disabled];
        if (domain === DISABLED_NAMED_PROFILES_SECTION) return [...disabledNamed];
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
    } as unknown as IConfigService,
    setDisabled: (names) => {
      disabled = [...names];
      sectionChanges.fire({ domain: DISABLED_BUILTIN_PROFILES_SECTION });
    },
    setDisabledNamed: (names) => {
      disabledNamed = [...names];
      sectionChanges.fire({ domain: DISABLED_NAMED_PROFILES_SECTION });
    },
  };
}

function makeCatalog(
  workspaceKey: string = WORKSPACE_KEY,
  disabled: readonly string[] = [],
  disabledNamed: readonly string[] = [],
  initialRecords: readonly AgentProfileContributionRecord[] = [],
) {
  const container = new InstantiationService(new ServiceCollection(), true);
  const registry = container.createInstance(AgentProfileRegistryService);
  const install = (record: AgentProfileContributionRecord): IDisposable => {
    const child = container.createChild(new ServiceCollection()) as InstantiationService;
    child.provide(IContributor, new SyncDescriptor(Contributor, [record] as never));
    child.invokeFunction((accessor) => accessor.get(IContributor));
    return child;
  };
  for (const record of initialRecords) install(record);
  const config = configStub(disabled, disabledNamed);
  const warnings: string[] = [];
  const log = stubLog();
  log.warn = (message: string) => warnings.push(message);
  const catalog = new SessionAgentProfileCatalogService(
    registry,
    { _serviceBrand: undefined, workspaceKey },
    config.service,
    log,
    { enabled: () => false } as unknown as IFlagService,
  );
  const contribute = (
    sourceId: string,
    profiles: readonly AgentProfile[],
    options?: { readonly priority?: number; readonly workspaceKey?: string },
  ): IDisposable => install({
    sourceId,
    priority: options?.priority,
    workspaceKey: options?.workspaceKey,
    contribution: { profiles },
  });
  return { container, registry, catalog, config, warnings, contribute };
}

describe('SessionAgentProfileCatalogService (registry projection)', () => {
  it('waits for all five loader sources before completing the cold catalog projection', async () => {
    const container = new InstantiationService(new ServiceCollection(), true);
    const registry = container.createInstance(AgentProfileRegistryService);
    const user = deferred();
    const readiness = [
      registry.registerSourceReadiness('user', WORKSPACE_KEY, user.promise),
      registry.registerSourceReadiness('plugin', WORKSPACE_KEY, Promise.resolve()),
      registry.registerSourceReadiness('explicit', WORKSPACE_KEY, Promise.resolve()),
      registry.registerSourceReadiness('extra', WORKSPACE_KEY, Promise.resolve()),
      registry.registerSourceReadiness('workspace', WORKSPACE_KEY, Promise.resolve()),
    ];
    const config = configStub();
    const catalog = new SessionAgentProfileCatalogService(
      registry,
      { _serviceBrand: undefined, workspaceKey: WORKSPACE_KEY },
      config.service,
      stubLog(),
      { enabled: () => false } as unknown as IFlagService,
    );
    const userProfile = profile('user-profile');
    const registration = registry.register({
      sourceId: 'user',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
      workspaceKey: WORKSPACE_KEY,
      contribution: { profiles: [userProfile] },
    });

    await Promise.resolve();
    expect(catalog.complete).toBe(false);
    expect(catalog.get('user-profile')).toBeUndefined();
    user.resolve();
    await catalog.ready;

    expect(catalog.complete).toBe(true);
    expect(catalog.get('user-profile')).toBe(userProfile);
    registration.dispose();
    for (const handle of readiness) handle.dispose();
    catalog.dispose();
    container.dispose();
  });

  it('completes after one loader fails and keeps profiles from the other sources', async () => {
    const container = new InstantiationService(new ServiceCollection(), true);
    const registry = container.createInstance(AgentProfileRegistryService);
    const workspace = deferred();
    const readiness = [
      registry.registerSourceReadiness('user', WORKSPACE_KEY, Promise.reject(new Error('user failed'))),
      registry.registerSourceReadiness('plugin', WORKSPACE_KEY, Promise.resolve()),
      registry.registerSourceReadiness('explicit', WORKSPACE_KEY, Promise.resolve()),
      registry.registerSourceReadiness('extra', WORKSPACE_KEY, Promise.resolve()),
      registry.registerSourceReadiness('workspace', WORKSPACE_KEY, workspace.promise),
    ];
    const config = configStub();
    const catalog = new SessionAgentProfileCatalogService(
      registry,
      { _serviceBrand: undefined, workspaceKey: WORKSPACE_KEY },
      config.service,
      stubLog(),
      { enabled: () => false } as unknown as IFlagService,
    );
    const workspaceProfile = profile('workspace-profile');
    const registration = registry.register({
      sourceId: 'workspace',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: WORKSPACE_KEY,
      contribution: { profiles: [workspaceProfile] },
    });

    workspace.resolve();
    await expect(catalog.ready).resolves.toBeUndefined();
    expect(catalog.complete).toBe(true);
    expect(catalog.get('workspace-profile')).toBe(workspaceProfile);
    registration.dispose();
    for (const handle of readiness) handle.dispose();
    catalog.dispose();
    container.dispose();
  });

  it('projects global entries and own-workspace entries, filtering other workspace keys', () => {
    const { container, catalog, contribute } = makeCatalog();
    const globalProfile = profile('global-p');
    const ownProfile = profile('own-ws-p');
    contribute('user', [globalProfile]);
    contribute('workspace', [ownProfile], { workspaceKey: 'wd_a' });
    contribute('workspace', [profile('other-ws-p')], { workspaceKey: 'wd_b' });

    expect(catalog.get('global-p')).toBe(globalProfile);
    expect(catalog.get('own-ws-p')).toBe(ownProfile);
    expect(catalog.get('other-ws-p')).toBeUndefined();
    catalog.dispose();
    container.dispose();
  });

  it('excludes same-name profiles of other workspace keys from the merge entirely', () => {
    const { container, catalog, contribute } = makeCatalog();
    const userProfile = profile('shared');
    const ownProfile = profile('shared');
    contribute('user', [userProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
    });
    contribute('workspace', [profile('shared')], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.explicit,
      workspaceKey: 'wd_b',
    });
    contribute('workspace', [ownProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: 'wd_a',
    });

    expect(catalog.get('shared')).toBe(ownProfile);
    expect(catalog.inspect('shared')).toEqual({
      name: 'shared',
      profile: ownProfile,
      sourceId: 'workspace',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      suppressed: [
        { sourceId: 'user', priority: AGENT_PROFILE_SOURCE_PRIORITY.user, reason: 'priority' },
      ],
    });
    catalog.dispose();
    container.dispose();
  });

  it('lets the higher-priority source win a name collision and reports the suppressed candidate', () => {
    const { container, catalog, contribute } = makeCatalog();
    const lowProfile = profile('x');
    const highProfile = profile('x');
    contribute('user', [lowProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
    });
    contribute('workspace', [highProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: 'wd_a',
    });

    expect(catalog.get('x')).toBe(highProfile);
    expect(catalog.inspect('x')).toEqual({
      name: 'x',
      profile: highProfile,
      sourceId: 'workspace',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      suppressed: [
        { sourceId: 'user', priority: AGENT_PROFILE_SOURCE_PRIORITY.user, reason: 'priority' },
      ],
    });
    catalog.dispose();
    container.dispose();
  });

  it('lets a same-name file profile win the default agent name by source priority', () => {
    const { container, catalog, contribute } = makeCatalog();
    const builtinProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const fileProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [builtinProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin,
    });
    contribute('workspace', [fileProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: 'wd_a',
    });

    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toMatchObject(fileProfile);
    expect(catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)).toEqual({
      name: DEFAULT_AGENT_PROFILE_NAME,
      profile: expect.objectContaining({ name: fileProfile.name }),
      sourceId: 'workspace',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      suppressed: [
        {
          sourceId: BUILTIN_AGENT_PROFILE_SOURCE_ID,
          priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin,
          reason: 'priority',
        },
      ],
    });
    catalog.dispose();
    container.dispose();
  });

  it('keeps the builtin bind candidate when the first projection contains invalid inherit', () => {
    const builtinProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const inherited = normalizeAgentProfile({
      name: 'writer',
      systemPromptMode: 'inherit',
      promptOverrides: { fields: { 'system.language': 'upper' } },
      systemPrompt: () => 'UNRESOLVED',
    });
    const { container, catalog, warnings } = makeCatalog(WORKSPACE_KEY, [], [], [
      {
        sourceId: BUILTIN_AGENT_PROFILE_SOURCE_ID,
        priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin,
        contribution: { profiles: [builtinProfile] },
      },
      {
        sourceId: 'workspace',
        priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
        workspaceKey: WORKSPACE_KEY,
        contribution: { profiles: [inherited] },
      },
    ]);

    expect(catalog.getDefault()).toMatchObject(builtinProfile);
    expect(catalog.resolveSelection({ profile: DEFAULT_AGENT_PROFILE_NAME }).profile).toMatchObject(builtinProfile);
    expect(catalog.get('writer')).toBeUndefined();
    expect(warnings).toContainEqual(expect.stringMatching(/writer.*no lower-priority base profile/));
    catalog.dispose();
    container.dispose();
  });

  it('lets a higher-priority file profile replace a same-name low-priority candidate', () => {
    const { container, catalog, contribute } = makeCatalog();
    const builtinProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const overrideProfile = profile(DEFAULT_AGENT_PROFILE_NAME, { override: true });
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [builtinProfile]);
    contribute('workspace', [overrideProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: 'wd_a',
    });

    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toMatchObject(overrideProfile);
    expect(catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)).toEqual({
      name: DEFAULT_AGENT_PROFILE_NAME,
      profile: expect.objectContaining({ name: overrideProfile.name }),
      sourceId: 'workspace',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      suppressed: [
        {
          sourceId: BUILTIN_AGENT_PROFILE_SOURCE_ID,
          priority: 0,
          reason: 'priority',
        },
      ],
    });
    catalog.dispose();
    container.dispose();
  });

  it('leaves legacy disabled-builtin filtering to the shipped-profile manager, not the session catalog', () => {
    const { container, catalog, config, contribute } = makeCatalog(WORKSPACE_KEY, [
      'coder',
      'plan',
    ]);
    const defaultProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const coderProfile = profile('coder');
    const exploreProfile = profile('explore');
    const planProfile = profile('plan');
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [
      defaultProfile,
      coderProfile,
      exploreProfile,
      planProfile,
    ]);

    expect(catalog.getDefault()).toMatchObject(defaultProfile);
    expect(catalog.get('coder')).toMatchObject(coderProfile);
    expect(catalog.get('plan')).toMatchObject(planProfile);
    expect(catalog.get('explore')).toMatchObject(exploreProfile);

    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));
    config.setDisabled(['explore']);

    expect(catalog.get('coder')).toMatchObject(coderProfile);
    expect(catalog.get('explore')).toMatchObject(exploreProfile);
    expect(seen).toEqual([]);
    subscription.dispose();
    catalog.dispose();
    container.dispose();
  });

  it('filters named profiles, rejects their dispatch selection, and hot-reprojects config changes', () => {
    const { container, catalog, config, contribute } = makeCatalog(
      WORKSPACE_KEY,
      [],
      ['reviewer'],
    );
    const defaultProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const namedDefaultProfile = profile(DEFAULT_AGENT_PROFILE_NAME, { override: true });
    const reviewerProfile = profile('reviewer');
    const coderProfile = profile('coder');
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [defaultProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin,
    });
    contribute('user', [namedDefaultProfile, reviewerProfile, coderProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
      workspaceKey: WORKSPACE_KEY,
    });

    expect(catalog.getDefault()).toMatchObject(namedDefaultProfile);
    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toMatchObject(namedDefaultProfile);
    expect(catalog.get('reviewer')).toBeUndefined();
    expect(catalog.get('coder')).toMatchObject(coderProfile);
    expect(() => catalog.resolveSelection({ profile: 'reviewer' })).toThrow(
      'Unknown agent profile: "reviewer"',
    );

    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));
    config.setDisabledNamed(['coder']);

    expect(catalog.getDefault()).toMatchObject(namedDefaultProfile);
    expect(catalog.get('reviewer')).toMatchObject(reviewerProfile);
    expect(catalog.get('coder')).toBeUndefined();
    expect(() => catalog.resolveSelection({ profile: 'coder' })).toThrow(
      'Unknown agent profile: "coder"',
    );
    expect(seen).toEqual(['catalog']);
    subscription.dispose();
    catalog.dispose();
    container.dispose();
  });

  it('keeps a disabled default profile only on the main-agent binding surface', async () => {
    const { container, catalog, warnings, contribute } = makeCatalog(
      WORKSPACE_KEY,
      [],
      [DEFAULT_AGENT_PROFILE_NAME],
    );
    const defaultProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const coderProfile = profile('coder');
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [defaultProfile, coderProfile]);
    await catalog.ready;

    expect(catalog.getDefault()).toMatchObject(defaultProfile);
    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeUndefined();
    expect(catalog.list()).toEqual([coderProfile]);
    expect(catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)).toBeUndefined();
    expect(() => catalog.resolveSelection({ profile: DEFAULT_AGENT_PROFILE_NAME })).toThrow(
      `Unknown agent profile: "${DEFAULT_AGENT_PROFILE_NAME}". Available agent profiles: coder`,
    );
    expect(warnings).toEqual([]);
    catalog.dispose();
    container.dispose();
  });

  it('lets a file profile take a disabled builtin name without override: true', () => {
    const { container, catalog, contribute } = makeCatalog(WORKSPACE_KEY, ['coder']);
    const fileProfile = profile('coder');
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [profile(DEFAULT_AGENT_PROFILE_NAME), profile('coder')]);
    contribute('workspace', [fileProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: WORKSPACE_KEY,
    });

    expect(catalog.get('coder')).toBe(fileProfile);
    expect(catalog.inspect('coder')?.sourceId).toBe('workspace');
    catalog.dispose();
    container.dispose();
  });

  it('re-projects and fires the source id on relevant registry changes, ignoring other keys', () => {
    const { container, catalog, contribute } = makeCatalog();
    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));

    const ownProfile = profile('own-ws-p');
    contribute('workspace', [ownProfile], { workspaceKey: 'wd_a' });
    expect(catalog.get('own-ws-p')).toBe(ownProfile);

    const globalProfile = profile('global-p');
    const globalHandle = contribute('user', [globalProfile]);
    expect(catalog.get('global-p')).toBe(globalProfile);

    const otherHandle = contribute('workspace', [profile('other-ws-p')], { workspaceKey: 'wd_b' });
    otherHandle.dispose();
    expect(catalog.get('other-ws-p')).toBeUndefined();

    globalHandle.dispose();
    expect(catalog.get('global-p')).toBeUndefined();

    expect(seen).toEqual(['workspace', 'user', 'user']);
    subscription.dispose();
    catalog.dispose();
    container.dispose();
  });

  it('keeps the last good projection when a catalog contribution cannot be projected', () => {
    const { container, catalog, warnings, contribute } = makeCatalog();
    const stable = profile('stable');
    contribute('user', [stable]);
    const snapshot = catalog.snapshot();
    const broken = profile('broken');
    Object.defineProperty(broken, 'name', {
      get: () => {
        throw new Error('broken profile getter');
      },
    });

    catalog.setContribution('broken', { profiles: [broken] }, 100);

    expect(catalog.get('stable')).toBe(stable);
    expect(catalog.snapshot()).toBe(snapshot);
    expect(warnings).toContainEqual(
      expect.stringContaining('keeping the last good catalog'),
    );
    catalog.dispose();
    container.dispose();
  });

  it("fires 'catalog' on reload", async () => {
    const { container, catalog } = makeCatalog();
    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));

    await catalog.reload();

    expect(seen).toEqual(['catalog']);
    subscription.dispose();
    catalog.dispose();
    container.dispose();
  });

  it('resolves ready after the config snapshot is available', async () => {
    const { container, catalog } = makeCatalog();

    await expect(catalog.ready).resolves.toBeUndefined();
    await expect(catalog.load()).resolves.toBeUndefined();
    catalog.dispose();
    container.dispose();
  });

  it('serves the read surface and throws from getDefault without the default profile', () => {
    const { container, catalog, contribute } = makeCatalog();
    expect(catalog.get('missing')).toBeUndefined();
    expect(catalog.inspect('missing')).toBeUndefined();
    expect(catalog.list()).toEqual([]);
    expect(() => catalog.getDefault()).toThrow(/not available/);

    const defaultProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const coderProfile = profile('coder');
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [defaultProfile]);
    contribute('user', [coderProfile]);

    expect(catalog.getDefault()).toMatchObject(defaultProfile);
    expect(catalog.get('coder')).toBe(coderProfile);
    expect(catalog.list()).toEqual([expect.objectContaining({ name: DEFAULT_AGENT_PROFILE_NAME }), coderProfile]);
    expect(catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)).toEqual({
      name: DEFAULT_AGENT_PROFILE_NAME,
      profile: expect.objectContaining({ name: defaultProfile.name }),
      sourceId: BUILTIN_AGENT_PROFILE_SOURCE_ID,
      priority: 0,
      suppressed: [],
    });
    catalog.dispose();
    container.dispose();
  });
});
