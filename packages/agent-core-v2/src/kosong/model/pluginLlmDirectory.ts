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
import type { Event } from '#/_base/event';
import type { ChatProvider } from '#/kosong/contract/provider';

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
