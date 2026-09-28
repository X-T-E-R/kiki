/**
 * Activity inbox model — "what is waiting for me", assembled from the session
 * records the sidebar already polls plus the local seen-marks
 * (`settings/sessionReadState`). No extra requests: everything here comes from
 * `Session.pending_interaction`, `busy`, `last_seq`, `last_turn_reason` and
 * `updated_at`.
 *
 * Two buckets, in the order a user drains them:
 *
 *   1. `needsYou` — an approval or a question is blocking the run. Nothing
 *      moves until the user answers, so these sort oldest-first: the run that
 *      has been stuck longest is the most expensive to leave.
 *   2. `unread`   — the run finished (or failed, or was cancelled) and the
 *      user has not opened the session since. Newest-first, the way an inbox
 *      reads.
 *
 * A busy session is in neither bucket unless it is also blocked: work in
 * flight is not an item to act on. Archived sessions never appear.
 *
 * Read state is a high-water mark on `last_seq`, so "seen" survives further
 * events correctly: opening a session marks it read at that sequence, and any
 * later turn makes it unread again.
 */

import type { Session } from '@kiki/protocol';

import type { SessionSeenMap } from '../settings/sessionReadState';
import { pendingKindOf } from './activity';

/** Why a session is in the inbox. */
export type InboxReason = 'approval' | 'question' | 'completed' | 'failed' | 'cancelled';

export interface InboxItem {
  readonly sessionId: string;
  readonly title: string;
  readonly workspaceId: string;
  readonly reason: InboxReason;
  /** ISO timestamp used for ordering and the relative-time label. */
  readonly at: string;
  /** Still holding a turn (a blocked session can also have work in flight). */
  readonly busy: boolean;
}

export interface InboxModel {
  /** Blocked on the user, longest-waiting first. */
  readonly needsYou: readonly InboxItem[];
  /** Finished since the user last looked, newest first. */
  readonly unread: readonly InboxItem[];
  /** `needsYou.length + unread.length` — the nav badge count. */
  readonly total: number;
}

export const EMPTY_INBOX: InboxModel = { needsYou: [], unread: [], total: 0 };

/** True when the session has events the user has not opened yet. */
export function isSessionUnread(session: Session, seen: SessionSeenMap): boolean {
  // A session with no events yet (a fresh draft) is never "unread".
  if (session.last_seq <= 0) return false;
  const mark = seen[session.id];
  return mark === undefined || mark < session.last_seq;
}

function finishedReason(session: Session): InboxReason | undefined {
  switch (session.last_turn_reason) {
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return 'completed';
    default:
      // No recorded outcome: an idle session with events still counts as
      // something that ran, so it belongs in the unread bucket rather than
      // disappearing.
      return 'completed';
  }
}

function ascending(left: InboxItem, right: InboxItem): number {
  return Date.parse(left.at) - Date.parse(right.at);
}

/**
 * Assemble the inbox. `sessions` is the already-fetched list (any order);
 * `seen` is the local read-state snapshot.
 */
export function buildInboxModel(
  sessions: readonly Session[],
  seen: SessionSeenMap,
): InboxModel {
  const needsYou: InboxItem[] = [];
  const unread: InboxItem[] = [];
  for (const session of sessions) {
    if (session.archived === true) continue;
    const base = {
      sessionId: session.id,
      title: session.title,
      workspaceId: session.workspace_id,
      at: session.updated_at,
      busy: session.busy,
    };
    const pending = pendingKindOf(session);
    if (pending !== 'none') {
      needsYou.push({ ...base, reason: pending });
      continue;
    }
    // Work in flight is not an item to act on.
    if (session.busy) continue;
    if (!isSessionUnread(session, seen)) continue;
    const reason = finishedReason(session);
    if (reason === undefined) continue;
    unread.push({ ...base, reason });
  }
  needsYou.sort(ascending);
  unread.sort((left, right) => ascending(right, left));
  return { needsYou, unread, total: needsYou.length + unread.length };
}

/** Sidebar row state: one of four, in precedence order. */
export type SessionRowState = 'needs-me' | 'running' | 'unread' | 'read';

/**
 * The visual state of one sidebar row. Blocking beats running (an approval is
 * the thing to act on even while a subagent works), running beats unread, and
 * a session with nothing outstanding is plain `read`.
 */
export function sessionRowState(session: Session, seen: SessionSeenMap): SessionRowState {
  if (pendingKindOf(session) !== 'none') return 'needs-me';
  if (session.busy) return 'running';
  return isSessionUnread(session, seen) ? 'unread' : 'read';
}
