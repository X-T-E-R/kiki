/**
 * `subagent` domain — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` defaults and timeout override, resolves exact model
 * aliases and thinking effort independently across tool, profile, default,
 * and caller layers, and conditionally inserts the legacy secondary recipe
 * only while the `secondary-model` experiment is enabled. The same flag gates
 * only the symbolic `model=primary|secondary` selector and its schema field;
 * exact `model_alias`, `thinking_effort`, and `[subagent]` defaults remain
 * active when it is off. Also owns display alias normalization, binding-source
 * tracking, catalog-error classification/wrapping, model descriptions, schema
 * constraints, and timeout formatting. Self-registered at module load via
 * `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { isPlainObject } from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  MODELS_SECTION,
  SECONDARY_MODEL_ENV,
  SECONDARY_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelPatch,
} from '#/app/kosongConfig/secondaryModelOverlay';
import { type SecondaryModelConfig } from '#/app/kosongConfig/configSection';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';

import { SECONDARY_MODEL_FLAG_ID } from './flag';
import { AGENTS_SECTION, type AgentsConfig } from '#/session/agentCollaboration/configSection';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  defaultModel: z.string().trim().min(1).optional(),
  defaultEffort: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS },
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
});

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export type SubagentModelChoice = AgentModelPreference;

export interface SubagentBindingRequest {
  readonly modelAlias?: string;
  readonly modelPreference?: SubagentModelChoice;
  readonly thinkingEffort?: string;
}

export type SubagentModelSource = 'tool' | 'profile' | 'default' | 'secondary' | 'caller';

export interface SubagentModelBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
}

export function resolveAgentCollaborationBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  request: Pick<SubagentBindingRequest, 'modelAlias' | 'thinkingEffort'>,
  profile: SubagentBindingRequest,
): SubagentModelBinding {
  const agents = config.get<AgentsConfig | undefined>(AGENTS_SECTION);
  const exactModel = normalized(request.modelAlias) ?? normalized(profile.modelAlias);
  if (exactModel !== undefined) assertSelectableAlias(exactModel, 'agent collaboration binding');
  const legacyProfile = flags.enabled(SECONDARY_MODEL_FLAG_ID)
    ? legacyPreferenceModel(profile.modelPreference, config, flags, own.modelAlias)
    : undefined;
  const configuredDefault = normalized(agents?.defaultSubagentModel);
  if (configuredDefault !== undefined) assertSelectableAlias(configuredDefault, '[agents].default_subagent_model');
  const legacyDefault = flags.enabled(SECONDARY_MODEL_FLAG_ID)
    ? legacyDefaultModel(config, flags, own.modelAlias)
    : undefined;
  const model = exactModel ?? legacyProfile ?? configuredDefault ?? legacyDefault ?? own.modelAlias;
  const inheritsCaller = model === own.modelAlias && (
    (exactModel === undefined && legacyProfile === undefined && configuredDefault === undefined && legacyDefault === undefined) ||
    (flags.enabled(SECONDARY_MODEL_FLAG_ID) && profile.modelPreference === 'primary')
  );
  const thinking =
    normalized(request.thinkingEffort) ??
    normalized(profile.thinkingEffort) ??
    normalized(agents?.defaultSubagentReasoningEffort) ??
    (flags.enabled(SECONDARY_MODEL_FLAG_ID) ? legacyDefaultEffort(config, flags, model) : undefined) ??
    (inheritsCaller ? own.thinkingLevel : undefined);
  return { model, thinking, displayModel: subagentDisplayModel(config, model) };
}

function legacyPreferenceModel(
  preference: AgentModelPreference | undefined,
  config: IConfigService,
  flags: IFlagService,
  caller: string,
): string | undefined {
  if (preference === 'primary') return caller;
  if (preference !== 'secondary') return undefined;
  const secondary = resolveSecondaryModel(config, flags);
  return secondary?.model === undefined ? caller : secondaryBindingAlias(secondary);
}

function legacyDefaultModel(config: IConfigService, flags: IFlagService, caller: string): string {
  const defaults = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
  if (normalized(defaults?.defaultModel) !== undefined) return defaults!.defaultModel!;
  const secondary = resolveSecondaryModel(config, flags);
  return secondary?.model === undefined ? caller : secondaryBindingAlias(secondary);
}

function legacyDefaultEffort(config: IConfigService, flags: IFlagService, model: string): string | undefined {
  const defaults = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
  if (normalized(defaults?.defaultEffort) !== undefined) return defaults!.defaultEffort;
  const secondary = resolveSecondaryModel(config, flags);
  return secondary?.model !== undefined && secondaryBindingAlias(secondary) === model
    ? normalized(secondary.defaultEffort)
    : undefined;
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
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
  config: IConfigService,
  flags: IFlagService,
): SecondaryModelConfig | undefined {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return undefined;
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: SubagentModelChoice | SubagentBindingRequest,
  profileRequest?: SubagentBindingRequest,
): SubagentModelBinding {
  const secondaryEnabled = flags.enabled(SECONDARY_MODEL_FLAG_ID);
  const tool = normalizeRequest(requested);
  const rawProfile = normalizeRequest(profileRequest);
  if (!secondaryEnabled && tool.modelPreference !== undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'The model parameter requires the secondary-model experiment to be enabled',
      { details: { model: tool.modelPreference, flag: SECONDARY_MODEL_FLAG_ID } },
    );
  }
  const profile: SubagentBindingRequest = secondaryEnabled
    ? rawProfile
    : {
        modelAlias: rawProfile.modelAlias,
        modelPreference: undefined,
        thinkingEffort: rawProfile.thinkingEffort,
      };
  assertValidRequest(tool, 'tool input');
  assertValidRequest(profile, 'agent profile');
  const secondary = secondaryEnabled ? resolveSecondaryModel(config, flags) : undefined;
  if (secondary?.model === SECONDARY_DERIVED_MODEL_ID) {
    throw invalidInternalAlias('[secondary_model].model');
  }
  const defaults = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);

  let model: string;
  let modelSource: SubagentModelSource;
  let inheritedCallerBinding = false;
  const selected = selectModelRequest(tool, profile);
  if (selected?.modelAlias !== undefined) {
    assertSelectableAlias(selected.modelAlias, selected.source);
    model = selected.modelAlias;
    modelSource = selected.source;
  } else if (selected?.modelPreference === 'primary') {
    model = own.modelAlias;
    modelSource = selected.source;
    inheritedCallerBinding = true;
  } else if (selected?.modelPreference === 'secondary') {
    if (secondary?.model !== undefined) {
      model = secondaryBindingAlias(secondary);
      modelSource = 'secondary';
    } else {
      model = own.modelAlias;
      modelSource = selected.source;
      inheritedCallerBinding = true;
    }
  } else if (defaults?.defaultModel !== undefined) {
    assertSelectableAlias(defaults.defaultModel, '[subagent].default_model');
    model = defaults.defaultModel;
    modelSource = 'default';
  } else if (secondary?.model !== undefined) {
    model = secondaryBindingAlias(secondary);
    modelSource = 'secondary';
  } else {
    model = own.modelAlias;
    modelSource = 'caller';
    inheritedCallerBinding = true;
  }

  const thinking =
    tool.thinkingEffort ??
    profile.thinkingEffort ??
    defaults?.defaultEffort ??
    (modelSource === 'secondary' ? secondary?.defaultEffort : undefined) ??
    (inheritedCallerBinding ? own.thinkingLevel : undefined);

  return recordBindingSource({
    model,
    thinking,
    displayModel: subagentDisplayModel(config, model),
  }, modelSource);
}

function normalizeRequest(
  request: SubagentModelChoice | SubagentBindingRequest | undefined,
): SubagentBindingRequest {
  return typeof request === 'string' ? { modelPreference: request } : (request ?? {});
}

function assertValidRequest(request: SubagentBindingRequest, source: string): void {
  if (request.modelAlias !== undefined && request.modelPreference !== undefined) {
    throw new Error2(
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
    : SECONDARY_DERIVED_MODEL_ID;
}

function assertSelectableAlias(alias: string, source: string): void {
  if (alias === SECONDARY_DERIVED_MODEL_ID) throw invalidInternalAlias(source);
}

function invalidInternalAlias(source: string): Error2 {
  return new Error2(
    ErrorCodes.CONFIG_INVALID,
    `${source} cannot select reserved internal model alias "${SECONDARY_DERIVED_MODEL_ID}"`,
    { details: { model: SECONDARY_DERIVED_MODEL_ID } },
  );
}

export function subagentDisplayModel(
  config: IConfigService,
  boundAlias: string,
): string {
  if (boundAlias !== SECONDARY_DERIVED_MODEL_ID) return boundAlias;
  return (
    config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION)?.model ?? boundAlias
  );
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
  modelCatalog: IModelCatalog,
): string | undefined {
  const secondary = resolveSecondaryModel(config, flags);
  const secondaryModel = secondary?.model;
  const aliases = Object.keys(config.get<Record<string, unknown> | undefined>(MODELS_SECTION) ?? {})
    .filter((alias) => alias !== SECONDARY_DERIVED_MODEL_ID);
  const lines: string[] = [];
  if (secondaryModel !== undefined && callerModelAlias !== undefined) {
    const boundSecondary =
      secondaryModelPatch(secondary) === undefined ? secondaryModel : SECONDARY_DERIVED_MODEL_ID;
    lines.push(
      'Available models (pass via model):',
      `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks${capabilitiesSuffix(resolvedCapabilities(modelCatalog, boundSecondary))}`,
      `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks${capabilitiesSuffix(resolvedCapabilities(modelCatalog, callerModelAlias))}`,
    );
  }
  if (aliases.length > 0) {
    lines.push(`Configured model aliases (pass an exact value via model_alias): ${aliases.join(', ')}`);
  }
  lines.push('Pass thinking_effort to override the thinking effort for a new subagent.');
  return lines.join('\n');
}

export type SubagentBindingSchemaUsage = 'agent' | 'swarm';

const legacyModelSchemaConstraints = new WeakSet<object>();
const BINDING_FIELD_NAMES = ['route', 'model', 'model_alias', 'thinking_effort'] as const;

export function addSubagentBindingSchemaConstraints(
  parameters: Record<string, unknown>,
  usage: SubagentBindingSchemaUsage,
): void {
  const properties = parameters['properties'];
  if (!isPlainObject(properties)) return;
  for (const field of ['model_alias', 'thinking_effort']) {
    const property = properties[field];
    if (isPlainObject(property)) property['pattern'] = '\\S';
  }

  const legacyConstraint = { not: { required: ['model', 'model_alias'] } };
  legacyModelSchemaConstraints.add(legacyConstraint);
  const constraints: Record<string, unknown>[] = [
    legacyConstraint,
    usage === 'agent' ? agentResumeBindingConstraint() : swarmResumeBindingConstraint(),
  ];
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
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `${field} must be a non-empty string`);
  }
  return normalized;
}

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const satisfies readonly (keyof ModelCapability)[];

function capabilitiesSuffix(capability: ModelCapability | undefined): string {
  if (capability === undefined) return '';
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capability[flag] === true);
  return `; capabilities: ${names.length === 0 ? 'none' : names.join(', ')}`;
}

function resolvedCapabilities(
  modelCatalog: IModelCatalog,
  model: string,
): ModelCapability | undefined {
  try {
    return modelCatalog.get(model).capabilities;
  } catch {
    return undefined;
  }
}

export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('model' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const allOf = parameters['allOf'];
  if (Array.isArray(allOf)) {
    const retained = allOf.filter(
      (constraint) =>
        typeof constraint !== 'object' ||
        constraint === null ||
        !legacyModelSchemaConstraints.has(constraint),
    );
    if (retained.length > 0) next['allOf'] = retained;
    else delete next['allOf'];
  }
  const required = parameters['required'];
  if (Array.isArray(required) && required.some((entry) => entry === 'model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

export function isMissingSubagentModelAlias(error: unknown, alias: string): boolean {
  return (
    isError2(error) &&
    error.code === ErrorCodes.CONFIG_INVALID &&
    error.details?.['model'] === alias
  );
}

export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
  source: SubagentModelSource = 'secondary',
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (source !== 'secondary') return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;
  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ID
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ID}"`
      : `"${boundModel}"`;
  return new Error2(
    error.code,
    `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        secondaryModel: boundModel,
        secondaryModelConfig: {
          section: 'secondaryModel.model',
          environment: SECONDARY_MODEL_ENV,
        },
      },
    },
  );
}

export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}
