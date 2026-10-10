import type { Session } from '@kiki/protocol';
import type { ConversationListItem } from './conversationList';
import { groupSessionsByTime, isPinnedSession, sortSessionItems, type SessionGroup, type SessionSortOrder, type TimeGroupLabels } from './sessionList';

function parentIdOf(session: Session): string | undefined {
  const createdBy = session.metadata['created_by_session_id'];
  if (typeof createdBy === 'string' && createdBy !== '' && createdBy !== session.id) return createdBy;
  const parent = session.metadata['parent_session_id'];
  return session.metadata['child_session_kind'] === 'child' && typeof parent === 'string' && parent !== '' && parent !== session.id ? parent : undefined;
}

function newer(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Project the activity clock of an attached display family without changing
 * a session's own timestamp, unread state, relation or pagination facts.
 * Consume after filtering, before the existing nesting walk. */
export function projectAttachedConversationGroups(
  groups: readonly SessionGroup<ConversationListItem>[],
  options: {
    readonly groupBy: 'time' | 'workspace' | 'none';
    readonly order: SessionSortOrder;
    readonly topLevelIds: ReadonlySet<string>;
    /** All loaded relation facts, including rows currently filtered out. */
    readonly sessions: readonly Session[];
    readonly nowMs: number;
    readonly labels?: TimeGroupLabels;
  },
): readonly SessionGroup<ConversationListItem>[] {
  if (options.order !== 'updated-desc') return groups;
  const items = groups.flatMap((group) => group.items);
  const byId = new Map<string, Session>();
  const groupOf = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) {
      if (item.kind !== 'session') continue;
      byId.set(item.id, item.session);
      groupOf.set(item.id, group.key);
    }
  }
  const rootOf = (session: Session): string => {
    const seen = new Set([session.id]);
    let current = session;
    for (;;) {
      if (options.topLevelIds.has(current.id)) return current.id;
      const parentId = parentIdOf(current);
      const parent = parentId === undefined ? undefined : byId.get(parentId);
      if (parent === undefined || seen.has(parent.id)) return current.id;
      seen.add(parent.id);
      current = parent;
    }
  };
  const hostOf = new Map<string, string>();
  for (const session of byId.values()) {
    const root = rootOf(session);
    const allowed = groupOf.get(root) === groupOf.get(session.id)
      || (options.groupBy !== 'workspace' && !isPinnedSession(session));
    hostOf.set(session.id, root !== session.id && allowed ? root : '');
  }
  for (const [id, host] of hostOf) {
    if (host !== '' && hostOf.get(host) !== '') hostOf.set(id, '');
  }

  // An aggregate cannot be borrowed across an explicit display boundary.
  // Trace business relations, not today's visible placement: an unloaded or
  // filtered parent does not make a child an explicitly promoted session.
  const relations = new Map(options.sessions.map((session) => [session.id, session]));
  for (const session of byId.values()) relations.set(session.id, session);
  const splitActivity = new Map<string, string>();
  for (const session of relations.values()) {
    const visibleBoundary = byId.has(session.id) && hostOf.get(session.id) === '' && rootOf(session) !== session.id;
    if (!options.topLevelIds.has(session.id) && !visibleBoundary) continue;
    const seen = new Set([session.id]);
    let parentId = parentIdOf(session);
    while (parentId !== undefined && !seen.has(parentId)) {
      seen.add(parentId);
      splitActivity.set(parentId, newer(splitActivity.get(parentId) ?? session.updated_at, session.updated_at));
      const parent = relations.get(parentId);
      parentId = parent === undefined ? undefined : parentIdOf(parent);
    }
  }
  const clocks = new Map<string, string>();
  for (const session of byId.values()) {
    const detachedAt = splitActivity.get(session.id);
    const separated = detachedAt !== undefined && Date.parse(session.updated_at) <= Date.parse(detachedAt);
    clocks.set(session.id, separated ? session.own_updated_at ?? session.updated_at : session.updated_at);
  }
  for (const session of byId.values()) {
    const host = hostOf.get(session.id);
    if (host === undefined || host === '') continue;
    clocks.set(host, newer(clocks.get(host)!, clocks.get(session.id)!));
  }
  const projected = items.map((item) => item.kind === 'room' ? item : { ...item, updated_at: clocks.get(item.id)! });
  const sorted = sortSessionItems(projected, options.order);
  if (options.groupBy === 'time') {
    const labels = { ...Object.fromEntries(groups.map((group) => [group.key, group.label])), ...options.labels };
    return groupSessionsByTime(sorted, options.nowMs, labels);
  }
  const projectedByKey = new Map(projected.map((item) => [item.key, item]));
  return groups.map((group) => ({ ...group, items: sortSessionItems(group.items.map((item) => projectedByKey.get(item.key)!), options.order) }));
}
