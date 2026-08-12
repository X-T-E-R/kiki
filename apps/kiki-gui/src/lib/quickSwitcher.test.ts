import { describe, expect, it } from 'vitest';

import type { Session } from '@moonshot-ai/protocol';

import type { SearchMessageHit } from './client';
import {
  buildSwitcherItems,
  SWITCHER_HIT_LIMIT,
  SWITCHER_RECENT_LIMIT,
  SWITCHER_TITLE_MATCH_LIMIT,
} from './quickSwitcher';

function session(id: string, updatedAt: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspace_id: 'wd_test',
    title: id,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: updatedAt,
    busy: false,
    metadata: { cwd: 'C:/tmp' },
    agent_config: { model: '' },
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
    message_count: 0,
    last_seq: 0,
    ...overrides,
  };
}

function hit(sessionId: string, snippet: string, score = 1): SearchMessageHit {
  return {
    session_id: sessionId,
    workspace_id: 'wd_test',
    session_title: sessionId,
    agent_id: 'main',
    role: 'user',
    snippet,
    time: 1_770_000_000_000,
    score,
  };
}

describe('buildSwitcherItems — empty query', () => {
  it('lists sessions newest-first, capped at the recent limit', () => {
    const sessions = Array.from({ length: SWITCHER_RECENT_LIMIT + 3 }, (_, index) =>
      session(`s${index}`, `2026-01-0${(index % 8) + 1}T00:00:00.000Z`),
    );
    const items = buildSwitcherItems({ query: '', sessions, hits: [], untitled: 'Untitled' });
    expect(items).toHaveLength(SWITCHER_RECENT_LIMIT);
    expect(items.every((item) => item.kind === 'session')).toBe(true);
    const stamps = items.map((item) => (item.kind === 'session' ? item.updatedAt : ''));
    expect(stamps).toEqual(stamps.toSorted().toReversed());
  });

  it('labels an untitled session with the last prompt, then the placeholder', () => {
    const sessions = [
      session('s1', '2026-01-02T00:00:00.000Z', { title: '', last_prompt: 'fix the flaky test' }),
      session('s2', '2026-01-01T00:00:00.000Z', { title: '' }),
    ];
    const items = buildSwitcherItems({ query: '', sessions, hits: [], untitled: 'Untitled' });
    expect(items[0]).toMatchObject({ kind: 'session', title: 'fix the flaky test' });
    expect(items[1]).toMatchObject({ kind: 'session', title: 'Untitled' });
  });
});

describe('buildSwitcherItems — with query', () => {
  const sessions = [
    session('persimmon-notes', '2026-01-03T00:00:00.000Z', { title: 'Persimmon notes' }),
    session('renderer', '2026-01-02T00:00:00.000Z', { title: 'Renderer rework' }),
    session('cwd-match', '2026-01-01T00:00:00.000Z', {
      title: 'Unrelated name',
      metadata: { cwd: 'C:/work/persimmon' },
    }),
  ];

  it('matches sessions by title or cwd, newest first, before search hits', () => {
    const items = buildSwitcherItems({
      query: 'persimmon',
      sessions,
      hits: [hit('renderer', '…the persimmon cache…')],
      untitled: 'Untitled',
    });
    const ids = items.map((item) => (item.kind === 'action' ? item.actionId : item.sessionId));
    expect(ids).toEqual(['persimmon-notes', 'cwd-match', 'renderer']);
    expect(items[2]).toMatchObject({ kind: 'hit', snippet: '…the persimmon cache…' });
  });

  it('is case-insensitive and caps title matches and hits', () => {
    const many = Array.from({ length: SWITCHER_TITLE_MATCH_LIMIT + 4 }, (_, index) =>
      session(`PERSIMMON-${index}`, `2026-01-0${(index % 8) + 1}T00:00:00.000Z`),
    );
    const manyHits = Array.from({ length: SWITCHER_HIT_LIMIT + 4 }, (_, index) =>
      hit('s-other', `persimmon hit ${index}`),
    );
    const items = buildSwitcherItems({
      query: 'persimmon',
      sessions: many,
      hits: manyHits,
      untitled: 'Untitled',
    });
    expect(items.filter((item) => item.kind === 'session')).toHaveLength(SWITCHER_TITLE_MATCH_LIMIT);
    expect(items.filter((item) => item.kind === 'hit')).toHaveLength(SWITCHER_HIT_LIMIT);
  });

  it('returns no session rows when nothing matches', () => {
    const items = buildSwitcherItems({ query: 'zzz', sessions, hits: [], untitled: 'Untitled' });
    expect(items).toEqual([]);
  });
});

describe('buildSwitcherItems — page actions', () => {
  const usageAction = { actionId: 'usage', title: 'Open usage dashboard', route: '/usage' };
  const sessions = [session('s1', '2026-01-02T00:00:00.000Z')];

  it('pins actions above the recent sessions on an empty query', () => {
    const items = buildSwitcherItems({
      query: '',
      sessions,
      hits: [],
      untitled: 'Untitled',
      actions: [usageAction],
    });
    expect(items[0]).toMatchObject({ kind: 'action', actionId: 'usage', route: '/usage' });
    expect(items[1]).toMatchObject({ kind: 'session', sessionId: 's1' });
  });

  it('matches actions by title substring, ahead of session matches', () => {
    const items = buildSwitcherItems({
      query: 'usage',
      sessions: [session('usage-notes', '2026-01-02T00:00:00.000Z', { title: 'Usage notes' })],
      hits: [],
      untitled: 'Untitled',
      actions: [usageAction],
    });
    expect(items.map((item) => item.kind)).toEqual(['action', 'session']);
  });

  it('drops actions whose title does not match the query', () => {
    const items = buildSwitcherItems({
      query: 'persimmon',
      sessions,
      hits: [],
      untitled: 'Untitled',
      actions: [usageAction],
    });
    expect(items.every((item) => item.kind !== 'action')).toBe(true);
  });
});
