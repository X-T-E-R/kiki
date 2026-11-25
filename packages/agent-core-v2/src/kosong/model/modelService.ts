import { Disposable } from '#/_base/di/lifecycle';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event, type IWaitUntil } from '#/_base/event';
import { IPluginLlmDirectoryService, type PluginModelLookup } from '#/app/plugin/pluginLlmDirectory';
import { LifecycleScope } from '#/app/scopes';

import { deepEqual, diffRecords, isEmptyDiff } from '#/_base/utils/recordDiff';

import {
  type DefaultModelChangedEvent,
  IModelService,
  type ModelRecord,
  type ModelsChangedEvent,
  type ModelsSection,
} from './model';
import {
  buildModelIdLookupIndex,
  resolveModelId,
  resolveModelIdWithIndex,
  type ModelIdLookupIndex,
} from './resolveModelId';

export { resolveModelId };

const NO_ABORT = new AbortController().signal;

function pluginLookupToModelRecord(lookup: PluginModelLookup): ModelRecord {
  const { provider, descriptor } = lookup;
  return {
    providerId: provider.definition.id,
    name: descriptor.wireModel,
    displayName: descriptor.displayName,
    maxContextSize: descriptor.maxContextSize,
    maxInputSize: descriptor.maxInputSize,
    maxOutputSize: descriptor.maxOutputSize,
    capabilities: [...descriptor.capabilities],
    supportEfforts: descriptor.supportEfforts === undefined ? undefined : [...descriptor.supportEfforts],
    defaultEffort: descriptor.defaultEffort,
  };
}

/** Stays on `Disposable` rather than `Service`: its own `get` collides with the Fiber vocabulary. */
export class ModelService extends Disposable implements IModelService {
  declare readonly _serviceBrand: undefined;

  private models: Readonly<Record<string, ModelRecord>> = {};
  private defaultModel: string | undefined;
  private hydrated = false;
  private cachedModelsRef: Readonly<Record<string, ModelRecord>> | undefined;
  private cachedPluginRevision = -1;
  private lookupIndex: ModelIdLookupIndex | undefined;
  private readonly resolutionCache = new Map<string, string | undefined>();
  private resolveReady!: () => void;
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  private readonly _onDidChangeModels = this._register(
    new AsyncEmitter<ModelsChangedEvent & IWaitUntil>(),
  );
  readonly onDidChangeModels: Event<ModelsChangedEvent & IWaitUntil> =
    this._onDidChangeModels.event;
  private readonly _onDidChangeDefaultModel = this._register(
    new AsyncEmitter<DefaultModelChangedEvent & IWaitUntil>(),
  );
  readonly onDidChangeDefaultModel: Event<DefaultModelChangedEvent & IWaitUntil> =
    this._onDidChangeDefaultModel.event;

  constructor(
    @ref(IPluginLlmDirectoryService) private readonly pluginLlm?: LiveRef<IPluginLlmDirectoryService>,
  ) {
    super();
  }

  resolveId(id: string): string | undefined {
    const pluginRev = this.pluginLlm?.current?.revision ?? -1;
    if (this.cachedModelsRef !== this.models || this.cachedPluginRevision !== pluginRev) {
      this.resolutionCache.clear();
      this.lookupIndex = undefined;
      this.cachedModelsRef = this.models;
      this.cachedPluginRevision = pluginRev;
    }
    if (this.resolutionCache.has(id)) return this.resolutionCache.get(id);
    if (Object.hasOwn(this.models, id) && this.models[id] !== undefined) {
      this.resolutionCache.set(id, id);
      return id;
    }
    this.lookupIndex ??= buildModelIdLookupIndex(this.models);
    const resolved = resolveModelIdWithIndex(
      this.models,
      this.lookupIndex,
      id,
      ({ candidates, resolved: winner }) => {
        console.warn(
          `[model] ambiguous model id "${id}" resolves to "${winner}" (first configured of ${candidates.map((candidate) => `"${candidate}"`).join(', ')}); use a full model id to pin another`,
        );
      },
    ) ?? this.pluginLlm?.current?.resolveModelId(id);
    this.resolutionCache.set(id, resolved);
    return resolved;
  }

  get(id: string): ModelRecord | undefined {
    return this.models[id];
  }

  getEffective(id: string): ModelRecord | undefined {
    const configured = this.models[id];
    const pluginLookup = this.pluginLlm?.current?.getModel(id);
    if (pluginLookup === undefined) return configured;
    const base = pluginLookupToModelRecord(pluginLookup);
    if (configured === undefined) return base;
    if (configured.baseUrl !== undefined && configured.baseUrl.trim().length > 0) return configured;
    return { ...base, ...configured, protocol: configured.protocol ?? base.protocol, providerId: configured.providerId ?? base.providerId };
  }

  list(): Readonly<Record<string, ModelRecord>> {
    return this.models;
  }

  listEffective(): Readonly<Record<string, ModelRecord>> {
    const directory = this.pluginLlm?.current;
    if (directory === undefined) return this.models;
    const pluginModels = directory.listModels();
    if (pluginModels.length === 0) return this.models;
    const merged: Record<string, ModelRecord> = {};
    for (const lookup of pluginModels) {
      merged[lookup.descriptor.id] = pluginLookupToModelRecord(lookup);
    }
    for (const [id, record] of Object.entries(this.models)) {
      const base = merged[id];
      if (base === undefined || (record.baseUrl !== undefined && record.baseUrl.trim().length > 0)) {
        merged[id] = record;
      } else {
        merged[id] = { ...base, ...record, protocol: record.protocol ?? base.protocol, providerId: record.providerId ?? base.providerId };
      }
    }
    return merged;
  }

  getDefaultModel(): string | undefined {
    return this.defaultModel;
  }

  loadAll(models: ModelsSection, defaultModel: string | undefined): void {
    void this.applyRecords(models);
    void this.applyDefaultModel(defaultModel);
    if (!this.hydrated) {
      this.hydrated = true;
      this.resolveReady();
    }
  }

  async replaceAll(models: ModelsSection): Promise<void> {
    await this.ready;
    await this.applyRecords(models);
  }

  async set(id: string, model: ModelRecord): Promise<void> {
    await this.ready;
    if (deepEqual(this.models[id], model)) return;
    await this.applyRecords({ ...this.models, [id]: model });
  }

  async delete(id: string): Promise<void> {
    await this.ready;
    if (!(id in this.models)) return;
    const { [id]: _removed, ...rest } = this.models;
    await this.applyRecords(rest);
  }

  async setDefaultModel(id: string | undefined): Promise<void> {
    await this.ready;
    await this.applyDefaultModel(id);
  }

  private async applyRecords(next: Readonly<Record<string, ModelRecord>>): Promise<void> {
    const diff = diffRecords(this.models, next);
    if (isEmptyDiff(diff)) return;
    this.models = { ...next };
    this.cachedModelsRef = this.models;
    this.lookupIndex = undefined;
    this.resolutionCache.clear();
    await this._onDidChangeModels.fireAsync(diff, NO_ABORT);
  }

  private async applyDefaultModel(id: string | undefined): Promise<void> {
    if (this.defaultModel === id) return;
    this.defaultModel = id;
    await this._onDidChangeDefaultModel.fireAsync({ id }, NO_ABORT);
  }
}

registerScopedService(LifecycleScope.App, IModelService, ModelService, ScopeActivation.OnScopeCreated, 'model');
