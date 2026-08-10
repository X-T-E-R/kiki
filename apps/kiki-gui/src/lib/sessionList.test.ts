import { describe, expect, it } from 'vitest';

import type { PageResponse, Session } from '@moonshot-ai/protocol';

import { dedupeSessions, mergeSessionFirstPage, type SessionListData } from './sessionList';

function session(id: string, updatedAt: string): Session {
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
