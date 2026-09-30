import type { AgentModelConstraints } from '@kiki/agent-profiles/agentProfile';
import {
  BINDING_ADVISORY_VERSION,
  type BindingAdvisory,
  type BindingAdvisoryDimension,
  type BindingValueSource,
} from '@kiki/agent-profiles/bindingAdvisory';

import type { AgentModelProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { resolveModelProfileEntry } from '#/app/agentProfileCatalog/modelProfileOverlay';
import { Error2, ErrorCodes } from '#/errors';
import { normalizeRequestedThinkingEffort } from '#/kosong/model/thinking';
import type { IModelService } from '#/kosong/model/model';

export interface SubagentRoleModelConstraints extends AgentModelConstraints {
  readonly modelProfiles?: readonly AgentModelProfile[];
  readonly modelConstraintProfiles?: readonly AgentModelProfile[];
  readonly origin?: string;
}

export function roleConstraintsFromProfile(
  profile: SubagentRoleModelConstraints,
  origin?: string,
): SubagentRoleModelConstraints {
  return {
    allowedModels: profile.allowedModels,
    denyModels: profile.denyModels,
    allowedEfforts: profile.allowedEfforts,
    preferredModels: profile.preferredModels,
    discouragedModels: profile.discouragedModels,
    preferredEfforts: profile.preferredEfforts,
    modelProfiles: profile.modelProfiles,
    modelConstraintProfiles: profile.modelConstraintProfiles,
    origin,
  };
}

export function resolveRoleThinkingDefault(
  constraints: SubagentRoleModelConstraints | undefined,
  model: string,
  models?: IModelService,
): string | undefined {
  return resolveModelProfileEntry(constraints?.modelProfiles, model, resolveId(models))?.thinkingEffort;
}

interface BindingConstraintCheck {
  readonly model: string;
  readonly requestedModel?: string;
  readonly thinking?: string;
  readonly requestedThinking?: string;
  readonly constraints?: SubagentRoleModelConstraints;
  readonly models?: IModelService;
  readonly ruleSource: string;
  readonly modelValueSource: BindingValueSource;
  readonly thinkingValueSource?: BindingValueSource;
  readonly checkModel?: boolean;
  readonly checkThinking?: boolean;
}

export function assertRoleBindingConstraints(input: BindingConstraintCheck): void {
  for (const layer of constraintLayers(input.constraints, input.model, input.models, input.ruleSource)) {
    const canonical = resolveModelIdentity(input.model, input.models);
    const reject = (field: string, values: readonly string[], value: string, dimension: BindingAdvisoryDimension) => {
      const ruleSource = `${layer.source}.${field}`;
      throw new Error2(ErrorCodes.PROFILE_CONSTRAINT_VIOLATION,
        `Hard constraint ${ruleSource} rejects ${dimension} "${value}". Select a permitted value or edit the constraint; pins and advisories cannot override it.`,
        { details: { strength: 'hard', ruleSource, ruleValues: [...values], effectiveValue: value,
          requestedValue: dimension === 'model' ? input.requestedModel : input.requestedThinking,
          valueSource: dimension === 'model' ? input.modelValueSource : input.thinkingValueSource ?? input.modelValueSource,
          dimension, model: canonical } });
    };
    if (input.checkModel !== false) {
      if (canonical.trim() === '' && (layer.constraints.allowedModels !== undefined || (layer.constraints.denyModels?.length ?? 0) > 0)) {
        reject('model_binding', [...(layer.constraints.allowedModels ?? []), ...(layer.constraints.denyModels ?? [])], 'unbound', 'model');
      }
      if (layer.constraints.denyModels !== undefined && identitySet(layer.constraints.denyModels, input.models).has(canonical)) {
        reject('deny_models', layer.constraints.denyModels, canonical, 'model');
      }
      if (layer.constraints.allowedModels !== undefined && !identitySet(layer.constraints.allowedModels, input.models).has(canonical)) {
        reject('allowed_models', layer.constraints.allowedModels, canonical, 'model');
      }
    }
    if (input.checkThinking !== false && input.thinking !== undefined && layer.constraints.allowedEfforts !== undefined
      && !effortAllowed(input.thinking, layer.constraints.allowedEfforts)) {
      reject('allowed_efforts', layer.constraints.allowedEfforts, input.thinking, 'thinking_effort');
    }
  }
}

export function roleBindingAdvisories(input: BindingConstraintCheck): readonly BindingAdvisory[] {
  assertRoleBindingConstraints(input);
  const constraints = input.constraints;
  if (constraints === undefined) return [];
  const advisories: BindingAdvisory[] = [];
  const canonicalModel = resolveModelIdentity(input.model, input.models);
  const layers = [{ constraints, source: input.ruleSource }, ...matchingEntries(constraints.modelProfiles, input.model, input.models)
    .map((entry) => ({ constraints: entry, source: `${input.ruleSource}.model_profiles:${entry.alias}` }))];
  for (const layer of layers) {
    const add = (code: BindingAdvisory['code'], field: string, values: readonly string[], dimension: BindingAdvisoryDimension, value: string) => {
      const source = dimension === 'model' ? input.modelValueSource : input.thinkingValueSource ?? input.modelValueSource;
      advisories.push({ version: BINDING_ADVISORY_VERSION, code, dimension,
        ruleSource: `${layer.source}.${field}`, ruleValues: [...values],
        requestedValue: dimension === 'model' ? input.requestedModel : input.requestedThinking,
        effectiveValue: value, valueSource: source, model: canonicalModel,
        message: `Soft recommendation ${layer.source}.${field} prefers [${values.join(', ')}]; continuing with "${value}" from ${bindingSelectionDescription(source)}.` });
    };
    if (input.checkModel !== false) {
      const discouraged = layer.constraints.discouragedModels;
      if (discouraged !== undefined && identitySet(discouraged, input.models).has(canonicalModel)) {
        add('model_discouraged', 'discouraged_models', discouraged, 'model', canonicalModel);
      } else if (layer.constraints.preferredModels !== undefined && !identitySet(layer.constraints.preferredModels, input.models).has(canonicalModel)) {
        add('model_not_preferred', 'preferred_models', layer.constraints.preferredModels, 'model', canonicalModel);
      }
    }
    if (input.checkThinking !== false && input.thinking !== undefined && layer.constraints.preferredEfforts !== undefined
      && !effortAllowed(input.thinking, layer.constraints.preferredEfforts)) {
      add('effort_not_preferred', 'preferred_efforts', layer.constraints.preferredEfforts, 'thinking_effort', input.thinking);
    }
  }
  return advisories;
}

export function pinBindingAdvisory(input: {
  readonly dimension: BindingAdvisoryDimension;
  readonly ruleSource: string;
  readonly pinnedValue: string;
  readonly requestedValue?: string;
  readonly effectiveValue: string;
  readonly valueSource: BindingValueSource;
  readonly model?: string;
  readonly models?: IModelService;
}): BindingAdvisory | undefined {
  const same = input.dimension === 'model'
    ? resolveModelIdentity(input.pinnedValue, input.models) === resolveModelIdentity(input.effectiveValue, input.models)
    : effortKey(input.pinnedValue) === effortKey(input.effectiveValue);
  if (same) return undefined;
  const field = input.dimension === 'model' ? 'model_alias' : 'thinking_effort';
  return {
    version: BINDING_ADVISORY_VERSION,
    code: input.dimension === 'model' ? 'model_pin_overridden' : 'effort_pin_overridden',
    dimension: input.dimension,
    ruleSource: `${input.ruleSource}.${field}`,
    ruleValue: input.pinnedValue,
    requestedValue: input.requestedValue,
    effectiveValue: input.effectiveValue,
    valueSource: input.valueSource,
    model: input.model,
    message: `${input.ruleSource} recommends ${field} "${input.pinnedValue}"; continuing with "${input.effectiveValue}" from ${bindingSelectionDescription(input.valueSource)}.`,
  };
}

export function roleModelAllowed(model: string, constraints: SubagentRoleModelConstraints | undefined, models?: IModelService): boolean {
  const canonical = resolveModelIdentity(model, models);
  return constraintLayers(constraints, model, models, 'profile').every((layer) =>
    !identitySet(layer.constraints.denyModels, models).has(canonical)
    && (layer.constraints.allowedModels === undefined || identitySet(layer.constraints.allowedModels, models).has(canonical)));
}

export function roleModelRecommended(model: string, constraints: SubagentRoleModelConstraints | undefined, models?: IModelService): boolean {
  if (!roleModelAllowed(model, constraints, models)) return false;
  const canonical = resolveModelIdentity(model, models);
  return constraints === undefined || (!identitySet(constraints.discouragedModels, models).has(canonical)
    && (constraints.preferredModels === undefined || identitySet(constraints.preferredModels, models).has(canonical)));
}

export function roleEffortRecommended(model: string, thinking: string | undefined, constraints: SubagentRoleModelConstraints | undefined, models?: IModelService): boolean {
  if (thinking === undefined) return true;
  return constraintLayers(constraints, model, models, 'profile').every((layer) =>
    (layer.constraints.allowedEfforts === undefined || effortAllowed(thinking, layer.constraints.allowedEfforts)))
    && (constraints?.preferredEfforts === undefined || effortAllowed(thinking, constraints.preferredEfforts));
}

function constraintLayers(constraints: SubagentRoleModelConstraints | undefined, model: string, models: IModelService | undefined, source: string) {
  if (constraints === undefined) return [];
  return [{ constraints, source }, ...matchingEntries([...(constraints.modelProfiles ?? []), ...(constraints.modelConstraintProfiles ?? [])], model, models)
    .map((entry) => ({ constraints: entry, source: `${source}.model_profiles:${entry.alias}` }))];
}

function matchingEntries(entries: readonly AgentModelProfile[] | undefined, model: string, models: IModelService | undefined): readonly AgentModelProfile[] {
  return (entries ?? []).filter((entry) => resolveModelProfileEntry([entry], model, resolveId(models)) === entry);
}

function bindingSelectionDescription(source: BindingValueSource): string {
  if (source === 'dispatch-explicit' || source === 'runtime-explicit') return 'explicit selection';
  if (source === 'resume-existing') return 'saved binding';
  if (source === 'environment-forced') return 'environment-forced value';
  return source.replaceAll('-', ' ');
}

function effortAllowed(thinking: string, permitted: readonly string[]): boolean {
  return permitted.some((effort) => effortKey(effort) === effortKey(thinking));
}

function effortKey(value: string): string {
  return normalizeRequestedThinkingEffort(value) ?? value.trim().toLowerCase();
}

function resolveModelIdentity(model: string, models?: IModelService): string {
  return models?.resolveId(model) ?? model;
}

function identitySet(entries: readonly string[] | undefined, models?: IModelService): Set<string> {
  return new Set((entries ?? []).map((model) => resolveModelIdentity(model, models)));
}

function resolveId(models: IModelService | undefined): (id: string) => string | undefined {
  return (id) => models === undefined ? id : models.resolveId(id);
}
