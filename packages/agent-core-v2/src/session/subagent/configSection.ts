import { z } from 'zod';
import type { SubagentDispatchCaller } from '@kiki/agent-profiles/subagentDispatch';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { isPlainObject } from '#/app/config/toml';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { collectRemovedKeyDiagnostics } from '#/app/config/deprecations';
import type { IModelService } from '#/kosong/model/model';

import {
  assertRoleBindingConstraints,
  resolveRoleThinkingDefault,
  type SubagentRoleModelConstraints,
} from './modelConstraints';

export type { SubagentRoleModelConstraints } from './modelConstraints';

/** `subagent` domain — the `[subagent]` config section and schema. An explicit dispatch pin
 *  wins over route/lease/profile pins; `default_model` fills only an otherwise unbound spawn.
 *  Caller model inheritance remains explicit via `model_alias: inherit`. */
export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
  defaultModel: z.string().trim().min(1).optional(),
  denyModels: z.array(z.string()).optional(),
  maxDirectChildren: z.number().int().min(0).optional(),
  maxTotalSubagents: z.number().int().min(0).optional(),
  defaultProfile: z.string().optional(),
  mainDispatchPolicy: z.enum(['advisory', 'strict']).optional(),
  subagentDispatchPolicy: z.enum(['advisory', 'strict']).optional(),
  allowedTools: z.array(z.string()).optional(),
});

export const DEFAULT_MAX_DIRECT_CHILDREN = 16;
export const DEFAULT_MAX_TOTAL_SUBAGENTS = 0;
export const DEFAULT_SUBAGENT_PROFILE = 'general';

export type DefaultSubagentTarget =
  | { readonly kind: 'generic' }
  | { readonly kind: 'profile'; readonly name: string }
  | { readonly kind: 'strict' };

export function resolveDefaultSubagentTarget(config: IConfigService): DefaultSubagentTarget {
  const inspected = config.inspect<SubagentConfig | undefined>(SUBAGENT_SECTION);
  const section = inspected.memoryValue ?? inspected.userValue;
  const value = section?.defaultProfile;
  if (value === undefined) return { kind: 'generic' };
  const trimmed = value.trim();
  return trimmed.length === 0 ? { kind: 'strict' } : { kind: 'profile', name: trimmed };
}

export function resolveDefaultSubagentProfileName(config: IConfigService): string | undefined {
  const value = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.defaultProfile;
  const trimmed = (value ?? DEFAULT_SUBAGENT_PROFILE).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function resolveDispatchCapacityLimits(config: IConfigService): {
  readonly maxDirectChildren: number;
  readonly maxTotalSubagents: number;
} {
  const section = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
  return {
    maxDirectChildren: section?.maxDirectChildren ?? DEFAULT_MAX_DIRECT_CHILDREN,
    maxTotalSubagents: section?.maxTotalSubagents ?? DEFAULT_MAX_TOTAL_SUBAGENTS,
  };
}

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

/** Resolve the host policy floor independently of the caller's role declaration. */
export function withDispatchPolicyDefaults<T extends SubagentDispatchCaller>(
  config: IConfigService,
  caller: T,
  position: 'main' | 'sub',
): T & { readonly defaultPolicy: 'advisory' | 'strict' } {
  const section = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
  return {
    ...caller,
    defaultPolicy: position === 'main'
      ? section?.mainDispatchPolicy ?? 'advisory'
      : section?.subagentDispatchPolicy ?? 'strict',
  };
}

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const SUBAGENT_TIMEOUT_ENV = 'KIKI_SUBAGENT_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: {
    timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    maxDirectChildren: DEFAULT_MAX_DIRECT_CHILDREN,
    maxTotalSubagents: DEFAULT_MAX_TOTAL_SUBAGENTS,
    defaultProfile: DEFAULT_SUBAGENT_PROFILE,
    allowedTools: [],
  },
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
  collectDiagnostics: (rawSection) =>
    collectRemovedKeyDiagnostics(SUBAGENT_SECTION, rawSection, ['default_effort']),
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

export function assertSubagentModelNotDenied(
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

export const INHERIT_MODEL_ALIAS = 'inherit';

export function resolveInheritedModelAlias(
  alias: string | undefined,
  callerModel: string | undefined,
): string | undefined {
  if (alias !== INHERIT_MODEL_ALIAS) return alias;
  if (callerModel === undefined || callerModel === INHERIT_MODEL_ALIAS) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      'model_alias: inherit requires a caller agent with a bound model; it cannot be used for a main agent.',
    );
  }
  return callerModel;
}

export const SUBAGENT_MODEL_UNBOUND_HINT =
  'Pin model_alias on the agent profile (or its route or the caller lease), pass a concrete model name as model_alias with the dispatch, or configure [subagent].default_model. AgentRun does not accept model_alias: "inherit"; caller inheritance must be configured by the profile, route, or caller lease.';

export function subagentModelUnboundMessage(target?: SubagentBindingTarget): string {
  const named =
    target?.routeId !== undefined
      ? `route "${target.routeId}"`
      : target?.profileName !== undefined
        ? `agent profile "${target.profileName}"`
        : 'this subagent';
  return `No model is bound for ${named}. ${SUBAGENT_MODEL_UNBOUND_HINT}`;
}

/** Resolve a dispatch pin before the profile pin, then the configured fallback. */
export function resolveSubagentBinding(
  config: IConfigService,
  requested: SubagentBindingRequest = {},
  profileRequest: SubagentBindingRequest = {},
  models?: IModelService,
  roleConstraints?: SubagentRoleModelConstraints,
  target?: SubagentBindingTarget,
  callerBinding?: SubagentBindingRequest,
): SubagentModelBinding {
  const toolModel = normalized(requested.modelAlias);
  const profileModel = normalized(profileRequest.modelAlias);
  const configuredModel = normalized(config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.defaultModel);
  const selectedModel = toolModel ?? profileModel ?? configuredModel;
  if (selectedModel === undefined) {
    throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, subagentModelUnboundMessage(target), {
      details: {
        profile: target?.profileName,
        route: target?.routeId,
      },
    });
  }
  const callerModel = normalized(callerBinding?.modelAlias);
  const model = resolveInheritedModelAlias(selectedModel, callerModel)!;
  const profileAlias = resolveInheritedModelAlias(profileModel, callerModel);
  const source: SubagentModelSource = toolModel !== undefined ? 'tool' : 'profile';
  const thinking =
    normalized(requested.thinkingEffort) ??
    resolveRoleThinkingDefault(roleConstraints, model, models) ??
    (selectedModel === INHERIT_MODEL_ALIAS ||
      profileAlias !== undefined && resolveModelIdentity(profileAlias, models) === resolveModelIdentity(model, models)
      ? normalized(profileRequest.thinkingEffort)
      : undefined) ??
    (selectedModel === INHERIT_MODEL_ALIAS ? normalized(callerBinding?.thinkingEffort) : undefined);
  assertSubagentModelNotDenied(config, model, models);
  assertRoleBindingConstraints({ model, thinking, constraints: roleConstraints, models,
    ruleSource: `profile:${target?.profileName ?? 'subagent'}`,
    requestedModel: toolModel, requestedThinking: requested.thinkingEffort,
    modelValueSource: toolModel === undefined ? 'profile-default' : 'dispatch-explicit' });
  return recordBindingMetadata({ model, thinking, displayModel: selectedModel }, { source });
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function buildSubagentModelDescriptions(aliases: readonly string[]): string {
  const lines: string[] = [];
  if (aliases.length > 0) {
    lines.push(
      `Model aliases available across the targets above: ${aliases.join(', ')}`,
    );
  }
  lines.push(
    'Model alias and Thinking effort under each profile are defaults. Omit model_alias and effort to use the target defaults; do not assume they copy your model or effort. AgentRun does not accept model_alias: "inherit". To select a model explicitly, specify a concrete configured model name; otherwise omit model_alias to use the target default. Caller inheritance configured by a profile, route, or caller lease remains supported. Executable explicit overrides must satisfy allowed_models, deny_models, and allowed_efforts in every scope. Deviations from preferred_models, discouraged_models, preferred_efforts, caller lease pins, or route pins produce binding advisories. Machine deny rules, missing models, unsupported efforts, and executor restrictions remain errors. A model listed for another target is only a recommendation for that target. If no model is bound, pass model_alias explicitly.',
  );
  return lines.join('\n');
}

export function addSubagentBindingSchemaConstraints(
  parameters: Record<string, unknown>,
): void {
  const properties = parameters['properties'];
  if (!isPlainObject(properties)) return;
  for (const field of ['model_alias', 'effort', 'profile_file']) {
    const property = properties[field];
    if (isPlainObject(property)) property['pattern'] = '\\S';
  }
  const conditionalSchema = { if: { required: ['allow_model_change'] } };
  const conditionalSchemaKeyword = ['th', 'en'].join('');
  Object.defineProperty(conditionalSchema, conditionalSchemaKeyword, {
    enumerable: true,
    value: { required: ['resume', 'model_alias'] },
  });
  parameters['allOf'] = [
    { not: { allOf: [{ required: ['resume'] }, { anyOf: ['profile', 'profile_file', 'route', 'name'].map((field) => ({ required: [field] })) }] } },
    { not: { allOf: [{ required: ['profile_file'] }, { anyOf: ['profile', 'route'].map((field) => ({ required: [field] })) }] } },
    conditionalSchema,
  ];
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
  if (ms === 0) return 'unlimited';
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
