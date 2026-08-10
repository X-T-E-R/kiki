/**
 * `subagent` domain — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`default_model`,
 * `default_effort`, and `timeout_ms` on disk) together with the
 * `KIMI_SUBAGENT_TIMEOUT_MS` env override for timeout (precedence: env >
 * config.toml > 2h default). While
 * the env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Per-run
 * timeouts resolve through `resolveSubagentTimeoutMs`, and the timeout
 * message renders with `formatSubagentTimeoutDescription`.
 *
 * The same experiment gates exact alias and thinking-effort tool fields,
 * profile fields, `[subagent]` defaults, and the legacy symbolic
 * primary/secondary selector. Model and effort precedence are resolved
 * independently. A secondary recipe with patch fields binds the
 * synthesized derived entry (`SECONDARY_DERIVED_MODEL_ID`); a pointer-only
 * recipe binds the pointed entry directly. `default_effort` is passed as the
 * explicit subagent thinking only when that recipe supplied the model. Both
 * tools resolve spawn
 * bindings through `resolveSubagentBinding`, advertise the pair via
 * `buildSubagentModelDescriptions` (each line suffixed with the entry's
 * resolved capability flags, so the parent can route multimodal or
 * thinking-heavy subagent tasks instead of guessing from the model id),
 * and wrap spawn failures with
 * `wrapSubagentModelError`; while the experiment is off they also strip the
 * no-op binding parameters from their advertised schemas via
 * `stripSubagentModelParameter`. Spawn reporting reads the display-facing
 * alias from `subagentDisplayModel`: the derived entry id means nothing to a
 * user, so it resolves back to the recipe's base alias — flag-independent on
 * purpose, since interpreting an already-persisted derived binding (resume)
 * must keep working after the experiment is switched off. Self-registered
 * at module load via `registerConfigSection`.
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
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) {
    return recordBindingSource({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: subagentDisplayModel(config, own.modelAlias),
    }, 'caller');
  }

  const tool = normalizeRequest(requested);
  const profile = normalizeRequest(profileRequest);
  assertValidRequest(tool, 'tool input');
  assertValidRequest(profile, 'agent profile');
  const secondary = resolveSecondaryModel(config, flags);
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
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return undefined;
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

const bindingSchemaConstraints = new WeakSet<object>();
const BINDING_FIELD_NAMES = ['model', 'model_alias', 'thinking_effort'] as const;

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
  if (!isPlainObject(properties)) return parameters;
  const nextProperties = { ...properties };
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
