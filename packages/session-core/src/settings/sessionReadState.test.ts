// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureSpaceStorage } from '../storage/spaceStorage';

import {
  beginOpenConversation,
  conversationSeenSnapshot,
  encodeConversationRef,
  forgetConversationSeen,
  forgetSessionSeen,
  markConversationSeen,
  markConversationUnread,
  markConversationsSeen,
  markSessionSeen,
  markSessionUnread,
  markSessionsSeen,
  resetConversationSeen,
  resetSessionSeen,
  seedLegacySeenForSpace,
  sessionSeenSnapshot,
  subscribeConversationSeen,
  subscribeSessionSeen,
  type ConversationRef,
} from './sessionReadState';

afterEach(() => {
  configureSpaceStorage(null);
  resetSessionSeen();
  resetConversationSeen();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
});

describe('markSessionsSeen', () => {
  it('records every mark in one publish and never moves one backwards', () => {
    markSessionSeen('a', 10);
    let publishes = 0;
    const unsubscribe = subscribeSessionSeen(() => { publishes += 1; });
    markSessionsSeen([
      { sessionId: 'a', lastSeq: 4 },
      { sessionId: 'b', lastSeq: 7 },
      { sessionId: 'c', lastSeq: 3 },
    ]);
    unsubscribe();
    expect(publishes).toBe(1);
    expect(sessionSeenSnapshot()).toEqual({ a: 10, b: 7, c: 3 });
    expect(JSON.parse(localStorage.getItem('kiki.sessionSeen.v1') ?? '{}')).toEqual({ a: 10, b: 7, c: 3 });
  });

  it('writes nothing when every mark is already current', () => {
    markSessionSeen('a', 5);
    const before = sessionSeenSnapshot();
    markSessionsSeen([{ sessionId: 'a', lastSeq: 5 }, { sessionId: '', lastSeq: 9 }]);
    expect(sessionSeenSnapshot()).toBe(before);
  });

  it('preserves another window write that landed in localStorage before a late storage event arrives', () => {
    markSessionSeen('a', 4);
    expect(sessionSeenSnapshot()).toEqual({ a: 4 });

    // Another window marks session A at seq 12 and session C at seq 9 before its storage event arrives.
    localStorage.setItem('kiki.sessionSeen.v1', JSON.stringify({ a: 12, c: 9 }));

    // This window marks session B seen before receiving the storage event.
    markSessionSeen('b', 7);
    expect(sessionSeenSnapshot()).toEqual({ a: 12, b: 7, c: 9 });
    expect(JSON.parse(localStorage.getItem('kiki.sessionSeen.v1') ?? '{}')).toEqual({ a: 12, b: 7, c: 9 });

    // Even a same-session write at an older seq reconciles the fresher mark from storage.
    localStorage.setItem('kiki.sessionSeen.v1', JSON.stringify({ a: 12, b: 15, c: 9, d: 3 }));
    markSessionSeen('b', 7);
    expect(sessionSeenSnapshot()).toEqual({ a: 12, b: 15, c: 9, d: 3 });

    // Batch write also merges concurrent storage marks without regressing local marks.
    localStorage.setItem('kiki.sessionSeen.v1', JSON.stringify({ a: 8, e: 11 }));
    markSessionsSeen([{ sessionId: 'f', lastSeq: 6 }]);
    expect(sessionSeenSnapshot()).toEqual({ a: 12, b: 15, c: 9, d: 3, e: 11, f: 6 });
    expect(JSON.parse(localStorage.getItem('kiki.sessionSeen.v1') ?? '{}')).toEqual({
      a: 12, b: 15, c: 9, d: 3, e: 11, f: 6,
    });
  });

  it('retains read marks past 300 sessions without silently evicting older active sessions back to unread', () => {
    for (let i = 1; i <= 350; i += 1) {
      markSessionSeen(`s-${i}`, i);
    }
    const snap = sessionSeenSnapshot();
    expect(Object.keys(snap)).toHaveLength(350);
    expect(snap['s-1']).toBe(1);
    expect(snap['s-150']).toBe(150);
    expect(snap['s-350']).toBe(350);

    markSessionsSeen([
      { sessionId: 's-351', lastSeq: 351 },
      { sessionId: 's-352', lastSeq: 352 },
    ]);
    const afterBatch = sessionSeenSnapshot();
    expect(Object.keys(afterBatch)).toHaveLength(352);
    expect(afterBatch['s-1']).toBe(1);
    expect(afterBatch['s-352']).toBe(352);
  });

  it('persists to storage before notifying subscribers so re-entrant listener writes are not overwritten', () => {
    let reentered = false;
    const unsubscribe = subscribeSessionSeen(() => {
      if (reentered) return;
      reentered = true;
      expect(JSON.parse(localStorage.getItem('kiki.sessionSeen.v1') ?? '{}')).toEqual({ a: 5 });
      markSessionSeen('b', 9);
    });
    markSessionSeen('a', 5);
    unsubscribe();

    expect(sessionSeenSnapshot()).toEqual({ a: 5, b: 9 });
    expect(JSON.parse(localStorage.getItem('kiki.sessionSeen.v1') ?? '{}')).toEqual({ a: 5, b: 9 });
  });

  it('supports explicit forgetSessionSeen and resetSessionSeen while preserving other marks', () => {
    markSessionsSeen([
      { sessionId: 'a', lastSeq: 10 },
      { sessionId: 'b', lastSeq: 20 },
    ]);
    localStorage.setItem('kiki.sessionSeen.v1', JSON.stringify({ a: 10, b: 20, c: 30 }));
    forgetSessionSeen('a');
    expect(sessionSeenSnapshot()).toEqual({ b: 20, c: 30 });
    expect(JSON.parse(localStorage.getItem('kiki.sessionSeen.v1') ?? '{}')).toEqual({ b: 20, c: 30 });

    resetSessionSeen();
    expect(sessionSeenSnapshot()).toEqual({});
    expect(localStorage.getItem('kiki.sessionSeen.v1')).toBeNull();
  });

  it('does not reuse or overwrite another home/scope cached marks for the same session id', () => {
    try {
      configureSpaceStorage({ homeId: 'home-a' }); resetSessionSeen();
      markSessionSeen('example', 10);
      configureSpaceStorage({ homeId: 'home-b' }); resetSessionSeen();
      expect(sessionSeenSnapshot()).toEqual({});
      markSessionSeen('example', 3);
      configureSpaceStorage({ homeId: 'home-a' });
      expect(sessionSeenSnapshot()).toEqual({ example: 10 });
      configureSpaceStorage({ homeId: 'home-b' });
      expect(sessionSeenSnapshot()).toEqual({ example: 3 });
    } finally {
      configureSpaceStorage(null);
    }
  });
});


describe('markSessionUnread', () => {
  it('lowers a v1 mark to just before the supplied sequence', () => {
    markSessionSeen('session-a', 10);
    markSessionUnread('session-a', 10);
    expect(sessionSeenSnapshot()).toEqual({ 'session-a': 9 });

    markSessionUnread('session-a', 1);
    expect(sessionSeenSnapshot()).toEqual({ 'session-a': 0 });
  });
});

describe('conversationSeen', () => {
  const sessionA = { spaceKey: 'space:one', kind: 'session' as const, id: 'same:id' };
  const roomA = { spaceKey: 'space:one', kind: 'room' as const, id: 'same:id' };
  const sessionB = { spaceKey: 'space:two', kind: 'session' as const, id: 'same:id' };
  const key = (ref: ConversationRef) => encodeConversationRef(ref);

  it('uses a collision-free tuple identity for shared ids, spaces, and kinds', () => {
    expect(encodeConversationRef(sessionA)).toBe('["space:one","session","same:id"]');
    markConversationsSeen([
      { ref: sessionA, cursor: { epoch: 'session-epoch', seq: 4 } },
      { ref: roomA, cursor: { epoch: 'room-epoch', seq: 5 } },
      { ref: sessionB, cursor: { epoch: 'other-epoch', seq: 6 } },
    ]);

    const snapshot = conversationSeenSnapshot();
    expect(snapshot).toBe(conversationSeenSnapshot());
    expect(Object.keys(snapshot)).toEqual([key(sessionA), key(roomA), key(sessionB)]);
    expect(snapshot[key(sessionA)]).toMatchObject({ epoch: 'session-epoch', seq: 4 });
    expect(snapshot[key(roomA)]).toMatchObject({ epoch: 'room-epoch', seq: 5 });
    expect(snapshot[key(sessionB)]).toMatchObject({ epoch: 'other-epoch', seq: 6 });
    expect(JSON.parse(localStorage.getItem('kiki.conversationSeen.v2') ?? '{}')).toHaveProperty(key(sessionA));
  });

  it('keeps same-epoch reads monotonic, accepts an epoch change, and rejects an epochless overwrite', () => {
    markConversationSeen(sessionA, { epoch: 'epoch-1', seq: 10 });
    const first = conversationSeenSnapshot()[key(sessionA)]!;
    markConversationSeen(sessionA, { epoch: 'epoch-1', seq: 3 });
    expect(conversationSeenSnapshot()[key(sessionA)]).toBe(first);

    markConversationSeen(sessionA, { seq: 100 });
    expect(conversationSeenSnapshot()[key(sessionA)]).toBe(first);

    markConversationSeen(sessionA, { epoch: 'epoch-2', seq: 1 });
    expect(conversationSeenSnapshot()[key(sessionA)]).toMatchObject({ epoch: 'epoch-2', seq: 1 });
  });

  it('re-reads authoritative storage and does not resurrect stale unrelated cached keys', () => {
    const unrelated = { spaceKey: 'space:one', kind: 'session' as const, id: 'unrelated' };
    markConversationSeen(sessionA, { epoch: 'epoch-1', seq: 4 });
    markConversationSeen(unrelated, { epoch: 'epoch-1', seq: 8 });
    expect(conversationSeenSnapshot()[key(unrelated)]).toBeDefined();

    localStorage.setItem('kiki.conversationSeen.v2', JSON.stringify({
      [key(sessionA)]: { epoch: 'epoch-1', seq: 4, updatedAt: 1 },
      [key(sessionB)]: { epoch: 'epoch-1', seq: 12, updatedAt: 2 },
    }));
    markConversationSeen(sessionA, { epoch: 'epoch-1', seq: 7 });

    expect(JSON.parse(localStorage.getItem('kiki.conversationSeen.v2') ?? '{}')).toEqual({
      [key(sessionA)]: expect.objectContaining({ epoch: 'epoch-1', seq: 7 }),
      [key(sessionB)]: { epoch: 'epoch-1', seq: 12, updatedAt: 2 },
    });
    expect(conversationSeenSnapshot()[key(unrelated)]).toBeUndefined();
  });

  it('invalidates the stable snapshot from a global storage event', () => {
    markConversationSeen(sessionA, { epoch: 'epoch-1', seq: 4 });
    const before = conversationSeenSnapshot();
    const listener = vi.fn();
    const unsubscribe = subscribeConversationSeen(listener);
    localStorage.setItem('kiki.conversationSeen.v2', JSON.stringify({
      [key(sessionA)]: { epoch: 'epoch-1', seq: 9, updatedAt: 3 },
    }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'kiki.conversationSeen.v2',
      storageArea: localStorage,
    }));
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(conversationSeenSnapshot()).not.toBe(before);
    expect(conversationSeenSnapshot()[key(sessionA)]).toMatchObject({ seq: 9 });
  });

  it('shows pending opens immediately, keeps each operation independent, and cancel never writes', () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    const first = beginOpenConversation(sessionA, { epoch: 'epoch-1', seq: 5 });
    const second = beginOpenConversation(sessionA, { epoch: 'epoch-1', seq: 7 });
    expect(conversationSeenSnapshot()[key(sessionA)]).toMatchObject({ epoch: 'epoch-1', seq: 7 });

    first.cancel();
    expect(conversationSeenSnapshot()[key(sessionA)]).toMatchObject({ epoch: 'epoch-1', seq: 7 });
    second.cancel();
    expect(conversationSeenSnapshot()[key(sessionA)]).toBeUndefined();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('cancelling a pending open drops only that overlay without reverting another window real read', () => {
    const remoteRef: ConversationRef = { spaceKey: 'remote:550e8400-e29b-41d4-a716-446655440000', kind: 'session', id: 's-1' };
    const remoteKey = key(remoteRef);
    const pending = beginOpenConversation(remoteRef, { epoch: 'epoch-1', seq: 5 });
    expect(conversationSeenSnapshot()[remoteKey]).toMatchObject({ epoch: 'epoch-1', seq: 5 });

    const unsubscribe = subscribeConversationSeen(() => {});
    try {
      // Another window actually opened and persisted seq 8.
      localStorage.setItem('kiki.conversationSeen.v2', JSON.stringify({
        [remoteKey]: { epoch: 'epoch-1', seq: 8, updatedAt: 99 },
      }));
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'kiki.conversationSeen.v2',
        storageArea: localStorage,
      }));

      // Local open is cancelled (e.g. dirty-guard aborted or remote open failed).
      pending.cancel();
      expect(conversationSeenSnapshot()[remoteKey]).toMatchObject({ epoch: 'epoch-1', seq: 8 });
      expect(JSON.parse(localStorage.getItem('kiki.conversationSeen.v2') ?? '{}')[remoteKey]).toMatchObject({
        epoch: 'epoch-1',
        seq: 8,
      });
    } finally {
      unsubscribe();
    }
  });

  it('commits an optimistic open once and never lets an old epoch overlay revert a newer read', () => {
    const pending = beginOpenConversation(sessionA, { epoch: 'old-epoch', seq: 30 });
    expect(conversationSeenSnapshot()[key(sessionA)]).toMatchObject({ epoch: 'old-epoch', seq: 30 });
    markConversationSeen(sessionA, { epoch: 'new-epoch', seq: 2 });
    pending.commit();
    pending.commit();
    expect(conversationSeenSnapshot()[key(sessionA)]).toMatchObject({ epoch: 'new-epoch', seq: 2 });
    expect(JSON.parse(localStorage.getItem('kiki.conversationSeen.v2') ?? '{}')[key(sessionA)]).toMatchObject({
      epoch: 'new-epoch', seq: 2,
    });
  });

  it('marks a conversation unread without raising a lower mark', () => {
    markConversationSeen(sessionA, { epoch: 'epoch-1', seq: 10 });
    markConversationUnread(sessionA, { epoch: 'epoch-1', seq: 10 });
    expect(conversationSeenSnapshot()[key(sessionA)]).toMatchObject({ epoch: 'epoch-1', seq: 9 });

    markConversationUnread(sessionA, { epoch: 'epoch-1', seq: 4 });
    expect(conversationSeenSnapshot()[key(sessionA)]).toMatchObject({ epoch: 'epoch-1', seq: 3 });
  });

  it('seeds one verified space once, preserves semantic marks, and never copies to another space', () => {
    configureSpaceStorage({ homeId: 'ambient-space' });
    seedLegacySeenForSpace('verified:one', { same: 4, 'room:shared': 6 });
    seedLegacySeenForSpace('verified:two', { same: 9 });

    const oneSession = { spaceKey: 'verified:one', kind: 'session' as const, id: 'same' };
    const oneRoom = { spaceKey: 'verified:one', kind: 'room' as const, id: 'shared' };
    const twoSession = { spaceKey: 'verified:two', kind: 'session' as const, id: 'same' };
    expect(conversationSeenSnapshot()[key(oneSession)]).toMatchObject({ seq: 4 });
    expect(conversationSeenSnapshot()[key(oneRoom)]).toMatchObject({ seq: 6 });
    expect(conversationSeenSnapshot()[key(twoSession)]).toMatchObject({ seq: 9 });
    expect(localStorage.getItem('kiki.space.ambient-space.kiki.conversationSeen.v2')).toBeNull();

    markConversationSeen(oneSession, { epoch: 'semantic-new', seq: 1 });
    seedLegacySeenForSpace('verified:one', { same: 99, 'room:shared': 99 });
    expect(conversationSeenSnapshot()[key(oneSession)]).toMatchObject({ epoch: 'semantic-new', seq: 1 });
    expect(conversationSeenSnapshot()[key(oneRoom)]).toMatchObject({ seq: 6 });

    forgetConversationSeen(oneRoom);
    expect(conversationSeenSnapshot()[key(oneRoom)]).toBeUndefined();
  });
});
