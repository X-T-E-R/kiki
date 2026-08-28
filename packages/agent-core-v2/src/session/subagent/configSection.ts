/**
 * `subagent` domain — subagent config schema and binding resolution.
 *
 * Owns the subagent timeout and resolves the model a spawn binds. A subagent
 * model has exactly two legitimate sources: a pin on the agent profile (or the
 * route/lease that stands in for it) and an explicit `model_alias` at dispatch
 * time. Nothing derives a subagent model from the caller, so a spawn with
 * neither source fails closed instead of silently following the main agent.
 * Self-registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { isPlainObject } from '#/app/config/toml';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { IModelService } from '#/kosong/model/model';

import {
  assertRoleSpawnConstraints,
  resolveRoleThinkingDefault,
  type SubagentRoleModelConstraints,
} from './modelConstraints';

export type { SubagentRoleModelConstraints } from './modelConstraints';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
  denyModels: z.array(z.string()).optional(),
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

export interface SubagentBindingRequest {
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
}

/** Names the dispatch target so an unbound spawn can say what to pin. */
export interface SubagentBindingTarget {
  readonly profileName?: string;
  readonly routeId?: string;
}

export type SubagentModelSource = 'tool' | 'profile';

export interface SubagentModelBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
}

interface SubagentBindingMetadata {
  readonly source: SubagentModelSource;
}

const bindingMetadata = new WeakMap<SubagentModelBinding, SubagentBindingMetadata>();

export function subagentModelSource(binding: SubagentModelBinding): SubagentModelSource {
  return bindingMetadata.get(binding)?.source ?? 'profile';
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

export function canonicalizeSubagentBinding(
  binding: SubagentModelBinding,
  models: IModelService,
): SubagentModelBinding {
  const canonicalModel = models.resolveId(binding.model) ?? binding.model;
  if (canonicalModel === binding.model) return binding;
  return recordBindingMetadata(
    {
      model: canonicalModel,
      thinking: binding.thinking,
      displayModel: binding.displayModel,
    },
    { source: subagentModelSource(binding) },
  );
}

function resolveModelIdentity(model: string, models?: IModelService): string {
  return models?.resolveId(model) ?? model;
}

function deniedModelIdentities(config: IConfigService, models?: IModelService): Set<string> {
  const denyModels = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.denyModels ?? [];
  return new Set(denyModels.map((model) => resolveModelIdentity(model, models)));
}

function assertModelNotDenied(
  config: IConfigService,
  model: string,
  models?: IModelService,
): void {
  const canonicalModel = resolveModelIdentity(model, models);
  if (!deniedModelIdentities(config, models).has(canonicalModel)) return;
  throw new Error2(
    ErrorCodes.CONFIG_INVALID,
    `Subagent model "${canonicalModel}" is denied by [subagent].deny_models.`,
    { details: { model: canonicalModel, deniedModels: [canonicalModel] } },
  );
}

function assertRoleModelConstraints(
  config: IConfigService,
  model: string,
  constraints: SubagentRoleModelConstraints | undefined,
  models?: IModelService,
  thinking?: string,
): void {
  assertRoleSpawnConstraints(
    model,
    constraints,
    models,
    deniedModelIdentities(config, models),
    thinking,
  );
}

export function assertBoundModelAllowed(
  config: IConfigService,
  model: string,
  constraints: SubagentRoleModelConstraints | undefined,
  models?: IModelService,
  thinking?: string,
): void {
  assertModelNotDenied(config, model, models);
  assertRoleModelConstraints(config, model, constraints, models, thinking);
}

export const SUBAGENT_MODEL_UNBOUND_HINT =
  'Pin model_alias on the agent profile (or its route or the caller lease), or pass model_alias with the dispatch. Subagents never take the caller\'s model.';

export function subagentModelUnboundMessage(target?: SubagentBindingTarget): string {
  const named =
    target?.routeId !== undefined
      ? `route "${target.routeId}"`
      : target?.profileName !== undefined
        ? `agent profile "${target.profileName}"`
        : 'this subagent';
  return `No model is bound for ${named}. ${SUBAGENT_MODEL_UNBOUND_HINT}`;
}

/**
 * Resolve the model a spawn binds from the only two permitted sources: the
 * dispatch request and the effective agent profile. Throws when neither
 * supplies a model alias.
 */
export function resolveSubagentBinding(
  config: IConfigService,
  requested: SubagentBindingRequest = {},
  profileRequest: SubagentBindingRequest = {},
  models?: IModelService,
  roleConstraints?: SubagentRoleModelConstraints,
  target?: SubagentBindingTarget,
): SubagentModelBinding {
  const toolModel = normalized(requested.modelAlias);
  const profileModel = normalized(profileRequest.modelAlias);
  const model = toolModel ?? profileModel;
  if (model === undefined) {
    throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, subagentModelUnboundMessage(target), {
      details: {
        profile: target?.profileName,
        route: target?.routeId,
      },
    });
  }
  const source: SubagentModelSource = toolModel !== undefined ? 'tool' : 'profile';
  const thinking =
    normalized(requested.thinkingEffort) ??
    normalized(profileRequest.thinkingEffort) ??
    resolveRoleThinkingDefault(roleConstraints, model, models);
  assertBoundModelAllowed(config, model, roleConstraints, models, thinking);
  return recordBindingMetadata({ model, thinking, displayModel: model }, { source });
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function buildSubagentModelDescriptions(models: IModelService): string | undefined {
  const aliases = Object.keys(models.list());
  const lines: string[] = [];
  if (aliases.length > 0) {
    lines.push(
      `Configured model aliases (pass an exact value via model_alias): ${aliases.join(', ')}`,
    );
  }
  lines.push(
    'A subagent runs on the model its profile pins, or the model_alias you pass here — never on your own model. Pass effort to override the thinking effort.',
  );
  return lines.join('\n');
}

export type SubagentBindingSchemaUsage = 'agent' | 'swarm';

const BINDING_FIELD_NAMES = ['route', 'model_alias', 'thinking_effort'] as const;

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

  const constraint =
    usage === 'agent' ? agentResumeBindingConstraint() : swarmResumeBindingConstraint();
  const current = parameters['allOf'];
  parameters['allOf'] = [...(Array.isArray(current) ? current : []), constraint];
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
  field: 'model_alias' | 'effort',
): string | undefined {
  if (value === undefined) return undefined;
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `${field} must be a non-empty string`);
  }
  return normalizedValue;
}

export function isMissingSubagentModelAlias(error: unknown, alias: string): boolean {
  return (
    isError2(error) &&
    error.code === ErrorCodes.CONFIG_INVALID &&
    error.details?.['model'] === alias
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
