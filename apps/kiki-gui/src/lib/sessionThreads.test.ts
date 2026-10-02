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

  it('reads a forked child, and only when the child kind says so', () => {
    expect(sessionRelationOf(session('b', { parent_session_id: 'a', child_session_kind: 'child' })))
      .toEqual({ kind: 'branch', parentId: 'a' });
    expect(sessionRelationOf(session('b', { parent_session_id: 'a' }))).toBeUndefined();
    expect(sessionRelationOf(session('b', { parent_session_id: 'a', child_session_kind: 'thread' }))).toBeUndefined();
  });

  it('ignores missing, empty, and self-referential parents', () => {
    expect(sessionRelationOf(session('b'))).toBeUndefined();
    expect(sessionRelationOf(session('b', { created_by_session_id: '' }))).toBeUndefined();
    expect(sessionRelationOf(session('b', { created_by_session_id: 'b' }))).toBeUndefined();
  });
});

describe('nestSessionThreads', () => {
  it('sorts parents by their own activity when a child becomes newest', () => {
    const root = { ...session('root'), updated_at: '2026-09-27T00:00:00Z' };
    const other = { ...session('other'), updated_at: '2026-09-28T12:00:00Z' };
    const child = session('child', { created_by_session_id: 'root' });
    for (const order of ['updated-desc', 'updated-asc'] as const) {
      for (const stamp of ['2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z']) {
        const items = mergeConversationItems([root, other, { ...child, updated_at: stamp, busy: true, last_seq: 10 }], [], {}, order);
        const tree = nestConversationItems([{ key: 'all', label: 'all', items }], { crossGroups: true });
        expect(tree[0]?.nodes.map((node) => node.item.id)).toEqual(order === 'updated-desc' ? ['other', 'root'] : ['root', 'other']);
        expect(tree[0]?.nodes.find((node) => node.item.id === 'root')?.children.map((node) => node.item.id)).toEqual(['child']);
        expect(root.updated_at).toBe('2026-09-27T00:00:00Z');
      }
    }
  });
  it('nests a thread under its creator and counts it in the group total', () => {
    const groups = [group('today', [
      session('root'),
      session('thread', { created_by_session_id: 'root' }),
    ])];
    const nested = nestSessionThreads(groups, { crossGroups: true });
    expect(shape(nested)).toEqual([{ key: 'today', rows: ['root', '>thread'] }]);
    expect(nested[0]?.total).toBe(2);
    expect(nested[0]?.nodes[0]?.children[0]?.relation).toEqual({ kind: 'thread', parentId: 'root' });
  });

  it('flattens a thread of a thread onto the visible root, never indenting twice', () => {
    const groups = [group('today', [
      session('root'),
      session('mid', { created_by_session_id: 'root' }),
      session('leaf', { created_by_session_id: 'mid' }),
    ])];
    expect(shape(nestSessionThreads(groups, { crossGroups: true })))
      .toEqual([{ key: 'today', rows: ['root', '>mid', '>leaf'] }]);
  });

  it('promotes a display root and its descendants without changing their relations', () => {
    const mid = session('mid', { created_by_session_id: 'root' });
    const groups = [group('today', [session('root'), mid, session('leaf', { created_by_session_id: 'mid' })])];
    const promoted = nestSessionThreads(groups, { crossGroups: true, topLevelIds: new Set(['mid']) });
    expect(shape(promoted)).toEqual([{ key: 'today', rows: ['root', 'mid', '>leaf'] }]);
    expect(promoted[0]?.nodes[1]?.relation?.parentId).toBe('root');
    expect(mid.metadata['created_by_session_id']).toBe('root');
    expect(shape(nestSessionThreads(groups, { crossGroups: true, topLevelIds: new Set() })))
      .toEqual([{ key: 'today', rows: ['root', '>mid', '>leaf'] }]);
  });

  it('keeps promoted threads in their own time bucket even while the parent is loaded', () => {
    const groups = [group('today', [session('thread', { created_by_session_id: 'root' })]), group('week', [session('root')])];
    expect(shape(nestSessionThreads(groups, { crossGroups: true, topLevelIds: new Set(['thread']) })))
      .toEqual([{ key: 'today', rows: ['thread'] }, { key: 'week', rows: ['root'] }]);
  });

  it('follows the creator across time buckets but stays inside workspace buckets', () => {
    const groups = [
      group('today', [session('root')]),
      group('week', [session('thread', { created_by_session_id: 'root' })]),
    ];
    expect(shape(nestSessionThreads(groups, { crossGroups: true })))
      .toEqual([{ key: 'today', rows: ['root', '>thread'] }]);
    expect(shape(nestSessionThreads(groups, { crossGroups: false })))
      .toEqual([{ key: 'today', rows: ['root'] }, { key: 'week', rows: ['thread'] }]);
  });

  it('keeps a pinned thread in the pinned bucket', () => {
    const groups = [
      group('pinned', [session('thread', { created_by_session_id: 'root', 'kiki.pinned': true })]),
      group('today', [session('root')]),
    ];
    expect(shape(nestSessionThreads(groups, { crossGroups: true })))
      .toEqual([{ key: 'pinned', rows: ['thread'] }, { key: 'today', rows: ['root'] }]);
  });

  it('leaves an orphan top-level but keeps its relation so the row can say where it came from', () => {
    const groups = [group('today', [session('orphan', { created_by_session_id: 'not_loaded' })])];
    const nested = nestSessionThreads(groups, { crossGroups: true });
    expect(shape(nested)).toEqual([{ key: 'today', rows: ['orphan'] }]);
    expect(nested[0]?.nodes[0]?.relation).toEqual({ kind: 'thread', parentId: 'not_loaded' });
  });

  it('drops no row when the metadata forms a cycle', () => {
    const groups = [group('today', [
      session('a', { created_by_session_id: 'b' }),
      session('b', { created_by_session_id: 'a' }),
    ])];
    const nested = nestSessionThreads(groups, { crossGroups: true });
    // Which one hosts the other is arbitrary for a cycle; both stay visible,
    // nothing indents twice, and the group still counts two sessions.
    const rows = shape(nested)[0]?.rows ?? [];
    expect([...rows].map((row) => row.replace('>', '')).sort()).toEqual(['a', 'b']);
    expect(rows.filter((row) => row.startsWith('>'))).toHaveLength(1);
    expect(nested[0]?.total).toBe(2);
  });
});
