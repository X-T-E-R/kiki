import { beforeEach, describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter, Event } from '#/_base/event';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog, type ISkillCatalogSink } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionSkillCatalogData } from '#/session/sessionSkillCatalog/skillCatalogData';
import { SessionSkillCatalogService } from '#/session/sessionSkillCatalog/skillCatalogService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';

import { stubSkill } from '../../app/skillCatalog/stubs';

function dataSeed(initial: InMemorySkillCatalog): {
  readonly data: ISessionSkillCatalogData;
  readonly changes: Emitter<string>;
  replace(next: InMemorySkillCatalog): void;
} {
  let current: SkillCatalog = initial;
  const changes = new Emitter<string>();
  return {
    changes,
    data: {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: changes.event,
      get catalog() {
        return current;
      },
    },
    replace(next: InMemorySkillCatalog) {
      current = next;
    },
  };
}

function catalogOf(...skills: readonly ReturnType<typeof stubSkill>[]): InMemorySkillCatalog {
  const catalog = new InMemorySkillCatalog();
  for (const skill of skills) catalog.register(skill, { replace: true });
  return catalog;
}

describe('SessionSkillCatalogService (seed view)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionStateService,
      SessionStateService,
    );
    registerScopedService(LifecycleScope.Session, ISessionSkillCatalog, SessionSkillCatalogService);
  });

  function makeSession(data: ISessionSkillCatalogData, sessionId = 's1', options?: {
    readonly plugins?: IPluginService;
    readonly usage?: IPluginUsageService;
    readonly discovery?: ISkillDiscovery;
  }) {
    const host = createScopedTestHost([]);
    const session = host.child(LifecycleScope.Session, sessionId, [
      stubPair(ISessionSkillCatalogData, data),
      stubPair(IWorkspaceStateService, new WorkspaceStateService()),
      stubPair(ISessionContext, makeSessionContext({ sessionId, workspaceId: 'workspace-a', sessionDir: '', cwd: '', sessionScope: `workspace-a/${sessionId}` })),
      ...(options?.plugins === undefined ? [] : [stubPair(IPluginService, options.plugins)]),
      ...(options?.usage === undefined ? [] : [stubPair(IPluginUsageService, options.usage)]),
      ...(options?.discovery === undefined ? [] : [stubPair(ISkillDiscovery, options.discovery)]),
    ]);
    return { host, catalog: session.accessor.get(ISessionSkillCatalog) };
  }

  it('exposes the seeded snapshot after ready', async () => {
    const seed = dataSeed(catalogOf(stubSkill('from-workspace')));
    const { host, catalog } = makeSession(seed.data);

    await catalog.load();
    expect(catalog.catalog.getSkill('from-workspace')).toBeDefined();
    await host.dispose();
  });

  it('re-folds and forwards the source id when the seed fires a change', async () => {
    const seed = dataSeed(catalogOf(stubSkill('before')));
    const { host, catalog } = makeSession(seed.data);
    await catalog.load();

    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));
    seed.replace(catalogOf(stubSkill('after')));
    seed.changes.fire('workspace');

    expect(catalog.catalog.getSkill('before')).toBeUndefined();
    expect(catalog.catalog.getSkill('after')).toBeDefined();
    expect(seen).toEqual(['workspace']);
    subscription.dispose();
    await host.dispose();
  });

  it('merges ad-hoc sink contributions over the seed and drops them on remove', async () => {
    const seed = dataSeed(catalogOf(stubSkill('shared', { description: 'from workspace' })));
    const { host, catalog } = makeSession(seed.data);
    await catalog.load();

    const sink = catalog as unknown as ISkillCatalogSink;
    sink.set(
      'adhoc',
      { skills: [stubSkill('shared', { description: 'from adhoc' }), stubSkill('adhoc-only')] },
      { priority: 40 },
    );
    expect(catalog.catalog.getSkill('shared')?.description).toBe('from adhoc');
    expect(catalog.catalog.getSkill('adhoc-only')).toBeDefined();

    sink.remove('adhoc');
    expect(catalog.catalog.getSkill('shared')?.description).toBe('from workspace');
    expect(catalog.catalog.getSkill('adhoc-only')).toBeUndefined();
    await host.dispose();
  });

  it('reload re-folds the current seed without rescanning and fires catalog', async () => {
    const seed = dataSeed(catalogOf(stubSkill('one')));
    const { host, catalog } = makeSession(seed.data);
    await catalog.load();

    seed.replace(catalogOf(stubSkill('two')));
    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));
    await catalog.reload();

    expect(catalog.catalog.getSkill('two')).toBeDefined();
    expect(seen).toEqual(['catalog']);
    subscription.dispose();
    await host.dispose();
  });

  it('keeps session plugin skills isolated within one workspace', async () => {
    const pluginSkill = stubSkill('demo-skill', {
      source: 'extra',
      plugin: { id: 'demo', instructions: 'demo instructions' },
      sourceRoot: '/plugins/demo/skills',
    });
    const seed = dataSeed(catalogOf(pluginSkill));
    const usage: IPluginUsageService = {
      _serviceBrand: undefined,
      enabled: () => true,
      read: async (workspaceId) => ({ workspaceId, revision: 0, overrides: {}, applyState: 'applied' as const, errors: [] }),
      allows: async (_workspaceId, _pluginId, sessionId) => sessionId === 's1',
      registerPluginStateReader: () => ({ dispose: () => {} }),
      readSession: async (workspaceId, sessionId) => ({ workspaceId, sessionId, revision: 0, overrides: {}, applyState: 'applied' as const, errors: [] }),
      applySession: async (snapshot) => snapshot,
      set: async () => { throw new Error('unused'); },
      onDidChange: Event.None as IPluginUsageService['onDidChange'],
      onDidApply: Event.None as IPluginUsageService['onDidApply'],
    };
    const rootsBySession: string[] = [];
    const plugins = {
      onDidReload: Event.None,
      pluginSkillRoots: async (_workspaceId: string | undefined, sessionId?: string) => {
        rootsBySession.push(sessionId ?? 'missing');
        return sessionId === 's1'
          ? [{ path: '/plugins/demo/skills', source: 'extra' as const, plugin: { id: 'demo' } }]
          : [];
      },
      hasLoadedSnapshot: () => true,
    } as unknown as IPluginService;
    const discovery: ISkillDiscovery = {
      _serviceBrand: undefined,
      discover: async (roots) => roots.length === 0
        ? { skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }
        : { skills: [pluginSkill], skipped: [], scannedRoots: ['/plugins/demo/skills'], scannedDirectories: [] },
    };
    const s1 = makeSession(seed.data, 's1', { plugins, usage, discovery });
    const s2 = makeSession(seed.data, 's2', { plugins, usage, discovery });
    await Promise.all([s1.catalog.load(), s2.catalog.load()]);

    expect(rootsBySession.toSorted()).toEqual(['s1', 's2']);
    expect(s1.catalog.catalog.getPluginSkill('demo', 'demo-skill')).toBeDefined();
    expect(s2.catalog.catalog.getPluginSkill('demo', 'demo-skill')).toBeUndefined();
    expect(s1.catalog.catalog.getSkill('demo-skill')).toBeDefined();
    expect(s2.catalog.catalog.getSkill('demo-skill')).toBeUndefined();
    await Promise.all([s1.host.dispose(), s2.host.dispose()]);
  });

  it('list returns plain summaries of the merged catalog after ready', async () => {
    const seed = dataSeed(
      catalogOf(stubSkill('from-workspace', { description: 'seeded', source: 'project' })),
    );
    const { host, catalog } = makeSession(seed.data);
    (catalog as unknown as ISkillCatalogSink).set(
      'adhoc',
      { skills: [stubSkill('adhoc-only', { source: 'extra' })] },
      { priority: 40 },
    );

    const summaries = await catalog.list();
    expect(summaries).toHaveLength(2);
    const seeded = summaries.find((summary) => summary.name === 'from-workspace');
    expect(seeded).toMatchObject({
      name: 'from-workspace',
      description: 'seeded',
      source: 'project',
    });
    expect(Object.keys(seeded ?? {})).not.toContain('content');
    expect(summaries.some((summary) => summary.name === 'adhoc-only')).toBe(true);
    await host.dispose();
  });
});
