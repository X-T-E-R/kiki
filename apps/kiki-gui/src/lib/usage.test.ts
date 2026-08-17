import { describe, expect, it } from 'vitest';

import type { Session, SessionUsage } from '@moonshot-ai/protocol';

import {
  aggregateUsage,
  bucketSessionsByDay,
  earliestActivityDay,
  filterSessionsByRange,
  formatCostUsd,
  formatGrouped,
  formatTokensPerSecond,
  groupUsageByModel,
  localDayStart,
  rankSessionsByCost,
  usageRangeStart,
} from './usage';

const DAY_MS = 24 * 3600_000;
// A fixed "now" in the middle of a local day so day-boundary math never
// straddles midnight while the suite runs.
const NOW = localDayStart(new Date('2026-08-10T12:00:00Z').getTime()) + 12 * 3600_000;

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
    ...overrides,
  };
}

function session(
  id: string,
  overrides: Partial<Session> & { updatedDaysAgo?: number } = {},
): Session {
  const { updatedDaysAgo = 0, ...rest } = overrides;
  return {
    id,
    workspace_id: 'wd_test',
    title: id,
    created_at: new Date(NOW - 30 * DAY_MS).toISOString(),
    updated_at: new Date(NOW - updatedDaysAgo * DAY_MS).toISOString(),
    busy: false,
    metadata: { cwd: 'C:/tmp' },
    agent_config: { model: '' },
    usage: usage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
    ...rest,
  };
}

describe('usageRangeStart', () => {
  it('starts today at local midnight, 7d six days back, 30d twenty-nine back', () => {
    const today = localDayStart(NOW);
    expect(usageRangeStart('today', NOW)).toBe(today);
    expect(usageRangeStart('7d', NOW)).toBe(today - 6 * DAY_MS);
    expect(usageRangeStart('30d', NOW)).toBe(today - 29 * DAY_MS);
    expect(usageRangeStart('all', NOW)).toBeUndefined();
  });
});

describe('filterSessionsByRange', () => {
  const sessions = [
    session('today', { updatedDaysAgo: 0 }),
    session('week', { updatedDaysAgo: 5 }),
    session('month', { updatedDaysAgo: 20 }),
    session('ancient', { updatedDaysAgo: 100 }),
    session('archived-recent', { updatedDaysAgo: 0, archived: true }),
  ];

  it('keeps sessions active inside the window', () => {
    expect(filterSessionsByRange(sessions, 'today', NOW).map((s) => s.id)).toEqual([
      'today',
      'archived-recent',
    ]);
    expect(filterSessionsByRange(sessions, '7d', NOW).map((s) => s.id)).toEqual([
      'today',
      'week',
      'archived-recent',
    ]);
    expect(filterSessionsByRange(sessions, '30d', NOW)).toHaveLength(4);
    expect(filterSessionsByRange(sessions, 'all', NOW)).toHaveLength(5);
  });

  it('drops archived sessions only when asked', () => {
    expect(
      filterSessionsByRange(sessions, 'all', NOW, { includeArchived: false }).map((s) => s.id),
    ).toEqual(['today', 'week', 'month', 'ancient']);
  });
});

describe('aggregateUsage', () => {
  it('sums every counter and derives cache hits from the full input volume', () => {
    const totals = aggregateUsage([
      session('a', {
        usage: usage({
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 3000,
          cache_creation_tokens: 200,
          total_cost_usd: 1.5,
          turn_count: 3,
        }),
      }),
      session('b', {
        usage: usage({
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 1000,
          cache_creation_tokens: 300,
          total_cost_usd: 0.5,
          turn_count: 2,
        }),
      }),
    ]);
    expect(totals).toMatchObject({
      sessions: 2,
      turns: 5,
      costUsd: 2,
      inputTokens: 2000,
      outputTokens: 1000,
      cacheReadTokens: 4000,
      cacheCreationTokens: 500,
      totalTokens: 7500,
    });
    // 4000 / (2000 other + 4000 cache read + 500 cache creation).
    expect(totals.cacheHitRate).toBeCloseTo(8 / 13, 10);
  });

  it('distinguishes cache writes from no input usage', () => {
    expect(aggregateUsage([]).cacheHitRate).toBeNull();
    expect(aggregateUsage([session('a')]).cacheHitRate).toBeNull();
    expect(
      aggregateUsage([
        session('cache-write', { usage: usage({ cache_creation_tokens: 250 }) }),
      ]).cacheHitRate,
    ).toBe(0);
  });
});

describe('groupUsageByModel', () => {
  it('rolls up per model, most expensive first, keeping the empty (default) key', () => {
    const groups = groupUsageByModel([
      session('a', { agent_config: { model: 'kimi/k2' }, usage: usage({ total_cost_usd: 2, turn_count: 4, input_tokens: 100 }) }),
      session('b', { agent_config: { model: 'kimi/k2' }, usage: usage({ total_cost_usd: 1, turn_count: 1, output_tokens: 50 }) }),
      session('c', { usage: usage({ total_cost_usd: 9, cache_read_tokens: 800 }) }),
    ]);
    expect(groups.map((group) => group.model)).toEqual(['', 'kimi/k2']);
    expect(groups[0]).toMatchObject({ sessions: 1, costUsd: 9, totalTokens: 800, turns: 0 });
    expect(groups[1]).toMatchObject({ sessions: 2, costUsd: 3, totalTokens: 150, turns: 5 });
  });
});

describe('bucketSessionsByDay', () => {
  it('zero-fills the span and lands each session in its local day', () => {
    const from = localDayStart(NOW) - 2 * DAY_MS;
    const buckets = bucketSessionsByDay(
      [
        session('today', { updatedDaysAgo: 0, usage: usage({ total_cost_usd: 1, input_tokens: 10 }) }),
        session('also-today', { updatedDaysAgo: 0, usage: usage({ total_cost_usd: 2, output_tokens: 20 }) }),
        session('two-back', { updatedDaysAgo: 2, usage: usage({ total_cost_usd: 4 }) }),
        session('outside', { updatedDaysAgo: 30, usage: usage({ total_cost_usd: 100 }) }),
      ],
      from,
      NOW,
    );
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toMatchObject({ dayStartMs: from, sessions: 1, costUsd: 4 });
    expect(buckets[1]).toMatchObject({ sessions: 0, costUsd: 0, totalTokens: 0 });
    expect(buckets[2]).toMatchObject({
      dayStartMs: localDayStart(NOW),
      sessions: 2,
      costUsd: 3,
      totalTokens: 30,
    });
  });

  it('returns nothing for an inverted span', () => {
    expect(bucketSessionsByDay([session('a')], NOW, NOW - DAY_MS)).toEqual([]);
  });
});

describe('earliestActivityDay', () => {
  it('finds the oldest last-active day; undefined when empty', () => {
    const sessions = [session('new', { updatedDaysAgo: 1 }), session('old', { updatedDaysAgo: 12 })];
    expect(earliestActivityDay(sessions)).toBe(localDayStart(NOW) - 12 * DAY_MS);
    expect(earliestActivityDay([])).toBeUndefined();
  });
});

describe('rankSessionsByCost', () => {
  it('orders by lifetime cost, most expensive first', () => {
    const ranked = rankSessionsByCost([
      session('cheap', { usage: usage({ total_cost_usd: 0.1 }) }),
      session('pricey', { usage: usage({ total_cost_usd: 9.9 }) }),
      session('mid', { usage: usage({ total_cost_usd: 1 }) }),
    ]);
    expect(ranked.map((s) => s.id)).toEqual(['pricey', 'mid', 'cheap']);
  });
});

describe('formatCostUsd', () => {
  it('scales precision with magnitude', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(0.00432)).toBe('$0.0043');
    expect(formatCostUsd(0.4321)).toBe('$0.432');
    expect(formatCostUsd(12.345)).toBe('$12.35'); // rounds up from the third decimal
    expect(formatCostUsd(12.344)).toBe('$12.34');
  });

  it('groups thousands and keeps a carried cent in the integer part', () => {
    expect(formatCostUsd(1234.56)).toBe('$1,234.56');
    expect(formatCostUsd(999.999)).toBe('$1,000.00');
  });
});

describe('formatGrouped', () => {
  it('separates thousands without locale dependence', () => {
    expect(formatGrouped(0)).toBe('0');
    expect(formatGrouped(999)).toBe('999');
    expect(formatGrouped(12483201)).toBe('12,483,201');
  });
});

describe('formatTokensPerSecond', () => {
  it('keeps one decimal below ten and rounds larger rates', () => {
    expect(formatTokensPerSecond(3.26)).toBe('3.3');
    expect(formatTokensPerSecond(9.95)).toBe('10');
    expect(formatTokensPerSecond(19.6)).toBe('20');
    expect(formatTokensPerSecond(Number.NaN)).toBe('0');
  });
});
