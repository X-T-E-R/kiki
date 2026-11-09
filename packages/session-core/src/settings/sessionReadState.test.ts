// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { configureSpaceStorage } from '../storage/spaceStorage';

import {
  forgetSessionSeen,
  markSessionSeen,
  markSessionsSeen,
  resetSessionSeen,
  sessionSeenSnapshot,
  subscribeSessionSeen,
} from './sessionReadState';

afterEach(() => { resetSessionSeen(); });

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
