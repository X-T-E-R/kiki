import { AGENT_NAME_PATTERN } from '../agentName';
import { z } from 'zod';
import { executorPromptSchema } from '../executorPrompt';

const modelAliasSchema = z.string().min(1).regex(/^\S+$/, 'model alias must not contain whitespace');
const optionalProfileStringSchema = z.string().trim().min(1).nullable().optional();
const profileStringListSchema = z.array(z.string().trim().min(1)).nullable().optional();
const serviceTierSchema = z.enum(['auto', 'default', 'flex', 'priority']);
const promptModeSchema = z.enum(['prepend', 'append', 'wrap']);
const requestParamsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const namedAgentModelProfileSchema = z.object({
  alias: z.string(),
  when: z.string().optional(),
  context_budget: z.number().int().min(1).optional(),
  auto_compact: z.number().int().positive().safe().optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  service_tier: serviceTierSchema.optional(),
  request_params: requestParamsSchema.optional(),
  thinking_effort: z.string().optional(),
  allowed_models: z.array(z.string()).optional(),
  deny_models: z.array(z.string()).optional(),
  allowed_efforts: z.array(z.string()).optional(),
  preferred_models: z.array(z.string()).optional(),
  discouraged_models: z.array(z.string()).optional(),
  preferred_efforts: z.array(z.string()).optional(),
  prompt_mode: promptModeSchema.optional(),
  prompt: z.string().optional(),
});
export type NamedAgentModelProfile = z.infer<typeof namedAgentModelProfileSchema>;

export const namedAgentSpawnConstraintsSchema = z.object({
  allowed_models: z.array(z.string()).optional(),
  deny_models: z.array(z.string()).optional(),
  allowed_efforts: z.array(z.string()).optional(),
  preferred_models: z.array(z.string()).optional(),
  discouraged_models: z.array(z.string()).optional(),
  preferred_efforts: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
});
export type NamedAgentSpawnConstraints = z.infer<typeof namedAgentSpawnConstraintsSchema>;

export const agentProfileSourceDiagnosticCodeSchema = z.enum([
  'agent_profile_source.invalid_path',
  'agent_profile_source.path_escape',
  'agent_profile_source.symlink_escape',
  'agent_profile_source.not_private',
  'agent_profile_source.unavailable',
  'agent_profile_source.invalid_profile',
  'agent_profile_source.cycle',
  'agent_profile_source.depth_exceeded',
]);
export type AgentProfileSourceDiagnosticCode = z.infer<typeof agentProfileSourceDiagnosticCodeSchema>;

export const namedAgentSubagentLeaseSchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  scope: z.literal('private').optional(),
  status: z.enum(['ready', 'unavailable']).optional(),
  diagnostic: z.string().optional(),
  diagnostic_code: agentProfileSourceDiagnosticCodeSchema.optional(),
  description: z.string().optional(),
  when_to_use: z.string().optional(),
  model_alias: z.string().optional(),
  thinking_effort: z.string().optional(),
  allowed_models: z.array(z.string()).optional(),
  deny_models: z.array(z.string()).optional(),
  allowed_efforts: z.array(z.string()).optional(),
  preferred_models: z.array(z.string()).optional(),
  discouraged_models: z.array(z.string()).optional(),
  preferred_efforts: z.array(z.string()).optional(),
  tools: z.array(z.string()).nullable().optional(),
  disallowed_tools: z.array(z.string()).optional(),
  subagents: z.array(z.string()).nullable().optional(),
  prompt_mode: promptModeSchema.optional(),
  prompt: z.string().optional(),
  delegation_notice: z.enum(['auto', 'off']).optional(),
  service_tier: serviceTierSchema.nullable().optional(),
  request_params: requestParamsSchema.nullable().optional(),
  model_profiles: z.array(namedAgentModelProfileSchema).optional(),
});
export type NamedAgentSubagentLease = z.infer<typeof namedAgentSubagentLeaseSchema>;

export const namedAgentRouteSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  model_alias: z.string().optional(),
  source_file: z.string(),
});
export type NamedAgentRoute = z.infer<typeof namedAgentRouteSchema>;

export const namedAgentExecutorFieldStateSchema = z.enum(['applied', 'mapped', 'ignored']);
export type NamedAgentExecutorFieldState = z.infer<typeof namedAgentExecutorFieldStateSchema>;
export const namedAgentExecutorFieldSchema = z.object({
  state: namedAgentExecutorFieldStateSchema,
  reason: z.string().optional(),
});
export type NamedAgentExecutorField = z.infer<typeof namedAgentExecutorFieldSchema>;

export const namedAgentProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  when_to_use: z.string().optional(),
  source: z.string(),
  workspace_id: z.string().optional(),
  workspace_ids: z.array(z.string()).optional(),
  source_file: z.string().optional(),
  prompt: z.string().optional(),
  main: z.boolean(),
  override: z.boolean().optional(),
  executor: z.string().optional(),
  executor_protocol: z.string().optional(),
  executor_options: requestParamsSchema.optional(),
  executor_prompt: executorPromptSchema.optional(),
  allow_kiki_subagents: z.boolean().optional(),
  kiki_context: z.array(z.enum(['memory', 'board', 'cron', 'threads', 'history', 'hooks'])).optional(),
  pinned_model_alias: z.string().optional(),
  thinking_effort: z.string().optional(),
  /** Hard role model allowlist (`["*"]` normalizes to absent; `[]` permits none). */
  allowed_models: z.array(z.string()).optional(),
  deny_models: z.array(z.string()).optional(),
  allowed_efforts: z.array(z.string()).optional(),
  preferred_models: z.array(z.string()).optional(),
  discouraged_models: z.array(z.string()).optional(),
  preferred_efforts: z.array(z.string()).optional(),
  service_tier: serviceTierSchema.optional(),
  request_params: requestParamsSchema.optional(),
  context_budget: z.number().int().min(1).optional(),
  auto_compact: z.number().int().positive().safe().optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  model_profiles: z.array(namedAgentModelProfileSchema).optional(),
  spawn_constraints: namedAgentSpawnConstraintsSchema.optional(),
  subagent_policy: z.enum(['advisory', 'strict']).optional(),
  subagents: z.array(z.union([z.string(), namedAgentSubagentLeaseSchema])).optional(),
  /** Same-source files that lost name discovery to this profile. */
  shadowed_files: z.array(z.string()).optional(),
  /** External executor field applicability, keyed by wire field name; absent for native execution. */
  executor_fields: z.record(z.string(), namedAgentExecutorFieldSchema).optional(),
  disabled: z.boolean(),
  routes: z.array(namedAgentRouteSchema),
});
export type NamedAgentProfile = z.infer<typeof namedAgentProfileSchema>;

const booleanQueryParam = z.preprocess(
  (value) => {
    if (value === 'true' || value === '1' || value === 1 || value === true) return true;
    if (value === 'false' || value === '0' || value === 0 || value === false) return false;
    return value;
  },
  z.boolean().optional(),
);

const absoluteCwdSchema = z.string().trim().min(1).refine(
  (value) => /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value),
  'cwd must be an absolute path',
);

export const listNamedAgentProfilesQuerySchema = z.object({
  expand: booleanQueryParam,
  effective: booleanQueryParam,
  workspace_id: z.string().trim().min(1).optional(),
  cwd: absoluteCwdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.workspace_id !== undefined && value.cwd !== undefined) {
    context.addIssue({ code: 'custom', message: 'workspace_id and cwd are mutually exclusive' });
  }
  if (value.effective === true && value.workspace_id === undefined && value.cwd === undefined) {
    context.addIssue({ code: 'custom', message: 'effective requires workspace_id or cwd' });
  }
  if (value.effective === true && value.expand === true) {
    context.addIssue({ code: 'custom', message: 'effective and expand are mutually exclusive' });
  }
});

export const agentCapabilitiesQuerySchema = z.union([
  z.object({
    session_id: z.string().trim().min(1),
    agent_id: z.string().trim().min(1),
  }).strict(),
  z.object({
    workspace_id: z.string().trim().min(1),
    profile: z.string().trim().min(1),
    caller_profile: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    cwd: absoluteCwdSchema,
    profile: z.string().trim().min(1),
    caller_profile: z.string().trim().min(1).optional(),
  }).strict(),
]);
export type AgentCapabilitiesQuery = z.infer<typeof agentCapabilitiesQuerySchema>;

export const agentCapabilityReasonCodeSchema = z.enum([
  'skill_tool_inactive',
  'skill_model_invocation_disabled',
  'snapshot_inventory_only',
  'tool_policy_disabled',
  'runtime_not_connected',
  'activation_condition_unmet',
  'approval_pending',
  'session_or_agent_not_live',
  'persisted_metadata_unavailable',
  'persisted_profile_unavailable',
  'snapshot_launch_unavailable',
  'agent_run_inactive',
  'agent_run_draft_disabled',
  'draft_inventory_only',
  'draft_policy_disabled',
  'strict_subagent_policy_blocked',
  'executor_binding_unavailable',
  'executor_route_binding_unavailable',
  'model_not_configured',
  'scoped_profile_unavailable',
  'binding_constraints_unsatisfied',
  'default_binding_unavailable',
  'research_readonly_dispatch_forbidden',
  'plan_resume_forbidden',
  'native_executor_required',
]);
export type AgentCapabilityReasonCode = z.infer<typeof agentCapabilityReasonCodeSchema>;
export const agentCapabilityReasonCodeWireSchema = z.string().min(1);

export const agentCapabilityModelSourceSchema = z.enum(['caller-lease', 'route', 'profile']);
export const agentCapabilityEffortSourceSchema = z.enum([
  'caller-lease', 'route', 'profile', 'model-profile', 'model', 'config', 'executor',
]);

export const agentBindingAdvisorySchema = z.object({
  version: z.literal(1),
  code: z.enum([
    'model_not_preferred',
    'model_discouraged',
    'effort_not_preferred',
    'model_not_allowed',
    'model_denied',
    'effort_not_allowed',
    'model_pin_overridden',
    'effort_pin_overridden',
  ]),
  dimension: z.enum(['model', 'thinking_effort']),
  rule_source: z.string(),
  rule_value: z.string().optional(),
  rule_values: z.array(z.string()).optional(),
  requested_value: z.string().optional(),
  effective_value: z.string(),
  value_source: z.enum([
    'dispatch-explicit',
    'runtime-explicit',
    'resume-existing',
    'route-default',
    'caller-lease-default',
    'profile-default',
    'model-profile-default',
    'model-default',
    'config-default',
    'executor-normalized',
    'environment-forced',
  ]),
  model: z.string().optional(),
  message: z.string(),
});
export type AgentBindingAdvisory = z.infer<typeof agentBindingAdvisorySchema>;

export const agentCapabilityTargetSchema = z.object({
  profile: z.string(),
  caller_profile: z.string().optional(),
  source: z.string().optional(),
  source_root: z.string().optional(),
  source_file: z.string().optional(),
  route: z.string().optional(),
  description: z.string().optional(),
  executor: z.string(),
  model_alias: z.string().optional(),
  model_source: agentCapabilityModelSourceSchema.optional(),
  thinking_effort: z.string().optional(),
  effort_source: agentCapabilityEffortSourceSchema.optional(),
  dispatch_policy: z.enum(['advisory', 'strict']).optional(),
  recommendation_status: z.enum(['preferred', 'allowed_nonpreferred', 'blocked', 'unconfigured']).optional(),
  advisory_deviation: z.boolean().optional(),
  defaults_available: z.boolean(),
  binding_advisories: z.array(agentBindingAdvisorySchema).optional(),
  unavailable_reason: z.string().optional(),
  unavailable_reason_code: agentCapabilityReasonCodeWireSchema.optional(),
  launch_allowed: z.boolean().optional(),
  launch_unavailable_reason: z.string().optional(),
  launch_unavailable_reason_code: agentCapabilityReasonCodeWireSchema.optional(),
  execution_restriction: z.literal('research-readonly').optional(),
});
export type AgentCapabilityTarget = z.infer<typeof agentCapabilityTargetSchema>;

export const agentPanelCapabilityStateSchema = z.enum([
  'enabled', 'disabled', 'approval-required', 'disconnected', 'unknown',
]);

export const agentPanelToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
  category: z.string(),
  group: z.string().optional(),
  state: agentPanelCapabilityStateSchema,
  unavailable_reason: z.string().optional(),
  unavailable_reason_code: agentCapabilityReasonCodeWireSchema.optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  read_only: z.boolean().optional(),
});

export const agentPanelSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.string(),
  source_kind: z.string().optional(),
  source_root: z.string().optional(),
  scope: z.enum(['workspace', 'global']),
  path: z.string(),
  state: agentPanelCapabilityStateSchema,
  unavailable_reason: z.string().optional(),
  unavailable_reason_code: agentCapabilityReasonCodeWireSchema.optional(),
  type: z.string().optional(),
  disable_model_invocation: z.boolean().optional(),
  prompt_command: z.boolean().optional(),
  argument_hint: z.string().optional(),
});

export const agentPanelProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
  source_file: z.string().optional(),
  definition_id: z.string().optional(),
  route: z.string().optional(),
  model: z.string().optional(),
  model_source: agentCapabilityModelSourceSchema.optional(),
  thinking_effort: z.string().optional(),
  effort_source: agentCapabilityEffortSourceSchema.optional(),
  thinking_effort_source: z.enum(['forced', 'adjusted']).optional(),
  route_detached: z.boolean().optional(),
  profile_source: z.enum(['registered', 'profile-file']).optional(),
  binding_advisories: z.array(agentBindingAdvisorySchema).optional(),
  executor: z.string().optional(),
  service_tier: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  disabled_tool_groups: z.array(z.string()).optional(),
  subagent_policy: z.enum(['advisory', 'strict']).optional(),
  execution_restriction: z.string().optional(),
  locked_model: z.string().optional(),
  locked_effort: z.string().optional(),
  tool_allow_policies: z.array(z.array(z.string())).optional(),
  spawn_constraints: namedAgentSpawnConstraintsSchema.optional(),
});
export type AgentPanelProfile = z.infer<typeof agentPanelProfileSchema>;

export const agentPanelMetricsSchema = z.object({
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  cacheReadTokens: z.number().nonnegative().nullable(),
  cacheWriteTokens: z.number().nonnegative().nullable(),
  totalTokens: z.number().nonnegative().nullable(),
  totalCostUsd: z.number().nonnegative().nullable(),
  contextTokens: z.number().nonnegative().nullable(),
  contextLimit: z.number().nonnegative().nullable(),
  compactionCount: z.number().int().nonnegative().nullable(),
  usagePartial: z.boolean().optional(),
  costPartial: z.boolean().optional(),
  usageSource: z.enum(['live', 'persisted']).optional(),
});
export type AgentPanelMetrics = z.infer<typeof agentPanelMetricsSchema>;

export const agentCapabilitiesResponseSchema = z.object({
  context: z.enum(['live', 'draft']),
  live: z.boolean().optional(),
  owner: z.object({ profile: z.string().optional(), agent_id: z.string().optional() }),
  available: z.boolean(),
  unavailable_reason: z.string().optional(),
  unavailable_reason_code: agentCapabilityReasonCodeWireSchema.optional(),
  targets: z.array(agentCapabilityTargetSchema),
  profile: agentPanelProfileSchema.optional(),
  tools: z.array(agentPanelToolSchema).optional(),
  skills: z.array(agentPanelSkillSchema).optional(),
  metrics: z.record(z.string(), agentPanelMetricsSchema).optional(),
});
export type AgentCapabilitiesResponse = z.infer<typeof agentCapabilitiesResponseSchema>;

export const agentCapabilityTargetProducerSchema = agentCapabilityTargetSchema.extend({
  unavailable_reason_code: agentCapabilityReasonCodeSchema.optional(),
  launch_unavailable_reason_code: agentCapabilityReasonCodeSchema.optional(),
});
export const agentPanelToolProducerSchema = agentPanelToolSchema.extend({
  unavailable_reason_code: agentCapabilityReasonCodeSchema.optional(),
});
export const agentPanelSkillProducerSchema = agentPanelSkillSchema.extend({
  unavailable_reason_code: agentCapabilityReasonCodeSchema.optional(),
});
export const agentCapabilitiesProducerResponseSchema = agentCapabilitiesResponseSchema.extend({
  unavailable_reason_code: agentCapabilityReasonCodeSchema.optional(),
  targets: z.array(agentCapabilityTargetProducerSchema),
  tools: z.array(agentPanelToolProducerSchema).optional(),
  skills: z.array(agentPanelSkillProducerSchema).optional(),
});
export type AgentCapabilitiesProducerResponse = z.infer<typeof agentCapabilitiesProducerResponseSchema>;

export type ListNamedAgentProfilesQuery = z.infer<
  typeof listNamedAgentProfilesQuerySchema
>;

export const listNamedAgentProfilesResponseSchema = z.object({
  items: z.array(namedAgentProfileSchema),
  complete: z.boolean(),
});
export type ListNamedAgentProfilesResponse = z.infer<
  typeof listNamedAgentProfilesResponseSchema
>;

export const namedAgentProfileNameParamsSchema = z.object({
  name: z.string().min(1),
});

export const updateNamedAgentRouteSchema = z.object({
  id: z.string().min(1),
  description: z.string().trim().min(1).optional(),
  model_alias: modelAliasSchema.nullable().optional(),
}).strict().refine(
  (value) => value.description !== undefined || value.model_alias !== undefined,
  { message: 'route update must include description or model_alias' },
);

export const createNamedAgentProfileRequestSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().regex(AGENT_NAME_PATTERN, 'name must use lowercase letters and digits separated by hyphens or underscores'),
  scope: z.enum(['user', 'project']),
  template: z.union([
    z.enum(['blank', 'implementer', 'reviewer']),
    z.string().refine(
      (value) => value.startsWith('duplicate:') && AGENT_NAME_PATTERN.test(value.slice('duplicate:'.length)),
      'template must duplicate a valid profile name',
    ),
  ]).optional(),
  main: z.boolean().optional(),
  description: z.string().trim().min(1).optional(),
  when_to_use: z.string().trim().min(1).optional(),
  pinned_model_alias: modelAliasSchema.optional(),
  thinking_effort: z.string().trim().min(1).optional(),
  tools: z.array(z.string().trim().min(1)).optional(),
  prompt: z.string().optional(),
}).strict().superRefine((value, context) => {
  if (value.template === undefined || value.template === 'blank') {
    if (value.description === undefined) context.addIssue({ code: 'custom', path: ['description'], message: 'description is required for blank profiles' });
    if (value.prompt?.trim() === '' || value.prompt === undefined) context.addIssue({ code: 'custom', path: ['prompt'], message: 'prompt is required for blank profiles' });
  }
});
export type CreateNamedAgentProfileRequest = z.infer<typeof createNamedAgentProfileRequestSchema>;

export const updateNamedAgentSubagentEntrySchema = z.union([
  z.string().trim().min(1),
  z.object({
    name: z.string().trim().min(1),
    model_alias: modelAliasSchema.nullable().optional(),
    thinking_effort: optionalProfileStringSchema,
    allowed_models: profileStringListSchema,
  }).strict(),
]);
export type UpdateNamedAgentSubagentEntry = z.infer<typeof updateNamedAgentSubagentEntrySchema>;

export const updateNamedAgentModelProfileEntrySchema = z.object({
  alias: modelAliasSchema,
  when: optionalProfileStringSchema,
  thinking_effort: optionalProfileStringSchema,
}).strict();
export type UpdateNamedAgentModelProfileEntry = z.infer<typeof updateNamedAgentModelProfileEntrySchema>;

export const updateNamedAgentProfileRequestSchema = z.object({
  scope: z.enum(['user', 'project', 'extra']),
  workspace_id: z.string().min(1),
  source_file: z.string().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  when_to_use: optionalProfileStringSchema,
  main: z.boolean().nullable().optional(),
  executor: z.string().trim().min(1).nullable().optional(),
  executor_prompt: executorPromptSchema.nullable().optional(),
  allow_kiki_subagents: z.boolean().nullable().optional(),
  kiki_context: z.array(z.enum(['memory', 'board', 'cron', 'threads', 'history', 'hooks'])).nullable().optional(),
  pinned_model_alias: modelAliasSchema.nullable().optional(),
  thinking_effort: optionalProfileStringSchema,
  allowed_models: profileStringListSchema,
  deny_models: profileStringListSchema,
  allowed_efforts: profileStringListSchema,
  preferred_models: profileStringListSchema,
  discouraged_models: profileStringListSchema,
  preferred_efforts: profileStringListSchema,
  /**
   * Whole ordered list. A bare name keeps that entry's existing lease mapping
   * untouched; a mapping merges the given keys onto it (`null` deletes a key).
   */
  subagents: z.array(updateNamedAgentSubagentEntrySchema).nullable().optional(),
  subagent_policy: z.enum(['advisory', 'strict']).nullable().optional(),
  spawn_constraints: namedAgentSpawnConstraintsSchema.nullable().optional(),
  /** Whole ordered list keyed by alias; unlisted per-model keys are preserved. */
  model_profiles: z.array(updateNamedAgentModelProfileEntrySchema).nullable().optional(),
  service_tier: serviceTierSchema.nullable().optional(),
  auto_compact: z.number().int().positive().safe().nullable().optional(),
  tools: profileStringListSchema,
  disallowed_tools: profileStringListSchema,
  routes: z.array(updateNamedAgentRouteSchema).optional(),
  prompt: z.string().optional(),
  raw_text: z.string().optional(),
}).strict().superRefine((value, context) => {
  const hasStructuredUpdate =
    value.description !== undefined ||
    value.when_to_use !== undefined ||
    value.main !== undefined ||
    value.executor !== undefined ||
    value.executor_prompt !== undefined ||
    value.allow_kiki_subagents !== undefined ||
    value.kiki_context !== undefined ||
    value.pinned_model_alias !== undefined ||
    value.thinking_effort !== undefined ||
    value.allowed_models !== undefined ||
    value.deny_models !== undefined ||
    value.allowed_efforts !== undefined ||
    value.preferred_models !== undefined ||
    value.discouraged_models !== undefined ||
    value.preferred_efforts !== undefined ||
    value.subagents !== undefined ||
    value.subagent_policy !== undefined ||
    value.spawn_constraints !== undefined ||
    value.model_profiles !== undefined ||
    value.service_tier !== undefined ||
    value.auto_compact !== undefined ||
    value.tools !== undefined ||
    value.disallowed_tools !== undefined ||
    value.prompt !== undefined ||
    (value.routes !== undefined && value.routes.length > 0);
  if (value.raw_text !== undefined && hasStructuredUpdate) {
    context.addIssue({
      code: 'custom',
      path: ['raw_text'],
      message: 'raw_text cannot be combined with field or route updates',
    });
  }
  if (value.raw_text === undefined && !hasStructuredUpdate) {
    context.addIssue({
      code: 'custom',
      message: 'at least one editable field or raw_text is required',
    });
  }
});
export type UpdateNamedAgentProfileRequest = z.infer<
  typeof updateNamedAgentProfileRequestSchema
>;

export const shippedAgentProfileStatusSchema = z.enum([
  'clean',
  'custom',
  'update-available',
  'removed',
  'adopted',
  'unmanaged',
  'disabled',
  'retired',
]);
export type ShippedAgentProfileStatus = z.infer<typeof shippedAgentProfileStatusSchema>;

export const shippedAgentProfileSchema = z.object({
  template_id: z.string(),
  status: shippedAgentProfileStatusSchema,
  managed: z.boolean(),
  main: z.boolean(),
  description: z.string().optional(),
  active_path: z.string().optional(),
  baseline_hash: z.string().optional(),
  active_hash: z.string().optional(),
  offered_hash: z.string().optional(),
});
export type ShippedAgentProfile = z.infer<typeof shippedAgentProfileSchema>;

export const listShippedAgentProfilesResponseSchema = z.object({
  items: z.array(shippedAgentProfileSchema),
});
export type ListShippedAgentProfilesResponse = z.infer<
  typeof listShippedAgentProfilesResponseSchema
>;
