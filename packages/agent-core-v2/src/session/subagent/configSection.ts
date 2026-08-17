/**
 * `subagent` domain — subagent config schemas and binding resolution.
 *
 * Owns the subagent timeout and the declarative secondary-model pool, resolves
 * pool choices together with the fork's exact model/thinking extensions, and
 * records whether a spawn binding should inherit the caller on resume or stay
 * fixed. Self-registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { isPlainObject } from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';
import type { IModelCatalog } from '#/kosong/model/catalog';
import { AGENTS_SECTION, type AgentsConfig } from '#/session/agentCollaboration/configSection';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';
export const SECONDARY_MODEL_SECTION = 'secondaryModel';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const SecondaryModelConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  models: z.record(z.string(), z.string()).optional(),
  force: z.boolean().optional(),
  model: z.string().min(1).optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

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

registerConfigSection(SECONDARY_MODEL_SECTION, SecondaryModelConfigSchema);

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';

export interface SubagentModelPool {
  readonly defaultModel?: string;
  readonly models: Record<string, string>;
}

export interface SubagentBindingRequest {
  readonly modelAlias?: string;
  readonly modelPreference?: string;
  readonly thinkingEffort?: string;
}

export interface SubagentBindingOwner {
  readonly modelAlias: string;
  readonly thinkingLevel: string;
  readonly inheritByDefault?: boolean;
}

export type SubagentModelSource = 'tool' | 'profile' | 'default' | 'secondary' | 'caller';
export type SubagentBindingMode = 'inherit' | 'fixed';

export interface SubagentModelBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
}

interface SubagentBindingMetadata {
  readonly source: SubagentModelSource;
  readonly mode: SubagentBindingMode;
}

const bindingMetadata = new WeakMap<SubagentModelBinding, SubagentBindingMetadata>();

export function subagentModelSource(binding: SubagentModelBinding): SubagentModelSource {
  return bindingMetadata.get(binding)?.source ?? 'caller';
}

export function subagentBindingMode(binding: SubagentModelBinding): SubagentBindingMode {
  return bindingMetadata.get(binding)?.mode ?? 'fixed';
}

function recordBindingMetadata(
  binding: SubagentModelBinding,
  metadata: SubagentBindingMetadata,
): SubagentModelBinding {
  Object.defineProperty(binding, 'displayModel', {
    value: binding.displayModel,
    enumerable: false,
  });
  bindingMetadata.set(binding, metadata);
  return binding;
}

export function resolveSubagentModelPool(config: IConfigService): SubagentModelPool | undefined {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.models !== undefined) {
    return { defaultModel: section.defaultModel, models: section.models };
  }
  if (section?.defaultModel !== undefined) {
    return { defaultModel: section.defaultModel, models: { [section.defaultModel]: '' } };
  }
  if (section?.model !== undefined) {
    return { defaultModel: section.model, models: { [section.model]: '' } };
  }
  return undefined;
}

export const SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model].force is set';

export const SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE =
  '[secondary_model].force cannot be combined with [secondary_model.models]: the pool table only exists to offer the main agent a choice, and force removes that choice';

export function isSubagentModelForced(config: IConfigService): boolean {
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION)?.force === true;
}

export function exposesSubagentModelChoice(config: IConfigService, flags: IFlagService): boolean {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return false;
  if (isSubagentModelForced(config)) return false;
  return resolveSubagentModelPool(config) !== undefined;
}

export const SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model.models] is configured';

export const SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE = `[secondary_model.models] key "${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved: it always binds the caller's own model. Rename the pool entry.`;

export function assertValidSubagentModelPool(
  pool: SubagentModelPool,
  modelCatalog: IModelCatalog,
): void {
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  const aliases = Object.keys(pool.models);
  if (pool.defaultModel === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, pool.defaultModel)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `[secondary_model].default_model "${pool.defaultModel}" is not a [secondary_model.models] key. Available models: ${aliases.join(', ')}.`,
      { details: { model: pool.defaultModel, availableModels: aliases } },
    );
  }
  for (const alias of aliases) {
    try {
      modelCatalog.get(alias);
    } catch (error) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[secondary_model.models] entry "${alias}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { model: alias } },
      );
    }
  }
}

export function assertValidSubagentModelConfig(
  config: IConfigService,
  flags: IFlagService,
  modelCatalog: IModelCatalog,
): void {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return;
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.force === true) {
    if (section.models !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'force' },
      });
    }
    if (section.defaultModel === undefined && section.model === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
      });
    }
  }
  const pool = resolveSubagentModelPool(config);
  if (pool !== undefined) assertValidSubagentModelPool(pool, modelCatalog);
}

export function cascadeSubagentModelPool(
  section: SecondaryModelConfig | undefined,
  survivingModels: Record<string, unknown>,
  renamedAliases: ReadonlyMap<string, string> = new Map(),
): SecondaryModelConfig | null | undefined {
  if (section === undefined) return undefined;
  const remap = (alias: string): string => renamedAliases.get(alias) ?? alias;
  const nextDefault = section.defaultModel === undefined ? undefined : remap(section.defaultModel);
  const nextLegacyDefault = section.model === undefined ? undefined : remap(section.model);
  const effectiveDefault = nextDefault ?? nextLegacyDefault;
  if (effectiveDefault !== undefined && !(effectiveDefault in survivingModels)) return null;

  let changed = nextDefault !== section.defaultModel || nextLegacyDefault !== section.model;
  let nextPool: Record<string, string> | undefined;
  if (section.models !== undefined) {
    nextPool = {};
    for (const [alias, description] of Object.entries(section.models)) {
      const key = remap(alias);
      if (!(key in survivingModels)) {
        changed = true;
        continue;
      }
      if (key !== alias) changed = true;
      nextPool[key] = description;
    }
    if (Object.keys(nextPool).length === 0) {
      nextPool = undefined;
      changed = true;
    }
  }
  if (!changed) return undefined;
  return { ...section, defaultModel: nextDefault, model: nextLegacyDefault, models: nextPool };
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: SubagentBindingOwner,
  requested?: string | SubagentBindingRequest,
  profileRequest: SubagentBindingRequest = {},
): SubagentModelBinding {
  const tool = normalizeRequest(requested);
  const profile = normalizeRequest(profileRequest);
  assertValidRequest(tool, 'tool input');
  assertValidRequest(profile, 'agent profile');

  const enabled = flags.enabled(SECONDARY_MODEL_FLAG_ID);
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  const selected = selectModelRequest(tool, profile);
  const explicitThinking = normalized(tool.thinkingEffort) ?? normalized(profile.thinkingEffort);

  if (enabled && section?.force === true) {
    if (section.models !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'force' },
      });
    }
    const forcedModel = section.defaultModel ?? section.model;
    if (forcedModel === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
      });
    }
    if (selected !== undefined) {
      const choice = selected.modelAlias ?? selected.modelPreference;
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid model "${choice}": [secondary_model].force is set, so every subagent binds "${forcedModel}" (omit the model parameter).`,
        { details: { model: choice } },
      );
    }
    return recordBindingMetadata(
      { model: forcedModel, thinking: explicitThinking, displayModel: forcedModel },
      { source: 'secondary', mode: 'fixed' },
    );
  }

  if (selected?.modelAlias !== undefined) {
    const model = selected.modelAlias;
    return recordBindingMetadata(
      { model, thinking: explicitThinking, displayModel: model },
      { source: selected.source, mode: 'fixed' },
    );
  }

  if (selected?.modelPreference === PRIMARY_SUBAGENT_MODEL_CHOICE) {
    return recordBindingMetadata(
      {
        model: own.modelAlias,
        thinking: explicitThinking ?? own.thinkingLevel,
        displayModel: own.modelAlias,
      },
      { source: selected.source, mode: 'fixed' },
    );
  }

  const pool = enabled ? resolveSubagentModelPool(config) : undefined;
  if (selected?.modelPreference === 'secondary' && selected.source === 'profile') {
    const choice = pool?.defaultModel;
    if (choice === undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        'The profile requests the secondary model, but no [secondary_model] default is configured.',
        { details: { model: 'secondary' } },
      );
    }
    return recordBindingMetadata(
      { model: choice, thinking: explicitThinking, displayModel: choice },
      { source: 'profile', mode: 'fixed' },
    );
  }

  if (pool === undefined) {
    if (selected?.modelPreference !== undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid model "${selected.modelPreference}": no [secondary_model.models] pool is configured, so subagents inherit the caller's model (pass "primary" or omit the model parameter).`,
        { details: { model: selected.modelPreference } },
      );
    }
    const mode: SubagentBindingMode =
      explicitThinking === undefined && own.inheritByDefault !== false ? 'inherit' : 'fixed';
    return recordBindingMetadata(
      {
        model: own.modelAlias,
        thinking: explicitThinking ?? own.thinkingLevel,
        displayModel: own.modelAlias,
      },
      { source: 'caller', mode },
    );
  }

  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  const choice = selected?.modelPreference ?? pool.defaultModel;
  if (choice === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, choice)) {
    const available = [...Object.keys(pool.models), PRIMARY_SUBAGENT_MODEL_CHOICE];
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid model "${choice}". Available models: ${available.join(', ')}.`,
      { details: { model: choice, availableModels: available } },
    );
  }
  return recordBindingMetadata(
    { model: choice, thinking: explicitThinking, displayModel: choice },
    { source: 'secondary', mode: 'fixed' },
  );
}

export function resolveAgentCollaborationBinding(
  config: IConfigService,
  flags: IFlagService,
  own: SubagentBindingOwner,
  request: Pick<SubagentBindingRequest, 'modelAlias' | 'thinkingEffort'>,
  profile: SubagentBindingRequest,
): SubagentModelBinding {
  const agents = config.get<AgentsConfig | undefined>(AGENTS_SECTION);
  const requestModel = normalized(request.modelAlias);
  const profileModel = normalized(profile.modelAlias);
  const exactModel = requestModel ?? profileModel;
  const pool = flags.enabled(SECONDARY_MODEL_FLAG_ID) ? resolveSubagentModelPool(config) : undefined;
  const profilePreference = normalized(profile.modelPreference);
  const preferredModel =
    profilePreference === PRIMARY_SUBAGENT_MODEL_CHOICE
      ? own.modelAlias
      : profilePreference === 'secondary'
        ? pool?.defaultModel
        : undefined;
  if (profilePreference === 'secondary' && preferredModel === undefined) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      'The profile requests the secondary model, but no [secondary_model] default is configured.',
      { details: { model: 'secondary' } },
    );
  }
  const configuredDefault = normalized(agents?.defaultSubagentModel);
  const poolDefault = pool?.defaultModel;
  const model = exactModel ?? preferredModel ?? configuredDefault ?? poolDefault ?? own.modelAlias;
  const source: SubagentModelSource =
    requestModel !== undefined
      ? 'tool'
      : profileModel !== undefined || preferredModel !== undefined
        ? 'profile'
        : configuredDefault !== undefined
          ? 'default'
          : poolDefault !== undefined
            ? 'secondary'
            : 'caller';
  const thinking =
    normalized(request.thinkingEffort) ??
    normalized(profile.thinkingEffort) ??
    normalized(agents?.defaultSubagentReasoningEffort) ??
    (source !== 'secondary' && model === own.modelAlias ? own.thinkingLevel : undefined);
  const mode: SubagentBindingMode =
    source === 'caller' &&
    own.inheritByDefault !== false &&
    normalized(request.thinkingEffort) === undefined &&
    normalized(profile.thinkingEffort) === undefined &&
    normalized(agents?.defaultSubagentReasoningEffort) === undefined
      ? 'inherit'
      : 'fixed';
  return recordBindingMetadata(
    { model, thinking, displayModel: model },
    { source, mode },
  );
}

function normalizeRequest(
  request: string | SubagentBindingRequest | undefined,
): SubagentBindingRequest {
  return typeof request === 'string' ? { modelPreference: request } : (request ?? {});
}

function assertValidRequest(request: SubagentBindingRequest, source: string): void {
  if (normalized(request.modelAlias) !== undefined && normalized(request.modelPreference) !== undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, `${source} cannot set both model and model_alias`);
  }
}

function selectModelRequest(
  tool: SubagentBindingRequest,
  profile: SubagentBindingRequest,
): (SubagentBindingRequest & { readonly source: 'tool' | 'profile' }) | undefined {
  if (normalized(tool.modelAlias) !== undefined || normalized(tool.modelPreference) !== undefined) {
    return {
      modelAlias: normalized(tool.modelAlias),
      modelPreference: normalized(tool.modelPreference),
      source: 'tool',
    };
  }
  if (normalized(profile.modelAlias) !== undefined || normalized(profile.modelPreference) !== undefined) {
    return {
      modelAlias: normalized(profile.modelAlias),
      modelPreference: normalized(profile.modelPreference),
      source: 'profile',
    };
  }
  return undefined;
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function subagentDisplayModel(
  _config: IConfigService,
  boundAlias: string,
): string {
  return boundAlias;
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
): string | undefined {
  const lines: string[] = [];
  if (exposesSubagentModelChoice(config, flags)) {
    const pool = resolveSubagentModelPool(config)!;
    lines.push('Available models (pass via model):');
    const defaultModel = pool.defaultModel;
    const markersFor = (alias: string): string => {
      const markers: string[] = [];
      if (alias === defaultModel) markers.push('[default]');
      if (alias === callerModelAlias) markers.push('[main model]');
      return markers.length === 0 ? '' : ` ${markers.join(' ')}`;
    };
    if (defaultModel !== undefined && Object.hasOwn(pool.models, defaultModel)) {
      lines.push(
        formatPoolLine(`${defaultModel}${markersFor(defaultModel)}`, pool.models[defaultModel]!),
      );
    }
    for (const [alias, description] of Object.entries(pool.models)) {
      if (alias === defaultModel) continue;
      lines.push(formatPoolLine(`${alias}${markersFor(alias)}`, description));
    }
    const callerInPool =
      callerModelAlias !== undefined && Object.hasOwn(pool.models, callerModelAlias);
    lines.push(
      `- ${PRIMARY_SUBAGENT_MODEL_CHOICE}${callerInPool ? ` (${callerModelAlias})` : ''}: freeze the main model and its current thinking level for this subagent`,
    );
  }
  const aliases = Object.keys(config.get<Record<string, unknown> | undefined>(MODELS_SECTION) ?? {});
  if (aliases.length > 0) {
    lines.push(`Configured model aliases (pass an exact value via model_alias): ${aliases.join(', ')}`);
  }
  lines.push('Pass thinking_effort to override the thinking effort for a new subagent.');
  return lines.join('\n');
}

function formatPoolLine(label: string, description: string): string {
  return description === '' ? `- ${label}` : `- ${label}: ${description}`;
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
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `${field} must be a non-empty string`);
  }
  return normalizedValue;
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
  return new Error2(
    error.code,
    `${error.message} (subagent model "${boundModel}" comes from [secondary_model.models] — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        subagentModel: boundModel,
        subagentModelConfig: {
          section: 'secondary_model.models',
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
