import type { PromptOverrides } from '@kiki/agent-profiles/promptOverrides';
import type { ModelBehaviorConfig } from '@kiki/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { Protocol } from '#/kosong/protocol/protocol';
import type { ServiceTier } from '#/kosong/contract/provider';
import type { RequestIdentityPolicy } from '#/kosong/requestIdentity/requestIdentityPolicy';
import type { ImagePolicyConfig } from '#/kosong/provider/providerImagePolicy';

import type { OAuthRef } from '../provider/provider';
import type { GenerationParameters, OptionalParameter } from './parameters';

export type ModelUsagePosition = 'main' | 'sub' | 'independent';

export interface ModelUsageParameters {
  thinkingEffort?: string;
  serviceTier?: OptionalParameter<ServiceTier>;
  autoCompact?: number;
  contextBudget?: number;
  maxCompletionTokens?: number;
}

export interface ModelUsagePolicy {
  main?: ModelUsageParameters;
  independent?: ModelUsageParameters;
}

export interface ModelParameterDefaults {
  autoCompact?: number;
  contextBudget?: number;
  maxCompletionTokens?: number;
  serviceTier?: ServiceTier;
  requestParams?: Record<string, string | number | boolean>;
}

export interface ModelOverride extends ModelParameterDefaults {
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;
}

export type CognitionPathRef = string | readonly string[];

export interface CognitionContent {
  overlay?: CognitionPathRef;
  steering?: CognitionPathRef;
  steeringOnTurn?: boolean;
  steeringOnInput?: boolean;
  steeringIntervalSteps?: number;
  anchor?: CognitionPathRef;
  overlayMode?: 'append' | 'prepend' | 'wrap' | 'persona' | 'replace';
  anchorSteps?: number;
  anchorScope?: 'session' | 'turn';
  steeringOnTurn?: boolean;
  steeringOnInput?: boolean;
  steeringIntervalSteps?: number;
}

export interface CognitionConfig extends CognitionContent {
  main?: 'same' | 'off' | CognitionContent;
  independent?: 'same' | 'off' | CognitionContent;
}

export interface ModelRecord extends ModelParameterDefaults {
  providerId?: string;

  baseUrl?: string;
  apiKey?: string;
  oauth?: OAuthRef;

  protocol?: Protocol;

  name?: string;
  aliases?: string[];
  pricingModel?: string;

  provider?: string;
  model?: string;
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  betaApi?: boolean;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;

  overrides?: ModelOverride;
  parameters?: GenerationParameters;
  usage?: ModelUsagePolicy;
  behavior?: ModelBehaviorConfig;
  recipe?: string;
  cognition?: CognitionConfig;
  promptOverrides?: PromptOverrides;
  requestIdentity?: RequestIdentityPolicy;
  images?: ImagePolicyConfig;
  serviceTier?: ServiceTier;

  [key: string]: unknown;
}

export type ModelsSection = Record<string, ModelRecord>;

export interface ModelsChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface DefaultModelChangedEvent {
  readonly id: string | undefined;
}

export interface IModelService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeModels: Event<ModelsChangedEvent & IWaitUntil>;
  readonly onDidChangeDefaultModel: Event<DefaultModelChangedEvent & IWaitUntil>;
  resolveId(id: string): string | undefined;
  get(id: string): ModelRecord | undefined;
  list(): Readonly<Record<string, ModelRecord>>;
  getDefaultModel(): string | undefined;
  set(id: string, model: ModelRecord): Promise<void>;
  delete(id: string): Promise<void>;
  loadAll(models: ModelsSection, defaultModel: string | undefined): void;
  replaceAll(models: ModelsSection): Promise<void>;
  setDefaultModel(id: string | undefined): Promise<void>;
}

export const IModelService: ServiceIdentifier<IModelService> =
  createDecorator<IModelService>('modelService');
