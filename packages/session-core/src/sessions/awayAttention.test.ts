import { describe, expect, it } from 'vitest';

import type { Session } from '@kiki/protocol';

import {
  ATTENTION_COOLDOWN_MS,
  CompletionObserver,
  EMPTY_ATTENTION_RATE,
  detectAttentionEvents,
  planAttentionNotifications,
  type AttentionBaseline,
  type AttentionEvent,
  type AwayNotificationPrefs,
} from './awayAttention';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function session(patch: Partial<Session> & { id: string }): Session {
  return {
    workspace_id: 'ws-1',
    title: patch.id,
    created_at: '2025-12-31T00:00:00.000Z',
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

function baselineOf(sessions: readonly Session[]): AttentionBaseline {
  return detectAttentionEvents(new Map(), sessions, START).baseline;
}

const ALL_ON: AwayNotificationPrefs = {
  enabled: true,
  kinds: { completed: true, failed: true, question: true, approval: true },
};

describe('detectAttentionEvents', () => {
  it('reports a turn that finished or failed after being seen busy', () => {
    const base = baselineOf([session({ id: 'a', busy: true }), session({ id: 'b', busy: true })]);
    const { events } = detectAttentionEvents(base, [
      session({ id: 'a', last_turn_reason: 'completed' }),
      session({ id: 'b', last_turn_reason: 'failed' }),
    ], START);
    expect(events).toEqual([
      { sessionId: 'a', kind: 'completed', title: 'a' },
      { sessionId: 'b', kind: 'failed', title: 'b' },
    ]);
  });

  it('catches a turn shorter than the poll interval by its new messages', () => {
    const base = baselineOf([session({ id: 'a', message_count: 2, last_turn_reason: 'completed' })]);
    const { events } = detectAttentionEvents(base, [
      session({ id: 'a', message_count: 4, last_turn_reason: 'completed' }),
    ], START);
    expect(events.map((event) => event.kind)).toEqual(['completed']);
  });

  it('stays quiet for metadata writes, stops, and sessions already idle', () => {
    const base = baselineOf([session({ id: 'idle', last_turn_reason: 'completed' }), session({ id: 'stop', busy: true })]);
    const { events } = detectAttentionEvents(base, [
      session({ id: 'idle', title: 'renamed', last_turn_reason: 'completed' }),
      session({ id: 'stop', last_turn_reason: 'cancelled' }),
    ], START);
    expect(events).toEqual([]);
  });

  it('reports a new approval or question once, and a switch between them', () => {
    const base = baselineOf([session({ id: 'a', busy: true })]);
    const first = detectAttentionEvents(base, [session({ id: 'a', busy: true, pending_interaction: 'question' })], START);
    expect(first.events.map((event) => event.kind)).toEqual(['question']);
    const again = detectAttentionEvents(first.baseline, [session({ id: 'a', busy: true, pending_interaction: 'question' })], START);
    expect(again.events).toEqual([]);
    const switched = detectAttentionEvents(again.baseline, [session({ id: 'a', busy: true, pending_interaction: 'approval' })], START);
    expect(switched.events.map((event) => event.kind)).toEqual(['approval']);
  });

  it('treats an old session that scrolls into the list as baseline, a newly created one as news', () => {
    const { events } = detectAttentionEvents(new Map(), [
      session({ id: 'old', last_turn_reason: 'failed' }),
      session({ id: 'cron', created_at: '2026-01-01T00:05:00.000Z', last_turn_reason: 'completed' }),
      session({ id: 'cron-ask', created_at: '2026-01-01T00:06:00.000Z', busy: true, pending_interaction: 'approval' }),
    ], START);
    expect(events.map((event) => `${event.sessionId}:${event.kind}`)).toEqual(['cron:completed', 'cron-ask:approval']);
  });

  it('keeps sessions absent from a narrower list in the baseline, and skips archived ones', () => {
    const base = baselineOf([session({ id: 'a', busy: true }), session({ id: 'b', busy: true })]);
    const narrow = detectAttentionEvents(base, [session({ id: 'a', busy: true })], START);
    expect(narrow.baseline.get('b')?.busy).toBe(true);
    const archived = detectAttentionEvents(narrow.baseline, [session({ id: 'b', archived: true, last_turn_reason: 'completed' })], START);
    expect(archived.events).toEqual([]);
  });
});

describe('CompletionObserver', () => {
  it('baselines first startup and preserves episode cursors across disconnects and reopening', () => {
    const observer = new CompletionObserver();
    const rows = [session({ id: 'a' })];
    const completion = (episode_id: string) => [{ session_id: 'a', episode_id, completed_at: START }];
    expect(observer.observe(completion('old'), rows)).toEqual([]);
    expect(observer.observe(completion('new'), rows)).toEqual([{ sessionId: 'a', kind: 'completed', title: 'a', episodeId: 'new' }]);
    expect(observer.observe([], rows)).toEqual([]);
    expect(observer.observe(completion('new'), rows)).toEqual([]);
    expect(observer.observe(completion('offline'), rows)).toHaveLength(1);
    const reopened = new CompletionObserver(observer.checkpoint());
    expect(reopened.observe(completion('offline'), rows)).toEqual([]);
    expect(reopened.observe(completion('later'), rows)).toHaveLength(1);
  });
});

describe('planAttentionNotifications', () => {
  const event = (sessionId: string, kind: AttentionEvent['kind']): AttentionEvent => ({ sessionId, kind, title: sessionId });

  it('delivers nothing with the master switch off, and drops kinds switched off', () => {
    expect(planAttentionNotifications([event('a', 'completed')], { ...ALL_ON, enabled: false }, EMPTY_ATTENTION_RATE, START).notification).toBeUndefined();
    const prefs = { enabled: true, kinds: { ...ALL_ON.kinds, completed: false } };
    expect(planAttentionNotifications([event('a', 'completed')], prefs, EMPTY_ATTENTION_RATE, START).notification).toBeUndefined();
    expect(planAttentionNotifications([event('a', 'failed')], prefs, EMPTY_ATTENTION_RATE, START).notification)
      .toEqual({ type: 'single', event: event('a', 'failed') });
  });

  it('rate-limits one session inside the cooldown unless the news is more urgent', () => {
    const first = planAttentionNotifications([event('a', 'completed')], ALL_ON, EMPTY_ATTENTION_RATE, START);
    expect(first.notification?.type).toBe('single');
    const repeat = planAttentionNotifications([event('a', 'completed')], ALL_ON, first.state, START + 10_000);
    expect(repeat.notification).toBeUndefined();
    const urgent = planAttentionNotifications([event('a', 'question')], ALL_ON, repeat.state, START + 20_000);
    expect(urgent.notification).toEqual({ type: 'single', event: event('a', 'question') });
    const later = planAttentionNotifications([event('a', 'completed')], ALL_ON, first.state, START + ATTENTION_COOLDOWN_MS);
    expect(later.notification?.type).toBe('single');
  });

  it('deduplicates the same completed episode without suppressing a different short episode', () => {
    const first = { ...event('a', 'completed'), episodeId: 'episode-one' };
    const delivered = planAttentionNotifications([first], ALL_ON, EMPTY_ATTENTION_RATE, START);
    expect(planAttentionNotifications([first], ALL_ON, delivered.state, START + 1).notification).toBeUndefined();
    expect(planAttentionNotifications([{ ...first, episodeId: 'episode-two' }], ALL_ON, delivered.state, START + 2).notification?.type).toBe('single');
  });

  it('keeps the most urgent event per session and merges several sessions into one', () => {
    const { notification } = planAttentionNotifications(
      [event('a', 'completed'), event('a', 'approval'), event('b', 'failed'), event('c', 'completed')],
      ALL_ON,
      EMPTY_ATTENTION_RATE,
      START,
    );
    expect(notification).toMatchObject({ type: 'merged', needsYou: 1, finished: 2 });
    if (notification?.type !== 'merged') throw new Error('expected merged');
    expect(notification.events.map((item) => `${item.sessionId}:${item.kind}`)).toEqual(['a:approval', 'b:failed', 'c:completed']);
  });
});
