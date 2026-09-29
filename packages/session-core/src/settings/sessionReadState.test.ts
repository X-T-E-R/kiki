// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
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
});
