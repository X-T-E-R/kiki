import { z } from 'zod';
import { generationParametersSchema, modelBehaviorWireSchema, modelBehaviorToWire } from '@kiki/protocol';

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
import type { ModelRecord, ModelUsagePosition } from './model';
import { effectiveModelConfig } from './modelAuth';
import { parametersToWire, type GenerationParameters, type ResolvedModelUsage } from './parameters';
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
  readonly autoCompact?: number;
  readonly maxCompletionTokens?: number;
  readonly requestParams?: ModelRecord['requestParams'];
  readonly serviceTier?: ServiceTier;
  readonly generationParameters?: GenerationParameters;
  readonly usageParameters?: Readonly<Record<ModelUsagePosition, ResolvedModelUsage>>;
  readonly preferredThinkingEffort?: string;
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
  readonly errorCode?: string;
  readonly httpStatus?: number;
}

const imagePolicyWireSchema = z.object({
  accepted_types: z.array(z.enum(IMAGE_MIME_TYPES)).min(1).optional(),
  convert_unsupported: z.enum(['off', 'auto', 'png', 'jpeg']).optional(),
});

export const modelCatalogItemSchema = z.object({
  id: z.string().min(1),
  provider_id: z.string(),
  remote_id: z.string().min(1),
  pricing_model: z.string().trim().min(1).optional(),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(0),
  auto_compact: z.number().int().positive().safe().optional(),
  capabilities: z.array(z.string()).optional(),
  effective_capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
  service_tier: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  parameters: generationParametersSchema.optional(),
  behavior: modelBehaviorWireSchema.optional(),
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
  defaults: generationParametersSchema.optional(),
  request_identity: RequestIdentityPolicyWireSchema.optional(),
  images: imagePolicyWireSchema.optional(),
  api_key: z.string().min(1).optional(),
  api_key_env: z.string().min(1).optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string().min(1)).optional(),
  model_source: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  custom_header_keys: z.array(z.string()).optional(),
  env_keys: z.array(z.string()).optional(),
  oauth: z.object({ storage: z.enum(['file', 'keyring']), signed_in: z.boolean() }).optional(),
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
  const effective = effectiveModelConfig(record, providerType ?? model.providerType);
  const effectiveCapabilities = modelCapabilityNames(model.capabilities);
  if (model.alwaysThinking) effectiveCapabilities.push('always_thinking');
  return {
    id: model.id,
    provider_id: model.providerName,
    remote_id: model.name ?? model.id,
    display_name: model.displayName ?? model.name ?? model.id,
    max_context_size: model.maxContextSize,
    auto_compact: model.autoCompact,
    capabilities: effective.capabilities,
    effective_capabilities:
      effective.capabilities === undefined && effectiveCapabilities.length === 0
        ? undefined
        : effectiveCapabilities,
    support_efforts: model.supportEfforts === undefined ? undefined : [...model.supportEfforts],
    default_effort: model.preferredThinkingEffort ?? model.overrides?.defaultEffort ?? model.defaultEffort,
    service_tier: model.serviceTier,
    pricing_model: record.pricingModel,
    parameters: parametersToWire(record.parameters),
    behavior: modelBehaviorToWire(record.behavior),
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
    auto_compact: effective.autoCompact,
    capabilities: effective.capabilities,
    effective_capabilities: undefined,
    support_efforts: effective.supportEfforts,
    default_effort: effective.defaultEffort,
    service_tier: effective.serviceTier,
    pricing_model: record.pricingModel,
    parameters: parametersToWire(record.parameters),
    behavior: modelBehaviorToWire(record.behavior),
    request_identity: requestIdentityToWire(record.requestIdentity),
    images: imagePolicyToWire(record.images),
  };
}

function modelCapabilityNames(capabilities: ModelCapability): string[] {
  return [
    capabilities.image_in ? 'image_in' : undefined,
    capabilities.video_in ? 'video_in' : undefined,
    capabilities.audio_in ? 'audio_in' : undefined,
    capabilities.thinking ? 'thinking' : undefined,
    capabilities.tool_use ? 'tool_use' : undefined,
    capabilities.dynamically_loaded_tools ? 'dynamically_loaded_tools' : undefined,
  ].filter((capability): capability is string => capability !== undefined);
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
    defaults: parametersToWire(provider.defaults),
    request_identity: requestIdentityToWire(provider.requestIdentity),
    images: imagePolicyToWire(provider.images),
    api_key_env: key.api_key_env,
    has_api_key: credential.hasApiKey,
    status: credential.hasApiKey || credential.hasOAuthToken ? 'connected' : 'unconfigured',
    models: providerModels,
    model_source: provider.modelSource,
    custom_header_keys: provider.customHeaders === undefined ? undefined : Object.keys(provider.customHeaders),
    env_keys: provider.env === undefined ? undefined : Object.keys(provider.env),
    oauth: provider.oauth === undefined ? undefined : { storage: provider.oauth.storage, signed_in: credential.hasOAuthToken },
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

  get(id: string, recipeSettings?: Record<string, unknown>): Model;
  getRequester(id: string, recipeSettings?: Record<string, unknown>): ModelRequester;
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
