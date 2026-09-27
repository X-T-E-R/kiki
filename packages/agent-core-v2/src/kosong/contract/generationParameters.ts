import type { ServiceTier } from './provider';

export interface ApiDefaultParameter {
  kind: 'api_default';
}

export type OptionalParameter<T> = T | ApiDefaultParameter;

export interface GenerationParameters {
  temperature?: OptionalParameter<number>;
  topP?: OptionalParameter<number>;
  maxCompletionTokens?: number;
  thinkingEffort?: string;
  serviceTier?: OptionalParameter<ServiceTier>;
}

export type GenerationParameterKey = keyof GenerationParameters;
export const GENERATION_PARAMETER_KEYS = [
  'temperature', 'topP', 'maxCompletionTokens', 'thinkingEffort', 'serviceTier',
] as const satisfies readonly GenerationParameterKey[];
