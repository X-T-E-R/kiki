import nodePath from 'node:path';

import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Emitter } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { IModelService } from '#/kosong/model/model';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { HOOKS_SECTION, type HooksConfig } from '../configSection';
import { loadHookRules, type HookRuleSource } from '../internal/loadRules';
import { hookHash, retainFailedHookSources, type HookRulesSnapshot } from '../internal/rules';
import { IHookRulesRegistry } from './hookRules';

export class HookRulesRegistry extends Disposable implements IHookRulesRegistry {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  private current: HookRulesSnapshot = { revision: '', rules: [], diagnostics: [] };
  private disabledIds: readonly string[] = [];
  private pending: Promise<void> = Promise.resolve();
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly watches = this._register(new DisposableStore());

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IPluginService private readonly plugins: IPluginService,
    @IModelService private readonly models: IModelService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly environment: IHostEnvironment,
    @IHostFsWatchService private readonly watch: IHostFsWatchService,
  ) {
    super();
    this.ready = this.reload();
    this._register(config.onDidSectionChange((event) => { if (event.domain === HOOKS_SECTION) void this.reload(); }));
    this._register(plugins.onDidReload(() => { void this.reload(); }));
    this._register(models.onDidChangeModels(() => { void this.reload(); }));
  }

  snapshot(): HookRulesSnapshot { return this.current; }
  disabled(): readonly string[] { return this.disabledIds; }

  reload(): Promise<void> {
    this.pending = this.pending.then(() => this.load()).catch((error) => {
      const sources = this.current.sources ?? [...new Set(this.current.rules.map((rule) => rule.namespace))].map((namespace) => ({ namespace, path: this.bootstrap.configPath }));
      this.current = retainFailedHookSources(this.current, { revision: hookHash(String(error)), rules: [], sources: sources.map((source) => ({ ...source, status: 'unavailable' })), diagnostics: [{ path: this.bootstrap.configPath, message: String(error) }] });
      this.changed.fire();
    });
    return this.pending;
  }

  private async load(): Promise<void> {
    await Promise.all([this.config.ready, this.models.ready, this.environment.ready]);
    const path = this.environment.pathClass === 'win32' ? nodePath.win32 : nodePath.posix;
    const configured = this.config.get<HooksConfig>(HOOKS_SECTION);
    const sources: HookRuleSource[] = [...await this.plugins.enabledHookRules('*')];
    this.disabledIds = !Array.isArray(configured) && configured !== undefined ? configured.enabled ? configured.disabled : ['*'] : [];
    if (configured !== undefined && !Array.isArray(configured)) {
      sources.push({ namespace: 'user', path: this.bootstrap.configPath, root: path.dirname(this.bootstrap.configPath), config: configured, mutable: !this.bootstrap.configReadOnly, trusted: true });
    }
    const snapshot = await loadHookRules(sources, this.fs, { ...path, separator: path.sep }, (alias) => this.models.resolveId(alias));
    this.disabledIds = [...new Set([...this.disabledIds, ...snapshot.disabled ?? []])];
    const diagnostics = this.config.diagnostics().filter((entry) => entry.domain === HOOKS_SECTION).map((entry) => ({ path: this.bootstrap.configPath, message: entry.message }));
    this.current = retainFailedHookSources(this.current, { ...snapshot,
      sources: diagnostics.length === 0 ? snapshot.sources : [...snapshot.sources?.filter((source) => source.namespace !== 'user') ?? [], { namespace: 'user', path: this.bootstrap.configPath, status: 'invalid' }],
      diagnostics: [...snapshot.diagnostics, ...diagnostics],
    });
    await this.watches.clear();
    for (const file of this.current.watchPaths ?? []) {
      const handle = this.watches.add(this.watch.watch(file));
      this.watches.add(handle.onDidChange(() => { this.reload().catch(onUnexpectedError); }));
    }
    this.changed.fire();
  }
}
