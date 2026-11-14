import { modelProtocolSchema, type ModelProtocol } from '@kiki/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { InspectionSource } from '#/kosong/contract/inspection';
import type { ChatProvider } from '#/kosong/contract/provider';
import type { RequestCompression } from '#/kosong/contract/requestCompression';
import type { ResponsesWebSocketConfig } from '#/kosong/contract/responsesTransport';

import type { ProtocolBaseId, ResolvedAdapterIdentity } from './protocolBase';
import type { IDynamicProtocolExtensionRegistry, ProviderAdapterDefinition } from './extensionRegistry';

export const ProtocolSchema = modelProtocolSchema;

export type Protocol = ModelProtocol;

export interface ProtocolProviderOptions {
  readonly reasoningKey?: string;
  readonly defaultMaxTokens?: number;
  readonly supportEfforts?: readonly string[];
  readonly offEffort?: string;
  readonly adaptiveThinking?: boolean;
  readonly betaApi?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly vertexai?: boolean;
  readonly project?: string;
  readonly location?: string;
  readonly acceptedImageMimes?: ReadonlySet<string>;
}

export interface ProtocolAdapterConfig {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly baseUrl?: string;
  readonly modelName: string;
  readonly pricingModel?: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly requestCompression?: RequestCompression;
  readonly responsesWebSocket?: ResponsesWebSocketConfig;
  readonly providerOptions?: ProtocolProviderOptions;
}

export interface ExplainedCapability {
  readonly capability: ModelCapability;
  readonly source: InspectionSource;
}

export interface IProtocolAdapterRegistry extends IDynamicProtocolExtensionRegistry {
  readonly _serviceBrand: undefined;

  supportedProtocols(): readonly Protocol[];

  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity;

  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId;

  resolveCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ModelCapability;

  explainCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ExplainedCapability;

  createChatProvider(config: ProtocolAdapterConfig): ChatProvider;

  providerDefinition?(id: string, protocol?: Protocol): ProviderAdapterDefinition | undefined;
  adapterCacheKey?(protocol: Protocol, providerType?: string): string | undefined;
}

export const IProtocolAdapterRegistry: ServiceIdentifier<IProtocolAdapterRegistry> =
  createDecorator<IProtocolAdapterRegistry>('protocolAdapterRegistry');
