/**
 * Session relations for the sidebar: a session created by another one
 * (ThreadCreate → `created_by_session_id`) or split off it as a child
 * (`parent_session_id` + `child_session_kind: 'child'`) nests under that
 * session when both are visible in the current view.
 *
 * The rule is deliberately narrow so filters and views stay predictable:
 *   - a child nests only under a parent that is itself a visible top-level row;
 *   - time buckets are not meaningful for a thread (it belongs with its
 *     creator), so in the time view a child follows its parent across buckets;
 *     workspace buckets and the pinned bucket are meaningful, so there a child
 *     nests only inside the same bucket;
 *   - a pinned child stays in the pinned bucket;
 *   - anything that cannot nest stays a top-level row and carries a
 *     "from <parent>" mark instead.
 * One level only: a thread of a thread nests under the visible root it
 * descends from, so the list never indents more than once.
 */

import type { Session } from '@kiki/protocol';

import { isPinnedSession, type SessionGroup } from '@kiki/session-core/sessions';

export type SessionRelationKind = 'thread' | 'branch';

export interface SessionRelation {
  readonly kind: SessionRelationKind;
  readonly parentId: string;
  /** Creator agent for ThreadCreate threads (`created_by_agent_id`). */
  readonly agentId?: string;
}

/** The session this one came from, if its metadata records one. */
export function sessionRelationOf(session: Session): SessionRelation | undefined {
  const metadata = session.metadata as Record<string, unknown>;
  const createdBy = metadata['created_by_session_id'];
  if (typeof createdBy === 'string' && createdBy !== '' && createdBy !== session.id) {
    const agent = metadata['created_by_agent_id'];
    return { kind: 'thread', parentId: createdBy, agentId: typeof agent === 'string' && agent !== '' ? agent : undefined };
  }
  const parent = metadata['parent_session_id'];
  if (metadata['child_session_kind'] === 'child' && typeof parent === 'string' && parent !== '' && parent !== session.id) {
    return { kind: 'branch', parentId: parent };
  }
  return undefined;
}

export interface SessionTreeNode {
  readonly session: Session;
  /** Present when the row came from another session (nested or not). */
  readonly relation?: SessionRelation;
  /** Nested children, in the view's sort order. Empty for leaves. */
  readonly children: readonly SessionTreeNode[];
}

export interface SessionTreeGroup {
  readonly key: string;
  readonly label: string;
  /** Top-level rows; the row count the "Show N more" preview limit counts. */
  readonly nodes: readonly SessionTreeNode[];
  /** Every session in the group, nested children included. */
  readonly total: number;
}

export function nestSessionThreads(
  groups: readonly SessionGroup[],
  options: { readonly crossGroups: boolean },
): SessionTreeGroup[] {
  const groupOf = new Map<string, string>();
  const byId = new Map<string, Session>();
  for (const group of groups) {
    for (const session of group.items) {
      groupOf.set(session.id, group.key);
      byId.set(session.id, session);
    }
  }

  // The visible root a session descends from: walk the parent chain through
  // loaded rows only, stopping at a gap or a (malformed) cycle.
  const rootOf = (session: Session): string => {
    const seen = new Set<string>([session.id]);
    let current = session;
    for (;;) {
      const relation = sessionRelationOf(current);
      const parent = relation === undefined ? undefined : byId.get(relation.parentId);
      if (parent === undefined || seen.has(parent.id)) return current.id;
      seen.add(parent.id);
      current = parent;
    }
  };
  // '' marks a top-level row; otherwise the id of the row it nests under.
  const hostOf = new Map<string, string>();
  for (const session of byId.values()) {
    const root = rootOf(session);
    const sameGroup = groupOf.get(root) === groupOf.get(session.id);
    const allowed = sameGroup || (options.crossGroups && !isPinnedSession(session));
    hostOf.set(session.id, root !== session.id && allowed ? root : '');
  }
  // A host must itself be top-level; anything else (only reachable through a
  // cycle) falls back to its own row so nothing ever disappears.
  for (const [id, host] of hostOf) {
    if (host !== '' && hostOf.get(host) !== '') hostOf.set(id, '');
  }

  const childrenOf = new Map<string, SessionTreeNode[]>();
  for (const group of groups) {
    for (const session of group.items) {
      const host = hostOf.get(session.id);
      if (host === undefined || host === '') continue;
      const list = childrenOf.get(host) ?? [];
      list.push({ session, relation: sessionRelationOf(session), children: [] });
      childrenOf.set(host, list);
    }
  }

  const result: SessionTreeGroup[] = [];
  for (const group of groups) {
    const nodes: SessionTreeNode[] = [];
    let total = 0;
    for (const session of group.items) {
      const host = hostOf.get(session.id);
      if (host !== undefined && host !== '') continue;
      const children = childrenOf.get(session.id) ?? [];
      total += 1 + children.length;
      nodes.push({ session, relation: sessionRelationOf(session), children });
    }
    if (nodes.length > 0) result.push({ key: group.key, label: group.label, nodes, total });
  }
  return result;
}
