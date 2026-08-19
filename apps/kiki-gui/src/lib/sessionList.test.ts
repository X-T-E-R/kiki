import { describe, expect, it } from 'vitest';

import type { PageResponse, Session } from '@moonshot-ai/protocol';

import {
  arrangePinnedFirst,
  dedupeSessions,
  groupSessionsByTime,
  isPinnedSession,
  mergeSessionFirstPage,
  pinMetadataPatch,
  SESSION_PIN_META_KEY,
  type SessionListData,
} from './sessionList';

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

function page(ids: string[], hasMore: boolean): PageResponse<Session> {
  return {
    items: ids.map((id) => session(id, '2026-01-01T00:00:00.000Z')),
    has_more: hasMore,
  };
}

function data(...pages: PageResponse<Session>[]): SessionListData {
  return { pages, pageParams: pages.map(() => undefined) };
}

describe('mergeSessionFirstPage', () => {
  it('replaces only the first page and keeps older pages', () => {
    const old = data(page(['s3', 's2'], true), page(['s1'], false));
    const merged = mergeSessionFirstPage(old, page(['s4', 's3'], true));
    expect(merged?.pages.map((p) => p.items.map((s) => s.id))).toEqual([['s4', 's3'], ['s1']]);
  });

  it('is a no-op before the first load', () => {
    expect(mergeSessionFirstPage(undefined, page(['s1'], false))).toBeUndefined();
  });
});

describe('dedupeSessions', () => {
  it('drops rows that a fresher page 1 pulled up from an older page', () => {
    const merged = mergeSessionFirstPage(
      data(page(['s3', 's2'], true), page(['s1'], false)),
      page(['s1', 's4', 's3'], true),
    );
    // s1 was bumped into page 1; its stale copy on page 2 must not duplicate.
    expect(dedupeSessions(merged).map((s) => s.id)).toEqual(['s1', 's4', 's3']);
  });

  it('returns every row in order when pages do not overlap', () => {
    const merged = data(page(['s3', 's2'], true), page(['s1'], false));
    expect(dedupeSessions(merged).map((s) => s.id)).toEqual(['s3', 's2', 's1']);
  });
});

describe('session pin', () => {
  it('reads the pin flag from session metadata', () => {
    const pinned = session('s1', '2026-01-01T00:00:00.000Z', {
      metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true },
    });
    expect(isPinnedSession(pinned)).toBe(true);
    expect(isPinnedSession(session('s2', '2026-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('builds a pin patch that preserves the cwd and existing custom metadata', () => {
    const withExtra = session('s1', '2026-01-01T00:00:00.000Z', {
      metadata: { cwd: 'C:/tmp', 'other.key': 1 },
    });
    expect(pinMetadataPatch(withExtra, true)).toEqual({ cwd: 'C:/tmp', 'other.key': 1, [SESSION_PIN_META_KEY]: true });
    // Unpin drops the flag but keeps cwd + every other custom key so the
    // patch is never empty (the v1 route skips empty metadata patches).
    expect(pinMetadataPatch(withExtra, false)).toEqual({ cwd: 'C:/tmp', 'other.key': 1 });
  });
});

describe('arrangePinnedFirst', () => {
  it('floats pinned sessions above unpinned, newest first within each tier', () => {
    const a = session('a', '2026-01-02T00:00:00.000Z');
    const b = session('b', '2026-01-03T00:00:00.000Z', { metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true } });
    const c = session('c', '2026-01-04T00:00:00.000Z');
    const d = session('d', '2026-01-01T00:00:00.000Z', { metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true } });
    expect(arrangePinnedFirst([a, b, c, d]).map((s) => s.id)).toEqual(['b', 'd', 'c', 'a']);
  });
});

describe('groupSessionsByTime', () => {
  const now = new Date('2026-02-01T00:00:00.000Z').getTime();
  const iso = (daysAgo: number) => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();

  it('buckets sessions by age and omits empty buckets', () => {
    const groups = groupSessionsByTime(
      [
        session('recent', iso(1)),
        session('this-week', iso(6)),
        session('this-month', iso(10)),
        session('old', iso(60)),
        session('bad-date', 'not-a-date'),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(['week', 'month', 'older']);
    expect(groups[0]!.items.map((s) => s.id)).toEqual(['recent', 'this-week']);
    expect(groups[1]!.items.map((s) => s.id)).toEqual(['this-month']);
    expect(groups[2]!.items.map((s) => s.id)).toEqual(['old', 'bad-date']);
  });

  it('puts pinned sessions in their own leading group regardless of age', () => {
    const pinned = session('pinned', iso(90), { metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true } });
    const groups = groupSessionsByTime([session('recent', iso(1)), pinned], now);
    expect(groups[0]!.key).toBe('pinned');
    expect(groups[0]!.items.map((s) => s.id)).toEqual(['pinned']);
  });
});
