import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Emitter } from '#/_base/event';
import { IModelService } from '#/kosong/model/model';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IHookRulesRegistry } from '../app/hookRules';
import { loadWorkspaceHookRules, projectHookRules } from '../internal/snapshot';
import { hookHash, retainFailedHookSources, type HookEvent, type HookRulesSnapshot } from '../internal/rules';
import { IHookRulesSession, ISessionHookWorkspace } from './hookRules';

export class HookRulesSession extends Disposable implements IHookRulesSession {
  declare readonly _serviceBrand: undefined;
  private readonly initial: Promise<void>;
  private usageReady: Promise<void> = Promise.resolve();
  private usageOverrides: Readonly<Record<string, boolean>> = {};
  private allowedPluginIds: ReadonlySet<string> | undefined;
  get ready(): Promise<void> { return Promise.all([this.initial, this.usageReady]).then(() => {}); }
  private project: HookRulesSnapshot = { revision: '', rules: [], diagnostics: [] };
  private pending: Promise<void> = Promise.resolve();
  private readonly subscriptions = this._register(new DisposableStore());
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly observed = this._register(new Emitter<HookEvent & { readonly hookId: string }>());
  readonly onDidObserve = this.observed.event;

  constructor(
    @IHookRulesRegistry private readonly registry: IHookRulesRegistry,
    @IModelService private readonly models: IModelService,
    @ref(ISessionHookWorkspace) private readonly workspace: LiveRef<ISessionHookWorkspace>,
    @IPluginUsageService private readonly usage?: IPluginUsageService,
    @ISessionContext private readonly session?: ISessionContext,
    @IPluginService private readonly plugins?: IPluginService,
  ) {
    super();
    this.initial = this.reload();
    const refreshUsage = () => {
      if (usage === undefined || !usage.enabled() || session === undefined) return Promise.resolve();
      return Promise.all([
        usage.read(session.workspaceId),
        usage.readSession(session.workspaceId, session.sessionId),
        this.plugins?.enabledHookRules(session.workspaceId, session.sessionId) ?? Promise.resolve([]),
      ]).then(([workspaceSnapshot, sessionSnapshot, sources]) => {
        this.usageOverrides = { ...workspaceSnapshot.overrides, ...sessionSnapshot.overrides };
        this.allowedPluginIds = this.plugins === undefined
          ? undefined
          : new Set(sources
            .map((source) => source.namespace.startsWith('plugin/') ? source.namespace.slice('plugin/'.length) : undefined)
            .filter((id): id is string => id !== undefined));
        this.changed.fire();
      });
    };
    this.usageReady = refreshUsage();
    if (usage !== undefined) this._register(usage.onDidChange((event) => {
      if (event.workspaceId !== session?.workspaceId ||
        (event.sessionId !== undefined && event.sessionId !== session?.sessionId)) return;
      this.usageReady = refreshUsage();
      event.waitUntil(this.usageReady);
    }));
    this._register(registry.onDidChange(() => { this.changed.fire(); }));
    this._register(models.onDidChangeModels(() => { void this.reload(); }));
    this._register(workspace.onDidChange(() => { void this.reload(); }));
  }

  snapshot(): HookRulesSnapshot {
    const global = this.registry.snapshot();
    const disabled = this.registry.disabled();
    const trusted = this.workspace.current?.trust.isTrusted() === true;
    const overrides = this.usage?.enabled() !== true ? undefined : {
      ...this.usageOverrides,
      ...this.pluginDisabledOverrides(global),
    };
    return projectHookRules(global, this.project, disabled, trusted, overrides);
  }

  private pluginDisabledOverrides(global: HookRulesSnapshot): Readonly<Record<string, boolean>> {
    if (this.allowedPluginIds === undefined) return {};
    const disabled: Record<string, boolean> = {};
    for (const rule of global.rules) {
      if (rule.namespace.startsWith('plugin/') && !this.allowedPluginIds.has(rule.namespace.slice('plugin/'.length))) {
        disabled[rule.namespace.slice('plugin/'.length)] = false;
      }
    }
    return disabled;
  }

  observe(event: HookEvent, hookId: string): void { this.observed.fire({ ...event, hookId }); }

  reload(): Promise<void> {
    this.pending = this.pending.then(() => this.load()).catch((error) => {
      const workspace = this.workspace.current;
      const path = workspace?.runtime.path.join(workspace.root, '.kiki', 'hooks.toml') ?? '.kiki/hooks.toml';
      const status = typeof error === 'object' && error !== null && 'code' in error ? 'unavailable' : 'invalid';
      this.project = retainFailedHookSources(this.project, { revision: hookHash(String(error)), rules: [],
        sources: [{ namespace: 'workspace', path, status }], diagnostics: [{ path, message: String(error) }] });
      this.changed.fire();
    });
    return this.pending;
  }

  private async load(): Promise<void> {
    await this.registry.ready;
    const workspace = this.workspace.current;
    await this.subscriptions.clear();
    if (workspace === undefined) return;
    await workspace.trust.ready;
    const { runtime, root } = workspace;
    this.subscriptions.add(workspace.trust.onDidChange(() => { this.reload().catch(onUnexpectedError); }));
    const file = runtime.path.join(root, '.kiki', 'hooks.toml');
    if (runtime.fs === undefined) {
      this.project = retainFailedHookSources(this.project, { revision: 'unsupported', rules: [], sources: [{ namespace: 'workspace', path: file, status: 'unavailable' }], diagnostics: [{ path: file, message: 'workspace hooks unsupported: runtime has no filesystem capability' }] });
      this.changed.fire();
      return;
    }
    if (runtime.watch !== undefined) {
      const handle = this.subscriptions.add(runtime.watch.watch(file));
      this.subscriptions.add(handle.onDidChange(() => { this.reload().catch(onUnexpectedError); }));
    }
    const next = await loadWorkspaceHookRules(workspace, alias => this.models.resolveId(alias));
    this.project = retainFailedHookSources(this.project, next);
    if (runtime.watch !== undefined) {
      for (const watched of (this.project.watchPaths ?? []).filter((watched) => watched !== file)) {
        const handle = this.subscriptions.add(runtime.watch.watch(watched));
        this.subscriptions.add(handle.onDidChange(() => { this.reload().catch(onUnexpectedError); }));
      }
    }
    this.changed.fire();
  }
}
