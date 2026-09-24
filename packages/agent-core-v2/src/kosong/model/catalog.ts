import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ProviderRequestAuth, ServiceTier } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { Protocol, ProtocolProviderOptions } from '#/kosong/protocol/protocol';

import { ENV_MODEL_PROVIDER_KEY, type ProviderConfig } from '../provider/provider';
import { explainProviderEndpoint } from '../provider/providerDefinition';
import {
  IMAGE_MIME_TYPES,
  type ImagePolicyConfig,
  type ResolvedImagePolicy,
} from '../provider/providerImagePolicy';
import {
  RequestIdentityPolicyWireSchema,
  requestIdentityToWire,
} from '../requestIdentity/requestIdentityPolicy';

import type { ModelInspection } from './inspection';
import type { ModelRecord } from './model';
import { effectiveModelConfig } from './modelAuth';
import type { ModelRequester } from './modelRequester';

export interface AuthProvider {
  readonly canRefresh?: boolean;

  getAuth(options?: { readonly force?: boolean }): Promise<ProviderRequestAuth | undefined>;
}

export class StaticAuthProvider implements AuthProvider {
  readonly canRefresh = false;

  constructor(private readonly apiKey: string | undefined) {}
  async getAuth(): Promise<ProviderRequestAuth | undefined> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) return undefined;
    return { apiKey: this.apiKey };
  }
}

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;

  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly overrides?: ModelRecord['overrides'];
  readonly contextBudget?: number;
  readonly maxCompletionTokens?: number;
  readonly requestParams?: ModelRecord['requestParams'];
  readonly serviceTier?: ServiceTier;
  readonly alwaysThinking: boolean;
  readonly providerType?: string;
  readonly providerName: string;
  readonly imagePolicy: ResolvedImagePolicy;

  readonly authProvider: AuthProvider;
  readonly providerOptions?: ProtocolProviderOptions;
}

export interface ModelPingResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly text?: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
}

const imagePolicyWireSchema = z.object({
  accepted_types: z.array(z.enum(IMAGE_MIME_TYPES)).min(1).optional(),
  convert_unsupported: z.enum(['off', 'auto', 'png', 'jpeg']).optional(),
});

export const modelCatalogItemSchema = z.object({
  id: z.string().min(1),
  provider_id: z.string(),
  remote_id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(0),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
  service_tier: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  request_identity: RequestIdentityPolicyWireSchema.optional(),
  images: imagePolicyWireSchema.optional(),
});
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

export const providerCatalogStatusSchema = z.enum([
  'connected',
  'error',
  'unconfigured',
]);
export type ProviderCatalogStatus = z.infer<typeof providerCatalogStatusSchema>;

export const providerCatalogItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  base_url: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  request_identity: RequestIdentityPolicyWireSchema.optional(),
  images: imagePolicyWireSchema.optional(),
  api_key: z.string().min(1).optional(),
  api_key_env: z.string().min(1).optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string().min(1)).optional(),
});
export type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>;

export const setDefaultModelResponseSchema = z.object({
  default_model: z.string().min(1),
  model: modelCatalogItemSchema,
});
export type SetDefaultModelResponse = z.infer<typeof setDefaultModelResponseSchema>;

export interface ProviderCredentialState {
  readonly hasApiKey: boolean;
  readonly hasOAuthToken: boolean;
}

export function providerCredentialFields(
  providerId: string,
  provider: Pick<ProviderConfig, 'type' | 'apiKey' | 'env'>,
): { api_key?: string; api_key_env?: string } {
  if (providerId === ENV_MODEL_PROVIDER_KEY) {
    return { api_key_env: provider.apiKey?.trim() ? 'KIKI_MODEL_API_KEY' : undefined };
  }
  if (provider.apiKey?.trim()) return { api_key: provider.apiKey };
  if (provider.type === undefined) return {};
  const bag = explainProviderEndpoint(provider.type, provider.env ?? {});
  return { api_key_env: bag.apiKeyEnvName ?? explainProviderEndpoint(provider.type).apiKeyEnvName };
}

export function toProtocolModel(
  model: Model,
  record: ModelRecord,
  providerType?: string,
): ModelCatalogItem {
  return {
    id: model.id,
    provider_id: model.providerName,
    remote_id: model.name ?? model.id,
    display_name: model.displayName ?? model.name ?? model.id,
    max_context_size: model.maxContextSize,
    capabilities: effectiveModelConfig(record, providerType ?? model.providerType).capabilities,
    support_efforts: model.supportEfforts === undefined ? undefined : [...model.supportEfforts],
    default_effort: model.defaultEffort,
    service_tier: model.serviceTier,
    request_identity: requestIdentityToWire(record.requestIdentity),
    images: imagePolicyToWire(record.images),
  };
}

export function toProtocolModelFallback(
  modelId: string,
  record: ModelRecord,
  providerType?: string,
): ModelCatalogItem {
  const effective = effectiveModelConfig(record, providerType);
  const remoteId = effective.name ?? effective.model ?? modelId;
  return {
    id: modelId,
    provider_id: effective.provider ?? effective.providerId ?? '',
    remote_id: remoteId,
    display_name: effective.displayName ?? remoteId,
    max_context_size: effective.maxContextSize ?? 0,
    capabilities: effective.capabilities,
    support_efforts: effective.supportEfforts,
    default_effort: effective.defaultEffort,
    service_tier: effective.serviceTier,
    request_identity: requestIdentityToWire(record.requestIdentity),
    images: imagePolicyToWire(record.images),
  };
}

export function toProtocolProvider(
  providerId: string,
  provider: ProviderConfig,
  models: Readonly<Record<string, ModelRecord>>,
  globalDefaultModel: string | undefined,
  credential: ProviderCredentialState,
): ProviderCatalogItem {
  const providerModels = modelIdsForProvider(models, providerId);
  const defaultModel =
    provider.defaultModel ?? globalDefaultForProvider(models, globalDefaultModel, providerId);
  const key = providerCredentialFields(providerId, provider);
  return {
    id: providerId,
    type: provider.type ?? 'openai',
    base_url: provider.baseUrl,
    default_model: defaultModel,
    request_identity: requestIdentityToWire(provider.requestIdentity),
    images: imagePolicyToWire(provider.images),
    api_key: key.api_key,
    api_key_env: key.api_key_env,
    has_api_key: credential.hasApiKey,
    status: credential.hasApiKey || credential.hasOAuthToken ? 'connected' : 'unconfigured',
    models: providerModels,
  };
}

function imagePolicyToWire(config: ImagePolicyConfig | undefined): z.infer<typeof imagePolicyWireSchema> | undefined {
  if (config === undefined) return undefined;
  return {
    accepted_types: config.acceptedTypes === undefined ? undefined : [...config.acceptedTypes],
    convert_unsupported: config.convertUnsupported,
  };
}

export function modelIdsForProvider(
  models: Readonly<Record<string, ModelRecord>>,
  providerId: string,
): string[] {
  return Object.entries(models)
    .filter(([, record]) => record.provider === providerId)
    .map(([modelId]) => modelId);
}

export function globalDefaultForProvider(
  models: Readonly<Record<string, ModelRecord>>,
  globalDefaultModel: string | undefined,
  providerId: string,
): string | undefined {
  if (globalDefaultModel === undefined) return undefined;
  const record = models[globalDefaultModel];
  return record?.provider === providerId ? globalDefaultModel : undefined;
}

export interface IModelCatalog {
  readonly _serviceBrand: undefined;

  get(id: string): Model;
  getRequester(id: string): ModelRequester;
  inspect(id: string): ModelInspection;
  ping(id: string): Promise<ModelPingResult>;
  findByName(name: string): readonly string[];

  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
}

export const IModelCatalog: ServiceIdentifier<IModelCatalog> =
  createDecorator<IModelCatalog>('modelResolver');
