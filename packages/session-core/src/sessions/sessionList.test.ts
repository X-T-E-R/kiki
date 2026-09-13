import { describe, expect, it } from 'vitest';

import type { PageResponse, Session, Workspace } from '@kiki/protocol';

import {
  arrangePinnedFirst,
  dedupeSessions,
  groupSessionsByTime,
  groupSessionsByWorkspace,
  isPinnedSession,
  mergeSessionFirstPage,
  pinMetadataPatch,
  SESSION_PIN_META_KEY,
  sortSessionItems,
  WORKSPACE_UNGROUPED_KEY,
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

describe('sortSessionItems', () => {
  const pinnedNew = session('pin-new', '2026-01-04T00:00:00.000Z', { metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true } });
  const pinnedOld = session('pin-old', '2026-01-01T00:00:00.000Z', { metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true } });
  const newer = session('z-newer', '2026-01-03T00:00:00.000Z');
  const older = session('a-older', '2026-01-02T00:00:00.000Z');

  it('sorts by most-recently-updated for the unpinned remainder (pinned still first)', () => {
    expect(sortSessionItems([older, pinnedOld, newer, pinnedNew], 'updated-desc').map((s) => s.id)).toEqual([
      'pin-new', 'pin-old', 'z-newer', 'a-older',
    ]);
  });

  it('sorts by least-recently-updated for the unpinned remainder', () => {
    expect(sortSessionItems([older, pinnedOld, newer, pinnedNew], 'updated-asc').map((s) => s.id)).toEqual([
      'pin-new', 'pin-old', 'a-older', 'z-newer',
    ]);
  });

  it('sorts by title (case/base-insensitive, numeric-aware) with a deterministic tie-break', () => {
    const bb = session('bb', '2026-01-02T00:00:00.000Z', { title: 'Beta' });
    const aa = session('aa', '2026-01-02T00:00:00.000Z', { title: 'alpha' });
    const n10 = session('n10', '2026-01-02T00:00:00.000Z', { title: 'Item 10' });
    const n2 = session('n2', '2026-01-02T00:00:00.000Z', { title: 'Item 2' });
    expect(sortSessionItems([bb, n10, aa, n2], 'title').map((s) => s.title)).toEqual([
      'alpha', 'Beta', 'Item 2', 'Item 10',
    ]);
  });
});

function workspace(id: string, name: string): Workspace {
  return {
    id,
    root: `C:/${name}`,
    name,
    created_at: '2026-01-01T00:00:00.000Z',
    last_opened_at: '2026-01-02T00:00:00.000Z',
    session_count: 0,
    pinned: false,
  };
}

describe('groupSessionsByWorkspace', () => {
  const wa = workspace('wd_a_000000000000', 'Alpha');
  const wb = workspace('wd_b_000000000000', 'Beta');
  const wc = workspace('wd_c_000000000000', 'Gamma');

  it('groups by workspace following the workspaces-list order', () => {
    const groups = groupSessionsByWorkspace(
      [
        session('s2', '2026-01-03T00:00:00.000Z', { workspace_id: wb.id }),
        session('s1', '2026-01-03T00:00:00.000Z', { workspace_id: wa.id }),
      ],
      [wc, wa, wb],
    );
    expect(groups.map((g) => g.key)).toEqual([wa.id, wb.id]);
    expect(groups.map((g) => g.label)).toEqual(['Alpha', 'Beta']);
    expect(groups[0]!.items.map((s) => s.id)).toEqual(['s1']);
    expect(groups[1]!.items.map((s) => s.id)).toEqual(['s2']);
  });

  it('buckets unknown or missing workspace_ids into an ungrouped trailing bucket', () => {
    const unknown = session('unknown', '2026-01-03T00:00:00.000Z', { workspace_id: 'wd_gone_000000000000' });
    const missing = session('missing', '2026-01-03T00:00:00.000Z', { workspace_id: '' });
    const groups = groupSessionsByWorkspace(
      [missing, unknown, session('known', '2026-01-03T00:00:00.000Z', { workspace_id: wa.id })],
      [wa],
      (w) => w.name,
      'Ungrouped',
    );
    expect(groups.map((g) => g.key)).toEqual([wa.id, WORKSPACE_UNGROUPED_KEY]);
    expect(groups[1]!.label).toBe('Ungrouped');
    // Item order inside the bucket is preserved as given.
    expect(groups[1]!.items.map((s) => s.id)).toEqual(['missing', 'unknown']);
  });

  it('omits workspaces that have no rows', () => {
    const groups = groupSessionsByWorkspace(
      [session('s1', '2026-01-03T00:00:00.000Z', { workspace_id: wa.id })],
      [wa, wb],
    );
    expect(groups.map((g) => g.key)).toEqual([wa.id]);
  });

  it('pulls pinned rows into one leading global bucket when a pinned label is given', () => {
    const pinned = session('pinned', '2026-01-03T00:00:00.000Z', {
      workspace_id: wb.id,
      metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true },
    });
    const groups = groupSessionsByWorkspace(
      [pinned, session('plain', '2026-01-03T00:00:00.000Z', { workspace_id: wa.id })],
      [wa, wb],
      (w) => w.name,
      'Ungrouped',
      'Pinned',
    );
    expect(groups.map((g) => g.key)).toEqual(['pinned', wa.id]);
    expect(groups[0]!.items.map((s) => s.id)).toEqual(['pinned']);
  });

  it('keeps pinned rows inside their workspace bucket without a pinned label', () => {
    const pinned = session('pinned', '2026-01-03T00:00:00.000Z', {
      workspace_id: wb.id,
      metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true },
    });
    const groups = groupSessionsByWorkspace([pinned], [wa, wb]);
    expect(groups.map((g) => g.key)).toEqual([wb.id]);
  });
});

describe('groupSessionsByTime', () => {
  // Local noon so the calendar-day boundaries below land the same way in every
  // timezone (February carries no DST transition).
  const now = new Date(2026, 1, 15, 12, 0, 0).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  /** `hoursAgo` from local noon, so day offsets stay inside the intended date. */
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();

  it('buckets sessions into calendar-day groups and omits empty buckets', () => {
    const groups = groupSessionsByTime(
      [
        session('this-morning', iso(6)),
        session('yesterday', iso(24)),
        session('this-week', iso(24 * 5)),
        session('this-month', iso(24 * 20)),
        session('old', iso(24 * 60)),
        session('bad-date', 'not-a-date'),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'week', 'month', 'older']);
    expect(groups[0]!.items.map((s) => s.id)).toEqual(['this-morning']);
    expect(groups[1]!.items.map((s) => s.id)).toEqual(['yesterday']);
    expect(groups[2]!.items.map((s) => s.id)).toEqual(['this-week']);
    expect(groups[3]!.items.map((s) => s.id)).toEqual(['this-month']);
    expect(groups[4]!.items.map((s) => s.id)).toEqual(['old', 'bad-date']);
  });

  it('splits on the calendar boundary, not on a rolling 24 hours', () => {
    // 13 hours back from local noon is 23:00 the previous date.
    const groups = groupSessionsByTime([session('late-last-night', iso(13))], now);
    expect(groups.map((g) => g.key)).toEqual(['yesterday']);
  });

  it('keeps the week bucket at seven calendar days and the month bucket at thirty', () => {
    const localMidnight = new Date(now);
    localMidnight.setHours(0, 0, 0, 0);
    const dayStart = (offset: number) => new Date(localMidnight.getTime() - offset * DAY).toISOString();
    const groups = groupSessionsByTime(
      [
        session('sixth-day', dayStart(6)),
        session('seventh-day', dayStart(7)),
        session('day-29', dayStart(29)),
        session('day-30', dayStart(30)),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(['week', 'month', 'older']);
    expect(groups[0]!.items.map((s) => s.id)).toEqual(['sixth-day']);
    expect(groups[1]!.items.map((s) => s.id)).toEqual(['seventh-day', 'day-29']);
    expect(groups[2]!.items.map((s) => s.id)).toEqual(['day-30']);
  });

  it('puts pinned sessions in their own leading group regardless of age', () => {
    const pinned = session('pinned', iso(24 * 90), { metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true } });
    const groups = groupSessionsByTime([session('recent', iso(2)), pinned], now);
    expect(groups[0]!.key).toBe('pinned');
    expect(groups[0]!.items.map((s) => s.id)).toEqual(['pinned']);
  });

  it('uses the localized labels when given and bare keys otherwise', () => {
    const groups = groupSessionsByTime([session('today', iso(1))], now, { today: '今天' });
    expect(groups[0]!.label).toBe('今天');
    expect(groupSessionsByTime([session('today', iso(1))], now)[0]!.label).toBe('today');
  });
});
