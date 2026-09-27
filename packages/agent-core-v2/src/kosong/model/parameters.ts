import type { GenerationParametersPatch, GenerationParametersWire } from '@kiki/protocol';

import type { InspectionSource } from '#/kosong/contract/inspection';
import { GENERATION_PARAMETER_KEYS, type ApiDefaultParameter, type GenerationParameterKey, type GenerationParameters } from '#/kosong/contract/generationParameters';

import type { ModelRecord } from './model';
import type { ProviderConfig } from '../provider/provider';

export { GENERATION_PARAMETER_KEYS } from '#/kosong/contract/generationParameters';
export type { ApiDefaultParameter, OptionalParameter, GenerationParameterKey, GenerationParameters } from '#/kosong/contract/generationParameters';

export interface ResolvedGenerationParameters {
  readonly values: GenerationParameters;
  readonly sources: Readonly<Partial<Record<GenerationParameterKey, InspectionSource>>>;
}

export function isApiDefault(value: unknown): value is ApiDefaultParameter {
  return typeof value === 'object' && value !== null && (value as ApiDefaultParameter).kind === 'api_default';
}

export function parametersFromWire(wire: GenerationParametersWire | undefined): GenerationParameters | undefined {
  if (wire === undefined) return undefined;
  return {
    temperature: wire.temperature,
    topP: wire.top_p,
    maxCompletionTokens: wire.max_completion_tokens,
    thinkingEffort: wire.thinking_effort,
    serviceTier: wire.service_tier,
  };
}

export function parametersToWire(parameters: GenerationParameters | undefined): GenerationParametersWire | undefined {
  if (parameters === undefined) return undefined;
  return {
    temperature: parameters.temperature,
    top_p: parameters.topP,
    max_completion_tokens: parameters.maxCompletionTokens,
    thinking_effort: parameters.thinkingEffort,
    service_tier: parameters.serviceTier,
  };
}

export function patchGenerationParameters(
  current: GenerationParameters | undefined,
  patch: GenerationParametersPatch | null | undefined,
): GenerationParameters | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  const next: GenerationParameters = { ...current };
  for (const [wireKey, key] of [
    ['temperature', 'temperature'], ['top_p', 'topP'],
    ['max_completion_tokens', 'maxCompletionTokens'], ['thinking_effort', 'thinkingEffort'],
    ['service_tier', 'serviceTier'],
  ] as const) {
    const value = patch[wireKey];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else Object.assign(next, { [key]: value });
  }
  return next;
}

export function resolveGenerationParameters(
  provider: ProviderConfig | undefined,
  model: ModelRecord,
): ResolvedGenerationParameters {
  const values: GenerationParameters = {};
  const sources: Partial<Record<GenerationParameterKey, InspectionSource>> = {};
  const apply = (layer: GenerationParameters | undefined, detail: string): void => {
    if (layer === undefined) return;
    for (const key of GENERATION_PARAMETER_KEYS) {
      const value = layer[key];
      if (value === undefined) continue;
      Object.assign(values, { [key]: value });
      sources[key] = { kind: 'config', detail };
    }
  };
  const legacyEffort = model.overrides?.supportEfforts !== undefined
    && model.overrides.defaultEffort === undefined
    && model.defaultEffort !== undefined
    && !model.overrides.supportEfforts.includes(model.defaultEffort)
    ? undefined : model.defaultEffort;
  apply(provider?.defaults, '[providers.*.defaults]');
  apply({
    maxCompletionTokens: model.maxCompletionTokens,
    serviceTier: model.serviceTier,
    thinkingEffort: legacyEffort,
    temperature: typeof model.requestParams?.['temperature'] === 'number' ? model.requestParams['temperature'] : undefined,
    topP: typeof model.requestParams?.['top_p'] === 'number' ? model.requestParams['top_p'] : undefined,
  }, '[models.*] legacy generation fields');
  apply({
    maxCompletionTokens: model.overrides?.maxCompletionTokens,
    serviceTier: model.overrides?.serviceTier,
    thinkingEffort: model.overrides?.defaultEffort,
    temperature: typeof model.overrides?.requestParams?.['temperature'] === 'number' ? model.overrides.requestParams['temperature'] : undefined,
    topP: typeof model.overrides?.requestParams?.['top_p'] === 'number' ? model.overrides.requestParams['top_p'] : undefined,
  }, '[models.*.overrides] legacy generation fields');
  apply(model.parameters, '[models.*.parameters]');
  return { values, sources };
}

export interface GenerationMigrationFinding {
  readonly modelId: string;
  readonly field: GenerationParameterKey | 'maxOutputSize';
  readonly severity: 'preserved' | 'requires_confirmation';
  readonly reason: string;
}

export function previewGenerationParameterMigration(
  models: Readonly<Record<string, ModelRecord>>,
): readonly GenerationMigrationFinding[] {
  const findings: GenerationMigrationFinding[] = [];
  for (const [modelId, record] of Object.entries(models)) {
    const source = resolveGenerationParameters(undefined, { ...record, parameters: undefined });
    for (const key of GENERATION_PARAMETER_KEYS) {
      if (source.values[key] === undefined) continue;
      findings.push({
        modelId,
        field: key,
        severity: record.parameters?.[key] === undefined ? 'preserved' : 'requires_confirmation',
        reason: record.parameters?.[key] === undefined
          ? 'Legacy value remains effective without rewriting the config file.'
          : 'Explicit parameters override an existing legacy value; inspect before migrating.',
      });
    }
    if (record.maxOutputSize !== undefined || record.overrides?.maxOutputSize !== undefined) {
      findings.push({
        modelId, field: 'maxOutputSize', severity: 'requires_confirmation',
        reason: 'Legacy max_output_size can be a model limit or request default; no automatic conversion.',
      });
    }
  }
  return findings;
}
