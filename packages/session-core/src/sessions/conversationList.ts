import type { RoomListItem, Session, Workspace } from '@kiki/protocol';
import { roomSeenKey, roomUnreadCount } from '../settings/roomReadState';
import type { SessionSeenMap } from '../settings/sessionReadState';
import { buildInboxModel, type InboxSource } from './inbox';
import { roomRefLink } from './conversationLinks';
import { filterSessions, groupSessionsByTime, groupSessionsByWorkspace, isPinnedSession, SESSION_PIN_META_KEY, sortSessionItems, type SessionFilterInput, type SessionGroup, type SessionListEntry, type SessionSortOrder, type TimeGroupLabels } from './sessionList';

type ConversationFields = SessionListEntry & {
  readonly key: string;
  readonly href: string;
  readonly last_seq: number;
  readonly unread_count: number;
  readonly needs_you: boolean;
  readonly failed: boolean;
  readonly pinned: boolean;
};

export type ConversationListItem = ConversationFields & (
  | { readonly kind: 'session'; readonly session: Session }
  | { readonly kind: 'room'; readonly room: RoomListItem; readonly member_count: number }
);

/** Merge only loaded thread pages with room summaries; preserve the session cursor separately. */
export function mergeConversationItems(sessions: readonly Session[], rooms: readonly RoomListItem[], seen: SessionSeenMap, order: SessionSortOrder = 'updated-desc'): ConversationListItem[] {
  const threads: ConversationListItem[] = sessions.map((session) => ({
    ...session, kind: 'session', session, key: `session:${session.id}`, href: `/s/${session.id}`,
    unread_count: Math.max(0, session.last_seq - (seen[session.id] ?? 0)),
    needs_you: session.pending_interaction === 'approval' || session.pending_interaction === 'question',
    failed: session.last_turn_reason === 'failed', pinned: isPinnedSession(session),
  }));
  const roomItems: ConversationListItem[] = rooms.map((room) => ({
    kind: 'room', room, id: room.id, key: roomSeenKey(room.id), href: roomRefLink(room.id),
    title: room.title, workspace_id: room.workspace, created_at: room.createdAt, updated_at: room.updatedAt,
    metadata: { cwd: '', [SESSION_PIN_META_KEY]: room.pinned }, archived: room.archived,
    busy: room.busy, pending_interaction: room.pendingInteraction,
    last_seq: room.lastSeq, unread_count: roomUnreadCount(room.id, room.lastSeq, seen),
    needs_you: room.needsYou, failed: room.failed, pinned: room.pinned, member_count: room.memberCount,
  }));
  return sortSessionItems([...threads, ...roomItems], order);
}

/** Shared time/workspace/no-group layout, with the same pin and filter semantics as threads. */
export function groupConversationItems(items: readonly ConversationListItem[], options: {
  readonly groupBy: 'time' | 'workspace' | 'none';
  readonly workspaces: readonly Workspace[];
  readonly filters: SessionFilterInput;
  readonly nowMs: number;
  readonly order?: SessionSortOrder;
  readonly labels?: TimeGroupLabels;
  readonly ungroupedLabel?: string;
}): SessionGroup<ConversationListItem>[] {
  const visible = filterSessions(items, { ...options.filters, status: [] }).filter((item) =>
    options.filters.status.length === 0 || options.filters.status.includes(item.needs_you ? 'needs-me' : item.busy ? 'running' : 'idle'));
  const sorted = sortSessionItems(visible, options.order ?? 'updated-desc');
  if (options.groupBy === 'time') return groupSessionsByTime(sorted, options.nowMs, options.labels);
  if (options.groupBy === 'workspace') return groupSessionsByWorkspace(sorted, options.workspaces, undefined, options.ungroupedLabel, options.labels?.pinned);
  return sorted.length === 0 ? [] : [{ key: 'all', label: '', items: sorted }];
}

export function buildConversationInbox(sessions: readonly Session[], rooms: readonly RoomListItem[], seen: SessionSeenMap) {
  const roomSources: InboxSource[] = rooms.map((room) => ({
    id: roomSeenKey(room.id), roomId: room.id, title: room.title, workspace_id: room.workspace,
    updated_at: room.updatedAt, last_seq: room.lastSeq, archived: room.archived, busy: room.busy,
    pending_interaction: room.pendingInteraction, needsYouReason: room.needsYou && room.pendingInteraction === 'none' ? 'budget' : undefined,
    last_turn_reason: room.failed ? 'failed' : 'completed',
  }));
  return buildInboxModel([...sessions, ...roomSources], seen);
}
