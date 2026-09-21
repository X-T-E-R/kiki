/**
 * `GET /v1/sessions/{session_id}/snapshot` — IM-style "initial sync".
 *
 * Returns an atomic-at-a-watermark view of everything a client needs to
 * rebuild a session's UI state, so the standard multi-device rebuild flow is:
 *
 *   1. `GET /sessions/{sid}/snapshot`            → state + `as_of_seq` + `epoch`
 *   2. WS `subscribe` with `cursors[sid] = { seq: as_of_seq, epoch }`
 *   3. apply live durable events (`seq > as_of_seq`) on top
 *
 * No gap and no duplication by construction: the watermark ties the REST
 * snapshot to the WS event stream.
 *
 * `in_flight_turn` carries the accumulated state of a currently-running turn
 * (volatile deltas are not replayable; this is how a reconnecting client
 * recovers mid-turn assistant/thinking text and running tool calls).
 *
 * The server enters the session event queue once to freeze the cursor,
 * committed context projection, and volatile ownership state. Blob references
 * are rehydrated outside that barrier from the immutable captured context.
 */

import { z } from 'zod';

import { approvalRequestSchema } from '../approval';
import { messageSchema } from '../message';
import { questionRequestSchema } from '../question';
import { sessionSchema } from '../session';
import { taskSchema } from '../task';

export const restContextBreakdownSchema = z.object({
  system_tokens: z.number().int().nonnegative(),
  tools_tokens: z.number().int().nonnegative(),
  messages_tokens: z.number().int().nonnegative(),
  estimated: z.literal(true),
});
export type RestContextBreakdown = z.infer<typeof restContextBreakdownSchema>;

export const inFlightToolCallSchema = z.object({
  tool_call_id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown().optional(),
  description: z.string().optional(),
  /** Display payload from `tool.call.started` (ToolInputDisplay). */
  display: z.unknown().optional(),
  /** Most recent `tool.progress` update, if any. */
  last_progress: z
    .object({
      kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
      text: z.string().optional(),
      percent: z.number().optional(),
    })
    .optional(),
});
export type InFlightToolCall = z.infer<typeof inFlightToolCallSchema>;

export const inFlightTurnSchema = z.object({
  turn_id: z.number().int().nonnegative(),
  step: z.number().int().positive().optional(),
  step_id: z.string().min(1).optional(),
  /** Assistant text accumulated from `assistant.delta` in the current step (reset on `turn.step.started`; earlier steps are in `messages`). */
  assistant_text: z.string(),
  /** Thinking text accumulated from `thinking.delta` in the current step (reset on `turn.step.started`). */
  thinking_text: z.string(),
  /** Tool calls started but without a `tool.result` yet. */
  running_tools: z.array(inFlightToolCallSchema),
  /** Daemon prompt_id of the active prompt, if the turn was started by IPromptService. */
  current_prompt_id: z.string().optional(),
});
export type InFlightTurn = z.infer<typeof inFlightTurnSchema>;

/**
 * A subagent relation or task as of the snapshot watermark. Extends the base
 * task wire shape with identity metadata that otherwise only rides the
 * (non-replayed) `subagent.spawned` WS event.
 */
export const snapshotSubagentSchema = taskSchema.extend({
  live: z.boolean().optional(),
  subagent_phase: z.enum(['queued', 'working', 'suspended', 'completed', 'failed']).optional(),
  profile: z.string().optional(),
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
  parent_agent_id: z.string().optional(),
  parent_tool_call_id: z.string().optional(),
  label: z.string().optional(),
  tool_call_count: z.number().int().nonnegative().optional(),
  suspended_reason: z.string().optional(),
  swarm_index: z.number().int().nonnegative().optional(),
  run_in_background: z.boolean().optional(),
});
export type SnapshotSubagent = z.infer<typeof snapshotSubagentSchema>;

export const sessionSnapshotResponseSchema = z.object({
  /** Durable event watermark this snapshot is consistent with. */
  as_of_seq: z.number().int().nonnegative(),
  /** Journal epoch — pass back via the WS cursor for invalidation detection. */
  epoch: z.string().min(1),
  session: sessionSchema,
  /** Most recent messages (chronological ascending), bounded page. */
  messages: z.object({
    items: z.array(messageSchema),
    has_more: z.boolean(),
  }),
  in_flight_turn: inFlightTurnSchema.nullable(),
  /**
   * Roster of live subagent tasks at the watermark, so a reconnecting client
   * can rebuild swarm cards before the swarm's tool result lands. Optional
   * for cross-version tolerance: older servers do not send it.
   */
  subagents: z.array(snapshotSubagentSchema).optional(),
  context_tokens: z.number().int().nonnegative().optional(),
  max_context_tokens: z.number().int().positive().optional(),
  context_breakdown: restContextBreakdownSchema.optional(),
  pending_approvals: z.array(approvalRequestSchema),
  pending_questions: z.array(questionRequestSchema),
});
export type SessionSnapshotResponse = z.infer<typeof sessionSnapshotResponseSchema>;
