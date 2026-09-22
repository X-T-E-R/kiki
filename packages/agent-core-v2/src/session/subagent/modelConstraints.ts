import {
  BINDING_ADVISORY_VERSION,
  type BindingAdvisory,
  type BindingAdvisoryDimension,
  type BindingValueSource,
} from '@kiki/agent-profiles/bindingAdvisory';

import type { AgentModelProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { resolveModelProfileEntry } from '#/app/agentProfileCatalog/modelProfileOverlay';
import { normalizeRequestedThinkingEffort } from '#/kosong/model/thinking';
import type { IModelService } from '#/kosong/model/model';

export interface SubagentRoleModelConstraints {
  readonly allowedModels?: readonly string[];
  readonly denyModels?: readonly string[];
  readonly allowedEfforts?: readonly string[];
  readonly modelProfiles?: readonly AgentModelProfile[];
  readonly origin?: string;
}

export function roleConstraintsFromProfile(
  profile: {
    readonly allowedModels?: readonly string[];
    readonly denyModels?: readonly string[];
    readonly allowedEfforts?: readonly string[];
    readonly modelProfiles?: readonly AgentModelProfile[];
  },
  origin?: string,
): SubagentRoleModelConstraints {
  return {
    allowedModels: profile.allowedModels,
    denyModels: profile.denyModels,
    allowedEfforts: profile.allowedEfforts,
    modelProfiles: profile.modelProfiles,
    ...(origin === undefined ? {} : { origin }),
  };
}

export function resolveRoleThinkingDefault(
  constraints: SubagentRoleModelConstraints | undefined,
  model: string,
  models?: IModelService,
): string | undefined {
  return resolveModelProfileEntry(constraints?.modelProfiles, model, resolveId(models))
    ?.thinkingEffort;
}

export function roleBindingAdvisories(input: {
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
}): readonly BindingAdvisory[] {
  const constraints = input.constraints;
  if (constraints === undefined) return [];
  const advisories: BindingAdvisory[] = [];
  const canonicalModel = resolveModelIdentity(input.model, input.models);
  const selection = bindingSelectionDescription(input.modelValueSource);
  if (input.checkModel !== false) {
    const denied = constraints.denyModels;
    if (denied !== undefined && identitySet(denied, input.models).has(canonicalModel)) {
      advisories.push({
        version: BINDING_ADVISORY_VERSION,
        code: 'model_denied',
        dimension: 'model',
        ruleSource: `${input.ruleSource}.deny_models`,
        ruleValues: [...denied],
        requestedValue: input.requestedModel,
        effectiveValue: canonicalModel,
        valueSource: input.modelValueSource,
        model: canonicalModel,
        message: `Model "${canonicalModel}" is listed in ${input.ruleSource} deny_models; continuing with the ${selection}.`,
      });
    } else if (
      constraints.allowedModels !== undefined &&
      !identitySet(constraints.allowedModels, input.models).has(canonicalModel)
    ) {
      advisories.push({
        version: BINDING_ADVISORY_VERSION,
        code: 'model_not_allowed',
        dimension: 'model',
        ruleSource: `${input.ruleSource}.allowed_models`,
        ruleValues: [...constraints.allowedModels],
        requestedValue: input.requestedModel,
        effectiveValue: canonicalModel,
        valueSource: input.modelValueSource,
        model: canonicalModel,
        message: `Model "${canonicalModel}" is not in ${input.ruleSource} allowed_models; continuing with the ${selection}.`,
      });
    }
  }
  const permittedEfforts = effectiveAllowedEfforts(constraints, input.model, input.models);
  if (
    input.checkThinking !== false &&
    permittedEfforts !== undefined &&
    input.thinking !== undefined &&
    input.thinking.trim().length > 0 &&
    !effortAllowed(input.thinking, permittedEfforts)
  ) {
    const source = input.thinkingValueSource ?? input.modelValueSource;
    advisories.push({
      version: BINDING_ADVISORY_VERSION,
      code: 'effort_not_allowed',
      dimension: 'thinking_effort',
      ruleSource: `${input.ruleSource}.allowed_efforts`,
      ruleValues: [...permittedEfforts],
      requestedValue: input.requestedThinking,
      effectiveValue: input.thinking,
      valueSource: source,
      model: canonicalModel,
      message: `Thinking effort "${input.thinking}" is not in ${input.ruleSource} allowed_efforts; continuing with the ${bindingSelectionDescription(source)}.`,
    });
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

export function roleModelRecommended(
  model: string,
  constraints: SubagentRoleModelConstraints | undefined,
  models?: IModelService,
): boolean {
  if (constraints === undefined) return true;
  const canonicalModel = resolveModelIdentity(model, models);
  if (identitySet(constraints.denyModels, models).has(canonicalModel)) return false;
  return constraints.allowedModels === undefined || identitySet(constraints.allowedModels, models).has(canonicalModel);
}

export function roleEffortRecommended(
  model: string,
  thinking: string | undefined,
  constraints: SubagentRoleModelConstraints | undefined,
  models?: IModelService,
): boolean {
  if (constraints === undefined || thinking === undefined || thinking.trim().length === 0) return true;
  const permitted = effectiveAllowedEfforts(constraints, model, models);
  return permitted === undefined || effortAllowed(thinking, permitted);
}

function bindingSelectionDescription(source: BindingValueSource): string {
  switch (source) {
    case 'dispatch-explicit':
    case 'runtime-explicit':
      return 'explicit selection';
    case 'resume-existing':
      return 'saved binding';
    case 'environment-forced':
      return 'environment-forced value';
    default:
      return source.replaceAll('-', ' ');
  }
}

function effectiveAllowedEfforts(
  constraints: SubagentRoleModelConstraints,
  model: string,
  models: IModelService | undefined,
): readonly string[] | undefined {
  const role = constraints.allowedEfforts;
  const entry = resolveModelProfileEntry(constraints.modelProfiles, model, resolveId(models));
  const entryEfforts = nonemptyList(entry?.allowedEfforts);
  if (role === undefined) return entryEfforts;
  if (entryEfforts === undefined) return role;
  if (role.length === 0) return [];
  const allowed = new Set(entryEfforts.map(effortKey));
  return role.filter((effort) => allowed.has(effortKey(effort)));
}

function nonemptyList(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values;
}

function effortAllowed(thinking: string, permitted: readonly string[]): boolean {
  const wanted = effortKey(thinking);
  return permitted.some((effort) => effortKey(effort) === wanted);
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
