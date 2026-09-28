import { describe, expect, it } from 'vitest';

import type { SearchMessageHit } from '../transport';
import {
  buildContentSearchBody,
  fuzzyMatch,
  groupSearchHits,
  highlightTerms,
  isSearchable,
  parseSearchQuery,
  resolveWorkspaceTerm,
  scopeContentHits,
  searchLocal,
  splitByRanges,
} from './search';

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

describe('parseSearchQuery', () => {
  it('splits in: and role: prefixes out of the free text', () => {
    expect(parseSearchQuery('in:kiki role:user persimmon cache')).toEqual({
      text: 'persimmon cache', workspaceTerm: 'kiki', role: 'user',
    });
    expect(parseSearchQuery('  plain  text ')).toEqual({ text: 'plain text' });
  });
});

describe('fuzzyMatch', () => {
  it('ranks a word-start substring above a mid-word one', () => {
    const start = fuzzyMatch('Cache layer', 'cach')!;
    const mid = fuzzyMatch('Recache layer', 'cach')!;
    expect(start.ranges).toEqual([[0, 4]]);
    expect(start.score).toBeGreaterThan(mid.score);
  });

  it('requires every word of a multi-word query', () => {
    expect(fuzzyMatch('Fix sidebar search', 'search fix')?.ranges).toEqual([[0, 3], [12, 18]]);
    expect(fuzzyMatch('Fix sidebar', 'search fix')).toBeNull();
  });

  it('accepts compact subsequences of three or more characters only', () => {
    expect(fuzzyMatch('session-core', 'sscr')).not.toBeNull();
    expect(fuzzyMatch('session-core', 'sc')).toBeNull();
    expect(fuzzyMatch(`s${'x'.repeat(40)}cr`, 'scr')).toBeNull();
  });
});

describe('highlightTerms / splitByRanges', () => {
  it('marks every occurrence of every term and splits text into segments', () => {
    const ranges = highlightTerms('cache the Cache', 'cache');
    expect(ranges).toEqual([[0, 5], [10, 15]]);
    expect(splitByRanges('cache the Cache', ranges)).toEqual([
      { text: 'cache', hit: true }, { text: ' the ', hit: false }, { text: 'Cache', hit: true },
    ]);
  });
});

describe('searchLocal', () => {
  const workspaces = [
    { id: 'ws-kiki', name: 'kiki', root: 'C:/work/kiki' },
    { id: 'ws-docs', name: 'docs', root: 'C:/work/handbook' },
  ];
  const sessions = [
    { id: 'title', title: 'Kiki sidebar', workspace_id: 'ws-docs', updated_at: '2026-01-01T00:00:00.000Z', cwd: 'C:/x' },
    { id: 'cwd', title: 'Other', workspace_id: 'ws-docs', updated_at: '2026-01-02T00:00:00.000Z', cwd: 'C:/work/kiki' },
    { id: 'ws', title: 'Else', workspace_id: 'ws-kiki', updated_at: '2026-01-03T00:00:00.000Z', cwd: 'C:/y' },
  ];

  it('ranks title over cwd over workspace-name matches, and finds workspaces by name or root', () => {
    const result = searchLocal({ text: 'kiki', sessions, workspaces });
    expect(result.sessions.map((match) => [match.session.id, match.matchedOn])).toEqual([
      ['title', 'title'], ['cwd', 'cwd'], ['ws', 'workspace'],
    ]);
    expect(result.workspaces.map((match) => match.workspace.id)).toEqual(['ws-kiki']);
    expect(searchLocal({ text: 'handbook', sessions: [], workspaces }).workspaces[0]?.workspace.id).toBe('ws-docs');
  });

  it('returns nothing for a blank query', () => {
    expect(searchLocal({ text: '  ', sessions, workspaces })).toEqual({ workspaces: [], sessions: [] });
  });

  it('resolves an in: term to the best workspace', () => {
    expect(resolveWorkspaceTerm('doc', workspaces)?.id).toBe('ws-docs');
    expect(resolveWorkspaceTerm(undefined, workspaces)).toBeUndefined();
  });
});

describe('content search scope', () => {
  it('sends workspace_id only when exactly one workspace scopes the search', () => {
    expect(buildContentSearchBody({ text: ' cache ', workspaceIds: ['ws-a'] })).toEqual({
      query: 'cache', sort: 'score', page_size: 20, workspace_id: 'ws-a',
    });
    expect(buildContentSearchBody({ text: 'cache', workspaceIds: ['ws-a', 'ws-b'], role: 'user' })).toEqual({
      query: 'cache', sort: 'score', page_size: 20, role: 'user',
    });
  });

  it('narrows hits to the workspace set and allowed sessions client-side', () => {
    const hits = [
      { session_id: 's1', workspace_id: 'ws-a' },
      { session_id: 's2', workspace_id: 'ws-b' },
      { session_id: 's3', workspace_id: 'ws-c' },
    ];
    expect(scopeContentHits(hits, { workspaceIds: ['ws-a', 'ws-b'] }).map((hit) => hit.session_id)).toEqual(['s1', 's2']);
    expect(scopeContentHits(hits, { workspaceIds: [], allowedSessionIds: new Set(['s3']) }).map((hit) => hit.session_id)).toEqual(['s3']);
  });
});
