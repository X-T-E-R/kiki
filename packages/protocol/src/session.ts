import { z } from 'zod';
import { executorCapabilitiesSchema } from './rest/executor';
import { executionBindingSchema, executionSelectionSchema } from './execution';

import {
  promptPermissionModeSchema,
  promptPlanGateSchema,
  promptThinkingSchema,
} from './rest/prompt';
import { personaAvatarDataSchema } from './rest/persona';
import { isoDateTimeSchema } from './time';
import { workspaceIdSchema } from './workspace';
import { usageAccountingSnapshotSchema } from './rest/usage';

export const sessionUsageSchema = /* @__PURE__ */ z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  tokens_by_model: z.record(z.string(), z.number().int().nonnegative()).optional(),
  by_model: z.record(z.string(), z.number().nonnegative()).optional(),
  cost_unknown_models: z.array(z.string()).optional(),
  accounting: usageAccountingSnapshotSchema.optional(),
  context_tokens: z.number().int().nonnegative(),
  context_limit: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
});

export type SessionUsage = z.infer<typeof sessionUsageSchema>;

/**
 * Why a session's usage numbers are missing or short. `read-failed` means the
 * read threw and `usage` is the zero placeholder; `agent-read-failed` means a
 * sub-agent's usage was skipped, so the totals understate.
 */
export const sessionUsageErrorSchema = /* @__PURE__ */ z.enum(['read-failed', 'agent-read-failed']);
export type SessionUsageError = z.infer<typeof sessionUsageErrorSchema>;

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

export const permissionRuleMatcherSchema = /* @__PURE__ */ z.object({
  kind: z.enum(['command_prefix', 'path_glob', 'exact_input', 'always']),
  value: z.string().optional(),
});

export const permissionRuleSchema = /* @__PURE__ */ z.object({
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
 * permission/plan flags on the single-session snapshot, which materializes the
 * main agent. List placeholders carry only `model`/`profile`, so the flags stay
 * Write-only controls (thinking, goals) belong to the patch schemas.
 */
export const sessionAgentConfigSchema = /* @__PURE__ */ z.object({
  model: z.string(),
  execution: executionBindingSchema.optional(),
  profile: z.string().min(1).optional(),
  persona: personaAvatarDataSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  plan_gate: promptPlanGateSchema.optional(),
});

export type SessionAgentConfig = z.infer<typeof sessionAgentConfigSchema>;

/**
 * Accepted on `POST /sessions/{id}/profile`. Strict on purpose: every key here
 * is applied by the server. Unknown keys (`system_prompt`, `tools`,
 * `mcp_servers`) are validation errors.
 */
export const sessionAgentConfigPartialSchema = /* @__PURE__ */ z.strictObject({
  execution: executionSelectionSchema.optional(),
  model: z.string().optional(),
  profile: z.string().min(1).optional(),
  thinking: promptThinkingSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  plan_gate: promptPlanGateSchema.optional(),
  goal_objective: z.string().optional(),
  goal_control: z.enum(['pause', 'resume', 'cancel']).optional(),
});
export type SessionAgentConfigPartial = z.infer<typeof sessionAgentConfigPartialSchema>;

/**
 * Accepted on `POST /sessions`. The goal controls are absent: a session being
 * created has no goal to resume or cancel, and creating one is a distinct
 * operation with its own route.
 */
export const sessionAgentConfigCreateSchema = /* @__PURE__ */ sessionAgentConfigPartialSchema.omit({
  goal_objective: true,
  goal_control: true,
});
export type SessionAgentConfigCreate = z.infer<typeof sessionAgentConfigCreateSchema>;

export const sessionMetadataSchema = /* @__PURE__ */ z
  .object({
    cwd: z.string().min(1),
  })
  .catchall(z.unknown());

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export const sessionPendingInteractionSchema = /* @__PURE__ */ z.enum(['none', 'approval', 'question']);
export type SessionPendingInteraction = z.infer<typeof sessionPendingInteractionSchema>;

export const sessionWorktreeSchema = /* @__PURE__ */ z.object({
  worktree_id: z.string(),
  branch: z.string(),
  source_root: z.string(),
  base_ref: z.string(),
});

export const worktreeIsolationSchema = /* @__PURE__ */ z.object({
  kind: z.literal('worktree'),
  branch: z.string().optional(),
  base: z.union([z.enum(['head', 'fresh']), z.object({ ref: z.string().min(1) })]).optional(),
});

export const sessionDeliverySchema = /* @__PURE__ */ z.enum(['reply', 'message']);
export type SessionDelivery = z.infer<typeof sessionDeliverySchema>;

export const sessionSeedModeSchema = /* @__PURE__ */ z.enum(['fresh', 'compact', 'verbatim']);
export type SessionSeedMode = z.infer<typeof sessionSeedModeSchema>;

/** Where a promoted thread came from: the subagent whose conversation seeded it. */
export const sessionPromotedFromSchema = /* @__PURE__ */ z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  agent_name: z.string().optional(),
  profile: z.string().optional(),
  promoted_at: isoDateTimeSchema.optional(),
});
export type SessionPromotedFrom = z.infer<typeof sessionPromotedFromSchema>;

/** Where a forked session came from: the source session and turn/message boundary it split off from. */
export const sessionForkedFromSchema = /* @__PURE__ */ z.object({
  session_id: z.string().min(1),
  title: z.string().optional(),
  through_message_id: z.string().min(1).optional(),
  turn_index: z.number().int().nonnegative().optional(),
  through_user_message: z.boolean().optional(),
  seed: sessionSeedModeSchema.optional(),
  forked_at: isoDateTimeSchema.optional(),
});
export type SessionForkedFrom = z.infer<typeof sessionForkedFromSchema>;

export const sessionAttentionCursorSchema = /* @__PURE__ */ z.object({
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

export type SessionAttentionCursor = z.infer<typeof sessionAttentionCursorSchema>;

export const sessionSchema = /* @__PURE__ */ z.object({
  executor_id: z.string().optional(),
  negotiated: executorCapabilitiesSchema.shape.negotiated,
  allow_kiki_subagents: z.boolean().optional(),
  delivery: sessionDeliverySchema.optional(),
  /** Set on threads created by promoting a subagent; absent otherwise and on older servers. */
  promoted_from: sessionPromotedFromSchema.optional(),
  /** Set on sessions forked from another session; absent otherwise and on older servers. */
  forked_from: sessionForkedFromSchema.optional(),
  id: z.string().min(1),
  workspace_id: workspaceIdSchema,
  title: z.string(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  /** Original session metadata update time, excluding activity propagated from
   *  other threads. Older servers omit this field; clients use `updated_at`. */
  own_updated_at: isoDateTimeSchema.optional(),
  /** Any agent in the session holds an active turn or background lease.
   *  Replaces the derived five-value `status` enum: awaiting
   *  states ride the approval/question channels, and turn outcomes ride
   *  turn.ended — clients compose their own presentation from the facts. */
  busy: z.boolean(),
  /** Current execution, excluding queued work and terminal task receipts awaiting delivery. Absent on older servers. */
  executing: z.boolean().optional(),
  cleanup_pending: z.boolean().optional(),
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
  execution_phase: z.enum(['running', 'pausing', 'paused', 'resuming', 'failed']).optional(),
  archived: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  private: z.boolean().optional(),
  /** When the session was archived (ISO 8601); absent for sessions archived
   *  before the field existed — clients fall back to `updated_at`. */
  archived_at: isoDateTimeSchema.optional(),
  current_prompt_id: z.string().min(1).optional(),
  /** Text of the most recent user prompt, for search/preview. Absent for empty sessions. */
  last_prompt: z.string().optional(),
  metadata: sessionMetadataSchema,
  worktree: sessionWorktreeSchema.optional(),
  agent_config: sessionAgentConfigSchema,
  usage: sessionUsageSchema,
  /**
   * Why `usage` is missing or short, so a client can tell "nothing recorded"
   * from "could not read". Absent when the read succeeded.
   */
  usage_error: sessionUsageErrorSchema.optional(),
  permission_rules: z.array(permissionRuleSchema),
  message_count: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
  attention_cursor: sessionAttentionCursorSchema.optional(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionMcpServerCommonShape = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().min(1).max(2_147_483_647).optional(),
  toolTimeoutMs: z.number().int().min(1).max(2_147_483_647).optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
  inherit: z.boolean().optional(),
};

export const sessionMcpServerStdioConfigSchema = /* @__PURE__ */ z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  runtime_id: z.string().min(1).optional(),
  ...sessionMcpServerCommonShape,
}).strict();

export const sessionMcpServerHttpConfigSchema = /* @__PURE__ */ z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...sessionMcpServerCommonShape,
}).strict();

export const sessionMcpServerSseConfigSchema = /* @__PURE__ */ z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...sessionMcpServerCommonShape,
}).strict();

const sessionMcpServerDiscriminatedSchema = /* @__PURE__ */ z.discriminatedUnion('transport', [
  sessionMcpServerStdioConfigSchema,
  sessionMcpServerHttpConfigSchema,
  sessionMcpServerSseConfigSchema,
]);

export const sessionMcpServerConfigSchema = /* @__PURE__ */ z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('transport' in obj) return obj;
  if (typeof obj['command'] === 'string') return { ...obj, transport: 'stdio' };
  if (typeof obj['url'] === 'string') return { ...obj, transport: 'http' };
  return obj;
}, sessionMcpServerDiscriminatedSchema);

export type SessionMcpServerConfig = z.infer<typeof sessionMcpServerConfigSchema>;

export const sessionUserToolSchema = /* @__PURE__ */ z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  inherit: z.boolean().optional(),
}).strict();

export type SessionUserTool = z.infer<typeof sessionUserToolSchema>;

export const sessionCreateSchema = /* @__PURE__ */ z.object({
  creation_id: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  title: z.string().min(1).optional(),
  delivery: sessionDeliverySchema.optional(),
  persona: z.string().min(1).optional(),
  persona_home: z.boolean().optional(),
  metadata: z.union([
    sessionMetadataSchema,
    sessionMetadataSchema.extend({
      cwd: z.string().min(1).optional(),
      externalClient: z.object({
        driver: z.literal('external'),
        connectionId: z.string().min(1),
      }),
    }),
  ]).optional(),
  agent_config: sessionAgentConfigCreateSchema.optional(),
  workspace_id: workspaceIdSchema.optional(),
  ephemeral: z.boolean().optional(),
  private: z.boolean().optional(),
  isolation: worktreeIsolationSchema.optional(),
  mcp_servers: z.record(z.string().min(1), sessionMcpServerConfigSchema).optional(),
  user_tools: z.array(sessionUserToolSchema).optional(),
});

export type SessionCreate = z.infer<typeof sessionCreateSchema>;

export const sessionUpdateSchema = /* @__PURE__ */ z.object({
  title: z.string().min(1).optional(),
  delivery: sessionDeliverySchema.optional(),
  private: z.boolean().optional(),
  metadata: sessionMetadataSchema.partial().optional(),
  agent_config: sessionAgentConfigPartialSchema.optional(),
  permission_rules: z.array(permissionRuleSchema).optional(),
});

export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;

export const expectedSessionCursorSchema = /* @__PURE__ */ z.object({
  seq: z.number().int().nonnegative(),
  epoch: z.string().min(1),
});
export type ExpectedSessionCursor = z.infer<typeof expectedSessionCursorSchema>;

export const sessionSeedCarrySchema = /* @__PURE__ */ z.union([
  z.object({ last: z.number().int().nonnegative() }).strict(),
  z.object({ fromMessageId: z.string().min(1) }).strict(),
]);
export type SessionSeedCarry = z.infer<typeof sessionSeedCarrySchema>;

export const sessionBranchCreateSchema = /* @__PURE__ */ z.object({
  parent_agent_id: z.string().min(1).optional(),
  task: z.string().optional(),
  prompt: z.string().optional(),
  seed: sessionSeedModeSchema.optional(),
  carry: sessionSeedCarrySchema.optional(),
  title: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.string().nullable().optional(),
  executor: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  tools_locked: z.boolean().optional(),
}).strict();
export type SessionBranchCreate = z.infer<typeof sessionBranchCreateSchema>;

export const sessionBranchFoldSchema = /* @__PURE__ */ z.object({
  branch_id: z.string().min(1),
  summary: z.string().optional(),
  context: z.string().optional(),
  asks: z.array(z.string().min(1)).optional(),
  done: z.boolean().optional(),
}).strict();
export type SessionBranchFold = z.infer<typeof sessionBranchFoldSchema>;

export const sessionBranchDiscardSchema = /* @__PURE__ */ z.object({
  branch_id: z.string().min(1),
}).strict();
export type SessionBranchDiscard = z.infer<typeof sessionBranchDiscardSchema>;

export const sessionBranchToolsLockSchema = /* @__PURE__ */ z.object({
  branch_id: z.string().min(1),
  locked: z.boolean(),
}).strict();
export type SessionBranchToolsLock = z.infer<typeof sessionBranchToolsLockSchema>;

export const sessionForkSchema = /* @__PURE__ */ z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  seed: sessionSeedModeSchema.optional(),
  carry: sessionSeedCarrySchema.optional(),
  through_message_id: z.string().min(1).optional(),
  expected_cursor: expectedSessionCursorSchema.optional(),
});

export type SessionFork = z.infer<typeof sessionForkSchema>;

/** Body of `POST /sessions/{id}/agents/{agent_id}:promote`. */
export const sessionAgentPromoteSchema = /* @__PURE__ */ z.object({
  title: z.string().trim().min(1).optional(),
  profile: z.string().trim().min(1).optional(),
});

export type SessionAgentPromote = z.infer<typeof sessionAgentPromoteSchema>;

export const sessionChildCreateSchema = /* @__PURE__ */ z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SessionChildCreate = z.infer<typeof sessionChildCreateSchema>;
