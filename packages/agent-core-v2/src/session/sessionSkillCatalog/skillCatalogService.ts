import { Service } from '#/_base/di/service';
import { IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillContribution } from '#/app/skillCatalog/skillSource';
import { summarizeSkill, type SkillCatalog, type SkillSummary } from '#/app/skillCatalog/types';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';

import { ISessionSkillCatalog, type ISkillCatalogSink } from './skillCatalog';
import { ISessionSkillCatalogData } from './skillCatalogData';

const SESSION_PLUGIN_CONTRIBUTION_ID = 'plugin-session-usage';

export const skillCatalogContributionsKey = defineState<
  Map<string, { readonly c: SkillContribution; readonly priority: number }>
>('sessionSkillCatalog.contributions', () => new Map());
export const skillCatalogMergedKey = defineState<InMemorySkillCatalog>(
  'sessionSkillCatalog.merged',
  () => new InMemorySkillCatalog(),
);

export class SessionSkillCatalogService
  extends Service
  implements ISessionSkillCatalog, ISkillCatalogSink
{
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;
  private readonly session?: ISessionContext;
  private readonly plugins?: IPluginService;
  private readonly discovery?: ISkillDiscovery;
  private readonly usage?: IPluginUsageService;
  private sessionPluginIds: ReadonlySet<string> | undefined;
  private pluginOverlayTail: Promise<void> = Promise.resolve();

  constructor(
    @ISessionSkillCatalogData private readonly data: ISessionSkillCatalogData,
    @ISessionStateService private readonly states: ISessionStateService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    this.session = optionalService(instantiation, ISessionContext);
    this.plugins = optionalService(instantiation, IPluginService);
    this.discovery = optionalService(instantiation, ISkillDiscovery);
    this.usage = optionalService(instantiation, IPluginUsageService);
    this.states.contributeState(skillCatalogContributionsKey);
    this.states.contributeState(skillCatalogMergedKey);
    this._register(
      this.data.onDidChange((sourceId) => {
        this.remerge();
        this.onDidChangeEmitter.fire(sourceId);
      }),
    );
    if (this.plugins !== undefined) this._register(this.plugins.onDidReload((event) => {
      event.waitUntil(this.refreshPluginOverlay());
    }));
    if (this.usage !== undefined && this.session !== undefined) this._register(this.usage.onDidChange((event) => {
      if (event.workspaceId !== this.session!.workspaceId ||
        (event.sessionId !== undefined && event.sessionId !== this.session!.sessionId)) return;
      event.waitUntil(this.refreshPluginOverlay());
    }));
    this.remerge();
    this.ready = Promise.all([this.data.ready, this.refreshPluginOverlay()]).then(() => {
      this.remerge();
    });
  }

  private get contributions(): Map<
    string,
    { readonly c: SkillContribution; readonly priority: number }
  > {
    return this.states.get(skillCatalogContributionsKey);
  }

  private get merged(): InMemorySkillCatalog {
    return this.states.get(skillCatalogMergedKey);
  }

  private set merged(value: InMemorySkillCatalog) {
    this.states.set(skillCatalogMergedKey, value);
  }

  get catalog(): SkillCatalog {
    return this.merged;
  }

  async load(): Promise<void> {
    await this.ready;
  }

  async reload(): Promise<void> {
    await this.ready;
    this.remerge();
    this.onDidChangeEmitter.fire('catalog');
  }

  async list(): Promise<readonly SkillSummary[]> {
    await this.ready;
    return this.catalog.listSkills().map(summarizeSkill);
  }

  set(id: string, c: SkillContribution, { priority }: { readonly priority: number }): void {
    this.contributions.set(id, { c, priority });
    this.remerge();
    this.onDidChangeEmitter.fire(id);
  }

  remove(id: string): void {
    this.contributions.delete(id);
    this.remerge();
    this.onDidChangeEmitter.fire(id);
  }

  private remerge(): void {
    const m = new InMemorySkillCatalog();
    const base = this.data.catalog;
    const excludedRoots = new Set(
      base.listSkills()
        .filter((skill) => this.sessionPluginIds !== undefined && skill.plugin !== undefined && !this.sessionPluginIds.has(skill.plugin.id))
        .flatMap((skill) => skill.sourceRoot === undefined ? [] : [skill.sourceRoot]),
    );
    for (const skill of base.listSkills()) {
      if (this.sessionPluginIds !== undefined && skill.plugin !== undefined && !this.sessionPluginIds.has(skill.plugin.id)) continue;
      m.register(skill, { replace: true });
    }
    m.addRoots(base.getSkillRoots().filter((root) => !excludedRoots.has(root)));
    m.recordSkipped(base.getSkippedByPolicy());
    const ordered = [...this.contributions.values()].toSorted((a, b) => a.priority - b.priority);
    for (const { c } of ordered) {
      for (const skill of c.skills) m.register(skill, { replace: true });
      m.addRoots(c.scannedRoots ?? []);
      m.recordSkipped(c.skipped ?? []);
    }
    this.merged = m;
  }

  private refreshPluginOverlay(): Promise<void> {
    if (this.plugins === undefined || this.discovery === undefined || this.session === undefined) return Promise.resolve();
    const next = this.pluginOverlayTail.catch(() => undefined).then(async () => {
      if (!this.plugins!.hasLoadedSnapshot()) return;
      const roots = await this.plugins!.pluginSkillRoots(this.session!.workspaceId, this.session!.sessionId);
      const contribution = await this.discovery!.discover(roots);
      this.sessionPluginIds = new Set(roots.flatMap((root) => root.plugin === undefined ? [] : [root.plugin.id]));
      this.contributions.set(SESSION_PLUGIN_CONTRIBUTION_ID, { c: contribution, priority: 5 });
      this.remerge();
      this.onDidChangeEmitter.fire('plugin');
    });
    this.pluginOverlayTail = next;
    return next;
  }
}

function optionalService<T>(instantiation: IInstantiationService, id: ServiceIdentifier<T>): T | undefined {
  try {
    return instantiation.invokeFunction((accessor) => accessor.get(id));
  } catch {
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSkillCatalog,
  SessionSkillCatalogService,
  ScopeActivation.OnScopeCreated,
  'sessionSkillCatalog',
);
