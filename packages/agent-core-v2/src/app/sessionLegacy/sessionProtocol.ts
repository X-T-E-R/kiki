import { z } from 'zod';

import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';

export const sessionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
});
export type SessionWarning = z.infer<typeof sessionWarningSchema>;

export const sessionWarningsResponseSchema = z.object({
  warnings: z.array(sessionWarningSchema),
});
export type SessionWarningsResponse = z.infer<typeof sessionWarningsResponseSchema>;

export const promptThinkingSchema = z.string().min(1);
export type PromptThinking = z.infer<typeof promptThinkingSchema>;

export const promptPermissionModeSchema = z.enum(['manual', 'yolo', 'auto']);
export type PromptPermissionMode = z.infer<typeof promptPermissionModeSchema>;

export const promptPlanGateSchema = z.enum(['free', 'gated']);
export type PromptPlanGate = z.infer<typeof promptPlanGateSchema>;

export const sessionMetadataSchema = z
  .object({
    cwd: z.string().min(1),
  })
  .catchall(z.unknown());
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

/** Mirrors `sessionAgentConfigSchema` in `@moonshot-ai/protocol`; the pair is
 *  pinned together by a drift test in kap-server. */
export const sessionAgentConfigSchema = z.object({
  model: z.string(),
  profile: z.string().min(1).optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  swarm_mode: z.boolean().optional(),
});
export type SessionAgentConfig = z.infer<typeof sessionAgentConfigSchema>;

/** Strict: a key the server does not apply is a validation error, not a
 *  silent drop. See the protocol package for the rationale. */
export const sessionAgentConfigPartialSchema = z.strictObject({
  model: z.string().optional(),
  profile: z.string().min(1).optional(),
  thinking: promptThinkingSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  swarm_mode: z.boolean().optional(),
  goal_objective: z.string().optional(),
  goal_control: z.enum(['pause', 'resume', 'cancel']).optional(),
});
export type SessionAgentConfigPartial = z.infer<typeof sessionAgentConfigPartialSchema>;

/** Create carries no goal controls: a new session has no goal to act on. */
export const sessionAgentConfigCreateSchema = sessionAgentConfigPartialSchema.omit({
  goal_objective: true,
  goal_control: true,
});
export type SessionAgentConfigCreate = z.infer<typeof sessionAgentConfigCreateSchema>;

export const permissionRuleMatcherSchema = z.object({
  kind: z.enum(['command_prefix', 'path_glob', 'exact_input', 'always']),
  value: z.string().optional(),
});
export type PermissionRuleMatcher = z.infer<typeof permissionRuleMatcherSchema>;

export const permissionRuleSchema = z.object({
  id: z.string().min(1),
  tool_name: z.string().min(1),
  matcher: permissionRuleMatcherSchema.optional(),
  decision: z.literal('approved'),
  created_at: isoDateTimeSchema,
  created_by: z.enum(['user', 'agent']),
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const updateSessionProfileRequestSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: sessionMetadataSchema.partial().optional(),
  agent_config: sessionAgentConfigPartialSchema.optional(),
  permission_rules: z.array(permissionRuleSchema).optional(),
});
export type UpdateSessionProfileRequest = z.infer<typeof updateSessionProfileRequestSchema>;

export const sessionStatusResponseSchema = z.object({
  busy: z.boolean(),
  model: z.string().optional(),
  thinking_level: z.string(),
  permission: z.string(),
  plan_mode: z.boolean(),
  swarm_mode: z.boolean(),
  context_tokens: z.number().int().nonnegative(),
  max_context_tokens: z.number().int().nonnegative().optional(),
  context_usage: z.number().min(0).max(1),
});
export type SessionStatusResponse = z.infer<typeof sessionStatusResponseSchema>;
