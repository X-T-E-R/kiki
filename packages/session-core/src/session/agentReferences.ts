/**
 * Agent references — a `kiki://agents/<profile>` link typed into a user
 * message, structured by the engine into the message origin's `agentRefs`.
 * The transcript carries the reference; the task it delegated to (when the
 * main agent accepted it) carries the same `refId` as `source_ref`, so a
 * chip can tell "not delegated yet" from "delegated to that child" without
 * guessing from the profile name.
 */

import type { Task } from '@kiki/protocol';
import type { AgentReference } from '@kiki/transcript';
import { agentReferenceSchema, projectTranscriptUserOrigin } from '@kiki/transcript';

import type { UserBlock } from './transcript/types';

/**
 * The references a user block carries, projected from its origin the same way
 * the wire adapter does. `sourceOrigin` is the open-content origin the block
 * retains; a plain user message has none and returns an empty list.
 */
export function agentRefsOfBlock(block: Pick<UserBlock, 'sourceOrigin'>): readonly AgentReference[] {
  if (block.sourceOrigin === undefined) return [];
  const origin = projectTranscriptUserOrigin(block.sourceOrigin);
  if (origin?.agentRefs !== undefined) return origin.agentRefs;
  const candidate = (block.sourceOrigin as { readonly agentRefs?: unknown }).agentRefs;
  const parsed = agentReferenceSchema.array().safeParse(candidate);
  return parsed.success && parsed.data.length > 0 ? parsed.data : [];
}

/** What the client knows about one reference's delegation outcome. */
export type AgentRefDelegation =
  | { readonly status: 'delegated'; readonly agentId: string; readonly taskId: string }
  | { readonly status: 'pending' }
  | { readonly status: 'rejected' };

/**
 * The delegation outcome of one reference, read off the session's task list.
 * A task whose `source_ref` names the same `refId` (and message, when the
 * message id is known) is the delegation that reference produced; its
 * `agent_id` is the child the chip opens. With no matching task the reference
 * is still just a mention — "not delegated yet" — unless the engine reported
 * the rejection as a failed, source-less task on the same message.
 */
export function agentRefDelegation(
  ref: AgentReference,
  tasks: readonly Task[],
  messageId?: string,
): AgentRefDelegation {
  const candidates = tasks.filter((task) => task.source_ref?.refId === ref.refId);
  const match = messageId === undefined
    ? candidates[0]
    : candidates.find((task) => task.source_ref?.messageId === messageId) ?? candidates[0];
  if (match === undefined) return { status: 'pending' };
  if (match.agent_id === undefined || match.status === 'failed' || match.status === 'cancelled') {
    return { status: 'rejected' };
  }
  return { status: 'delegated', agentId: match.agent_id, taskId: match.id };
}
