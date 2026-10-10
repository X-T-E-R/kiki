/**
 *   POST /v1/sessions/{sid}/prompts
 *     Body:  PromptSubmission {
 *              content: MessageContent[],
 *              metadata?: ...,
 *              profile?: string,
 *              model?: string,
 *              thinking?: 'off'|'low'|'medium'|'high'|'xhigh'|'max',
 *              permission_mode?: 'manual'|'auto'|'review'|'yolo',
 *              plan_mode?: boolean,
 *              disabled_tools?: string[],
 *            }
 *     Reply: PromptSubmitResult { prompt_id, user_message_id, status, content, created_at }
 *            status='running' when sent immediately, status='queued' when
 *            another prompt is already active, status='blocked' when rejected
 *            before a turn is launched.
 *
 *   GET /v1/sessions/{sid}/prompts
 *     Reply: { active: PromptItem | null, queued: PromptItem[] }
 *
 *   POST /v1/sessions/{sid}/prompts/{pid}:steer
 *   POST /v1/sessions/{sid}/prompts:steer
 *     Body:  { prompt_ids: string[] } for the collection route
 *     Reply: { steered: true, prompt_ids: string[] }
 *
 *   POST /v1/sessions/{sid}/prompts/{pid}:timing
 *     Body:  { append_timing, expected_revision? }
 *     Reply: PromptItem (authoritative post-change entry)
 *
 *   POST /v1/sessions/{sid}/prompts/{pid}:abort
 *     Body:  empty
 *     Reply: { aborted: true, at_seq: number }   (envelope code 0)
 *            { aborted: false, at_seq: number }  (envelope code 40903, idempotent)
 */

import { z } from 'zod';
import { transcriptPromptRuntimeControlsSchema } from '@kiki/transcript';
import { executionSelectionSchema } from '../execution';

import { messageContentSchema } from '../message';
import { isoDateTimeSchema } from '../time';

// Accept any non-empty, model-declared effort string. Providers normalize
// unrecognized efforts on the wire, so the REST layer must not reject a value
// the catalog advertises via `support_efforts`.
export const promptThinkingSchema = z.string().min(1);
export type PromptThinking = z.infer<typeof promptThinkingSchema>;

export const promptPermissionModeSchema = z.enum(['manual', 'auto', 'review', 'yolo']);
export type PromptPermissionMode = z.infer<typeof promptPermissionModeSchema>;

export const promptPlanGateSchema = z.enum(['free', 'gated']);
export type PromptPlanGate = z.infer<typeof promptPlanGateSchema>;

// Closed set of deferred-append timings a queued prompt can wait on. A newer
// server always reports the effective `append_timing` on every `PromptItem`;
// older responses omit it and callers fall back to `agent_idle`.
export const deferredAppendTimingSchema = z.enum(['agent_idle', 'subagents_done', 'tasks_done']);
export type DeferredAppendTiming = z.infer<typeof deferredAppendTimingSchema>;

// A goal's automatic continuation is at least as strict as `subagents_done`;
// `agent_idle` and immediate appends are user-message concepts only.
export const goalFollowUpTimingSchema = z.enum(['subagents_done', 'tasks_done']);
export type GoalFollowUpTiming = z.infer<typeof goalFollowUpTimingSchema>;

export const goalInitialStatusSchema = z.enum(['active', 'paused']);
export type GoalInitialStatus = z.infer<typeof goalInitialStatusSchema>;

export const promptSubmissionSchema = z.object({
  execution: executionSelectionSchema.optional(),
  content: z.array(messageContentSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  agent_id: z.string().min(1).optional(),
  // Agent profile captured with this prompt and applied when the prompt starts.
  // A different name replaces the target agent's current base-profile binding.
  profile: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  after_model_switch: z.string().min(1).optional(),
  model_switch_mode: z.enum(['direct', 'compact', 'fresh']).optional(),
  thinking: promptThinkingSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_gate: promptPlanGateSchema.optional(),
  plan_mode: z.boolean().optional(),
  goal_objective: z.string().optional(),
  goal_control: z.enum(['pause', 'resume', 'cancel']).optional(),
  goal_follow_up_timing: goalFollowUpTimingSchema.optional(),
  goal_initial_status: goalInitialStatusSchema.optional(),
  // Deferred-append timing for this submission; omitted means `agent_idle`.
  // Consumed when the prompt is dequeued, never while it is queued.
  append_timing: deferredAppendTimingSchema.optional(),
  // Client-managed session tool denylist: full-replace on every submit; the
  // bound profile's own deny always survives. Omit to keep the persisted
  // value, send `[]` to clear the client portion.
  disabled_tools: z.array(z.string()).optional(),
  // Client-chosen prompt record id; the engine echoes it on the consuming
  // turn's `turn.started` (`promptId`) so the submitter can bind its own
  // bookkeeping to that turn exactly. Omit to let the engine assign one.
  prompt_id: z.string().min(1).optional(),
  persona_greeting_reply: z.boolean().optional(),
  skills: z.array(z.object({ name: z.string().min(1), args: z.string().optional() })).min(1).optional(),
});
export type PromptSubmission = z.infer<typeof promptSubmissionSchema>;

export const promptExecutionOverridesSchema = promptSubmissionSchema.pick({
  execution: true,
  profile: true,
  model: true,
  thinking: true,
  permission_mode: true,
  plan_gate: true,
  plan_mode: true,
  persona_greeting_reply: true,
  disabled_tools: true,
});
export type PromptExecutionOverrides = z.infer<typeof promptExecutionOverridesSchema>;

export const promptStatusSchema = z.enum(['running', 'queued', 'blocked']);
export type PromptStatus = z.infer<typeof promptStatusSchema>;

export const promptItemSchema = z.object({
  runtime_controls: transcriptPromptRuntimeControlsSchema.optional(),
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  status: promptStatusSchema,
  origin: z.unknown().optional(),
  content: z.array(messageContentSchema).min(1),
  created_at: isoDateTimeSchema,
  // Always populated by a server that supports deferred-append timing; absent
  // on older responses, where callers should assume `agent_idle`.
  append_timing: deferredAppendTimingSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
});
export type PromptItem = z.infer<typeof promptItemSchema>;

export const promptQueueHoldSchema = z.object({
  reason: z.literal('recovery'),
  count: z.number().int().nonnegative(),
});
export type PromptQueueHold = z.infer<typeof promptQueueHoldSchema>;

export const promptListResponseSchema = z.object({
  active: promptItemSchema.nullable(),
  queued: z.array(promptItemSchema),
  recovery_hold: promptQueueHoldSchema.optional(),
});
export type PromptListResponse = z.infer<typeof promptListResponseSchema>;

export const promptSubmitResultSchema = promptItemSchema;
export type PromptSubmitResult = z.infer<typeof promptSubmitResultSchema>;

export const promptSubmitReceiptSchema = promptItemSchema.omit({ content: true }).extend({
  resolved_media: z.array(z.object({ index: z.number().int().nonnegative(), content: messageContentSchema })).optional(),
  resolved_parts: z.array(z.object({ index: z.number().int().nonnegative(), content: z.array(messageContentSchema) })).optional(),
});
export type PromptSubmitReceipt = z.infer<typeof promptSubmitReceiptSchema>;

export const promptReplaceRequestSchema = z.object({
  content: z.array(messageContentSchema).min(1),
  replace_attachments: z.boolean().optional(),
});
export type PromptReplaceRequest = z.infer<typeof promptReplaceRequestSchema>;

export const promptReplaceResultSchema = promptItemSchema;
export type PromptReplaceResult = z.infer<typeof promptReplaceResultSchema>;

export const promptTimingRequestSchema = z.object({
  append_timing: deferredAppendTimingSchema,
  expected_revision: z.number().int().nonnegative().optional(),
});
export type PromptTimingRequest = z.infer<typeof promptTimingRequestSchema>;

export const promptTimingResultSchema = promptItemSchema;
export type PromptTimingResult = z.infer<typeof promptTimingResultSchema>;

// Edit hold (`POST …/prompts/{pid}:hold`): `held: true` parks the prompt and
// everything queued after it while a client edits it (renew to keep it; it
// lapses after a few minutes on its own); `held: false` releases it.
export const promptHoldRequestSchema = z.object({
  held: z.boolean(),
});
export type PromptHoldRequest = z.infer<typeof promptHoldRequestSchema>;

export const promptHoldResultSchema = z.object({
  prompt_id: z.string().min(1),
  held: z.boolean(),
});
export type PromptHoldResult = z.infer<typeof promptHoldResultSchema>;

export const promptMoveRequestSchema = z.object({
  target_index: z.number().int().nonnegative(),
});
export type PromptMoveRequest = z.infer<typeof promptMoveRequestSchema>;

export const promptMoveResultSchema = z.object({
  moved: z.literal(true),
  prompt_id: z.string().min(1),
  target_index: z.number().int().nonnegative(),
  queued_prompt_ids: z.array(z.string().min(1)),
});
export type PromptMoveResult = z.infer<typeof promptMoveResultSchema>;

export const promptSteerRequestSchema = z.object({
  prompt_ids: z.array(z.string().min(1)).min(1),
});
export type PromptSteerRequest = z.infer<typeof promptSteerRequestSchema>;

export const promptSteerResultSchema = z.object({
  steered: z.literal(true),
  prompt_ids: z.array(z.string().min(1)).min(1),
});
export type PromptSteerResult = z.infer<typeof promptSteerResultSchema>;

export const promptAbortResponseSchema = z.object({
  aborted: z.boolean(),
  at_seq: z.number().int().nonnegative().optional(),
});
export type PromptAbortResponse = z.infer<typeof promptAbortResponseSchema>;

export const turnAbortResponseSchema = z.object({ aborted: z.boolean() });
export type TurnAbortResponse = z.infer<typeof turnAbortResponseSchema>;

export interface PromptCompletedEventPayload {
  readonly type: 'prompt.completed';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason?: 'completed' | 'failed' | 'blocked';
}

export interface PromptAbortedEventPayload {
  readonly type: 'prompt.aborted';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly abortedAt: string;
  readonly beforeStart?: boolean;
}

export interface PromptMovedEventPayload {
  readonly type: 'prompt.moved';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly targetIndex: number;
  readonly queuedPromptIds: readonly string[];
  readonly movedAt: string;
}

export interface PromptSteeredEventPayload {
  readonly type: 'prompt.steered';
  readonly agentId: string;
  readonly sessionId: string;
  readonly activePromptId: string;
  readonly promptIds: readonly string[];
  readonly content: PromptSubmission['content'];
  readonly steeredAt: string;
}
