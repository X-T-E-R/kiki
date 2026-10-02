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

import { isPinnedSession, type ConversationListItem, type SessionGroup } from '@kiki/session-core/sessions';

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

interface TreeNode<T> {
  readonly item: T;
  readonly relation?: SessionRelation;
  readonly children: readonly TreeNode<T>[];
}

interface TreeGroup<T> {
  readonly key: string;
  readonly label: string;
  readonly nodes: readonly TreeNode<T>[];
  readonly total: number;
}

/**
 * The nesting walk over a generic row item. `sessionOf` returns the session
 * an item nests by, or undefined for rows that can never nest or host (a
 * room: it has no creator metadata and no session ever names it as parent).
 */
function nestItems<T>(
  groups: readonly SessionGroup<T>[],
  sessionOf: (item: T) => Session | undefined,
  options: { readonly crossGroups: boolean; readonly topLevelIds?: ReadonlySet<string> },
): TreeGroup<T>[] {
  const groupOf = new Map<string, string>();
  const byId = new Map<string, { item: T; session: Session }>();
  for (const group of groups) {
    for (const item of group.items) {
      const session = sessionOf(item);
      if (session === undefined) continue;
      groupOf.set(session.id, group.key);
      byId.set(session.id, { item, session });
    }
  }

  // The visible root a session descends from: walk the parent chain through
  // loaded rows only, stopping at a gap or a (malformed) cycle.
  const rootOf = (session: Session): string => {
    const seen = new Set<string>([session.id]);
    let current = session;
    for (;;) {
      if (options.topLevelIds?.has(current.id)) return current.id;
      const relation = sessionRelationOf(current);
      const parent = relation === undefined ? undefined : byId.get(relation.parentId);
      if (parent === undefined || seen.has(parent.session.id)) return current.id;
      seen.add(parent.session.id);
      current = parent.session;
    }
  };
  // '' marks a top-level row; otherwise the id of the row it nests under.
  const hostOf = new Map<string, string>();
  for (const { session } of byId.values()) {
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

  const childrenOf = new Map<string, TreeNode<T>[]>();
  for (const { item, session } of byId.values()) {
    const host = hostOf.get(session.id);
    if (host === undefined || host === '') continue;
    const list = childrenOf.get(host) ?? [];
    list.push({ item, relation: sessionRelationOf(session), children: [] });
    childrenOf.set(host, list);
  }

  const result: TreeGroup<T>[] = [];
  for (const group of groups) {
    const nodes: TreeNode<T>[] = [];
    let total = 0;
    for (const item of group.items) {
      const session = sessionOf(item);
      const host = session === undefined ? '' : hostOf.get(session.id);
      if (host !== undefined && host !== '') continue;
      const children = session === undefined ? [] : childrenOf.get(session.id) ?? [];
      total += 1 + children.length;
      nodes.push({ item, relation: session === undefined ? undefined : sessionRelationOf(session), children });
    }
    if (nodes.length > 0) result.push({ key: group.key, label: group.label, nodes, total });
  }
  return result;
}

function toSessionNode(node: TreeNode<Session>): SessionTreeNode {
  return {
    session: node.item,
    ...(node.relation !== undefined ? { relation: node.relation } : {}),
    children: node.children.map(toSessionNode),
  };
}

export function nestSessionThreads(
  groups: readonly SessionGroup[],
  options: { readonly crossGroups: boolean; readonly topLevelIds?: ReadonlySet<string> },
): SessionTreeGroup[] {
  return nestItems<Session>(groups, (session) => session, options).map((group) => ({
    key: group.key,
    label: group.label,
    nodes: group.nodes.map(toSessionNode),
    total: group.total,
  }));
}

export interface ConversationTreeNode {
  readonly item: ConversationListItem;
  /** Present when the row came from another session (nested or not). */
  readonly relation?: SessionRelation;
  /** Nested children, in the view's sort order. Empty for leaves and rooms. */
  readonly children: readonly ConversationTreeNode[];
}

export interface ConversationTreeGroup {
  readonly key: string;
  readonly label: string;
  /** Top-level rows; the row count the "Show N more" preview limit counts. */
  readonly nodes: readonly ConversationTreeNode[];
  /** Every conversation in the group, nested children included. */
  readonly total: number;
}

function toConversationNode(node: TreeNode<ConversationListItem>): ConversationTreeNode {
  return {
    item: node.item,
    ...(node.relation !== undefined ? { relation: node.relation } : {}),
    children: node.children.map(toConversationNode),
  };
}

/**
 * Rooms ride along as always-top-level rows; only thread items nest. A room
 * can never be a parent: no session's metadata names a room as its creator.
 */
export function nestConversationItems(
  groups: readonly SessionGroup<ConversationListItem>[],
  options: { readonly crossGroups: boolean; readonly topLevelIds?: ReadonlySet<string> },
): ConversationTreeGroup[] {
  return nestItems<ConversationListItem>(groups, (item) => item.kind === 'session' ? item.session : undefined, options).map((group) => ({
    key: group.key,
    label: group.label,
    nodes: group.nodes.map(toConversationNode),
    total: group.total,
  }));
}
