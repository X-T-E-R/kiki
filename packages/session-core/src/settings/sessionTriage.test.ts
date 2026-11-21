// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeConversationRef, type ConversationRef } from './sessionReadState';
import {
  archiveConversationTriage,
  classifyConversationTriage,
  clearChangedTriageMarks,
  clearConversationTriage,
  computeSnoozeUntilMs,
  conversationTriageSnapshot,
  isAttentionCursorSame,
  nextSnoozeExpiryMs,
  resetConversationTriage,
  settleConversation,
  snoozeConversation,
  subscribeConversationTriage,
  type TriageRecord,
} from './sessionTriage';

afterEach(() => {
  resetConversationTriage();
  localStorage.clear();
});

describe('computeSnoozeUntilMs', () => {
  it('computes fixed elapsed offsets and next local calendar day 09:00 for tomorrow', () => {
    const now = new Date(2026, 10, 30, 22, 15, 30, 500);
    expect(computeSnoozeUntilMs('30m', now)).toBe(now.getTime() + 30 * 60_000);
    expect(computeSnoozeUntilMs('1h', now)).toBe(now.getTime() + 60 * 60_000);
    expect(computeSnoozeUntilMs('3h', now)).toBe(now.getTime() + 3 * 60 * 60_000);

    const tomorrow = new Date(computeSnoozeUntilMs('tomorrow', now));
    expect(tomorrow.getFullYear()).toBe(2026);
    expect(tomorrow.getMonth()).toBe(11);
    expect(tomorrow.getDate()).toBe(1);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getMinutes()).toBe(0);
    expect(tomorrow.getSeconds()).toBe(0);
    expect(tomorrow.getMilliseconds()).toBe(0);
  });
});

describe('isAttentionCursorSame', () => {
  it('matches seq and compares epoch whenever both sides carry one', () => {
    const withEpoch: TriageRecord = { s: 'archived', epoch: 'ep-1', seq: 5, t: 100 };
    const withoutEpoch: TriageRecord = { s: 'archived', seq: 5, t: 100 };

    expect(isAttentionCursorSame({ epoch: 'ep-1', seq: 5 }, withEpoch)).toBe(true);
    expect(isAttentionCursorSame({ epoch: 'ep-1', seq: 6 }, withEpoch)).toBe(false);
    expect(isAttentionCursorSame({ epoch: 'ep-2', seq: 5 }, withEpoch)).toBe(false);
    expect(isAttentionCursorSame({ seq: 5 }, withEpoch)).toBe(true);
    expect(isAttentionCursorSame({ epoch: 'ep-1', seq: 5 }, withoutEpoch)).toBe(true);
    expect(isAttentionCursorSame({ seq: 5 }, withoutEpoch)).toBe(true);
  });
});

describe('classifyConversationTriage', () => {
  const cursor = { epoch: 'ep-1', seq: 10 };
  const nextCursor = { epoch: 'ep-1', seq: 11 };
  const newEpochCursor = { epoch: 'ep-2', seq: 1 };

  it('never hides unresolved needsYou gates with settle or archive, only active same-cursor snooze', () => {
    const settled: TriageRecord = { s: 'settled', epoch: 'ep-1', seq: 10, t: 100 };
    const archived: TriageRecord = { s: 'archived', epoch: 'ep-1', seq: 10, t: 100 };
    const snoozed: TriageRecord = { s: 'snoozed', epoch: 'ep-1', seq: 10, u: 5000, t: 100 };

    expect(classifyConversationTriage({ needsYou: true, busy: true, unread: true, cursor, reason: 'approval' }, settled, 1000)).toBe('active');
    expect(classifyConversationTriage({ needsYou: true, busy: false, unread: false, cursor, reason: 'question' }, archived, 1000)).toBe('active');
    expect(classifyConversationTriage({ needsYou: true, busy: false, unread: false, cursor, reason: 'budget' }, snoozed, 4999)).toBe('snoozed');
    expect(classifyConversationTriage({ needsYou: true, busy: false, unread: false, cursor, reason: 'budget' }, snoozed, 5000)).toBe('active');
    expect(classifyConversationTriage({ needsYou: true, busy: false, unread: false, cursor: nextCursor, reason: 'budget' }, snoozed, 2000)).toBe('active');
  });

  it('keeps busy conversations in working unless archived at the same cursor', () => {
    const archived: TriageRecord = { s: 'archived', epoch: 'ep-1', seq: 10, t: 100 };
    const snoozed: TriageRecord = { s: 'snoozed', epoch: 'ep-1', seq: 10, u: 5000, t: 100 };

    expect(classifyConversationTriage({ needsYou: false, busy: true, unread: false, cursor, reason: 'running' }, undefined, 1000)).toBe('working');
    expect(classifyConversationTriage({ needsYou: false, busy: true, unread: false, cursor, reason: 'running' }, archived, 1000)).toBe('archived');
    expect(classifyConversationTriage({ needsYou: false, busy: true, unread: false, cursor: nextCursor, reason: 'running' }, archived, 1000)).toBe('working');
    expect(classifyConversationTriage({ needsYou: false, busy: true, unread: false, cursor, reason: 'running' }, snoozed, 1000)).toBe('working');
  });

  it('resurfaces expired snoozes into active even when the underlying turn is already read', () => {
    const snoozed: TriageRecord = { s: 'snoozed', epoch: 'ep-1', seq: 10, u: 5000, t: 100 };
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: false, cursor }, snoozed, 4999)).toBe('snoozed');
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: false, cursor }, snoozed, 5000)).toBe('active');
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: true, cursor }, snoozed, 5000)).toBe('active');
  });

  it('respects same-cursor marks for unread idle items and auto-wakes on cursor or epoch change', () => {
    const settled: TriageRecord = { s: 'settled', epoch: 'ep-1', seq: 10, t: 100 };
    const snoozed: TriageRecord = { s: 'snoozed', epoch: 'ep-1', seq: 10, u: 5000, t: 100 };
    const archived: TriageRecord = { s: 'archived', epoch: 'ep-1', seq: 10, t: 100 };

    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: true, cursor }, undefined, 1000)).toBe('active');
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: true, cursor }, settled, 1000)).toBe('settled');
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: true, cursor }, snoozed, 1000)).toBe('snoozed');
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: true, cursor }, archived, 1000)).toBe('archived');

    for (const record of [settled, snoozed, archived]) {
      expect(classifyConversationTriage({ needsYou: false, busy: false, unread: true, cursor: nextCursor }, record, 1000)).toBe('active');
      expect(classifyConversationTriage({ needsYou: false, busy: false, unread: true, cursor: newEpochCursor }, record, 1000)).toBe('active');
    }
  });

  it('keeps read idle items hidden unless actively snoozed or archived at the same cursor', () => {
    const settled: TriageRecord = { s: 'settled', epoch: 'ep-1', seq: 10, t: 100 };
    const archived: TriageRecord = { s: 'archived', epoch: 'ep-1', seq: 10, t: 100 };

    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: false, cursor }, undefined, 1000)).toBe('hidden');
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: false, cursor }, settled, 1000)).toBe('hidden');
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: false, cursor }, archived, 1000)).toBe('archived');
    expect(classifyConversationTriage({ needsYou: false, busy: false, unread: false, cursor: nextCursor }, archived, 1000)).toBe('hidden');
  });
});

describe('conversationTriage store', () => {
  const refA: ConversationRef = { spaceKey: 'remote:uuid-1', kind: 'session', id: 's-1' };
  const refB: ConversationRef = { spaceKey: 'main', kind: 'room', id: 'r-1' };
  const keyA = encodeConversationRef(refA);
  const keyB = encodeConversationRef(refB);

  it('persists settle, snooze, archive, clear, and exposes a reference-stable snapshot', () => {
    const before = conversationTriageSnapshot();
    expect(conversationTriageSnapshot()).toBe(before);

    settleConversation(refA, { epoch: 'ep-1', seq: 4 }, 'completed', 1000);
    expect(conversationTriageSnapshot()[keyA]).toEqual({
      s: 'settled',
      epoch: 'ep-1',
      seq: 4,
      reason: 'completed',
      t: 1000,
    });

    snoozeConversation(refA, { epoch: 'ep-1', seq: 4 }, '1h', 'completed', 2000);
    expect(conversationTriageSnapshot()[keyA]).toEqual({
      s: 'snoozed',
      epoch: 'ep-1',
      seq: 4,
      reason: 'completed',
      u: 2000 + 60 * 60_000,
      t: 2000,
    });

    archiveConversationTriage(refB, { seq: 8 }, 'failed', 3000);
    expect(conversationTriageSnapshot()[keyB]).toEqual({
      s: 'archived',
      seq: 8,
      reason: 'failed',
      t: 3000,
    });

    clearConversationTriage(refA);
    expect(conversationTriageSnapshot()[keyA]).toBeUndefined();
    expect(conversationTriageSnapshot()[keyB]).toBeDefined();
  });

  it('merges concurrent storage writes across windows and syncs on storage events', () => {
    settleConversation(refA, { epoch: 'ep-1', seq: 3 }, 'completed', 1000);

    // Another window writes refB before storage event arrives.
    localStorage.setItem('kiki.conversationTriage.v1', JSON.stringify({
      [keyA]: { s: 'settled', epoch: 'ep-1', seq: 3, reason: 'completed', t: 1000 },
      [keyB]: { s: 'archived', seq: 9, t: 1500 },
    }));

    archiveConversationTriage(refA, { epoch: 'ep-1', seq: 3 }, 'completed', 2000);
    expect(conversationTriageSnapshot()[keyB]).toEqual({ s: 'archived', seq: 9, t: 1500 });
    expect(conversationTriageSnapshot()[keyA]).toEqual({ s: 'archived', epoch: 'ep-1', seq: 3, reason: 'completed', t: 2000 });

    const listener = vi.fn();
    const unsubscribe = subscribeConversationTriage(listener);
    localStorage.setItem('kiki.conversationTriage.v1', JSON.stringify({
      [keyB]: { s: 'snoozed', seq: 9, u: 9000, t: 2500 },
    }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kiki.conversationTriage.v1', storageArea: localStorage }));
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(conversationTriageSnapshot()[keyA]).toBeUndefined();
    expect(conversationTriageSnapshot()[keyB]).toMatchObject({ s: 'snoozed', u: 9000 });
  });

  it('clears only marks whose cursors changed and computes the earliest future snooze expiry', () => {
    snoozeConversation(refA, { epoch: 'ep-1', seq: 5 }, 4000, 'completed', 1000);
    snoozeConversation(refB, { seq: 2 }, 9000, 'failed', 1000);

    expect(nextSnoozeExpiryMs(conversationTriageSnapshot(), 3000)).toBe(4000);
    expect(nextSnoozeExpiryMs(conversationTriageSnapshot(), 4000)).toBe(9000);
    expect(nextSnoozeExpiryMs(conversationTriageSnapshot(), 9000)).toBeUndefined();

    const cleared = clearChangedTriageMarks([
      { ref: refA, cursor: { epoch: 'ep-1', seq: 6 } },
      { ref: refB, cursor: { seq: 2 } },
    ]);
    expect(cleared).toBe(1);
    expect(conversationTriageSnapshot()[keyA]).toBeUndefined();
    expect(conversationTriageSnapshot()[keyB]).toBeDefined();
  });

  it('prunes entries older than 30 days and caps total stored marks at 300', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const base = 1_700_000_000_000;
    const seeded: Record<string, TriageRecord> = {};
    for (let i = 0; i < 310; i += 1) {
      const k = encodeConversationRef({ spaceKey: 'main', kind: 'session', id: `s-${i}` });
      seeded[k] = { s: 'settled', seq: 1, t: base + i * 1000 };
    }
    const staleKey = encodeConversationRef({ spaceKey: 'main', kind: 'session', id: 'stale' });
    seeded[staleKey] = { s: 'archived', seq: 1, t: base - 31 * DAY };
    const futureSnoozeKey = encodeConversationRef({ spaceKey: 'main', kind: 'session', id: 'future-snooze' });
    seeded[futureSnoozeKey] = { s: 'snoozed', seq: 1, u: base + 10 * DAY, t: base - 31 * DAY };

    localStorage.setItem('kiki.conversationTriage.v1', JSON.stringify(seeded));

    settleConversation(refA, { seq: 1 }, 'completed', base + 400_000);
    const snap = conversationTriageSnapshot();
    expect(Object.keys(snap)).toHaveLength(300);
    expect(snap[staleKey]).toBeUndefined();
    expect(snap[keyA]).toBeDefined();
    // Oldest of the 310 entries were evicted past the 300-entry cap, newest retained.
    expect(snap[encodeConversationRef({ spaceKey: 'main', kind: 'session', id: 's-0' })]).toBeUndefined();
    expect(snap[encodeConversationRef({ spaceKey: 'main', kind: 'session', id: 's-309' })]).toBeDefined();
  });
});
