import { type CollectionView } from '#/_base/di/collection';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { BugIndicatingError, Error2, ErrorCodes, onUnexpectedError } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { findSpacePreset, spacePresetDefaults } from '#/app/bootstrap/spacePresets';
import { ILogService } from '#/_base/log/log';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  type AnyEnvBindings,
  type ConfigChangedEvent,
  type ConfigDiagnostic,
  type ConfigSectionChangedEvent,
  type ConfigEffectiveOverlay,
  type ConfigInspectValue,
  type ConfigOrigin,
  type ConfigMerge,
  type ConfigOverlayRegisteredEvent,
  type ConfigSchema,
  type ConfigSection,
  type ConfigSectionRegisteredEvent,
  type ConfigChangeSource,
  type EnvBinding,
  type RegisterSectionOptions,
  type ResolvedConfig,
  ConfigScope,
  ConfigTarget,
  IConfigRegistry,
  IConfigService,
} from './config';
import { deepEqual, deepMerge, describeUnknownError, isPlainObject } from './configPure';
import { readConfigDocumentSnapshot, writeConfigDocument } from './configDocument';
import { leafOrigins, mergeConfigLayers } from './configLayers';
import { mergeConfigCredentials, splitConfigCredentials } from './credentials';
import {
  ConfigSectionContribution,
  getConfigSectionContributions,
} from './configSectionContributions';
import {
  ConfigWriteValidatorContribution,
  type ConfigWriteValidator,
} from './configWriteValidation';
import { getConfigOverlayContributions } from './configOverlayContributions';
import { collectRemovedSectionDiagnostics } from './deprecations';
import { CREDENTIALS_KEY, LEGACY_CREDENTIALS_KEY, migrateConfigCredentials, migrateCredentialsDirectory, migrateThinkingEffortMaxToHigh } from './migrations';
import { applyModelGenerationMigration as applyGeneration, isModelGenerationBackupKey, listModelGenerationBackups, modelGenerationRevision, prepareModelGenerationMigration as prepareGeneration, previewModelGenerationMigration as previewGeneration, restoreModelGenerationMigration as restoreGeneration } from './modelGenerationMigration';
import {
  applySectionToToml,
  camelToSnake,
  cloneRecord,
  describeTomlSyntaxError,
  TomlError,
  transformTomlData,
} from './toml';

const CONFIG_SCOPE = '';

type GetEnv = (name: string) => string | undefined;

function isEnvBinding(value: unknown): value is EnvBinding {
  return typeof value === 'string' || (isPlainObject(value) && 'env' in value);
}

function parseBoundRaw(binding: EnvBinding, raw: string): unknown {
  return typeof binding === 'string' ? raw : binding.parse ? binding.parse(raw) : raw;
}

function resolveBinding(
  binding: EnvBinding,
  getEnv: GetEnv,
  existing: unknown,
): unknown {
  if (typeof binding !== 'string') {
    const raw = getEnv(binding.env);
    if (raw !== undefined) {
      const parsed = parseBoundRaw(binding, raw);
      if (parsed !== undefined) return parsed;
    }
  } else {
    const raw = getEnv(binding);
    if (raw !== undefined) return raw;
  }
  if (typeof binding === 'object' && binding.default !== undefined && existing === undefined) {
    return binding.default;
  }
  return existing;
}

function applyEnvBindings(
  target: Record<string, unknown>,
  bindings: AnyEnvBindings,
  getEnv: GetEnv,
): void {
  for (const [key, binding] of Object.entries(bindings)) {
    if (isEnvBinding(binding)) {
      const resolved = resolveBinding(binding, getEnv, target[key]);
      if (resolved !== undefined) target[key] = resolved;
    } else if (binding !== undefined) {
      const child: Record<string, unknown> = isPlainObject(target[key])
        ? { ...target[key] }
        : {};
      target[key] = child;
      applyEnvBindings(child, binding as AnyEnvBindings, getEnv);
      if (Object.keys(child).length === 0) {
        delete target[key];
      }
    }
  }
}

function applySectionEnv(
  base: unknown,
  env: AnyEnvBindings,
  getEnv: GetEnv,
): unknown {
  if (isEnvBinding(env)) {
    return resolveBinding(env, getEnv, base);
  }
  const target: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  applyEnvBindings(target, env, getEnv);
  return target;
}

function isSameSection(
  existing: ConfigSection,
  schema: ConfigSchema<unknown>,
  options: RegisterSectionOptions<unknown>,
): boolean {
  return (
    existing.schema === schema &&
    existing.merge === (options.merge ?? deepMerge) &&
    existing.scope === (options.scope ?? ConfigScope.Core) &&
    existing.env === (options.env as ConfigSection['env']) &&
    existing.stripEnv === (options.stripEnv as ConfigSection['stripEnv']) &&
    existing.fromToml === options.fromToml &&
    existing.toToml === options.toToml &&
    deepEqual(existing.defaultValue, options.defaultValue) &&
    existing.collectDiagnostics === options.collectDiagnostics &&
    existing.entryKeyed === options.entryKeyed &&
    existing.layerMerge === options.layerMerge
  );
}

export class ConfigRegistry extends Disposable implements IConfigRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly sections = new Map<string, ConfigSection>();
  private readonly overlays: ConfigEffectiveOverlay[] = [];
  private readonly _onDidRegisterSection = this._register(
    new Emitter<ConfigSectionRegisteredEvent>(),
  );
  readonly onDidRegisterSection: Event<ConfigSectionRegisteredEvent> =
    this._onDidRegisterSection.event;
  private readonly _onDidUnregisterSection = this._register(
    new Emitter<ConfigSectionRegisteredEvent>(),
  );
  readonly onDidUnregisterSection: Event<ConfigSectionRegisteredEvent> =
    this._onDidUnregisterSection.event;
  private readonly _onDidRegisterOverlay = this._register(
    new Emitter<ConfigOverlayRegisteredEvent>(),
  );
  readonly onDidRegisterOverlay: Event<ConfigOverlayRegisteredEvent> =
    this._onDidRegisterOverlay.event;
  private readonly foldDomains = new Set<string>();

  constructor(
    @ConfigSectionContribution view?: CollectionView<ConfigSectionContribution>,
  ) {
    super();
    for (const c of getConfigSectionContributions()) {
      this.registerSection(c.domain, c.schema, c.options);
    }
    for (const overlay of getConfigOverlayContributions()) {
      this.registerEffectiveOverlay(overlay);
    }
    if (view === undefined) return;
    for (const item of view.items) {
      this.addContribution(item);
    }
    this._register(
      view.onDidChange((change) => {
        for (const contribution of change.removed) {
          this.removeContribution(contribution);
        }
        for (const contribution of change.added) {
          this.addContribution(contribution);
        }
      }),
    );
  }

  private addContribution(contribution: ConfigSectionContribution): void {
    const before = this.sections.get(contribution.domain);
    try {
      this.registerSection(contribution.domain, contribution.schema, contribution.options);
    } catch (error) {
      onUnexpectedError(error);
      return;
    }
    if (before === undefined && this.sections.get(contribution.domain) !== undefined) {
      this.foldDomains.add(contribution.domain);
    }
  }

  private removeContribution(contribution: ConfigSectionContribution): void {
    if (!this.foldDomains.delete(contribution.domain)) return;
    this.unregisterSection(contribution.domain);
  }

  registerSection<T>(
    domain: string,
    schema: ConfigSchema<T>,
    options: RegisterSectionOptions<T> = {},
  ): void {
    const existing = this.sections.get(domain);
    if (existing !== undefined) {
      if (
        isSameSection(
          existing,
          schema as ConfigSchema<unknown>,
          options as RegisterSectionOptions<unknown>,
        )
      ) {
        return;
      }
      throw new BugIndicatingError(`ConfigRegistry: section '${domain}' is already registered`);
    }
    this.sections.set(domain, {
      domain,
      schema: schema as ConfigSchema<unknown>,
      defaultValue: options.defaultValue,
      merge: (options.merge ?? deepMerge) as ConfigMerge<unknown>,
      scope: options.scope ?? ConfigScope.Core,
      env: options.env as ConfigSection['env'],
      stripEnv: options.stripEnv as ConfigSection['stripEnv'],
      fromToml: options.fromToml,
      toToml: options.toToml,
      collectDiagnostics: options.collectDiagnostics,
      entryKeyed: options.entryKeyed,
      layerMerge: options.layerMerge,
    });
    this._onDidRegisterSection.fire({ domain });
  }

  unregisterSection(domain: string): void {
    if (!this.sections.delete(domain)) return;
    this._onDidUnregisterSection.fire({ domain });
  }

  getSection(domain: string): ConfigSection | undefined {
    return this.sections.get(domain);
  }

  listSections(): readonly ConfigSection[] {
    return [...this.sections.values()];
  }

  registerEffectiveOverlay(overlay: ConfigEffectiveOverlay): void {
    this.overlays.push(overlay);
    this._onDidRegisterOverlay.fire({ overlay });
  }

  listEffectiveOverlays(): readonly ConfigEffectiveOverlay[] {
    return [...this.overlays];
  }

  validate<T>(domain: string, value: unknown): T {
    const schema = this.sections.get(domain)?.schema;
    return (schema === undefined ? value : schema.parse(value)) as T;
  }

  merge<T>(domain: string, base: T | undefined, patch: unknown): T {
    const merge = this.sections.get(domain)?.merge ?? deepMerge;
    return merge(base, patch) as T;
  }

  defaultValue<T>(domain: string): T | undefined {
    return this.sections.get(domain)?.defaultValue as T | undefined;
  }
}

export class ConfigService extends Disposable implements IConfigService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChangeConfiguration = this._register(new Emitter<ConfigChangedEvent>());
  readonly onDidChangeConfiguration: Event<ConfigChangedEvent> = this._onDidChangeConfiguration.event;
  private readonly _onDidSectionChange = this._register(new Emitter<ConfigSectionChangedEvent>());
  readonly onDidSectionChange: Event<ConfigSectionChangedEvent> = this._onDidSectionChange.event;
  private readonly _onDidChangeDiagnostics = this._register(
    new Emitter<readonly ConfigDiagnostic[]>(),
  );
  readonly onDidChangeDiagnostics: Event<readonly ConfigDiagnostic[]> =
    this._onDidChangeDiagnostics.event;
  readonly ready: Promise<void>;

  private stateChain: Promise<unknown> = Promise.resolve();

  private rawSnake: ResolvedConfig = {};
  private raw: ResolvedConfig = {};
  private baseSnake: ResolvedConfig = {};
  private homeSnake: ResolvedConfig = {};
  private baseRaw: ResolvedConfig = {};
  private homeRaw: ResolvedConfig = {};
  private presetSnake: ResolvedConfig = {};
  private presetRaw: ResolvedConfig = {};
  private validated: ResolvedConfig = {};
  private effective: ResolvedConfig = {};
  private memory: ResolvedConfig = {};
  private delivered: ResolvedConfig = {};
  private freshCache:
    | {
        readonly envNames: readonly string[];
        readonly fingerprint: string;
        readonly value: ResolvedConfig;
      }
    | undefined;
  private readonly diagnosticsList: ConfigDiagnostic[] = [];
  private lastDiagnosticsSnapshot = '[]';
  private readonly configKey: string;
  private tainted = false;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchCandidate: string | undefined;
  private watchRetries = 0;
  private watchClosed = false;

  constructor(
    @IConfigRegistry private readonly registry: IConfigRegistry,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IAtomicTomlDocumentStore private readonly documentStore: IAtomicTomlDocumentStore,
    @ConfigWriteValidatorContribution private readonly writeValidators: CollectionView<ConfigWriteValidator>,
  ) {
    super();
    this.configKey = this.bootstrap.configKey;
    this._register(this.registry.onDidRegisterSection((e) => this.revalidateDomain(e.domain)));
    this._register(this.registry.onDidUnregisterSection((e) => this.devalidateDomain(e.domain)));
    this._register(this.registry.onDidRegisterOverlay(() => this.reapplyOverlays()));
    const { configKey } = this;
    const { homeDir } = this.bootstrap;
    this.ready = (async () => {
      if (!this.bootstrap.configReadOnly) {
        await migrateCredentialsDirectory(this.documentStore);
        await migrateConfigCredentials(this.documentStore, configKey, this.log);
        await migrateThinkingEffortMaxToHigh(this.documentStore, configKey, homeDir);
      }
      await this.load('load');
    })();
    const changed = (): void => {
      this.watchRetries = 0;
      this.scheduleWatchReload();
    };
    for (const key of [this.configKey, CREDENTIALS_KEY, LEGACY_CREDENTIALS_KEY]) {
      this._register(this.documentStore.watch(CONFIG_SCOPE, key)(changed));
    }
    const baseStore = this.bootstrap.baseConfigDocumentStore;
    if (baseStore !== undefined) {
      for (const key of ['config.toml', CREDENTIALS_KEY, LEGACY_CREDENTIALS_KEY]) {
        this._register(baseStore.watch(CONFIG_SCOPE, key)(changed));
      }
    }
    const refresh = setInterval(() => {
      if (this.watchTimer === undefined) this.scheduleWatchReload();
    }, 10_000);
    refresh.unref?.();
    this._register({ dispose: () => {
      this.watchClosed = true;
      clearTimeout(this.watchTimer);
      clearInterval(refresh);
    } });
  }

  private scheduleWatchReload(): void {
    if (this.watchClosed) return;
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.refreshWatchedConfiguration().catch((error) => {
        if (!this.watchClosed) this.log.warn('config hot reload failed', { error: describeUnknownError(error) });
      });
    }, 200);
    this.watchTimer.unref?.();
  }

  private async refreshWatchedConfiguration(): Promise<void> {
    await this.ready;
    await this.enqueueStateTransition(async () => {
      if (this.watchClosed) return;
      try {
        const read = async (store: IAtomicTomlDocumentStore, key: string, inheritConfig = true, shared = true) => {
          const snapshots = await Promise.all([key, CREDENTIALS_KEY, LEGACY_CREDENTIALS_KEY].map((name, index) =>
            (index === 0 ? inheritConfig : shared)
              ? readConfigDocumentSnapshot(store, name, { recoverMissing: false })
              : Promise.resolve({ data: {}, text: undefined })));
          const [config, credentials, legacy] = snapshots;
          if (legacy!.text !== undefined && credentials!.text !== undefined && legacy!.text !== credentials!.text) {
            throw new Error('Old and new credentials.toml differ');
          }
          return {
            text: snapshots.map((snapshot) => snapshot.text),
            data: mergeConfigCredentials(shared ? config!.data : splitConfigCredentials(config!.data).config, credentials!.text === undefined ? legacy!.data : credentials!.data),
            empty: config!.text === undefined || config!.text.trim().length === 0,
          };
        };
        const home = await read(this.documentStore, this.configKey);
        const baseStore = this.bootstrap.baseConfigDocumentStore;
        const base = baseStore === undefined ? undefined : await read(baseStore, 'config.toml', this.bootstrap.space?.inherit.config !== false, this.bootstrap.space?.inherit.credentials !== 'isolated');
        const baseData = base?.data ?? this.baseSnake;
        if (this.watchClosed) return;
        if (!this.tainted && deepEqual(home.data, this.homeSnake) && deepEqual(baseData, this.baseSnake)) {
          this.watchCandidate = undefined;
          this.watchRetries = 0;
          return;
        }
        const candidate = JSON.stringify([home.text, base?.text]);
        if (candidate !== this.watchCandidate) {
          this.watchCandidate = candidate;
          this.watchRetries = 0;
          this.scheduleWatchReload();
          return;
        }
        if ((home.empty && Object.keys(this.homeSnake).length > 0) && this.watchRetries++ < 5) {
          this.scheduleWatchReload();
          return;
        }
        await this.load('reload');
        if (this.tainted && this.watchRetries++ < 5) {
          this.scheduleWatchReload();
          return;
        }
        this.watchCandidate = undefined;
        this.watchRetries = 0;
      } catch (error) {
        if (this.watchRetries++ < 5) {
          this.scheduleWatchReload();
          return;
        }
        this.watchRetries = 0;
        this.watchCandidate = undefined;
        this.log.warn('config hot reload retry budget exhausted; reloading latest disk state', { error: describeUnknownError(error) });
        await this.load('reload');
      }
    });
  }

  get<T = unknown>(domain: string): T {
    if (Object.prototype.hasOwnProperty.call(this.memory, domain)) return this.memory[domain] as T;
    return this.freshEffective()[domain] as T;
  }

  inspect<T = unknown>(domain: string): ConfigInspectValue<T> {
    const memoryValue = this.memory[domain] as T | undefined;
    return {
      value: this.get<T>(domain),
      defaultValue: this.registry.defaultValue<T>(domain),
      userValue: this.homeRaw[domain] as T | undefined,
      memoryValue,
    };
  }

  getAll(): ResolvedConfig {
    return { ...this.freshEffective(), ...this.memory };
  }

  origins(domain: string): Record<string, ConfigOrigin> {
    const envFields = new Set<string>();
    const walk = (bindings: AnyEnvBindings, path: string[]): void => {
      if (isEnvBinding(bindings)) {
        const name = typeof bindings === 'string' ? bindings : bindings.env;
        const raw = this.bootstrap.getEnv(name);
        if (raw !== undefined && (typeof bindings === 'string' || parseBoundRaw(bindings, raw) !== undefined)) envFields.add(path.join('.'));
        return;
      }
      for (const [key, entry] of Object.entries(bindings)) if (entry !== undefined) walk(entry, [...path, key]);
    };
    const sectionEnv = this.registry.getSection(domain)?.env;
    if (sectionEnv !== undefined) walk(sectionEnv, []);
    return leafOrigins(this.get(domain), this.baseRaw[domain], this.homeRaw[domain], this.validated[domain], this.memory[domain], envFields, this.presetRaw[domain]);
  }

  private freshEffective(): ResolvedConfig {
    const cached = this.freshCache;
    if (cached !== undefined && this.envFingerprint(cached.envNames) === cached.fingerprint) {
      return cached.value;
    }
    const accessed = new Set<string>();
    const getEnv = (name: string): string | undefined => {
      accessed.add(name);
      return this.bootstrap.getEnv(name);
    };
    const effective: ResolvedConfig = { ...this.validated };
    this.applySectionEnvBindings(effective, false, getEnv);
    this.applyEnvOverlay(effective, false, getEnv);
    const envNames = [...accessed].sort();
    this.freshCache = { envNames, fingerprint: this.envFingerprint(envNames), value: effective };
    return effective;
  }

  private envFingerprint(names: readonly string[]): string {
    let fingerprint = '';
    for (const name of names) {
      fingerprint += `${name}\u0000${this.bootstrap.getEnv(name) ?? '\u0001'}\u0002`;
    }
    return fingerprint;
  }

  private invalidateFresh(): void {
    this.freshCache = undefined;
  }

  diagnostics(): readonly ConfigDiagnostic[] {
    return [...this.diagnosticsList];
  }

  /** Append a diagnostic, skipping exact duplicates (rebuilds re-run the same checks). */
  private pushDiagnostic(diagnostic: ConfigDiagnostic): void {
    const duplicate = this.diagnosticsList.some(
      (existing) =>
        existing.domain === diagnostic.domain &&
        existing.severity === diagnostic.severity &&
        existing.message === diagnostic.message,
    );
    if (!duplicate) this.diagnosticsList.push(diagnostic);
  }

  private emitDiagnosticsIfChanged(): void {
    const snapshot = JSON.stringify(this.diagnosticsList);
    if (snapshot === this.lastDiagnosticsSnapshot) return;
    this.lastDiagnosticsSnapshot = snapshot;
    this._onDidChangeDiagnostics.fire(this.diagnostics());
  }

  async removeOverride(domain: string, keyPath: readonly string[]): Promise<void> {
    await this.ready;
    await this.enqueueStateTransition(async () => {
      this.assertPersistable();
      await this.persist(domain, (stagedRaw, stagedRawSnake) => {
        const snake = camelToSnake(domain);
        const root = stagedRawSnake[snake];
        if (keyPath.length === 0) {
          delete stagedRawSnake[snake];
          delete stagedRaw[domain];
          return;
        }
        if (!isPlainObject(root)) return;
        const parents: { parent: Record<string, unknown>; key: string }[] = [];
        let current: Record<string, unknown> = root;
        for (let index = 0; index < keyPath.length; index += 1) {
          const part = keyPath[index]!;
          const key = Object.hasOwn(current, part) ? part : camelToSnake(part);
          parents.push({ parent: current, key });
          const child = current[key];
          if (index < keyPath.length - 1 && !isPlainObject(child)) return;
          if (isPlainObject(child)) current = child;
        }
        const last = parents.pop();
        if (last === undefined) return;
        delete last.parent[last.key];
        for (const { parent, key } of parents.reverse()) {
          if (isPlainObject(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
        }
        if (Object.keys(root).length === 0) delete stagedRawSnake[snake];
        const transformed = transformTomlData({ [snake]: stagedRawSnake[snake] }, this.registry);
        stagedRaw[domain] = transformed[domain];
      }, true);
      this.rebuildEffective('set', [domain]);
    });
  }

  async set(
    domain: string,
    patch: unknown,
    target: ConfigTarget = ConfigTarget.User,
  ): Promise<void> {
    await this.ready;
    if (target === ConfigTarget.Memory) {
      const next = this.registry.merge(domain, this.memory[domain], patch);
      const validated = this.validateWrite(domain, this.registry.validate(domain, next));
      if (validated === undefined) {
        delete this.memory[domain];
      } else {
        this.memory[domain] = validated;
      }
      this.commit('set', [domain]);
      return;
    }
    await this.enqueueStateTransition(async () => {
      this.assertPersistable();
      await this.persist(domain, (stagedRaw, stagedRawSnake) => {
        const next = this.registry.merge(domain, stagedRaw[domain], patch);
        const writing = this.bootstrap.baseConfigDocumentStore === undefined ? this.registry.validate(domain, next) : next;
        this.validateLayeredWrite(domain, writing);
        const stripped = this.stripEnv(domain, writing, stagedRaw, stagedRawSnake);
        if (stripped === undefined) {
          delete stagedRaw[domain];
        } else {
          this.validateWrite(domain, this.validateLayeredWrite(domain, stripped));
          stagedRaw[domain] = stripped;
        }
      });
      this.rebuildEffective('set', [domain]);
    });
  }

  async replace(
    domain: string,
    value: unknown,
    target: ConfigTarget = ConfigTarget.User,
  ): Promise<void> {
    await this.ready;
    const effectiveValue = value === null ? undefined : value;
    if (target === ConfigTarget.Memory) {
      if (effectiveValue === undefined) {
        delete this.memory[domain];
      } else {
        this.memory[domain] = this.validateWrite(domain, this.registry.validate(domain, effectiveValue));
      }
      this.commit('set', [domain]);
      return;
    }
    await this.enqueueStateTransition(async () => {
      this.assertPersistable();
      await this.persist(domain, (stagedRaw, stagedRawSnake) => {
        const stripped = this.stripEnv(domain, effectiveValue, stagedRaw, stagedRawSnake);
        if (stripped === undefined) {
          delete stagedRaw[domain];
        } else {
          this.validateWrite(domain, this.validateLayeredWrite(domain, stripped));
          stagedRaw[domain] = stripped;
        }
      }, true);
      this.rebuildEffective('set', [domain]);
    });
  }

  async replaceSections(
    sections: Readonly<Record<string, unknown>>,
    target: ConfigTarget = ConfigTarget.User,
    expectedValues?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.ready;
    const domains = Object.keys(sections);
    if (domains.length === 0) return;
    if (target === ConfigTarget.Memory) {
      const staged: ResolvedConfig = { ...this.memory };
      assertExpectedConfigValues(staged, expectedValues);
      for (const domain of domains) {
        const value = sections[domain];
        if (value === undefined || value === null) {
          delete staged[domain];
        } else {
          staged[domain] = this.validateWrite(domain, this.registry.validate(domain, value));
        }
      }
      this.memory = staged;
      this.commit('set', domains);
      return;
    }
    await this.enqueueStateTransition(async () => {
      this.assertPersistable();
      await this.persistDomains(domains, (stagedRaw, stagedRawSnake) => {
        assertExpectedConfigValues(stagedRaw, expectedValues);
        for (const domain of domains) {
          const value = sections[domain] === null ? undefined : sections[domain];
          const stripped = this.stripEnv(domain, value, stagedRaw, stagedRawSnake);
          if (stripped === undefined) {
            delete stagedRaw[domain];
          } else {
            this.validateWrite(domain, this.validateLayeredWrite(domain, stripped));
            stagedRaw[domain] = stripped;
          }
        }
      }, true);
      this.rebuildEffective('set', domains);
    });
  }

  private mergeLayers(base: ResolvedConfig, home: ResolvedConfig): ResolvedConfig {
    const merged = mergeConfigLayers(base, home);
    for (const section of this.registry.listSections()) {
      const key = camelToSnake(section.domain);
      if (section.layerMerge === 'union' && Array.isArray(base[key]) && Array.isArray(home[key])) {
        merged[key] = [...new Set([...base[key], ...home[key]])];
      }
    }
    for (const key of ['providers', 'models']) {
      if (!isPlainObject(home[key]) || !isPlainObject(merged[key])) continue;
      const entries = { ...merged[key] };
      for (const [name, value] of Object.entries(home[key])) {
        if (isPlainObject(value) && value['enabled'] === false) delete entries[name];
      }
      merged[key] = entries;
    }
    return merged;
  }

  private validateLayeredWrite(domain: string, value: unknown): unknown {
    const lower = transformTomlData(this.mergeLayers(this.presetSnake, this.baseSnake), this.registry);
    const candidate = this.registry.merge(domain, lower[domain], value);
    return this.registry.validate(domain, candidate);
  }

  private validateWrite<T>(domain: string, value: T): T {
    for (const validator of this.writeValidators.items) {
      if (validator.domain === domain) validator.validate(value);
    }
    return value;
  }

  private stripEnv(
    domain: string,
    value: unknown,
    raw: ResolvedConfig,
    rawSnake: ResolvedConfig,
  ): unknown {
    let result = value;
    const section = this.registry.getSection(domain);
    if (section?.stripEnv !== undefined) {
      const getEnv = (name: string): string | undefined => this.bootstrap.getEnv(name);
      result = section.stripEnv(result, raw[domain], getEnv);
    }
    if (result === undefined) return result;
    for (const overlay of this.registry.listEffectiveOverlays()) {
      if (overlay.strip === undefined) continue;
      result = overlay.strip(domain, result, rawSnake);
      if (result === undefined) return result;
    }
    return result;
  }

  async reload(): Promise<void> {
    await this.ready;
    await this.enqueueStateTransition(() => this.load('reload'));
  }

  async previewModelGenerationMigration() {
    await this.ready;
    const prepared = await previewGeneration(this.documentStore, this.configKey);
    return {
      revision: modelGenerationRevision(prepared.originalText),
      changes: prepared.preview.changes,
      needsReview: prepared.preview.needsConfirmation.map(({ modelId, code, field }) => ({ modelId, code, ...(field === undefined ? {} : { field }) })),
      backups: await listModelGenerationBackups(this.documentStore, this.configKey),
    };
  }

  async applyModelGenerationMigration(expectedRevision: string): Promise<{ readonly backupKey: string; readonly revision: string }> {
    await this.ready;
    return this.enqueueStateTransition(async () => {
      this.assertPersistable();
      if (this.bootstrap.configReadOnly) throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Configuration is read-only');
      const prepared = await previewGeneration(this.documentStore, this.configKey);
      if (modelGenerationRevision(prepared.originalText) !== expectedRevision) {
        throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Config changed since migration preview');
      }
      const { backupKey } = await applyGeneration(this.documentStore, this.configKey, prepared);
      if (backupKey === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'No model parameter changes to migrate');
      this.invalidateFresh();
      await this.load('reload', true);
      this.assertPersistable();
      return { backupKey, revision: modelGenerationRevision(prepared.nextText) };
    });
  }

  async restoreModelGenerationMigration(backupKey: string, expectedRevision: string): Promise<{ readonly revision: string }> {
    await this.ready;
    return this.enqueueStateTransition(async () => {
      this.assertPersistable();
      if (this.bootstrap.configReadOnly) throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Configuration is read-only');
      if (!isModelGenerationBackupKey(this.configKey, backupKey)) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Invalid migration backup key');
      const backup = await this.documentStore.getText(CONFIG_SCOPE, backupKey, { recoverMissing: false });
      if (backup === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Migration backup missing');
      const prepared = prepareGeneration(backup);
      const current = await this.documentStore.getText(CONFIG_SCOPE, this.configKey, { recoverMissing: false });
      if (current === undefined || modelGenerationRevision(current) !== expectedRevision || prepared.nextText !== current) {
        throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Config changed since restore preview');
      }
      if (prepared.originalText === prepared.nextText) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Backup contains no migratable model changes');
      await restoreGeneration(this.documentStore, this.configKey, prepared, backupKey);
      this.invalidateFresh();
      await this.load('reload', true);
      this.assertPersistable();
      return { revision: modelGenerationRevision(prepared.originalText) };
    });
  }

  private enqueueStateTransition<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateChain.then(() => fn());
    this.stateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(source: ConfigChangeSource, skipCredentialMigration = false): Promise<void> {
    this.diagnosticsList.length = 0;
    if (this.bootstrap.homeDiagnostic !== undefined) this.pushDiagnostic({ severity: 'error', message: this.bootstrap.homeDiagnostic });
    let fileData: ResolvedConfig = {};
    let failed = false;
    try {
      if (source === 'reload' && !skipCredentialMigration && !this.bootstrap.configReadOnly) {
        await migrateCredentialsDirectory(this.documentStore);
        await migrateConfigCredentials(this.documentStore, this.configKey, this.log);
      }
      const readOptions = this.bootstrap.configReadOnly ? { recoverMissing: false } : undefined;
      const configSnapshot = await readConfigDocumentSnapshot(this.documentStore, this.configKey, readOptions);
      const credentialSnapshot = await readConfigDocumentSnapshot(this.documentStore, CREDENTIALS_KEY, readOptions);
      const legacySnapshot = await readConfigDocumentSnapshot(this.documentStore, LEGACY_CREDENTIALS_KEY, { recoverMissing: false });
      if (legacySnapshot.text !== undefined && credentialSnapshot.text !== undefined && legacySnapshot.text !== credentialSnapshot.text) {
        throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Old and new credentials.toml differ; inspect both files before loading.');
      }
      fileData = mergeConfigCredentials(configSnapshot.data, credentialSnapshot.text === undefined ? legacySnapshot.data : credentialSnapshot.data);
    } catch (error) {
      failed = true;
      const message =
        error instanceof TomlError
          ? `Failed to parse ${this.bootstrap.configPath} or credentials.toml: ${describeTomlSyntaxError(error)}`
          : describeUnknownError(error);
      this.pushDiagnostic({ severity: 'error', message });
      this.log.warn('config load failed', { error: describeUnknownError(error) });
      if (source !== 'load') {
        this.tainted = true;
        this.emitDiagnosticsIfChanged();
        return;
      }
    }
    this.tainted = failed;
    let baseData = this.baseSnake;
    const baseStore = this.bootstrap.baseConfigDocumentStore;
    if (baseStore !== undefined) {
      try {
        const inheritConfig = this.bootstrap.space?.inherit.config !== false;
        const baseConfig = inheritConfig
          ? await readConfigDocumentSnapshot(baseStore, 'config.toml', { recoverMissing: false })
          : { data: {}, text: undefined };
        const shared = this.bootstrap.space?.inherit.credentials !== 'isolated';
        const baseCredentials = shared
          ? await readConfigDocumentSnapshot(baseStore, CREDENTIALS_KEY, { recoverMissing: false })
          : { data: {}, text: undefined };
        const baseLegacy = shared
          ? await readConfigDocumentSnapshot(baseStore, LEGACY_CREDENTIALS_KEY, { recoverMissing: false })
          : { data: {}, text: undefined };
        if (baseLegacy.text !== undefined && baseCredentials.text !== undefined && baseLegacy.text !== baseCredentials.text) {
          throw new Error('Base credentials.toml files differ');
        }
        if (inheritConfig && baseConfig.text === undefined && (!shared || (baseCredentials.text === undefined && baseLegacy.text === undefined))) {
          this.pushDiagnostic({ severity: 'warning', message: `Base configuration unavailable: ${this.bootstrap.baseHomeDir}` });
        }
        const publicBase = shared ? baseConfig.data : splitConfigCredentials(baseConfig.data).config;
        baseData = mergeConfigCredentials(publicBase, baseCredentials.text === undefined ? baseLegacy.data : baseCredentials.data);
        if (baseConfig.text !== undefined) {
          try {
            if (prepareGeneration(baseConfig.text).preview.changes.length > 0) {
              this.pushDiagnostic({ severity: 'warning', message: `Base config requires model-generation migration in the main space: ${this.bootstrap.baseHomeDir}` });
            }
          } catch {
            this.pushDiagnostic({ severity: 'warning', message: `Base model-generation migration preview unavailable: ${this.bootstrap.baseHomeDir}` });
          }
        }
      } catch (error) {
        this.pushDiagnostic({ severity: 'warning', message: `Base configuration unavailable (${this.bootstrap.baseHomeDir}); retaining previous values: ${error instanceof TomlError ? describeTomlSyntaxError(error) : describeUnknownError(error)}` });
        this.log.warn('base config load failed', { error: describeUnknownError(error) });
      }
    }
    this.baseSnake = cloneRecord(baseData);
    this.homeSnake = cloneRecord(fileData);
    this.baseRaw = transformTomlData(this.baseSnake, this.registry);
    this.homeRaw = transformTomlData(this.homeSnake, this.registry);
    const preset = this.bootstrap.space?.preset;
    if (preset !== undefined && findSpacePreset(preset) === undefined) {
      this.pushDiagnostic({ severity: 'warning', message: `Unknown space preset ${preset}; using Kiki defaults` });
    }
    this.presetSnake = this.bootstrap.space === undefined ? {} : spacePresetDefaults(preset);
    this.presetRaw = transformTomlData(this.presetSnake, this.registry);
    const nextRawSnake = cloneRecord(this.mergeLayers(this.mergeLayers(this.presetSnake, baseData), fileData));
    for (const section of this.registry.listSections()) {
      if (section.collectDiagnostics === undefined) continue;
      const rawSection = nextRawSnake[camelToSnake(section.domain)];
      for (const diagnostic of section.collectDiagnostics(rawSection)) {
        this.pushDiagnostic(diagnostic);
      }
    }
    for (const diagnostic of collectRemovedSectionDiagnostics(nextRawSnake)) {
      this.pushDiagnostic(diagnostic);
    }
    if (source !== 'load' && JSON.stringify(nextRawSnake) === JSON.stringify(this.rawSnake)) {
      const scratch = this.buildValidated(this.raw);
      this.applySectionEnvBindings(scratch, true);
      this.applyEnvOverlay(scratch);
      this.emitDiagnosticsIfChanged();
      return;
    }
    this.rawSnake = nextRawSnake;
    this.raw = transformTomlData(nextRawSnake, this.registry);
    this.rebuildEffective(source);
  }

  private rebuildEffective(
    source: ConfigChangeSource = 'reload',
    domains?: readonly string[],
  ): void {
    const previous = this.effective;
    this.validated = this.buildValidated(this.raw);
    this.invalidateFresh();
    const next = { ...this.validated };
    this.applySectionEnvBindings(next, true);
    this.applyEnvOverlay(next);
    this.effective = next;

    const candidates = new Set(
      domains ?? [...Object.keys(previous), ...Object.keys(next)],
    );
    for (const domain of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (!deepEqual(previous[domain], next[domain])) candidates.add(domain);
    }
    this.commit(source, [...candidates]);
    this.emitDiagnosticsIfChanged();
  }

  private deliveredValue(domain: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.memory, domain)
      ? this.memory[domain]
      : this.effective[domain];
  }

  private commit(source: ConfigChangeSource, domains: readonly string[]): void {
    for (const domain of domains) {
      const previousValue = this.delivered[domain];
      const value = this.deliveredValue(domain);
      this._onDidChangeConfiguration.fire({ domain, source, value, previousValue });
      if (!deepEqual(value, previousValue)) {
        this._onDidSectionChange.fire({ domain, source, value, previousValue });
      }
      this.delivered[domain] = value;
    }
  }

  private buildValidated(raw: ResolvedConfig): ResolvedConfig {
    const previous = this.validated;
    const validated: ResolvedConfig = {};
    for (const [domain, value] of Object.entries(raw)) {
      try {
        validated[domain] = this.validateSection(domain, value, true, previous[domain]);
      } catch (error) {
        this.pushDiagnostic({
          domain,
          severity: 'warning',
          message: `Ignored invalid config section '${domain}'${this.bootstrap.baseHomeDir === undefined ? '' : ` (base/home conflict; home override: ${Object.hasOwn(this.homeRaw, domain)})`}: ${describeUnknownError(error)}`,
        });
        if (Object.prototype.hasOwnProperty.call(previous, domain)) {
          validated[domain] = previous[domain];
        }
      }
    }
    for (const section of this.registry.listSections()) {
      if (validated[section.domain] === undefined && section.defaultValue !== undefined) {
        validated[section.domain] = section.defaultValue;
      }
    }
    return validated;
  }

  private validateSection(
    domain: string,
    value: unknown,
    reportErrors: boolean,
    previous?: unknown,
  ): unknown {
    const entryKeyed = this.registry.getSection(domain)?.entryKeyed;
    if (entryKeyed === undefined || !isPlainObject(value)) {
      return this.registry.validate(domain, value);
    }
    const previousEntries = isPlainObject(previous) ? previous : {};
    const salvaged: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      try {
        salvaged[entryKey] = entryKeyed.parse(entry);
      } catch (error) {
        const retained = Object.prototype.hasOwnProperty.call(previousEntries, entryKey);
        if (retained) salvaged[entryKey] = previousEntries[entryKey];
        if (reportErrors) {
          this.pushDiagnostic({
            domain,
            severity: 'warning',
            message: `${retained ? 'Rejected' : 'Ignored'} invalid [${domain}] entry '${entryKey}'${retained ? ' and retained its last valid value' : ''}: ${describeUnknownError(error)}`,
          });
        }
      }
    }
    return salvaged;
  }

  private applySectionEnvBindings(
    effective: ResolvedConfig,
    reportErrors: boolean,
    getEnv: (name: string) => string | undefined = (name) => this.bootstrap.getEnv(name),
  ): void {
    for (const section of this.registry.listSections()) {
      if (section.env === undefined) continue;
      try {
        const base = effective[section.domain];
        const next = applySectionEnv(base, section.env, getEnv);
        effective[section.domain] = this.validateSection(
          section.domain,
          next,
          reportErrors,
          base,
        );
      } catch (error) {
        if (reportErrors) {
          this.pushDiagnostic({
            domain: section.domain,
            severity: 'warning',
            message: `Ignoring env overlay for '${section.domain}': ${describeUnknownError(error)}`,
          });
        }
      }
    }
  }

  private applyEnvOverlay(
    effective: ResolvedConfig,
    reportErrors = true,
    getEnv: (name: string) => string | undefined = (name) => this.bootstrap.getEnv(name),
  ): void {
    const validate = (domain: string, value: unknown): unknown =>
      this.registry.validate(domain, value);
    for (const overlay of this.registry.listEffectiveOverlays()) {
      try {
        overlay.apply(effective, getEnv, validate);
      } catch (error) {
        if (reportErrors) {
          this.pushDiagnostic({
            severity: 'warning',
            message: `Ignoring config environment overlay: ${describeUnknownError(error)}`,
          });
        }
      }
    }
  }

  private reapplyOverlays(): void {
    const before = this.effective;
    this.validated = this.buildValidated(this.raw);
    this.invalidateFresh();
    const next = { ...this.validated };
    this.applySectionEnvBindings(next, true);
    this.applyEnvOverlay(next);
    this.effective = next;
    this.commit('reload', [...new Set([...Object.keys(before), ...Object.keys(next)])]);
    this.emitDiagnosticsIfChanged();
  }

  private revalidateDomain(domain: string): void {
    const section = this.registry.getSection(domain);
    if (section === undefined) return;
    this.invalidateFresh();

    if (section.fromToml !== undefined) {
      const rawSnakeValue = this.rawSnake[camelToSnake(domain)];
      if (rawSnakeValue !== undefined) {
        this.raw[domain] = section.fromToml(rawSnakeValue);
      }
    }

    if (this.raw[domain] !== undefined) {
      try {
        const validatedValue = this.validateSection(
          domain,
          this.raw[domain],
          true,
          this.validated[domain],
        );
        this.validated[domain] = validatedValue;
        this.effective[domain] = validatedValue;
      } catch {
        return;
      }
    } else if (section.defaultValue !== undefined && this.effective[domain] === undefined) {
      this.validated[domain] = section.defaultValue;
      this.effective[domain] = section.defaultValue;
    } else {
      return;
    }

    this.applyEnvOverlay(this.effective);
    if (section.env !== undefined) {
      const getEnv = (name: string): string | undefined => this.bootstrap.getEnv(name);
      try {
        const base = this.effective[domain];
        const next = applySectionEnv(base, section.env, getEnv);
        this.effective[domain] = this.validateSection(domain, next, true, base);
      } catch (error) {
        this.pushDiagnostic({
          domain,
          severity: 'warning',
          message: `Ignoring env overlay for '${domain}': ${describeUnknownError(error)}`,
        });
      }
    }
    this.commit('reload', [domain]);
    this.emitDiagnosticsIfChanged();
  }

  private devalidateDomain(domain: string): void {
    if (this.registry.getSection(domain) !== undefined) return;
    this.invalidateFresh();

    const snakeKey = camelToSnake(domain);
    const rawSnakeValue = this.rawSnake[snakeKey];
    if (rawSnakeValue === undefined) {
      delete this.raw[domain];
      delete this.validated[domain];
      delete this.effective[domain];
    } else {
      const raw = transformTomlData({ [snakeKey]: rawSnakeValue }, this.registry)[domain];
      this.raw[domain] = raw;
      this.validated[domain] = raw;
      this.effective[domain] = raw;
    }

    this.applyEnvOverlay(this.effective);
    this.commit('reload', [domain]);
  }

  private assertPersistable(): void {
    if (!this.tainted) return;
    throw new Error2(
      ErrorCodes.CONFIG_PERSIST_BLOCKED,
      `Refusing to persist config: ${this.bootstrap.configPath} or credentials.toml needs inspection; fix the files and reload before writing.`,
    );
  }

  private async persist(
    domain: string,
    rebase: (stagedRaw: ResolvedConfig, stagedRawSnake: ResolvedConfig) => void,
    replaceSecrets = false,
  ): Promise<void> {
    await this.persistDomains([domain], rebase, replaceSecrets);
  }

  private async persistDomains(
    domains: readonly string[],
    rebase: (stagedRaw: ResolvedConfig, stagedRawSnake: ResolvedConfig) => void,
    replaceSecrets = false,
  ): Promise<void> {
    this.assertPersistable();
    try {
      await this.persistDomainsGuarded(this.documentStore, domains, rebase, replaceSecrets);
    } catch (error) {
      if (error instanceof Error2 && error.details?.['reason'] === 'write_conflict') {
        this.log.warn('config write conflicted with an external edit; using latest disk values', { domains });
        await this.load('reload');
      }
      throw error;
    }
    this.invalidateFresh();
  }

  private async persistDomainsGuarded(
    store: IAtomicTomlDocumentStore,
    domains: readonly string[],
    rebase: (stagedRaw: ResolvedConfig, stagedRawSnake: ResolvedConfig) => void,
    replaceSecrets: boolean,
  ): Promise<void> {
    let config: ResolvedConfig = {};
    let credentials: ResolvedConfig = {};
    let configText: string | undefined;
    let credentialsText: string | undefined;
    try {
      if (!this.bootstrap.configReadOnly) await migrateCredentialsDirectory(store);
      const configSnapshot = await readConfigDocumentSnapshot(store, this.configKey);
      const credentialsSnapshot = await readConfigDocumentSnapshot(store, CREDENTIALS_KEY);
      config = configSnapshot.data;
      credentials = credentialsSnapshot.data;
      configText = configSnapshot.text;
      credentialsText = credentialsSnapshot.text;
    } catch (error) {
      const message =
        error instanceof TomlError
          ? `Failed to parse ${this.bootstrap.configPath} or credentials.toml: ${describeTomlSyntaxError(error)}`
          : describeUnknownError(error);
      this.pushDiagnostic({ severity: 'error', message });
      this.emitDiagnosticsIfChanged();
      this.log.warn('config persist aborted: re-read failed', {
        error: describeUnknownError(error),
      });
      this.tainted = true;
      throw new Error2(
        ErrorCodes.CONFIG_PERSIST_BLOCKED,
        `Refusing to persist config: ${this.bootstrap.configPath} or credentials.toml could not be read; fix the file and reload before writing.`,
        { cause: error },
      );
    }
    const stagedRawSnake = cloneRecord(mergeConfigCredentials(config, credentials));
    if (!deepEqual(stagedRawSnake, this.homeSnake)) {
      this.log.warn('config changed externally before settings write; rebasing on latest disk values', { domains });
    }
    const stagedRaw = transformTomlData(stagedRawSnake, this.registry);
    rebase(stagedRaw, stagedRawSnake);
    for (const domain of domains) {
      if (replaceSecrets) {
        const snakeKey = camelToSnake(domain);
        delete stagedRawSnake[snakeKey];
      }
      applySectionToToml(stagedRawSnake, domain, stagedRaw[domain], this.registry);
    }
    const separated = splitConfigCredentials(stagedRawSnake);
    let writtenCredentials: string | undefined;
    try {
      writtenCredentials = await writeConfigDocument(store, CREDENTIALS_KEY, credentials, credentialsText, separated.credentials);
    } catch (error) {
      if (error instanceof Error2 && error.code === ErrorCodes.CONFIG_PERSIST_BLOCKED) this.tainted = true;
      throw error;
    }
    try {
      await writeConfigDocument(store, this.configKey, config, configText, separated.config);
    } catch (error) {
      if (error instanceof Error2 && error.code === ErrorCodes.CONFIG_PERSIST_BLOCKED) this.tainted = true;
      if (writtenCredentials !== undefined) {
        try {
          if (!await store.compareAndSetText(CONFIG_SCOPE, CREDENTIALS_KEY, writtenCredentials, credentialsText)) {
            throw new Error('Credential rollback conflicted with another writer', { cause: error });
          }
        } catch (rollbackError) {
          this.tainted = true;
          throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Config write failed; credential rollback could not be completed. Reload and inspect both config files.', { cause: rollbackError });
        }
      }
      throw error;
    }
    this.homeSnake = cloneRecord(stagedRawSnake);
    const layered = this.bootstrap.space !== undefined || this.bootstrap.baseConfigDocumentStore !== undefined;
    this.homeRaw = layered ? transformTomlData(this.homeSnake, this.registry) : stagedRaw;
    this.rawSnake = layered ? this.mergeLayers(this.mergeLayers(this.presetSnake, this.baseSnake), stagedRawSnake) : stagedRawSnake;
    this.raw = layered ? transformTomlData(this.rawSnake, this.registry) : stagedRaw;
  }
}

function assertExpectedConfigValues(current: ResolvedConfig, expected: Readonly<Record<string, unknown>> | undefined): void {
  for (const [domain, value] of Object.entries(expected ?? {})) {
    if (!deepEqual(current[domain], value)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Configuration changed during validation. Reload settings and retry.');
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IConfigRegistry,
  ConfigRegistry,
  ScopeActivation.OnScopeCreated,
  'config',
);
registerScopedService(
  LifecycleScope.App,
  IConfigService,
  ConfigService,
  ScopeActivation.OnScopeCreated,
  'config',
);
