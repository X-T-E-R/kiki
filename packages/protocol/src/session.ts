import { z } from 'zod';

import {
  promptPermissionModeSchema,
  promptThinkingSchema,
} from './rest/prompt';
import { isoDateTimeSchema } from './time';
import { workspaceIdSchema } from './workspace';

export const sessionUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  tokens_by_model: z.record(z.string(), z.number().int().nonnegative()).optional(),
  by_model: z.record(z.string(), z.number().nonnegative()).optional(),
  cost_unknown_models: z.array(z.string()).optional(),
  context_tokens: z.number().int().nonnegative(),
  context_limit: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
});

export type SessionUsage = z.infer<typeof sessionUsageSchema>;

export function emptySessionUsage(): SessionUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  };
}

export const permissionRuleMatcherSchema = z.object({
  kind: z.enum(['command_prefix', 'path_glob', 'exact_input', 'always']),
  value: z.string().optional(),
});

export const permissionRuleSchema = z.object({
  id: z.string().min(1),
  tool_name: z.string().min(1),
  matcher: permissionRuleMatcherSchema.optional(),
  decision: z.literal('approved'),
  created_at: isoDateTimeSchema,
  created_by: z.enum(['user', 'agent']),
});

export type PermissionRule = z.infer<typeof permissionRuleSchema>;

/**
 * The main agent's live binding, echoed on session reads. Every field here is
 * one the server actually projects: `model`/`profile` on any read, and the
 * three mode flags on the single-session snapshot, which materializes the main
 * agent. List placeholders carry only `model`/`profile`, so the flags stay
 * optional. Write-only controls (thinking, goals) belong to the patch schemas.
 */
export const sessionAgentConfigSchema = z.object({
  model: z.string(),
  profile: z.string().min(1).optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  swarm_mode: z.boolean().optional(),
});

export type SessionAgentConfig = z.infer<typeof sessionAgentConfigSchema>;

/**
 * Accepted on `POST /sessions/{id}/profile`. Strict on purpose: every key here
 * is applied by the server, and anything else — a typo, or a field an older
 * build accepted and dropped (`system_prompt`, `tools`, `mcp_servers`) — is a
 * validation error rather than a silent no-op.
 */
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

/**
 * Accepted on `POST /sessions`. The goal controls are absent: a session being
 * created has no goal to resume or cancel, and creating one is a distinct
 * operation with its own route.
 */
export const sessionAgentConfigCreateSchema = sessionAgentConfigPartialSchema.omit({
  goal_objective: true,
  goal_control: true,
});
export type SessionAgentConfigCreate = z.infer<typeof sessionAgentConfigCreateSchema>;

export const sessionMetadataSchema = z
  .object({
    cwd: z.string().min(1),
  })
  .catchall(z.unknown());

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export const sessionPendingInteractionSchema = z.enum(['none', 'approval', 'question']);
export type SessionPendingInteraction = z.infer<typeof sessionPendingInteractionSchema>;

export const sessionSchema = z.object({
  id: z.string().min(1),
  workspace_id: workspaceIdSchema,
  title: z.string(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  /** Any agent in the session holds an active turn or background lease.
   *  Replaces the derived five-value `status` enum: awaiting
   *  states ride the approval/question channels, and turn outcomes ride
   *  turn.ended — clients compose their own presentation from the facts. */
  busy: z.boolean(),
  /** Whether the MAIN agent currently owns an active turn. Unlike `busy`,
   *  this excludes background tasks and sub-agent turns. Optional for wire
   *  compatibility with older servers. */
  main_turn_active: z.boolean().optional(),
  /** Highest-priority pending human interaction, so list clients can restore
   *  the pre-status attention badge without subscribing to every session. */
  pending_interaction: sessionPendingInteractionSchema.optional(),
  /** Outcome of the MAIN agent's most recent turn, when the session is live
   *  and a turn has ended since activation. A fact, not a state: clients
   *  decide how to present it (e.g. an "aborted" tag when `!busy` and the
   *  reason is cancelled/failed). */
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  archived: z.boolean().optional(),
  /** When the session was archived (ISO 8601); absent for sessions archived
   *  before the field existed — clients fall back to `updated_at`. */
  archived_at: isoDateTimeSchema.optional(),
  current_prompt_id: z.string().min(1).optional(),
  /** Text of the most recent user prompt, for search/preview. Absent for empty sessions. */
  last_prompt: z.string().optional(),
  metadata: sessionMetadataSchema,
  agent_config: sessionAgentConfigSchema,
  usage: sessionUsageSchema,
  permission_rules: z.array(permissionRuleSchema),
  message_count: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionCreateSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: sessionMetadataSchema.optional(),
  agent_config: sessionAgentConfigCreateSchema.optional(),
  workspace_id: workspaceIdSchema.optional(),
});

export type SessionCreate = z.infer<typeof sessionCreateSchema>;

export const sessionUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: sessionMetadataSchema.partial().optional(),
  agent_config: sessionAgentConfigPartialSchema.optional(),
  permission_rules: z.array(permissionRuleSchema).optional(),
});

export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;

export const expectedSessionCursorSchema = z.object({
  seq: z.number().int().nonnegative(),
  epoch: z.string().min(1),
});
export type ExpectedSessionCursor = z.infer<typeof expectedSessionCursorSchema>;

export const sessionForkSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  through_message_id: z.string().min(1).optional(),
  expected_cursor: expectedSessionCursorSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.through_message_id === undefined) === (value.expected_cursor === undefined)) return;
  ctx.addIssue({
    code: 'custom',
    message: 'through_message_id and expected_cursor must be provided together',
    path: value.through_message_id === undefined ? ['through_message_id'] : ['expected_cursor'],
  });
});

export type SessionFork = z.infer<typeof sessionForkSchema>;

export const sessionChildCreateSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SessionChildCreate = z.infer<typeof sessionChildCreateSchema>;
