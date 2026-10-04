import type { GenerationParametersPatch, GenerationParametersWire, ModelUsageParametersWire, ModelUsagePolicyWire, ModelUsagePolicyPatch } from '@kiki/protocol';

import type { InspectionSource } from '#/kosong/contract/inspection';
import { GENERATION_PARAMETER_KEYS, type ApiDefaultParameter, type GenerationParameterKey, type GenerationParameters } from '#/kosong/contract/generationParameters';

import type { ModelRecord, ModelUsageParameters, ModelUsagePolicy, ModelUsagePosition } from './model';
import type { Model } from './catalog';
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

const USAGE_PARAMETER_KEYS = ['thinkingEffort', 'serviceTier', 'autoCompact', 'contextBudget', 'maxCompletionTokens'] as const;
const USAGE_WIRE_KEYS = ['thinking_effort', 'service_tier', 'auto_compact', 'context_budget', 'max_completion_tokens'] as const;

export interface ResolvedModelUsage {
  readonly values: ModelUsageParameters;
  readonly sources: Readonly<Partial<Record<keyof ModelUsageParameters, InspectionSource>>>;
}

export function usageParametersFromWire(wire: ModelUsageParametersWire): ModelUsageParameters {
  return { thinkingEffort: wire.thinking_effort, serviceTier: wire.service_tier, autoCompact: wire.auto_compact, contextBudget: wire.context_budget, maxCompletionTokens: wire.max_completion_tokens };
}

export function usageParametersToWire(values: ModelUsageParameters): ModelUsageParametersWire {
  return { thinking_effort: values.thinkingEffort, service_tier: values.serviceTier, auto_compact: values.autoCompact, context_budget: values.contextBudget, max_completion_tokens: values.maxCompletionTokens };
}

export function usagePolicyFromWire(wire: ModelUsagePolicyWire): ModelUsagePolicy {
  return { main: wire.main === undefined ? undefined : usageParametersFromWire(wire.main), independent: wire.independent === undefined ? undefined : usageParametersFromWire(wire.independent) };
}

export function usagePolicyToWire(policy: ModelUsagePolicy | undefined): ModelUsagePolicyWire | undefined {
  if (policy === undefined) return undefined;
  return { main: policy.main === undefined ? undefined : usageParametersToWire(policy.main), independent: policy.independent === undefined ? undefined : usageParametersToWire(policy.independent) };
}

export function patchModelUsagePolicy(current: ModelUsagePolicy | undefined, patch: ModelUsagePolicyPatch | null): ModelUsagePolicy | undefined {
  if (patch === null) return undefined;
  const next: ModelUsagePolicy = { ...current };
  for (const position of ['main', 'independent'] as const) {
    const branch = patch[position];
    if (branch === undefined) continue;
    if (branch === null) {
      delete next[position];
      continue;
    }
    const values: ModelUsageParameters = { ...next[position] };
    for (const [index, key] of USAGE_PARAMETER_KEYS.entries()) {
      const value = branch[USAGE_WIRE_KEYS[index]!];
      if (value === undefined) continue;
      if (value === null) delete values[key];
      else Object.assign(values, { [key]: value });
    }
    next[position] = values;
  }
  return next;
}

export function resolveModelUsage(
  generation: ResolvedGenerationParameters,
  model: Pick<ModelRecord, 'autoCompact' | 'contextBudget' | 'overrides' | 'usage'>,
  position: ModelUsagePosition,
): ResolvedModelUsage {
  const values: ModelUsageParameters = {
    thinkingEffort: generation.values.thinkingEffort,
    serviceTier: generation.values.serviceTier,
    maxCompletionTokens: generation.values.maxCompletionTokens,
    autoCompact: model.overrides?.autoCompact ?? model.autoCompact,
    contextBudget: model.overrides?.contextBudget ?? model.contextBudget,
  };
  const sources: Partial<Record<keyof ModelUsageParameters, InspectionSource>> = {};
  for (const key of ['thinkingEffort', 'serviceTier', 'maxCompletionTokens'] as const) sources[key] = generation.sources[key];
  for (const key of ['autoCompact', 'contextBudget'] as const) {
    if (values[key] !== undefined) sources[key] = { kind: 'config', detail: model.overrides?.[key] === undefined ? `[models.*.${key}]` : `[models.*.overrides.${key}]` };
  }
  const branch = position === 'sub' ? undefined : model.usage?.[position];
  for (const key of USAGE_PARAMETER_KEYS) {
    const value = branch?.[key];
    if (value === undefined) continue;
    if ((key === 'contextBudget' || key === 'maxCompletionTokens') && typeof value === 'number' && values[key] !== undefined && values[key] < value) continue;
    Object.assign(values, { [key]: value });
    sources[key] = { kind: 'config', detail: `[models.*.usage.${position}.${key}]` };
  }
  return { values, sources };
}

export function modelWithUsage(model: Model, position: ModelUsagePosition): Model {
  const resolved = model.usageParameters?.[position];
  if (resolved === undefined) return model;
  const values = resolved.values;
  return {
    ...model,
    contextBudget: values.contextBudget,
    autoCompact: values.autoCompact,
    maxCompletionTokens: values.maxCompletionTokens,
    serviceTier: isApiDefault(values.serviceTier) ? undefined : values.serviceTier,
    preferredThinkingEffort: resolved.sources.thinkingEffort?.detail?.includes('.usage.') === true ? values.thinkingEffort : model.preferredThinkingEffort,
    generationParameters: { ...model.generationParameters, thinkingEffort: values.thinkingEffort, serviceTier: values.serviceTier, maxCompletionTokens: values.maxCompletionTokens },
  };
}
