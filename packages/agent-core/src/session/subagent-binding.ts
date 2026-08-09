import {
  SECONDARY_DERIVED_MODEL_ALIAS,
  SECONDARY_MODEL_ENV,
  secondaryModelPatch,
  type KimiConfig,
  type SecondaryModelConfig,
} from '../config';
import { ErrorCodes, KimiError } from '../errors';
import type { ExperimentalFlagResolver } from '../flags';
import type { AgentModelPreference } from '../profile';

/**
 * Subagent model binding for new Agent and AgentSwarm children.
 *
 * The existing `secondary-model` experiment gates exact model aliases,
 * thinking-effort overrides, profile and `[subagent]` defaults, and the
 * legacy symbolic primary/secondary selector. Model and effort precedence are
 * resolved independently. A patched secondary recipe binds the synthesized
 * derived entry ({@link SECONDARY_DERIVED_MODEL_ALIAS}); display paths map it
 * back to the recipe's base alias. With the experiment disabled, children
 * inherit the immediate caller's complete binding.
 */

export type SubagentModelChoice = AgentModelPreference;

export interface SubagentBindingRequest {
  readonly modelAlias?: string;
  readonly modelPreference?: SubagentModelChoice;
  readonly thinkingEffort?: string;
}

export type SubagentModelSource = 'tool' | 'profile' | 'default' | 'secondary' | 'caller';

export interface SubagentModelBinding {
  readonly modelAlias: string | undefined;
  readonly thinkingEffort?: string;
}

const bindingSources = new WeakMap<SubagentModelBinding, SubagentModelSource>();

export function subagentModelSource(binding: SubagentModelBinding): SubagentModelSource {
  return bindingSources.get(binding) ?? 'caller';
}

function recordBindingSource(
  binding: SubagentModelBinding,
  source: SubagentModelSource,
): SubagentModelBinding {
  bindingSources.set(binding, source);
  return binding;
}

export function resolveSecondaryModel(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
): SecondaryModelConfig | undefined {
  if (!flags.enabled('secondary-model')) return undefined;
  return config?.secondaryModel;
}

/**
 * Resolve which model a newly spawned subagent binds to. `requested` is the
 * explicit per-spawn choice (tool argument or profile preference); `own` is
 * the caller's current model state, used when inheriting.
 */
export function resolveSubagentBinding(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
  own: { readonly modelAlias: string | undefined; readonly thinkingEffort: string },
  requested?: SubagentModelChoice | SubagentBindingRequest,
  profileRequest?: SubagentBindingRequest,
): SubagentModelBinding {
  if (!flags.enabled('secondary-model')) {
    return recordBindingSource({
      modelAlias: own.modelAlias,
      thinkingEffort: own.thinkingEffort,
    }, 'caller');
  }

  const tool = normalizeRequest(requested);
  const profile = normalizeRequest(profileRequest);
  assertValidRequest(tool, 'tool input');
  assertValidRequest(profile, 'agent profile');
  const secondary = resolveSecondaryModel(config, flags);
  if (secondary?.model === SECONDARY_DERIVED_MODEL_ALIAS) {
    throw invalidInternalAlias('[secondary_model].model');
  }
  const defaultModel = config?.subagent?.defaultModel;

  let modelAlias: string | undefined;
  let modelSource: SubagentModelSource;
  let inheritedCallerBinding = false;
  const selected = selectModelRequest(tool, profile);
  if (selected?.modelAlias !== undefined) {
    assertSelectableAlias(selected.modelAlias, selected.source);
    modelAlias = selected.modelAlias;
    modelSource = selected.source;
  } else if (selected?.modelPreference === 'primary') {
    modelAlias = own.modelAlias;
    modelSource = selected.source;
    inheritedCallerBinding = true;
  } else if (selected?.modelPreference === 'secondary') {
    if (secondary?.model !== undefined) {
      modelAlias = secondaryBindingAlias(secondary);
      modelSource = 'secondary';
    } else {
      modelAlias = own.modelAlias;
      modelSource = selected.source;
      inheritedCallerBinding = true;
    }
  } else if (defaultModel !== undefined) {
    assertSelectableAlias(defaultModel, '[subagent].default_model');
    modelAlias = defaultModel;
    modelSource = 'default';
  } else if (secondary?.model !== undefined) {
    modelAlias = secondaryBindingAlias(secondary);
    modelSource = 'secondary';
  } else {
    modelAlias = own.modelAlias;
    modelSource = 'caller';
    inheritedCallerBinding = true;
  }

  const thinkingEffort =
    tool.thinkingEffort ??
    profile.thinkingEffort ??
    config?.subagent?.defaultEffort ??
    (modelSource === 'secondary' ? secondary?.defaultEffort : undefined) ??
    (inheritedCallerBinding ? own.thinkingEffort : undefined);

  return recordBindingSource({
    modelAlias,
    thinkingEffort,
  }, modelSource);
}

function normalizeRequest(
  request: SubagentModelChoice | SubagentBindingRequest | undefined,
): SubagentBindingRequest {
  return typeof request === 'string' ? { modelPreference: request } : (request ?? {});
}

function assertValidRequest(request: SubagentBindingRequest, source: string): void {
  if (request.modelAlias !== undefined && request.modelPreference !== undefined) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `${source} cannot set both model and model_alias`,
    );
  }
}

function selectModelRequest(
  tool: SubagentBindingRequest,
  profile: SubagentBindingRequest,
): (SubagentBindingRequest & { readonly source: 'tool' | 'profile' }) | undefined {
  if (tool.modelAlias !== undefined || tool.modelPreference !== undefined) {
    return { ...tool, source: 'tool' };
  }
  if (profile.modelAlias !== undefined || profile.modelPreference !== undefined) {
    return { ...profile, source: 'profile' };
  }
  return undefined;
}

function secondaryBindingAlias(secondary: SecondaryModelConfig): string {
  return secondaryModelPatch(secondary) === undefined
    ? secondary.model!
    : SECONDARY_DERIVED_MODEL_ALIAS;
}

function assertSelectableAlias(alias: string, source: string): void {
  if (alias === SECONDARY_DERIVED_MODEL_ALIAS) throw invalidInternalAlias(source);
}

function invalidInternalAlias(source: string): KimiError {
  return new KimiError(
    ErrorCodes.CONFIG_INVALID,
    `${source} cannot select reserved internal model alias "${SECONDARY_DERIVED_MODEL_ALIAS}"`,
    { details: { model: SECONDARY_DERIVED_MODEL_ALIAS } },
  );
}

export function subagentDisplayModel(
  config: KimiConfig | undefined,
  boundAlias: string | undefined,
): string | undefined {
  if (boundAlias !== SECONDARY_DERIVED_MODEL_ALIAS) return boundAlias;
  return config?.secondaryModel?.model ?? boundAlias;
}

/**
 * The "Available models" block appended to the `Agent` / `AgentSwarm` tool
 * descriptions so the parent model knows it can pick. `undefined` when the
 * secondary model is not configured or the caller's model is not bound yet.
 */
export function buildSubagentModelDescriptions(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
  callerModelAlias: string | undefined,
): string | undefined {
  if (!flags.enabled('secondary-model')) return undefined;
  const secondaryModel = resolveSecondaryModel(config, flags)?.model;
  const aliases = Object.keys(config?.models ?? {}).filter(
    (alias) => alias !== SECONDARY_DERIVED_MODEL_ALIAS,
  );
  const lines: string[] = [];
  if (secondaryModel !== undefined && callerModelAlias !== undefined) {
    lines.push(
      'Available models (pass via model):',
      `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks`,
      `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
    );
  }
  if (aliases.length > 0) {
    lines.push(`Configured model aliases (pass an exact value via model_alias): ${aliases.join(', ')}`);
  }
  lines.push('Pass thinking_effort to override the thinking effort for a new subagent.');
  return lines.join('\n');
}

export type SubagentBindingSchemaUsage = 'agent' | 'swarm';

const bindingSchemaConstraints = new WeakSet<object>();
const BINDING_FIELD_NAMES = ['model', 'model_alias', 'thinking_effort'] as const;

/** Add binding rules that zod refinements cannot project into JSON Schema. */
export function addSubagentBindingSchemaConstraints(
  parameters: Record<string, unknown>,
  usage: SubagentBindingSchemaUsage,
): void {
  const properties = parameters['properties'];
  if (typeof properties !== 'object' || properties === null) return;
  const propertyMap = properties as Record<string, unknown>;
  for (const field of ['model_alias', 'thinking_effort']) {
    const property = propertyMap[field];
    if (typeof property === 'object' && property !== null) {
      (property as Record<string, unknown>)['pattern'] = '\\S';
    }
  }

  const constraints: Record<string, unknown>[] = [
    { not: { required: ['model', 'model_alias'] } },
    usage === 'agent' ? agentResumeBindingConstraint() : swarmResumeBindingConstraint(),
  ];
  for (const constraint of constraints) bindingSchemaConstraints.add(constraint);
  const current = parameters['allOf'];
  parameters['allOf'] = [...(Array.isArray(current) ? current : []), ...constraints];
}

function agentResumeBindingConstraint(): Record<string, unknown> {
  return {
    not: {
      allOf: [
        {
          required: ['resume'],
          properties: { resume: { type: 'string', pattern: '\\S' } },
        },
        anyBindingFieldPresent(),
      ],
    },
  };
}

function swarmResumeBindingConstraint(): Record<string, unknown> {
  return {
    not: {
      allOf: [
        {
          required: ['resume_agent_ids'],
          properties: {
            resume_agent_ids: { type: 'object', minProperties: 1 },
            items: { type: 'array', maxItems: 0 },
          },
        },
        anyBindingFieldPresent(),
      ],
    },
  };
}

function anyBindingFieldPresent(): Record<string, unknown> {
  return { anyOf: BINDING_FIELD_NAMES.map((field) => ({ required: [field] })) };
}

export function normalizeSubagentBindingValue(
  value: string | undefined,
  field: 'model_alias' | 'thinking_effort',
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, `${field} must be a non-empty string`);
  }
  return normalized;
}

/**
 * Strip the `model` property from a subagent collaboration tool's advertised
 * JSON schema. While the `secondary-model` experiment is off the parameter is
 * a silent no-op, so the schema the model sees (and the args validator
 * compiled from the same advertised schema) drops it entirely — the
 * secondary-model concept never enters the prompt, and a stray `model`
 * argument is rejected instead of silently inheriting the caller's model.
 * Returns the input unchanged when there is no `model` property; otherwise a
 * shallow copy — the input is never mutated, so callers can keep both
 * variants as shared constants.
 */
export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (typeof properties !== 'object' || properties === null) {
    return parameters;
  }
  const nextProperties = { ...(properties as Record<string, unknown>) };
  const bindingFields = ['model', 'model_alias', 'thinking_effort'];
  if (!bindingFields.some((field) => field in nextProperties)) return parameters;
  for (const field of bindingFields) delete nextProperties[field];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const allOf = parameters['allOf'];
  if (Array.isArray(allOf)) {
    const retained = allOf.filter(
      (constraint) =>
        typeof constraint !== 'object' ||
        constraint === null ||
        !bindingSchemaConstraints.has(constraint),
    );
    if (retained.length > 0) next['allOf'] = retained;
    else delete next['allOf'];
  }
  const required = parameters['required'];
  if (Array.isArray(required) && required.some((entry) => bindingFields.includes(String(entry)))) {
    next['required'] = required.filter((entry) => !bindingFields.includes(String(entry)));
  }
  return next;
}

/**
 * Point a spawn-time model resolution failure at the secondary-model
 * configuration when the bound model is not the caller's own — otherwise the
 * parent model sees a bare "model not configured" error with no hint that it
 * comes from `[secondary_model]`.
 */
export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
  source: SubagentModelSource = 'secondary',
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (source !== 'secondary') return error;
  if (!(error instanceof KimiError) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  // ProviderManager tags only the missing-alias failure with details.model;
  // malformed aliases and providers must keep their own actionable errors.
  if (error.details?.['model'] !== boundModel) return error;
  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ALIAS
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ALIAS}"`
      : `"${boundModel}"`;
  return new KimiError(
    error.code,
    `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      details: {
        ...error.details,
        secondaryModel: boundModel,
      },
    },
  );
}
