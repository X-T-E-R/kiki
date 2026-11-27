import { describe, expect, it } from 'vitest';

import type { RoomListItem, Session } from '@kiki/protocol';

import { encodeConversationRef, type ConversationRef } from '../settings/sessionReadState';
import type { ConversationTriageMap } from '../settings/sessionTriage';
import { buildUnifiedConversationEntries } from './conversationList';
import {
  buildInboxModel,
  buildUnifiedInbox,
  filterInboxModel,
  hasSemanticAttentionCursor,
  isConversationUnread,
  isSessionUnread,
  nextCursorAfterDismiss,
  sessionAttentionCursor,
  sessionRowState,
  stepInboxCursor,
  type UnifiedInboxEntry,
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

  it('uses semantic attention_cursor to stay immune to non-attention last_seq bumps', () => {
    const metadataOnly = session({ id: 'meta', last_seq: 12, attention_cursor: { epoch: 'ep-1', seq: 0 } });
    expect(hasSemanticAttentionCursor(metadataOnly)).toBe(true);
    expect(sessionAttentionCursor(metadataOnly)).toEqual({ epoch: 'ep-1', seq: 0 });
    expect(isSessionUnread(metadataOnly, {})).toBe(false);
    expect(isConversationUnread(sessionAttentionCursor(metadataOnly), undefined, true)).toBe(false);

    const renamedAfterRead = session({ id: 'renamed', last_seq: 20, attention_cursor: { epoch: 'ep-1', seq: 5 } });
    expect(isSessionUnread(renamedAfterRead, { renamed: 5 })).toBe(false);
    expect(isConversationUnread({ epoch: 'ep-1', seq: 5 }, { epoch: 'ep-1', seq: 5, updatedAt: 10 }, true)).toBe(false);
    expect(isConversationUnread({ epoch: 'ep-2', seq: 1 }, { epoch: 'ep-1', seq: 5, updatedAt: 10 }, true)).toBe(true);

    const legacy = session({ id: 'legacy', last_seq: 7 });
    expect(hasSemanticAttentionCursor(legacy)).toBe(false);
    expect(sessionAttentionCursor(legacy)).toEqual({ seq: 7 });
    expect(isSessionUnread(legacy, { legacy: 7 })).toBe(false);
    expect(isSessionUnread(legacy, { legacy: 6 })).toBe(true);
  });
});

function roomItem(patch: Partial<RoomListItem> & { id: string }): RoomListItem {
  return {
    kind: 'room',
    title: patch.id,
    workspace: 'ws-room',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastSeq: 4,
    memberCount: 2,
    busy: false,
    needsYou: false,
    pendingInteraction: 'none',
    failed: false,
    pinned: false,
    archived: false,
    ...patch,
  };
}

describe('buildUnifiedInbox', () => {
  const keyOf = (ref: ConversationRef) => encodeConversationRef(ref);

  it('orders active tiers (needsYou oldest-first, failed/cancelled newest-first, completed/woken newest-first) across local and remote spaces', () => {
    const entries = buildUnifiedConversationEntries([
      {
        spaceKey: 'main',
        spaceName: 'Main',
        isRemote: false,
        workspaces: [{ id: 'ws-1', name: 'Core', root: '/core' }],
        sessions: [
          session({ id: 'q-newer', pending_interaction: 'question', updated_at: '2026-01-01T03:00:00.000Z', attention_cursor: { epoch: 'e1', seq: 3 } }),
          session({ id: 'a-older', pending_interaction: 'approval', busy: true, updated_at: '2026-01-01T01:00:00.000Z', attention_cursor: { epoch: 'e1', seq: 2 } }),
          session({ id: 'fail-old', last_turn_reason: 'failed', updated_at: '2026-01-01T02:00:00.000Z', attention_cursor: { epoch: 'e1', seq: 4 } }),
          session({ id: 'cancel-new', last_turn_reason: 'cancelled', updated_at: '2026-01-01T05:00:00.000Z', attention_cursor: { epoch: 'e1', seq: 5 } }),
          session({ id: 'done-old', last_turn_reason: 'completed', updated_at: '2026-01-01T04:00:00.000Z', attention_cursor: { epoch: 'e1', seq: 6 } }),
          session({ id: 'done-new', last_turn_reason: 'completed', updated_at: '2026-01-01T06:00:00.000Z', attention_cursor: { epoch: 'e1', seq: 7 } }),
          session({ id: 'running-1', busy: true, executing: true, updated_at: '2026-01-01T07:00:00.000Z', attention_cursor: { epoch: 'e1', seq: 8 } }),
          session({ id: 'meta-only', last_seq: 15, updated_at: '2026-01-01T08:00:00.000Z', attention_cursor: { epoch: 'e1', seq: 0 } }),
          session({ id: 'backend-archived', archived: true, last_seq: 9 }),
          session({ id: 'private-1', private: true, pending_interaction: 'approval', last_seq: 9 }),
        ],
        rooms: [
          roomItem({ id: 'r-budget', workspace: '/core', needsYou: true, updatedAt: '2026-01-01T02:00:00.000Z' }),
        ],
      },
      {
        spaceKey: 'remote:550e8400-e29b-41d4-a716-446655440000',
        spaceName: 'GPU Box',
        isRemote: true,
        workspaces: [{ id: 'ws-r', name: 'Train', root: '/train' }],
        sessions: [
          session({
            id: 'a-older',
            workspace_id: 'ws-r',
            last_turn_reason: 'failed',
            updated_at: '2026-01-01T06:30:00.000Z',
            attention_cursor: { epoch: 're1', seq: 9 },
            last_prompt: '  run   eval  ',
          }),
        ],
      },
    ]);

    const model = buildUnifiedInbox(entries, {}, {}, 10_000);
    expect(model.active.map((item) => [item.spaceName, item.ref.kind, item.ref.id, item.reason])).toEqual([
      ['Main', 'session', 'a-older', 'approval'],
      ['Main', 'room', 'r-budget', 'budget'],
      ['Main', 'session', 'q-newer', 'question'],
      ['GPU Box', 'session', 'a-older', 'failed'],
      ['Main', 'session', 'cancel-new', 'cancelled'],
      ['Main', 'session', 'fail-old', 'failed'],
      ['Main', 'session', 'done-new', 'completed'],
      ['Main', 'session', 'done-old', 'completed'],
    ]);
    expect(model.working.map((item) => item.sessionId)).toEqual(['running-1']);
    expect(model.needsYouCount).toBe(3);
    expect(model.unreadCount).toBe(5);
    expect(model.total).toBe(8);

    const remoteItem = model.active.find((item) => item.isRemote)!;
    expect(remoteItem).toMatchObject({
      spaceKey: 'remote:550e8400-e29b-41d4-a716-446655440000',
      spaceName: 'GPU Box',
      isRemote: true,
      workspaceId: 'ws-r',
      workspaceName: 'Train',
      preview: 'run eval',
      attentionCursor: { epoch: 're1', seq: 9 },
      triageClass: 'active',
      unread: true,
      needsYou: false,
    });
  });

  it('wakes expired snoozes even when already read and sorts active snoozes soonest-first', () => {
    const refWoken: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'woken' };
    const refSoon: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'soon' };
    const refLater: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'later' };
    const refArchived: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'arch' };

    const entries: UnifiedInboxEntry[] = [
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'woken', attention_cursor: { epoch: 'e1', seq: 5 }, last_seq: 12, updated_at: '2026-01-01T01:00:00.000Z' }) },
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'soon', attention_cursor: { epoch: 'e1', seq: 5 }, last_seq: 5, updated_at: '2026-01-01T02:00:00.000Z' }) },
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'later', attention_cursor: { epoch: 'e1', seq: 5 }, last_seq: 5, updated_at: '2026-01-01T03:00:00.000Z' }) },
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'arch', attention_cursor: { epoch: 'e1', seq: 5 }, last_seq: 5, updated_at: '2026-01-01T04:00:00.000Z' }) },
    ];

    const seenMap = {
      [keyOf(refWoken)]: { epoch: 'e1', seq: 5, updatedAt: 100 },
      [keyOf(refSoon)]: { epoch: 'e1', seq: 5, updatedAt: 100 },
      [keyOf(refLater)]: { epoch: 'e1', seq: 5, updatedAt: 100 },
    };
    const triageMap: ConversationTriageMap = {
      [keyOf(refWoken)]: { s: 'snoozed', epoch: 'e1', seq: 5, u: 5000, t: 100 },
      [keyOf(refSoon)]: { s: 'snoozed', epoch: 'e1', seq: 5, u: 6000, t: 100 },
      [keyOf(refLater)]: { s: 'snoozed', epoch: 'e1', seq: 5, u: 9000, t: 100 },
      [keyOf(refArchived)]: { s: 'archived', epoch: 'e1', seq: 5, t: 100 },
    };

    const model = buildUnifiedInbox(entries, seenMap, triageMap, 5000);
    expect(model.active.map((item) => item.sessionId)).toEqual(['woken']);
    expect(model.active[0]?.unread).toBe(false);
    expect(model.active[0]?.snoozedUntil).toBeUndefined();
    expect(model.active[0]?.triageClass).toBe('active');
    expect(model.unreadCount).toBe(1);
    expect(model.total).toBe(1);

    expect(model.snoozed.map((item) => [item.sessionId, item.snoozedUntil])).toEqual([
      ['soon', 6000],
      ['later', 9000],
    ]);
    expect(model.archived.map((item) => item.sessionId)).toEqual(['arch']);
  });

  it('pins the currently viewed clicked row in active until navigated away or triaged, without inflating counts', () => {
    const refViewed: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'viewed' };
    const refOther: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'other-unread' };
    const viewedKey = keyOf(refViewed);

    const entries: UnifiedInboxEntry[] = [
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'viewed', attention_cursor: { epoch: 'e1', seq: 5 }, last_seq: 5, updated_at: '2026-01-01T02:00:00.000Z' }) },
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'other-unread', attention_cursor: { epoch: 'e1', seq: 5 }, last_seq: 5, updated_at: '2026-01-01T01:00:00.000Z' }) },
    ];
    const seenMap = {
      [viewedKey]: { epoch: 'e1', seq: 5, updatedAt: 100 },
    };

    const pinned = buildUnifiedInbox(entries, seenMap, {}, 1000, { pinnedViewingKey: viewedKey });
    expect(pinned.active.map((item) => item.sessionId)).toEqual(['viewed', 'other-unread']);
    expect(pinned.active[0]?.triageClass).toBe('hidden');
    expect(pinned.unreadCount).toBe(1);
    expect(pinned.total).toBe(1);

    // Navigating away drops the read row from active.
    const unpinned = buildUnifiedInbox(entries, seenMap, {}, 1000);
    expect(unpinned.active.map((item) => item.sessionId)).toEqual(['other-unread']);
    expect(unpinned.total).toBe(1);

    // Explicitly archiving while still viewing moves it out of active into archived.
    const triaged = buildUnifiedInbox(
      entries,
      seenMap,
      { [viewedKey]: { s: 'archived', epoch: 'e1', seq: 5, t: 500 } },
      1000,
      { pinnedViewingKey: viewedKey },
    );
    expect(triaged.active.map((item) => item.sessionId)).toEqual(['other-unread']);
    expect(triaged.archived.map((item) => item.sessionId)).toEqual(['viewed']);
  });

  it('keeps the currently entered running, idle, settled, or snoozed conversation in active without inflating badge counts or duplicating drawers', () => {
    const refRunning: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'active-run' };
    const refIdle: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'active-idle' };
    const refSnoozedBlocked: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'active-snoozed' };
    const refArchived: ConversationRef = { spaceKey: 'main', kind: 'session', id: 'active-archived' };
    const runKey = keyOf(refRunning);
    const idleKey = keyOf(refIdle);
    const snoozedKey = keyOf(refSnoozedBlocked);
    const archivedKey = keyOf(refArchived);

    const entries: UnifiedInboxEntry[] = [
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'active-run', busy: true, executing: true, last_seq: 4, updated_at: '2026-01-01T03:00:00.000Z' }) },
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'active-idle', last_seq: 5, attention_cursor: { epoch: 'e1', seq: 5 }, updated_at: '2026-01-01T02:00:00.000Z' }) },
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'active-snoozed', pending_interaction: 'approval', last_seq: 6, attention_cursor: { epoch: 'e1', seq: 6 }, updated_at: '2026-01-01T01:00:00.000Z' }) },
      { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: session({ id: 'active-archived', last_seq: 7, attention_cursor: { epoch: 'e1', seq: 7 }, updated_at: '2026-01-01T00:30:00.000Z' }) },
    ];
    const seenMap = {
      [idleKey]: { epoch: 'e1', seq: 5, updatedAt: 100 },
    };
    const triageMap: ConversationTriageMap = {
      [snoozedKey]: { s: 'snoozed', epoch: 'e1', seq: 6, u: 9000, t: 100 },
      [archivedKey]: { s: 'archived', epoch: 'e1', seq: 7, t: 100 },
    };

    // Entering the running conversation keeps it in active (not duplicated in working) with zero badge count.
    const viewingRunning = buildUnifiedInbox(entries, seenMap, triageMap, 1000, { activeConversationKey: runKey });
    expect(viewingRunning.active.map((item) => item.sessionId)).toEqual(['active-run']);
    expect(viewingRunning.working).toEqual([]);
    expect(viewingRunning.needsYouCount).toBe(0);
    expect(viewingRunning.unreadCount).toBe(0);
    expect(viewingRunning.total).toBe(0);

    // Navigating away to the idle conversation moves the running session cleanly to working and keeps the idle one visible in active.
    const viewingIdle = buildUnifiedInbox(entries, seenMap, triageMap, 1000, { activeConversationKey: idleKey });
    expect(viewingIdle.active.map((item) => item.sessionId)).toEqual(['active-idle']);
    expect(viewingIdle.working.map((item) => item.sessionId)).toEqual(['active-run']);
    expect(viewingIdle.total).toBe(0);

    // Viewing a snoozed needsYou conversation shows it in active without duplicating in snoozed or inflating needsYouCount.
    const viewingSnoozed = buildUnifiedInbox(entries, seenMap, triageMap, 1000, { activeConversationKey: snoozedKey });
    expect(viewingSnoozed.active.map((item) => item.sessionId)).toEqual(['active-snoozed']);
    expect(viewingSnoozed.snoozed).toEqual([]);
    expect(viewingSnoozed.needsYouCount).toBe(0);
    expect(viewingSnoozed.total).toBe(0);

    // Viewing an inbox-archived conversation respects its archived bucket.
    const viewingArchived = buildUnifiedInbox(entries, seenMap, triageMap, 1000, { activeConversationKey: archivedKey });
    expect(viewingArchived.active).toEqual([]);
    expect(viewingArchived.archived.map((item) => item.sessionId)).toEqual(['active-archived']);
  });

  it('surfaces idle restart-interrupted sessions as needsYou interrupted and suppresses while busy', () => {
    const interruptedWork = {
      interrupted_at: '2026-01-01T02:00:00.000Z',
      main_interrupted: true,
      lost_tasks: 2,
    };
    const idleInterrupted = session({
      id: 's-interrupted',
      busy: false,
      interrupted_work: interruptedWork,
      updated_at: '2026-01-01T02:00:00.000Z',
    });
    const busyRecovered = session({
      id: 's-running',
      busy: true,
      executing: true,
      interrupted_work: interruptedWork,
      updated_at: '2026-01-01T03:00:00.000Z',
    });
    const flat = buildInboxModel([idleInterrupted, busyRecovered], {});
    expect(flat.needsYou).toHaveLength(1);
    expect(flat.needsYou[0]).toMatchObject({
      sessionId: 's-interrupted',
      reason: 'interrupted',
      interruptedWork,
    });
    expect(flat.running.map((item) => item.sessionId)).toEqual(['s-running']);

    const unified = buildUnifiedInbox(
      [
        { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: idleInterrupted },
        { kind: 'session', spaceKey: 'main', spaceName: 'Main', isRemote: false, session: busyRecovered },
      ],
      {},
      {},
      Date.parse('2026-01-01T04:00:00.000Z'),
    );
    expect(unified.active).toHaveLength(1);
    expect(unified.active[0]).toMatchObject({
      sessionId: 's-interrupted',
      reason: 'interrupted',
      needsYou: true,
      interruptedWork,
    });
    expect(unified.needsYouCount).toBe(1);
    expect(unified.working.map((item) => item.sessionId)).toEqual(['s-running']);
  });

  it('suppresses routine unread noise for off and urgent sessions across flat, unified, and row-state models', () => {
    const interruptedWork = {
      interrupted_at: '2026-01-01T02:00:00.000Z',
      main_interrupted: true,
    };
    const mutedDone = session({
      id: 'muted-done',
      last_seq: 12,
      last_turn_reason: 'completed',
      metadata: { cwd: '/w', 'kiki.notifications': 'off' },
    });
    const mutedFailed = session({
      id: 'muted-failed',
      last_seq: 12,
      last_turn_reason: 'failed',
      metadata: { cwd: '/w', 'kiki.notifications': 'off' },
    });
    const mutedInterrupted = session({
      id: 'muted-interrupted',
      last_seq: 12,
      interrupted_work: interruptedWork,
      metadata: { cwd: '/w', 'kiki.notifications': 'off' },
    });
    const mutedApproval = session({
      id: 'muted-approval',
      last_seq: 12,
      pending_interaction: 'approval',
      metadata: { cwd: '/w', 'kiki.notifications': 'off' },
    });
    const urgentDone = session({
      id: 'urgent-done',
      last_seq: 12,
      last_turn_reason: 'completed',
      metadata: { cwd: '/w', 'kiki.notifications': 'urgent' },
    });
    const urgentFailed = session({
      id: 'urgent-failed',
      last_seq: 12,
      last_turn_reason: 'failed',
      metadata: { cwd: '/w', 'kiki.notifications': 'urgent' },
    });
    const urgentInterrupted = session({
      id: 'urgent-interrupted',
      last_seq: 12,
      interrupted_work: interruptedWork,
      metadata: { cwd: '/w', 'kiki.notifications': 'urgent' },
    });

    const all = [
      mutedDone,
      mutedFailed,
      mutedInterrupted,
      mutedApproval,
      urgentDone,
      urgentFailed,
      urgentInterrupted,
    ];
    const flat = buildInboxModel(all, {});
    expect(flat.unread.map((item) => item.sessionId)).toEqual(['urgent-failed']);
    expect(flat.needsYou.map((item) => item.sessionId).sort()).toEqual(['muted-approval', 'urgent-interrupted']);
    expect(flat.total).toBe(3);

    const unified = buildUnifiedInbox(
      all.map((item) => ({ kind: 'session' as const, spaceKey: 'main', spaceName: 'Main', isRemote: false, session: item })),
      {},
      {},
      Date.parse('2026-01-01T04:00:00.000Z'),
    );
    expect(unified.active.map((item) => item.sessionId).sort()).toEqual([
      'muted-approval',
      'urgent-failed',
      'urgent-interrupted',
    ]);
    expect(unified.needsYouCount).toBe(2);
    expect(unified.unreadCount).toBe(1);
    expect(unified.total).toBe(3);

    expect(sessionRowState(mutedDone, {})).toBe('read');
    expect(sessionRowState(mutedFailed, {})).toBe('read');
    expect(sessionRowState(mutedApproval, {})).toBe('needs-me');
    expect(sessionRowState(urgentDone, {})).toBe('read');
    expect(sessionRowState(urgentFailed, {})).toBe('unread');
  });
});
