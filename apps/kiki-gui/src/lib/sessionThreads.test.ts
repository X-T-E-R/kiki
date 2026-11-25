import { describe, expect, it } from 'vitest';

import type { Session } from '@kiki/protocol';
import { mergeConversationItems, type SessionGroup } from '@kiki/session-core/sessions';

import { nestConversationItems, nestSessionThreads, sessionRelationOf } from './sessionThreads';

function session(id: string, metadata: Record<string, unknown> = {}): Session {
  return {
    id,
    title: id,
    workspace_id: 'wd_a_0123456789ab',
    created_at: '2026-09-28T00:00:00Z',
    updated_at: '2026-09-28T00:00:00Z',
    metadata,
  } as unknown as Session;
}

function group(key: string, items: Session[]): SessionGroup {
  return { key, label: key, items };
}

/** Flattened ids per group, children marked with a `>` prefix. */
function shape(groups: readonly { key: string; nodes: readonly { session: Session; children: readonly { session: Session }[] }[] }[]) {
  return groups.map((g) => ({
    key: g.key,
    rows: g.nodes.flatMap((node) => [node.session.id, ...node.children.map((child) => `>${child.session.id}`)]),
  }));
}

describe('sessionRelationOf', () => {
  it('reads a ThreadCreate thread with its creating agent', () => {
    expect(sessionRelationOf(session('b', { created_by_session_id: 'a', created_by_agent_id: 'agent-3' })))
      .toEqual({ kind: 'thread', parentId: 'a', agentId: 'agent-3' });
  });

  it('reads a forked child, and only when the child kind or typed forked_from says so', () => {
    expect(sessionRelationOf(session('b', { parent_session_id: 'a', child_session_kind: 'child' })))
      .toEqual({ kind: 'branch', parentId: 'a' });
    expect(sessionRelationOf(session('b', { parent_session_id: 'a' }))).toBeUndefined();
    expect(sessionRelationOf(session('b', { parent_session_id: 'a', child_session_kind: 'thread' }))).toBeUndefined();
    expect(sessionRelationOf({
      ...session('b'),
      forked_from: { session_id: 'a', turn_index: 2, seed: 'verbatim' },
    })).toEqual({ kind: 'fork', parentId: 'a' });
    expect(sessionRelationOf({
      ...session('b'),
      forked_from: { session_id: 'b' },
    })).toBeUndefined();
  });

  it('ignores missing, empty, and self-referential parents', () => {
    expect(sessionRelationOf(session('b'))).toBeUndefined();
    expect(sessionRelationOf(session('b', { created_by_session_id: '' }))).toBeUndefined();
    expect(sessionRelationOf(session('b', { created_by_session_id: 'b' }))).toBeUndefined();
  });
});

describe('nestSessionThreads', () => {
  it('keeps threads and creators as flat top-level rows sorted by their own activity', () => {
    const root = { ...session('root'), updated_at: '2026-09-27T00:00:00Z' };
    const other = { ...session('other'), updated_at: '2026-09-28T12:00:00Z' };
    const child = session('child', { created_by_session_id: 'root' });
    const items = mergeConversationItems([root, other, { ...child, updated_at: '2026-09-29T00:00:00Z', busy: true, last_seq: 10 }], [], {}, 'updated-desc');
    const tree = nestConversationItems([{ key: 'all', label: 'all', items }], { crossGroups: true });
    expect(tree[0]?.nodes.map((node) => node.item.id)).toEqual(['child', 'other', 'root']);
    expect(tree[0]?.nodes.every((node) => node.children.length === 0)).toBe(true);
    expect(tree[0]?.nodes[0]?.relation).toEqual({ kind: 'thread', parentId: 'root' });
    expect(root.updated_at).toBe('2026-09-27T00:00:00Z');
  });

  it('keeps threads, grandchildren, and cycles top-level while preserving provenance relations', () => {
    const groups = [group('today', [
      session('root'),
      session('mid', { created_by_session_id: 'root' }),
      session('leaf', { created_by_session_id: 'mid' }),
    ])];
    const flat = nestSessionThreads(groups, { crossGroups: true });
    expect(shape(flat)).toEqual([{ key: 'today', rows: ['root', 'mid', 'leaf'] }]);
    expect(flat[0]?.total).toBe(3);
    expect(flat[0]?.nodes[1]?.relation).toEqual({ kind: 'thread', parentId: 'root' });
    expect(flat[0]?.nodes[2]?.relation).toEqual({ kind: 'thread', parentId: 'mid' });

    const crossBucket = [
      group('today', [session('root')]),
      group('week', [session('thread', { created_by_session_id: 'root' })]),
    ];
    expect(shape(nestSessionThreads(crossBucket, { crossGroups: true })))
      .toEqual([{ key: 'today', rows: ['root'] }, { key: 'week', rows: ['thread'] }]);

    const cycle = [group('today', [
      session('a', { created_by_session_id: 'b' }),
      session('b', { created_by_session_id: 'a' }),
    ])];
    const nestedCycle = nestSessionThreads(cycle, { crossGroups: true });
    expect(shape(nestedCycle)).toEqual([{ key: 'today', rows: ['a', 'b'] }]);
    expect(nestedCycle[0]?.total).toBe(2);
  });

  it('keeps a pinned thread in the pinned bucket', () => {
    const groups = [
      group('pinned', [session('thread', { created_by_session_id: 'root', 'kiki.pinned': true })]),
      group('today', [session('root')]),
    ];
    expect(shape(nestSessionThreads(groups, { crossGroups: true })))
      .toEqual([{ key: 'pinned', rows: ['thread'] }, { key: 'today', rows: ['root'] }]);
  });

  it('leaves an orphan top-level and keeps its relation so the row can say where it came from', () => {
    const groups = [group('today', [session('orphan', { created_by_session_id: 'not_loaded' })])];
    const nested = nestSessionThreads(groups, { crossGroups: true });
    expect(shape(nested)).toEqual([{ key: 'today', rows: ['orphan'] }]);
    expect(nested[0]?.nodes[0]?.relation).toEqual({ kind: 'thread', parentId: 'not_loaded' });
  });
});
