import { z } from 'zod';

import { requestIdentityPolicySchema } from '../modelCatalog';
import { interactionConfigSchema, askUserQuestionGuardWireSchema } from '../questionGuard';
import { hooksConfigSchema } from './hooksConfig';
import { nbSearchConfigPatchSchema, nbSearchSourceConfigSchema } from './nbSearch';
import { requestGovernanceConfigPatchSchema } from './requestGovernance';
import { spaceUiConfigSchema, spaceUiConfigPatchSchema } from './space';

export const modelSwitchModeSchema = z.enum(['direct', 'compact', 'fresh']);

const modelSwitchPatternSchema = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'Model pattern must not be blank',
});

export const modelSwitchRuleSchema = z.object({
  id: z.string().min(1).refine((value) => value.trim().length > 0),
  enabled: z.boolean().default(true),
  from_models: z.array(modelSwitchPatternSchema).min(1).optional(),
  to_models: z.array(modelSwitchPatternSchema).min(1).optional(),
  mode: modelSwitchModeSchema,
  confirm: z.boolean().optional(),
}).strict();

export const modelSwitchRulesSchema = z.array(modelSwitchRuleSchema).refine(
  (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
  { message: 'Model switch rule IDs must be unique' },
);

export const modelSwitchConfigSchema = z.object({
  default_mode: modelSwitchModeSchema.default('direct'),
  confirm: z.boolean().default(true),
  rules: modelSwitchRulesSchema.default([]),
}).strict();
export type ModelSwitchConfig = z.infer<typeof modelSwitchConfigSchema>;
export type ModelSwitchRule = z.infer<typeof modelSwitchRuleSchema>;
export type ModelSwitchMode = z.infer<typeof modelSwitchModeSchema>;

export const modelSwitchConfigPatchSchema = z.object({
  default_mode: modelSwitchModeSchema.optional(),
  confirm: z.boolean().optional(),
  rules: modelSwitchRulesSchema.optional(),
}).strict();

export const taskBoardStorageConfigSchema = z.object({
  storage: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('auto') }).strict(),
    z.object({ mode: z.literal('global') }).strict(),
    z.object({ mode: z.literal('fixed'), path: z.string().trim().min(1).max(4096) }).strict(),
  ]),
}).strict();

export const promptConfigSchema = z.object({
  shared: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  tools: z.record(z.string(), z.string()).optional(),
}).strict();
export type PromptConfig = z.infer<typeof promptConfigSchema>;

export const providerConfigResponseSchema = z.object({
  type: z.string(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  api_key: z.string().min(1).optional(),
  api_key_env: z.string().min(1).optional(),
  has_api_key: z.boolean(),
});
export type ProviderConfigResponse = z.infer<typeof providerConfigResponseSchema>;

export const subagentConfigResponseSchema = z.object({
  timeoutMs: z.number().int().nonnegative().optional(),
  defaultModel: z.string().optional(),
  maxDirectChildren: z.number().int().nonnegative().optional(),
  maxTotalSubagents: z.number().int().nonnegative().optional(),
  defaultProfile: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

export const agentsDelegationConfigSchema = z.object({
  sub: z.boolean().optional(),
  independent: z.boolean().optional(),
}).strict();

export const agentsConfigResponseSchema = z.object({
  enabled: z.boolean().optional(),
  notify_parent: z.boolean().optional(),
  delegation: agentsDelegationConfigSchema.optional(),
});

export const sessionTitleTriggerSchema = z.enum([
  'first_user_message', 'first_turn_completed', 'context_compacted',
]);
export type SessionTitleTrigger = z.infer<typeof sessionTitleTriggerSchema>;

export const sessionTitleConfigResponseSchema = z.object({
  model: z.string().optional(),
  triggers: z.array(sessionTitleTriggerSchema).optional(),
  prompt: z.string().optional(),
  default_prompt: z.string().optional(),
  prompt_source: z.enum(['default', 'custom']).optional(),
});

export const sessionTitleConfigPatchSchema = sessionTitleConfigResponseSchema
  .omit({ default_prompt: true, prompt_source: true })
  .extend({ model: z.string().nullable().optional(), prompt: z.string().nullable().optional() })
  .strict();

export const planConfigResponseSchema = z.object({
  gate: z.enum(['free', 'gated']),
  enterApprovalTimeoutMs: z.number().int().min(5000),
});

export const planConfigRequestSchema = z
  .object({
    gate: z.enum(['free', 'gated']).optional(),
    enter_approval_timeout_ms: z.number().int().min(5000).optional(),
  })
  .strict();

export const permissionRuleConfigSchema = z.object({
  decision: z.enum(['allow', 'deny', 'ask']),
  scope: z.enum(['turn-override', 'session-runtime', 'project', 'user']).default('user'),
  pattern: z.string().min(1).refine((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) return false;
    const open = trimmed.indexOf('(');
    return open === -1 || (open > 0 && trimmed.endsWith(')'));
  }, { message: 'Invalid permission rule pattern' }),
  reason: z.string().optional(),
});

export const dangerousBashGuardSchema = z.enum(['on', 'off', 'default']);

export const permissionReviewerResponseSchema = z.object({
  backend: z.enum(['model', 'jev']),
  model: z.string().optional(),
  timeoutMs: z.number().int().optional(),
  allowThreshold: z.number(),
  denyThreshold: z.number(),
  categories: z.array(z.string()),
  hasApiKey: z.boolean(),
  apiKeySource: z.enum(['kiki', 'environment', 'none']).optional(),
  apiKeyEnv: z.string().optional(),
});

export const permissionConfigResponseSchema = z.object({
  rules: z.array(permissionRuleConfigSchema).optional(),
  dangerousBash: dangerousBashGuardSchema.optional(),
  reviewer: permissionReviewerResponseSchema.optional(),
}).passthrough();

export const permissionConfigPatchSchema = z.object({
  rules: z.array(permissionRuleConfigSchema).optional(),
  dangerous_bash: dangerousBashGuardSchema.optional(),
  reviewer: z.object({
    backend: z.enum(['model', 'jev']).optional(),
    model: z.string().min(1).optional(),
    /** Omitted keeps the stored key; `null` removes it. */
    api_key: z.string().min(1).nullable().optional(),
    timeout_ms: z.number().int().min(100).max(30_000).optional(),
    allow_threshold: z.number().min(0.5).max(1).optional(),
    deny_threshold: z.number().min(0.5).max(1).optional(),
    categories: z.array(z.string()).min(1).optional(),
  }).optional(),
}).passthrough();

export const worktreeConfigResponseSchema = z.object({
  enabled: z.boolean(),
  root: z.string(),
  branchPrefix: z.string(),
  defaultBase: z.enum(['head', 'fresh']),
  gitTimeoutMs: z.number().int().min(1_000).max(600_000),
  cleanup: z.object({
    auto: z.boolean(),
    afterDays: z.number().int().min(1),
    disposableIgnored: z.array(z.string()),
  }),
});

export const worktreeConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  root: z.string().optional(),
  branch_prefix: z.string().regex(/^[a-z0-9][a-z0-9/-]*\/$/).optional(),
  default_base: z.enum(['head', 'fresh']).optional(),
  git_timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  cleanup: z.object({
    auto: z.boolean().optional(),
    after_days: z.number().int().min(1).optional(),
    disposable_ignored: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict();

export const sessionResidencyConfigResponseSchema = z.object({
  idleTtlMs: z.number().int().optional(),
  maxLiveSessions: z.number().int().optional(),
  minIdleMs: z.number().int().optional(),
  sweepIntervalMs: z.number().int().optional(),
  maxConcurrentRestores: z.number().int().optional(),
  maxQueuedRestores: z.number().int().optional(),
});

export const sessionResidencyConfigPatchSchema = z.object({
  idle_ttl_ms: z.number().int().min(0).max(86_400_000).optional(),
  max_live_sessions: z.number().int().min(1).max(64).optional(),
  min_idle_ms: z.number().int().min(0).max(86_400_000).optional(),
  sweep_interval_ms: z.number().int().min(1_000).max(300_000).optional(),
  max_concurrent_restores: z.number().int().min(1).max(4).optional(),
  max_queued_restores: z.number().int().min(0).max(64).optional(),
}).strict();

export const interactionConfigResponseSchema = interactionConfigSchema;

export const interactionConfigPatchSchema = z.object({
  ask_user_question: z.enum(['background', 'blocking']).optional(),
  ask_user_question_guard: askUserQuestionGuardWireSchema.optional(),
}).strict();

export const agentExecutorDisplayConfigSchema = z.object({
  externalsVisible: z.boolean().optional(),
}).strict();

export const agentExecutorDisplayConfigPatchSchema = z.object({
  externals_visible: z.boolean().nullable().optional(),
}).strict();

export const configResponseSchema = z.object({
  agent_executor_display: agentExecutorDisplayConfigSchema.optional(),
  model_switch: modelSwitchConfigSchema.optional(),
  space_ui: spaceUiConfigSchema.optional(),
  providers: z.record(z.string(), providerConfigResponseSchema).default({}),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  fast_model: z.string().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  request_identity: requestIdentityPolicySchema.optional(),
  thinking: z.unknown().optional(),
  plan: planConfigResponseSchema.optional(),
  plan_mode: z.boolean().optional(),
  task_board: taskBoardStorageConfigSchema.optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: permissionConfigResponseSchema.optional(),
  interaction: interactionConfigResponseSchema.optional(),
  hooks: hooksConfigSchema.optional(),
  nb_search: nbSearchConfigPatchSchema.optional(),
  nb_search_source: nbSearchSourceConfigSchema.optional(),
  prompt: promptConfigSchema.optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  worktree: worktreeConfigResponseSchema.optional(),
  session_residency: sessionResidencyConfigResponseSchema.optional(),
  background: z.unknown().optional(),
  subagent: subagentConfigResponseSchema.optional(),
  agents: agentsConfigResponseSchema.optional(),
  builtin_product_skills: z.boolean().optional(),
  session_title: sessionTitleConfigResponseSchema.optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  skip_builtin_profile_installation: z.array(z.string()).optional(),
  disabled_named_profiles: z.array(z.string()).optional(),
  retry: z.unknown().optional(),
  plugins: z.object({ marketplaceUrl: z.string().optional() }).passthrough().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

export const patchConfigRequestSchema = z.object({
  agent_executor_display: agentExecutorDisplayConfigPatchSchema.optional(),
  model_switch: modelSwitchConfigPatchSchema.optional(),
  space_ui: spaceUiConfigPatchSchema.optional(),
  providers: z.record(z.string(), z.unknown()).optional(),
  default_provider: z.string().optional(),
  default_model: z.string().optional(),
  fast_model: z.string().nullable().optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  request_identity: requestIdentityPolicySchema.nullable().optional(),
  thinking: z.unknown().optional(),
  plan: planConfigRequestSchema.optional(),
  plan_mode: z.boolean().optional(),
  task_board: taskBoardStorageConfigSchema.optional(),
  yolo: z.boolean().optional(),
  default_permission_mode: z.string().optional(),
  default_plan_mode: z.boolean().optional(),
  permission: permissionConfigPatchSchema.optional(),
  interaction: interactionConfigPatchSchema.optional(),
  hooks: hooksConfigSchema.optional(),
  services: z.never().optional(),
  nb_search: nbSearchConfigPatchSchema.optional(),
  nb_search_source: nbSearchSourceConfigSchema.optional(),
  prompt: promptConfigSchema.optional(),
  merge_all_available_skills: z.boolean().optional(),
  extra_skill_dirs: z.array(z.string()).optional(),
  loop_control: z.unknown().optional(),
  worktree: worktreeConfigPatchSchema.optional(),
  session_residency: sessionResidencyConfigPatchSchema.optional(),
  background: z.unknown().optional(),
  subagent: z.object({
    timeout_ms: z.number().int().nonnegative().optional(),
    default_model: z.string().nullable().optional(),
    max_direct_children: z.number().int().nonnegative().optional(),
    max_total_subagents: z.number().int().nonnegative().optional(),
    default_profile: z.string().optional(),

    allowed_tools: z.array(z.string()).optional(),
  }).optional(),
  agents: z.object({
    enabled: z.boolean().optional(),
    notify_parent: z.boolean().optional(),
    delegation: agentsDelegationConfigSchema.optional(),
  }).optional(),
  builtin_product_skills: z.boolean().optional(),
  session_title: sessionTitleConfigPatchSchema.optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  skip_builtin_profile_installation: z.array(z.string()).optional(),
  disabled_named_profiles: z.array(z.string()).optional(),
  /** Per-engine launch overrides keyed by executor id; a null value removes a field. */
  agent_executor_overrides: z.record(z.string(), z.unknown()).optional(),
  request_governance: requestGovernanceConfigPatchSchema.optional(),
  retry: z.unknown().optional(),
  plugins: z.object({ marketplace_url: z.string().optional() }).optional(),
});
export type PatchConfigRequest = z.infer<typeof patchConfigRequestSchema>;
