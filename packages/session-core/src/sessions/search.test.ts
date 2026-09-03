import { describe, expect, it } from 'vitest';

import type { SearchMessageHit } from './client';
import { groupSearchHits, isSearchable } from './search';

function hit(sessionId: string, overrides: Partial<SearchMessageHit> = {}): SearchMessageHit {
  return {
    session_id: sessionId,
    workspace_id: 'wd_1',
    session_title: `Session ${sessionId}`,
    agent_id: 'main',
    role: 'user',
    snippet: `snippet in ${sessionId}`,
    time: 1_700_000_000_000,
    score: 0.5,
    ...overrides,
  };
}

describe('groupSearchHits', () => {
  it('groups hits by session, best score first', () => {
    const groups = groupSearchHits([
      hit('a', { score: 0.4 }),
      hit('b', { score: 0.9 }),
      hit('a', { score: 0.7 }),
    ]);
    expect(groups.map((group) => group.sessionId)).toEqual(['b', 'a']);
    expect(groups[1]?.hits).toHaveLength(2);
  });

  it('caps hits per group and keeps the best-scored ones in order', () => {
    const groups = groupSearchHits(
      [
        hit('a', { snippet: 'one', score: 0.9 }),
        hit('a', { snippet: 'two', score: 0.8 }),
        hit('a', { snippet: 'three', score: 0.7 }),
        hit('a', { snippet: 'four', score: 0.6 }),
      ],
      { maxPerGroup: 2 },
    );
    expect(groups[0]?.hits.map((item) => item.snippet)).toEqual(['one', 'two']);
  });

  it('prefers a non-empty title from any hit in the group', () => {
    const groups = groupSearchHits([
      hit('a', { session_title: '' }),
      hit('a', { session_title: 'Real title' }),
    ]);
    expect(groups[0]?.title).toBe('Real title');
  });

  it('handles an empty result set', () => {
    expect(groupSearchHits([])).toEqual([]);
  });
});

describe('isSearchable', () => {
  it('requires two non-space characters', () => {
    expect(isSearchable('')).toBe(false);
    expect(isSearchable(' a ')).toBe(false);
    expect(isSearchable('ab')).toBe(true);
  });
});
