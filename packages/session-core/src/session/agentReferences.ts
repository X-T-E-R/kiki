/**
 * Agent references — a `kiki://agents/<profile>` link typed into a user
 * message, structured by the engine into the message origin's `agentRefs`.
 * The transcript carries the reference; the task it delegated to (when the
 * main agent accepted it) carries the same `refId` as `source_ref`, so a
 * chip can tell "not delegated yet" from "delegated to that child" without
 * guessing from the profile name.
 */

import type { Task } from '@kiki/protocol';
import { findAgentRefs } from '@kiki/protocol';
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

/**
 * One run a reference produced: the child it opened and the task that records
 * it, so a chip can jump to the run and tell the runs apart.
 */
export interface AgentRefRun {
  readonly agentId: string;
  readonly taskId: string;
  /** The run's own description — what distinguishes it from the reference's other runs. */
  readonly label?: string;
  /** The task's lifecycle status; a run is never `failed`/`cancelled` (those read as rejected). */
  readonly status: Task['status'];
  /** Task start time (ISO); a run with none sorts as the oldest. */
  readonly startedAt?: string;
}

/** What the client knows about one reference's delegation outcome. */
export type AgentRefDelegation =
  | { readonly status: 'delegated'; readonly agentId: string; readonly taskId: string; readonly runs: readonly AgentRefRun[] }
  | { readonly status: 'pending' }
  | { readonly status: 'rejected' };

/** Newest first; a run without a start time is treated as older than any dated one. */
function byMostRecent(a: AgentRefRun, b: AgentRefRun): number {
  const at = a.startedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(a.startedAt);
  const bt = b.startedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(b.startedAt);
  return bt - at;
}

/**
 * The delegation outcome of one reference, read off the session's task list.
 * A task whose `source_ref` names the same `refId` (and message, when the
 * message id is known) is a delegation that reference produced. One reference
 * can run several children over time: the chip jumps to the most recent and
 * reads the rest as "N runs". With no matching task the reference is still
 * just a mention — "not delegated yet" — unless the engine reported the
 * rejection as a failed, child-less task on the same message.
 */
export function agentRefDelegation(
  ref: AgentReference,
  tasks: readonly Task[],
  messageId?: string,
): AgentRefDelegation {
  const named = tasks.filter((task) => task.source_ref?.refId === ref.refId);
  const candidates = messageId === undefined
    ? named
    : named.filter((task) => task.source_ref?.messageId === messageId);
  const pool = candidates.length > 0 ? candidates : named;
  if (pool.length === 0) return { status: 'pending' };
  const runs = pool
    .filter((task) => task.agent_id !== undefined && task.status !== 'failed' && task.status !== 'cancelled')
    .map((task) => ({
      agentId: task.agent_id!,
      taskId: task.id,
      label: task.description?.trim() === '' ? undefined : task.description,
      status: task.status,
      startedAt: task.started_at,
    }))
    .sort(byMostRecent);
  if (runs.length === 0) return { status: 'rejected' };
  const latest = runs[0]!;
  return { status: 'delegated', agentId: latest.agentId, taskId: latest.taskId, runs };
}

/**
 * Plain-text form of the references in `text`: each `kiki://agents/<profile>`
 * link becomes `@<profile>`, so a one-line summary stays readable without the
 * raw URL. The engine name the link carries is the readable label.
 */
export function replaceAgentRefs(text: string): string {
  const matches = findAgentRefs(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start) + `@${match.profile}`;
    cursor = match.end;
  }
  return out + text.slice(cursor);
}
