import type {
  LlmProviderContributionDefinition,
  PluginLlmProviderDescription,
  PluginLlmProviderReadiness,
  PluginLlmStreamEvent,
  PluginLlmStreamRequest,
  PluginModelDescriptor,
  PluginProviderQuotaReadResult,
  PluginProviderQuotaTargetDescriptor,
  ProviderQuotaSourceDefinition,
} from '@kiki/protocol';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { abortable } from '#/_base/utils/abort';
import { LifecycleScope } from '#/app/scopes';
import type { ChatProvider } from '#/kosong/contract/provider';
import { ProtocolSchema } from '#/kosong/protocol/protocol';
import { hasProviderDefinition } from '#/kosong/provider/providerDefinition';

import { createPluginLlmChatProvider } from './pluginLlmChatProvider';

export interface PluginLlmProviderRuntime {
  describe(signal?: AbortSignal): Promise<{ readonly description: PluginLlmProviderDescription; readonly supportsForceRefreshAuth: boolean }>;
  stream(request: PluginLlmStreamRequest, signal?: AbortSignal): AsyncIterable<PluginLlmStreamEvent>;
  forceRefreshAuth(signal?: AbortSignal): Promise<boolean>;
}

export interface PluginProviderQuotaRuntime {
  listTargets(signal?: AbortSignal): Promise<readonly PluginProviderQuotaTargetDescriptor[]>;
  read(targetId: string, signal?: AbortSignal): Promise<PluginProviderQuotaReadResult>;
}

export interface PluginLlmProviderEntry {
  readonly pluginId: string;
  readonly generation: number;
  readonly definition: LlmProviderContributionDefinition;
  readonly readiness: PluginLlmProviderReadiness;
  readonly statusText?: string;
  readonly accountSummary?: string;
  readonly models: readonly PluginModelDescriptor[];
  readonly supportsForceRefreshAuth: boolean;
  readonly runtime: PluginLlmProviderRuntime;
}

export interface PluginModelLookup {
  readonly provider: PluginLlmProviderEntry;
  readonly descriptor: PluginModelDescriptor;
}

export interface PluginProviderQuotaSourceEntry {
  readonly pluginId: string;
  readonly generation: number;
  readonly definition: ProviderQuotaSourceDefinition;
  readonly runtime: PluginProviderQuotaRuntime;
}

export interface PluginLlmDirectoryChangeEvent {
  readonly revision: number;
  readonly reason: 'index' | 'describe' | 'degraded' | 'withdraw' | 'quota';
  readonly pluginId?: string;
  readonly providerId?: string;
}

export interface IPluginLlmDirectoryService {
  readonly _serviceBrand: undefined;
  readonly revision: number;
  readonly indexReady: Promise<void>;
  readonly onDidChange: Event<PluginLlmDirectoryChangeEvent>;

  markIndexReady(): void;
  waitForManifestIndex(signal?: AbortSignal): Promise<void>;

  publishPlugin(input: {
    readonly pluginId: string;
    readonly generation: number;
    readonly llmProviders: readonly {
      readonly definition: LlmProviderContributionDefinition;
      readonly runtime: PluginLlmProviderRuntime;
    }[];
    readonly quotaSources: readonly {
      readonly definition: ProviderQuotaSourceDefinition;
      readonly runtime: PluginProviderQuotaRuntime;
    }[];
  }): { readonly acceptedProviders: readonly string[]; readonly rejectedProviders: readonly { readonly id: string; readonly reason: string }[] };

  commitProviderDescription(
    pluginId: string,
    generation: number,
    providerId: string,
    description: PluginLlmProviderDescription,
    supportsForceRefreshAuth: boolean,
  ): boolean;

  markProviderDegraded(
    pluginId: string,
    generation: number,
    providerId: string,
    statusText: string,
  ): boolean;

  withdrawPlugin(pluginId: string): void;
  notifyQuotaChanged(pluginId: string): void;

  listProviders(): readonly PluginLlmProviderEntry[];
  getProvider(providerId: string): PluginLlmProviderEntry | undefined;
  listModels(): readonly PluginModelLookup[];
  getModel(modelId: string): PluginModelLookup | undefined;
  resolveModelId(id: string): string | undefined;
  listQuotaSources(): readonly PluginProviderQuotaSourceEntry[];
  ensureProviderDescribed(providerId: string, signal?: AbortSignal): Promise<PluginLlmProviderEntry | undefined>;
  createChatProvider(providerId: string, modelId: string, wireModel: string): ChatProvider | undefined;
}

export const IPluginLlmDirectoryService: ServiceIdentifier<IPluginLlmDirectoryService> =
  createDecorator<IPluginLlmDirectoryService>('pluginLlmDirectoryService');

export class PluginLlmDirectoryService extends Disposable implements IPluginLlmDirectoryService {
  declare readonly _serviceBrand: undefined;

  private currentRevision = 0;
  private indexHydrated = false;
  private resolveIndexReady!: () => void;
  readonly indexReady: Promise<void> = new Promise<void>((resolve) => {
    this.resolveIndexReady = resolve;
  });

  private readonly providersById = new Map<string, PluginLlmProviderEntry>();
  private readonly modelsById = new Map<string, PluginModelLookup>();
  private readonly quotaSourcesByPlugin = new Map<string, readonly PluginProviderQuotaSourceEntry[]>();
  private readonly describeFlights = new Map<string, { readonly generation: number; readonly promise: Promise<PluginLlmProviderEntry | undefined> }>();
  private readonly _onDidChange = this._register(new Emitter<PluginLlmDirectoryChangeEvent>());
  readonly onDidChange: Event<PluginLlmDirectoryChangeEvent> = this._onDidChange.event;

  constructor() {
    super();
    this._register(toDisposable(() => {
      this.providersById.clear();
      this.modelsById.clear();
      this.quotaSourcesByPlugin.clear();
      this.describeFlights.clear();
      this.markIndexReady();
    }));
  }

  get revision(): number {
    return this.currentRevision;
  }

  markIndexReady(): void {
    if (this.indexHydrated) return;
    this.indexHydrated = true;
    this.resolveIndexReady();
  }

  async waitForManifestIndex(signal?: AbortSignal): Promise<void> {
    if (this.indexHydrated) return;
    if (signal === undefined) {
      await this.indexReady;
      return;
    }
    await abortable(this.indexReady, signal);
  }

  publishPlugin(input: {
    readonly pluginId: string;
    readonly generation: number;
    readonly llmProviders: readonly {
      readonly definition: LlmProviderContributionDefinition;
      readonly runtime: PluginLlmProviderRuntime;
    }[];
    readonly quotaSources: readonly {
      readonly definition: ProviderQuotaSourceDefinition;
      readonly runtime: PluginProviderQuotaRuntime;
    }[];
  }): { readonly acceptedProviders: readonly string[]; readonly rejectedProviders: readonly { readonly id: string; readonly reason: string }[] } {
    const pluginKey = input.pluginId.toLowerCase();
    const acceptedProviders: string[] = [];
    const rejectedProviders: { id: string; reason: string }[] = [];
    const nextEntries: PluginLlmProviderEntry[] = [];
    const seenIds = new Set<string>();

    for (const item of input.llmProviders) {
      const id = item.definition.id;
      if (seenIds.has(id)) {
        rejectedProviders.push({ id, reason: 'Duplicate provider id in plugin manifest' });
        continue;
      }
      if (hasProviderDefinition(id) || ProtocolSchema.safeParse(id).success) {
        rejectedProviders.push({ id, reason: `Provider id '${id}' is reserved by built-in providers` });
        continue;
      }
      const existing = this.providersById.get(id);
      if (existing !== undefined && existing.pluginId.toLowerCase() !== pluginKey) {
        rejectedProviders.push({ id, reason: `Provider id '${id}' is already owned by plugin '${existing.pluginId}'` });
        continue;
      }
      seenIds.add(id);
      acceptedProviders.push(id);
      const preserved = existing !== undefined && existing.pluginId.toLowerCase() === pluginKey ? existing : undefined;
      nextEntries.push({
        pluginId: input.pluginId,
        generation: input.generation,
        definition: item.definition,
        readiness: 'initializing',
        statusText: preserved?.statusText,
        accountSummary: preserved?.accountSummary,
        models: item.definition.defaultModels,
        supportsForceRefreshAuth: false,
        runtime: item.runtime,
      });
    }

    for (const [providerId, entry] of [...this.providersById.entries()]) {
      if (entry.pluginId.toLowerCase() === pluginKey && !seenIds.has(providerId)) {
        this.providersById.delete(providerId);
        this.describeFlights.delete(providerId);
      }
    }
    for (const entry of nextEntries) {
      this.providersById.set(entry.definition.id, entry);
      this.describeFlights.delete(entry.definition.id);
    }

    const nextQuotas: PluginProviderQuotaSourceEntry[] = input.quotaSources.map((item) => ({
      pluginId: input.pluginId,
      generation: input.generation,
      definition: item.definition,
      runtime: item.runtime,
    }));
    if (nextQuotas.length > 0) this.quotaSourcesByPlugin.set(pluginKey, nextQuotas);
    else this.quotaSourcesByPlugin.delete(pluginKey);

    this.rebuildModelIndex();
    this.bump('index', input.pluginId);
    return { acceptedProviders, rejectedProviders };
  }

  commitProviderDescription(
    pluginId: string,
    generation: number,
    providerId: string,
    description: PluginLlmProviderDescription,
    supportsForceRefreshAuth: boolean,
  ): boolean {
    const current = this.providersById.get(providerId);
    if (current === undefined || current.pluginId.toLowerCase() !== pluginId.toLowerCase() || current.generation !== generation) {
      return false;
    }
    const next: PluginLlmProviderEntry = {
      ...current,
      readiness: description.readiness,
      statusText: description.statusText,
      accountSummary: description.accountSummary,
      models: description.models,
      supportsForceRefreshAuth,
    };
    this.providersById.set(providerId, next);
    this.rebuildModelIndex();
    this.bump('describe', pluginId, providerId);
    return true;
  }

  markProviderDegraded(
    pluginId: string,
    generation: number,
    providerId: string,
    statusText: string,
  ): boolean {
    const current = this.providersById.get(providerId);
    if (current === undefined || current.pluginId.toLowerCase() !== pluginId.toLowerCase() || current.generation !== generation) {
      return false;
    }
    this.providersById.set(providerId, {
      ...current,
      readiness: 'degraded',
      statusText,
    });
    this.bump('degraded', pluginId, providerId);
    return true;
  }

  withdrawPlugin(pluginId: string): void {
    const pluginKey = pluginId.toLowerCase();
    let changed = false;
    for (const [providerId, entry] of [...this.providersById.entries()]) {
      if (entry.pluginId.toLowerCase() === pluginKey) {
        this.providersById.delete(providerId);
        this.describeFlights.delete(providerId);
        changed = true;
      }
    }
    if (this.quotaSourcesByPlugin.delete(pluginKey)) changed = true;
    if (!changed) return;
    this.rebuildModelIndex();
    this.bump('withdraw', pluginId);
  }

  notifyQuotaChanged(pluginId: string): void {
    if (!this.quotaSourcesByPlugin.has(pluginId.toLowerCase())) return;
    this.bump('quota', pluginId);
  }

  listProviders(): readonly PluginLlmProviderEntry[] {
    return [...this.providersById.values()];
  }

  getProvider(providerId: string): PluginLlmProviderEntry | undefined {
    return this.providersById.get(providerId);
  }

  listModels(): readonly PluginModelLookup[] {
    return [...this.modelsById.values()];
  }

  getModel(modelId: string): PluginModelLookup | undefined {
    return this.modelsById.get(modelId);
  }

  resolveModelId(id: string): string | undefined {
    if (this.modelsById.has(id)) return id;
    return undefined;
  }

  listQuotaSources(): readonly PluginProviderQuotaSourceEntry[] {
    const out: PluginProviderQuotaSourceEntry[] = [];
    for (const list of this.quotaSourcesByPlugin.values()) {
      out.push(...list);
    }
    return out;
  }

  async ensureProviderDescribed(providerId: string, signal?: AbortSignal): Promise<PluginLlmProviderEntry | undefined> {
    await this.waitForManifestIndex(signal);
    const current = this.providersById.get(providerId);
    if (current === undefined) return undefined;
    if (current.readiness !== 'initializing') return current;
    const existingFlight = this.describeFlights.get(providerId);
    let flightPromise: Promise<PluginLlmProviderEntry | undefined>;
    if (existingFlight !== undefined && existingFlight.generation === current.generation) {
      flightPromise = existingFlight.promise;
    } else {
      const generation = current.generation;
      const pluginId = current.pluginId;
      const flightEntry: { readonly generation: number; promise?: Promise<PluginLlmProviderEntry | undefined> } = {
        generation,
      };
      const flight = (async () => {
        try {
          const described = await current.runtime.describe();
          this.commitProviderDescription(
            pluginId,
            generation,
            providerId,
            described.description,
            described.supportsForceRefreshAuth,
          );
        } catch (error) {
          this.markProviderDegraded(
            pluginId,
            generation,
            providerId,
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          const active = this.describeFlights.get(providerId);
          if (active?.promise === flightEntry.promise) {
            this.describeFlights.delete(providerId);
          }
        }
        return this.providersById.get(providerId);
      })();
      flightEntry.promise = flight;
      flightPromise = flight;
      this.describeFlights.set(providerId, { generation, promise: flight });
    }
    return signal === undefined ? flightPromise : abortable(flightPromise, signal);
  }

  createChatProvider(providerId: string, modelId: string, wireModel: string): ChatProvider | undefined {
    const entry = this.providersById.get(providerId);
    if (entry === undefined) return undefined;
    const pinnedRuntime = entry.runtime;
    return createPluginLlmChatProvider({
      providerId,
      modelId,
      wireModel,
      executor: pinnedRuntime,
    });
  }

  private rebuildModelIndex(): void {
    this.modelsById.clear();
    for (const provider of this.providersById.values()) {
      for (const descriptor of provider.models) {
        if (!this.modelsById.has(descriptor.id)) {
          this.modelsById.set(descriptor.id, { provider, descriptor });
        }
      }
    }
  }

  private bump(reason: PluginLlmDirectoryChangeEvent['reason'], pluginId?: string, providerId?: string): void {
    this.currentRevision += 1;
    this._onDidChange.fire({ revision: this.currentRevision, reason, pluginId, providerId });
  }
}

registerScopedService(
  LifecycleScope.App,
  IPluginLlmDirectoryService,
  PluginLlmDirectoryService,
  ScopeActivation.OnScopeCreated,
  'plugin',
);
