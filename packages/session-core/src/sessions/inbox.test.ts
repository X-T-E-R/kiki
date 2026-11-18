import { describe, expect, it } from 'vitest';

import type { Session } from '@kiki/protocol';

import {
  buildInboxModel,
  filterInboxModel,
  nextCursorAfterDismiss,
  sessionRowState,
  stepInboxCursor,
} from './inbox';

function session(patch: Partial<Session> & { id: string }): Session {
  return {
    workspace_id: 'ws-1',
    title: patch.id,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd: '/w' },
    agent_config: { model: 'example-model' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 2,
    last_seq: 10,
    ...patch,
  } as Session;
}

describe('inbox model', () => {
  it('puts blocked sessions first, oldest wait first, and routes active background runs to running without inflating total', () => {
    const model = buildInboxModel(
      [
        session({ id: 'q-new', pending_interaction: 'question', updated_at: '2026-01-01T03:00:00.000Z' }),
        session({ id: 'a-old', pending_interaction: 'approval', updated_at: '2026-01-01T01:00:00.000Z', busy: true }),
        session({ id: 'busy-1', busy: true, executing: true, updated_at: '2026-01-01T04:00:00.000Z' }),
        session({ id: 'busy-2', busy: true, updated_at: '2026-01-01T06:00:00.000Z' }),
        session({ id: 'stale-busy', busy: true, executing: false, updated_at: '2026-01-01T05:00:00.000Z' }),
      ],
      {},
    );
    expect(model.needsYou.map((item) => item.sessionId)).toEqual(['a-old', 'q-new']);
    expect(model.needsYou[0]?.reason).toBe('approval');
    expect(model.needsYou[0]?.busy).toBe(true);
    expect(model.unread).toEqual([]);
    expect(model.running.map((item) => item.sessionId)).toEqual(['busy-2', 'busy-1']);
    expect(model.running[0]?.reason).toBe('running');
    expect(model.total).toBe(2);
  });

  it('lists finished-but-unseen sessions newest first and drops the ones already opened', () => {
    const sessions = [
      session({ id: 'done-old', last_seq: 5, updated_at: '2026-01-01T01:00:00.000Z', last_turn_reason: 'completed' }),
      session({ id: 'done-new', last_seq: 9, updated_at: '2026-01-01T05:00:00.000Z', last_turn_reason: 'failed' }),
      session({ id: 'seen', last_seq: 7, updated_at: '2026-01-01T02:00:00.000Z', last_turn_reason: 'completed' }),
      session({ id: 'empty', last_seq: 0, updated_at: '2026-01-01T06:00:00.000Z' }),
      session({ id: 'archived', archived: true, last_seq: 4, updated_at: '2026-01-01T07:00:00.000Z' }),
      session({ id: 'priv-unread', private: true, last_seq: 8, updated_at: '2026-01-01T08:00:00.000Z', pending_interaction: 'question' }),
    ];
    const model = buildInboxModel(sessions, { seen: 7 });
    expect(model.unread.map((item) => item.sessionId)).toEqual(['done-new', 'done-old']);
    expect(model.unread[0]?.reason).toBe('failed');
    expect(model.total).toBe(2);
  });

  it('projects persona attribution, model, and turn count from session config and legacy metadata', () => {
    const model = buildInboxModel(
      [
        session({
          id: 'bound-persona',
          pending_interaction: 'approval',
          agent_config: {
            model: 'provider/example-pro',
            persona: { id: 'p-writer', name: 'Editorial Desk' },
          },
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            total_cost_usd: 0,
            context_tokens: 30,
            context_limit: 1000,
            turn_count: 4,
          },
        }),
        session({
          id: 'legacy-persona',
          last_turn_reason: 'completed',
          metadata: { cwd: '/w', bot_persona_id: 'p-legacy' },
        }),
      ],
      {},
    );
    expect(model.needsYou[0]).toMatchObject({
      personaId: 'p-writer',
      personaName: 'Editorial Desk',
      model: 'provider/example-pro',
      turnCount: 4,
    });
    expect(model.unread[0]).toMatchObject({
      personaId: 'p-legacy',
      personaName: undefined,
    });
  });

  it('filters by workspace and slice while preserving cursor stepping and post-dismiss selection', () => {
    const model = buildInboxModel(
      [
        session({ id: 'blocked-1', workspace_id: 'ws-1', pending_interaction: 'approval' }),
        session({ id: 'done-1', workspace_id: 'ws-1', last_turn_reason: 'completed', updated_at: '2026-01-01T04:00:00.000Z' }),
        session({ id: 'done-2', workspace_id: 'ws-2', last_turn_reason: 'failed', updated_at: '2026-01-01T05:00:00.000Z' }),
        session({ id: 'run-1', workspace_id: 'ws-1', busy: true, executing: true }),
      ],
      {},
    );

    const ws1All = filterInboxModel(model, { workspaceId: 'ws-1', filter: 'all' });
    expect(ws1All.visibleItems.map((item) => item.sessionId)).toEqual(['blocked-1', 'done-1', 'run-1']);
    expect(ws1All.total).toBe(2);

    const runningOnly = filterInboxModel(model, { filter: 'running' });
    expect(runningOnly.visibleItems.map((item) => item.sessionId)).toEqual(['run-1']);

    expect(stepInboxCursor(ws1All.visibleItems, undefined, 1)).toBe('blocked-1');
    expect(stepInboxCursor(ws1All.visibleItems, 'blocked-1', 1)).toBe('done-1');
    expect(stepInboxCursor(ws1All.visibleItems, 'run-1', 1)).toBe('run-1');
    expect(stepInboxCursor(ws1All.visibleItems, 'done-1', -1)).toBe('blocked-1');

    expect(nextCursorAfterDismiss(ws1All.visibleItems, 'done-1')).toBe('run-1');
    expect(nextCursorAfterDismiss(ws1All.visibleItems, 'run-1')).toBe('done-1');
  });

  it('marks a session unread again once new events arrive past the seen mark', () => {
    const later = session({ id: 's', last_seq: 12, last_turn_reason: 'completed' });
    expect(buildInboxModel([later], { s: 12 }).total).toBe(0);
    expect(buildInboxModel([later], { s: 11 }).total).toBe(1);
  });

  it('shows unconfirmed process cleanup before execution and unread, after blocking interaction', () => {
    const cleanup = session({ id: 'cleanup', busy: true, executing: false, cleanup_pending: true });
    expect(sessionRowState(cleanup, {})).toBe('cleanup-pending');
    expect(sessionRowState({ ...cleanup, executing: true }, { cleanup: 10 })).toBe('cleanup-pending');
    expect(sessionRowState({ ...cleanup, pending_interaction: 'approval' }, {})).toBe('needs-me');
    expect(sessionRowState({ ...cleanup, cleanup_pending: undefined, busy: false }, {})).toBe('unread');
  });

  it('ranks row state: blocked over running over unread over read', () => {
    expect(sessionRowState(session({ id: 'a', pending_interaction: 'approval', busy: true }), {})).toBe('needs-me');
    expect(sessionRowState(session({ id: 'b', busy: true, executing: true }), {})).toBe('running');
    expect(sessionRowState(session({ id: 'stale', busy: true, executing: false }), {})).toBe('unread');
    expect(sessionRowState(session({ id: 'c' }), {})).toBe('unread');
    expect(sessionRowState(session({ id: 'd' }), { d: 10 })).toBe('read');
    expect(sessionRowState(session({ id: 'e', last_seq: 0 }), {})).toBe('read');
  });
});
