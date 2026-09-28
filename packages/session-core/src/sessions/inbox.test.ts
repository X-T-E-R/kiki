import { describe, expect, it } from 'vitest';

import type { Session } from '@kiki/protocol';

import { buildInboxModel, sessionRowState } from './inbox';

function session(patch: Partial<Session> & { id: string }): Session {
  return {
    workspace_id: 'ws-1',
    title: patch.id,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd: '/w' },
    agent_config: {},
    usage: {},
    permission_rules: [],
    message_count: 2,
    last_seq: 10,
    ...patch,
  } as Session;
}

describe('inbox model', () => {
  it('puts blocked sessions first, oldest wait first, and never double-lists a busy one', () => {
    const model = buildInboxModel(
      [
        session({ id: 'q-new', pending_interaction: 'question', updated_at: '2026-01-01T03:00:00.000Z' }),
        session({ id: 'a-old', pending_interaction: 'approval', updated_at: '2026-01-01T01:00:00.000Z', busy: true }),
        session({ id: 'busy', busy: true, updated_at: '2026-01-01T04:00:00.000Z' }),
      ],
      {},
    );
    // Longest-waiting first: that run has been stuck the longest.
    expect(model.needsYou.map((item) => item.sessionId)).toEqual(['a-old', 'q-new']);
    expect(model.needsYou[0]?.reason).toBe('approval');
    expect(model.needsYou[0]?.busy).toBe(true);
    // Work in flight is not an item to act on, and a blocked session appears once.
    expect(model.unread).toEqual([]);
    expect(model.total).toBe(2);
  });

  it('lists finished-but-unseen sessions newest first and drops the ones already opened', () => {
    const sessions = [
      session({ id: 'done-old', last_seq: 5, updated_at: '2026-01-01T01:00:00.000Z', last_turn_reason: 'completed' }),
      session({ id: 'done-new', last_seq: 9, updated_at: '2026-01-01T05:00:00.000Z', last_turn_reason: 'failed' }),
      session({ id: 'seen', last_seq: 7, updated_at: '2026-01-01T02:00:00.000Z', last_turn_reason: 'completed' }),
      session({ id: 'empty', last_seq: 0, updated_at: '2026-01-01T06:00:00.000Z' }),
      session({ id: 'archived', archived: true, last_seq: 4, updated_at: '2026-01-01T07:00:00.000Z' }),
    ];
    const model = buildInboxModel(sessions, { seen: 7 });
    expect(model.unread.map((item) => item.sessionId)).toEqual(['done-new', 'done-old']);
    expect(model.unread[0]?.reason).toBe('failed');
    // A fresh session with no events, and archived work, stay out of the inbox.
    expect(model.total).toBe(2);
  });

  it('marks a session unread again once new events arrive past the seen mark', () => {
    const later = session({ id: 's', last_seq: 12, last_turn_reason: 'completed' });
    expect(buildInboxModel([later], { s: 12 }).total).toBe(0);
    expect(buildInboxModel([later], { s: 11 }).total).toBe(1);
  });

  it('ranks row state: blocked over running over unread over read', () => {
    expect(sessionRowState(session({ id: 'a', pending_interaction: 'approval', busy: true }), {})).toBe('needs-me');
    expect(sessionRowState(session({ id: 'b', busy: true }), {})).toBe('running');
    expect(sessionRowState(session({ id: 'c' }), {})).toBe('unread');
    expect(sessionRowState(session({ id: 'd' }), { d: 10 })).toBe('read');
    // An empty session is not "unread" — there is nothing to catch up on.
    expect(sessionRowState(session({ id: 'e', last_seq: 0 }), {})).toBe('read');
  });
});
