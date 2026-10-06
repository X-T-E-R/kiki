import { parse } from 'smol-toml';

import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Emitter } from '#/_base/event';
import { IModelService } from '#/kosong/model/model';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IHookRulesRegistry } from '../app/hookRules';
import { loadHookRules } from '../internal/loadRules';
import { hookHash, hookOrder, retainFailedHookSources, type HookEvent, type HookRulesSnapshot } from '../internal/rules';
import { IHookRulesSession, ISessionHookWorkspace } from './hookRules';

export class HookRulesSession extends Disposable implements IHookRulesSession {
  declare readonly _serviceBrand: undefined;
  private readonly initial: Promise<void>;
  private usageReady: Promise<void> = Promise.resolve();
  private usageOverrides: Readonly<Record<string, boolean>> = {};
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
  ) {
    super();
    this.initial = this.reload();
    const refreshUsage = () => {
      if (usage === undefined || !usage.enabled() || session === undefined) return Promise.resolve();
      return usage.read(session.workspaceId).then((snapshot) => {
        this.usageOverrides = snapshot.overrides;
        this.changed.fire();
      });
    };
    this.usageReady = refreshUsage();
    if (usage !== undefined) this._register(usage.onDidChange((event) => {
      if (event.workspaceId !== session?.workspaceId) return;
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
    const rules = [...global.rules, ...this.project.rules.map((entry) => !trusted ? { ...entry, active: false, reason: 'workspace_untrusted' } : entry)]
      .map((entry) => disabled.includes('*') || disabled.includes(entry.id) ? { ...entry, active: false, reason: 'disabled' } : entry)
      .map((entry) => this.usage?.enabled() && entry.namespace.startsWith('plugin/') && this.usageOverrides[entry.namespace.slice('plugin/'.length)] === false
        ? { ...entry, active: false, reason: 'workspace_plugin_disabled' } : entry).toSorted(hookOrder);
    return { sources: [...global.sources ?? [], ...this.project.sources ?? []], revision: hookHash([global.revision, this.project.revision, trusted, disabled, this.usage?.enabled() ? this.usageOverrides : {}]), rules, diagnostics: [...global.diagnostics, ...this.project.diagnostics] };
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
    let config: unknown;
    try { config = parse(await runtime.fs.readText(file))['hooks']; }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'os.fs.not_found' || error.code === 'ENOENT')) config = undefined;
      else throw error;
    }
    const next = config === undefined ? { revision: 'absent', rules: [], diagnostics: [], sources: [{ namespace: 'workspace', path: file, status: 'absent' as const }] } : await loadHookRules([
      { namespace: 'workspace', path: file, root, config, trusted: workspace.trust.isTrusted(), mutable: true },
    ], runtime.fs, runtime.path, (alias) => this.models.resolveId(alias));
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
