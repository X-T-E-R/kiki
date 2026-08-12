/**
 * Activity-panel model — pure assembly of the sidebar's "what is happening
 * globally" view from already-available data:
 *
 *   - running sessions come from the polled Session records (`busy`);
 *   - per-session prompt queues (`GET /sessions/{id}/prompts`) give the
 *     active prompt's start time + preview text and the queue depth;
 *   - per-session tasks (`GET /sessions/{id}/tasks`) give running background
 *     task counts (subagent-kind tasks excluded, mirroring the right rail);
 *   - waiting sessions come from `pending_interaction` on the record.
 *
 * A busy session with a pending interaction appears in the running list with
 * a waiting chip, not twice; the waiting list holds pending sessions whose
 * main turn is no longer running.
 */

import type { Message, PromptListResponse, Session, Task } from '@moonshot-ai/protocol';

import { switcherSessionLabel } from './quickSwitcher';

export interface ActivityEntry {
  readonly sessionId: string;
  readonly title: string;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: 'approval' | 'question' | 'none';
  /** Active prompt's submission time (ISO) — the live timer's anchor. */
  readonly turnStartedAt: string | undefined;
  /** Active prompt text, else the record's last prompt, else undefined. */
  readonly promptPreview: string | undefined;
  readonly queuedCount: number;
  readonly runningTaskCount: number;
  readonly updatedAt: string;
}

export interface ActivityModel {
  /** Busy sessions, most recently updated first. */
  readonly running: readonly ActivityEntry[];
  /** Pending-approval/question sessions that are not busy. */
  readonly waiting: readonly ActivityEntry[];
  readonly queuedTotal: number;
  readonly runningTaskTotal: number;
}

export function pendingKindOf(session: Session): 'approval' | 'question' | 'none' {
  return session.pending_interaction === 'approval' || session.pending_interaction === 'question'
    ? session.pending_interaction
    : 'none';
}

/** First text part of a message/prompt content array; undefined when none. */
export function promptPreviewText(content: Message['content']): string | undefined {
  for (const part of content) {
    if (part.type === 'text' && part.text.trim() !== '') return part.text.trim();
  }
  return undefined;
}

function toEntry(
  session: Session,
  prompts: PromptListResponse | undefined,
  tasks: readonly Task[] | undefined,
  untitled: string,
): ActivityEntry {
  const activeText =
    prompts?.active !== null && prompts?.active !== undefined
      ? promptPreviewText(prompts.active.content)
      : undefined;
  const fallback = session.last_prompt?.trim();
  return {
    sessionId: session.id,
    title: switcherSessionLabel(session, untitled),
    mainTurnActive: session.main_turn_active === true,
    pendingInteraction: pendingKindOf(session),
    turnStartedAt: prompts?.active?.created_at,
    promptPreview: activeText ?? (fallback !== undefined && fallback !== '' ? fallback : undefined),
    queuedCount: prompts?.queued.length ?? 0,
    runningTaskCount:
      tasks?.filter((task) => task.status === 'running' && task.kind !== 'subagent').length ?? 0,
    updatedAt: session.updated_at,
  };
}

export function buildActivityModel(input: {
  sessions: readonly Session[];
  /** Per-session prompt list; only busy sessions get queried. */
  prompts: Readonly<Record<string, PromptListResponse | undefined>>;
  /** Per-session task list; only busy sessions get queried. */
  tasks: Readonly<Record<string, readonly Task[] | undefined>>;
  untitled: string;
}): ActivityModel {
  const byRecency = (a: ActivityEntry, b: ActivityEntry) => b.updatedAt.localeCompare(a.updatedAt);
  const running = input.sessions
    .filter((session) => session.busy)
    .map((session) => toEntry(session, input.prompts[session.id], input.tasks[session.id], input.untitled))
    .toSorted(byRecency);
  const waiting = input.sessions
    .filter((session) => !session.busy && pendingKindOf(session) !== 'none')
    .map((session) => toEntry(session, undefined, undefined, input.untitled))
    .toSorted(byRecency);
  return {
    running,
    waiting,
    queuedTotal: running.reduce((sum, entry) => sum + entry.queuedCount, 0),
    runningTaskTotal: running.reduce((sum, entry) => sum + entry.runningTaskCount, 0),
  };
}

/** Live-turn clock: "0:47", "12:03", "1:02:40" past the hour. */
export function formatElapsedClock(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mmss = `${minutes}:${String(rest).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : mmss;
}
