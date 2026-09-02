// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateDimensionGroups,
  buildAgentTree,
  buildUsageApiQuery,
  bucketLabel,
  burnRatePerHour,
  cacheHitRateOf,
  parseUsageDetailView,
  parseUsageFilters,
  readStoredUsageFilters,
  searchHasUsageParams,
  totalTokensOf,
  USAGE_FILTER_DEFAULTS,
  USAGE_FILTERS_STORAGE_KEY,
  usageDetailViewToSearch,
  usageFiltersToSearch,
  usageSessionDeepLink,
  writeStoredUsageFilters,
  type UsageFilters,
  type UsageGroupWire,
  type UsageTrendBucketWire,
} from './usageV2';

function group(overrides: Partial<UsageGroupWire> & { key: string }): UsageGroupWire {
  return {
    tokens: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    cost_usd_estimated: 0,
    cost_unknown: false,
    provider: null,
    model_alias: null,
    agent_id: null,
    parent_agent_id: null,
    profile_name: null,
    ...overrides,
  };
}

function bucket(startAt: number, groups: UsageGroupWire[]): UsageTrendBucketWire {
  return {
    key: String(startAt),
    start_at: startAt,
    end_at: startAt + 24 * 3600_000,
    groups,
    drilldown: { sessions: [], sessions_truncated: false },
  };
}

describe('parseUsageFilters', () => {
  it('defaults to all history / day / model with no query', () => {
    expect(parseUsageFilters('')).toEqual(USAGE_FILTER_DEFAULTS);
    expect(USAGE_FILTER_DEFAULTS.range).toBe('all');
  });

  it('parses every axis from the URL', () => {
    const filters = parseUsageFilters(
      '?granularity=five_hour&range=last_7_days&dimension=agent&workspace=wd_1&include_archived=false',
    );
    expect(filters).toEqual({
      granularity: 'five_hour',
      range: 'last_7_days',
      dimension: 'agent',
      workspaceId: 'wd_1',
      includeArchived: false,
      startAt: undefined,
      endAt: undefined,
    });
  });

  it('drops unknown values individually instead of failing the whole URL', () => {
    const filters = parseUsageFilters('?granularity=hourly&range=bogus&dimension=model');
    expect(filters.granularity).toBe('day');
    expect(filters.range).toBe('all');
    expect(filters.dimension).toBe('model');
  });

  it('accepts custom only with valid bounds', () => {
    expect(parseUsageFilters('?range=custom').range).toBe('all');
    expect(parseUsageFilters('?range=custom&start_at=2000&end_at=1000').range).toBe('all');
    const valid = parseUsageFilters('?range=custom&start_at=1000&end_at=2000');
    expect(valid).toMatchObject({ range: 'custom', startAt: 1000, endAt: 2000 });
  });
});

describe('detail view deep links', () => {
  it('defaults to the sessions tab and degrades unknown values', () => {
    expect(parseUsageDetailView('')).toBe('sessions');
    expect(parseUsageDetailView('?view=bogus')).toBe('sessions');
    expect(parseUsageDetailView('?view=breakdown')).toBe('breakdown');
    expect(parseUsageDetailView('?view=five_hour')).toBe('five_hour');
  });

  it('round-trips through the URL while preserving filter and locator params', () => {
    const search = usageDetailViewToSearch(
      'breakdown',
      '?dimension=agent&session=s_1&server=http%3A%2F%2Fexample.com',
    );
    const params = new URLSearchParams(search);
    expect(params.get('view')).toBe('breakdown');
    expect(params.get('dimension')).toBe('agent');
    expect(params.get('session')).toBe('s_1');
    expect(params.get('server')).toBe('http://example.com');
    // The default view is omitted so the canonical URL stays clean.
    expect(usageDetailViewToSearch('sessions', '?view=breakdown')).toBe('');
  });
});

describe('usageFiltersToSearch', () => {
  it('omits defaults so the canonical all-history URL has no query', () => {
    expect(usageFiltersToSearch(USAGE_FILTER_DEFAULTS)).toBe('');
  });

  it('round-trips a fully specified selection', () => {
    const filters: UsageFilters = {
      granularity: 'week',
      range: 'custom',
      dimension: 'project',
      workspaceId: 'wd_9',
      includeArchived: false,
      startAt: 1000,
      endAt: 2000,
    };
    const search = usageFiltersToSearch(filters);
    expect(searchHasUsageParams(search)).toBe(true);
    expect(parseUsageFilters(search)).toEqual(filters);
  });

  it('preserves unrelated params (server/token/session deep-link keys)', () => {
    const search = usageFiltersToSearch(
      { ...USAGE_FILTER_DEFAULTS, range: 'today' },
      '?server=http%3A%2F%2Fexample.com&token=abc&session=s_1',
    );
    const params = new URLSearchParams(search);
    expect(params.get('server')).toBe('http://example.com');
    expect(params.get('token')).toBe('abc');
    expect(params.get('session')).toBe('s_1');
    expect(params.get('range')).toBe('today');
  });
});

describe('stored filters', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips through localStorage', () => {
    const filters: UsageFilters = {
      ...USAGE_FILTER_DEFAULTS,
      range: 'this_month',
      granularity: 'month',
    };
    writeStoredUsageFilters(filters);
    expect(readStoredUsageFilters()).toEqual(filters);
  });

  it('returns undefined for missing or corrupt storage', () => {
    expect(readStoredUsageFilters()).toBeUndefined();
    localStorage.setItem(USAGE_FILTERS_STORAGE_KEY, '{nope');
    expect(readStoredUsageFilters()).toBeUndefined();
    localStorage.setItem(USAGE_FILTERS_STORAGE_KEY, JSON.stringify({ range: 'forever' }));
    expect(readStoredUsageFilters()?.range).toBe('all');
  });
});

describe('buildUsageApiQuery', () => {
  it('sends every axis explicitly with the east-positive timezone offset', () => {
    const query = buildUsageApiQuery(
      { ...USAGE_FILTER_DEFAULTS, range: 'today', includeArchived: false },
      { timezoneOffsetMinutes: 480, pageSize: 25 },
    );
    expect(query).toMatchObject({
      granularity: 'day',
      range: 'today',
      dimension: 'model',
      include_archived: 'false',
      timezone_offset_minutes: 480,
      page_size: 25,
    });
    expect(query['start_at']).toBeUndefined();
    expect(query['page_token']).toBeUndefined();
  });

  it('passes custom bounds and the page token through untouched', () => {
    const query = buildUsageApiQuery(
      { ...USAGE_FILTER_DEFAULTS, range: 'custom', startAt: 100, endAt: 200 },
      { timezoneOffsetMinutes: 0, pageToken: 'tok_1' },
    );
    expect(query).toMatchObject({ start_at: 100, end_at: 200, page_token: 'tok_1' });
  });

  it('never sends start_at/end_at for non-custom ranges', () => {
    const query = buildUsageApiQuery(
      { ...USAGE_FILTER_DEFAULTS, range: 'last_7_days', startAt: 100, endAt: 200 },
      { timezoneOffsetMinutes: 0 },
    );
    expect(query['start_at']).toBeUndefined();
    expect(query['end_at']).toBeUndefined();
  });

  it('omits range for all history so the server marks defaulted_to_all_history', () => {
    const query = buildUsageApiQuery(USAGE_FILTER_DEFAULTS, { timezoneOffsetMinutes: 0 });
    expect(query['range']).toBeUndefined();
  });
});

describe('aggregateDimensionGroups', () => {
  it('rolls buckets up per key, cost-descending, preserving unknown keys', () => {
    const rows = aggregateDimensionGroups([
      bucket(1000, [
        group({
          key: 'k2-thinking',
          provider: 'kimi',
          model_alias: 'k2-thinking',
          tokens: { input_other: 10, output: 5, input_cache_read: 20, input_cache_creation: 5 },
          cost_usd_estimated: 1,
        }),
      ]),
      bucket(2000, [
        group({ key: 'k2-thinking', provider: 'kimi', model_alias: 'k2-thinking', cost_usd_estimated: 2 }),
        group({ key: 'unknown', cost_usd_estimated: 0.5, cost_unknown: true }),
      ]),
    ]);
    expect(rows.map((row) => row.key)).toEqual(['k2-thinking', 'unknown']);
    expect(rows[0]).toMatchObject({
      costUsdEstimated: 3,
      totalTokens: 40,
      provider: 'kimi',
      modelAlias: 'k2-thinking',
      mixedAttribution: false,
    });
    expect(rows[1]).toMatchObject({ costUnknown: true, provider: null });
  });

  it('flags conflicting attribution instead of guessing', () => {
    const rows = aggregateDimensionGroups([
      bucket(1000, [group({ key: 'alias', provider: 'a', cost_usd_estimated: 2 })]),
      bucket(2000, [group({ key: 'alias', provider: 'b', cost_usd_estimated: 1 })]),
    ]);
    expect(rows[0]?.mixedAttribution).toBe(true);
    expect(rows[0]?.provider).toBe('a');
  });
});

describe('buildAgentTree', () => {
  it('nests children under parents and keeps orphans visible', () => {
    const rows = aggregateDimensionGroups([
      bucket(1000, [
        group({ key: 'agent-main', agent_id: 'agent-main', cost_usd_estimated: 5 }),
        group({
          key: 'agent-sub',
          agent_id: 'agent-sub',
          parent_agent_id: 'agent-main',
          cost_usd_estimated: 2,
        }),
        group({
          key: 'agent-orphan',
          agent_id: 'agent-orphan',
          parent_agent_id: 'agent-gone',
          cost_usd_estimated: 1,
        }),
      ]),
    ]);
    const tree = buildAgentTree(rows);
    expect(tree.roots.map((row) => row.key)).toEqual(['agent-main']);
    expect(tree.childrenByParent.get('agent-main')?.map((row) => row.key)).toEqual(['agent-sub']);
    expect(tree.childrenByParent.get('agent-gone')?.map((row) => row.key)).toEqual([
      'agent-orphan',
    ]);
  });
});

describe('rates and labels', () => {
  it('computes cache hit over the full input volume', () => {
    expect(
      cacheHitRateOf({
        tokens: { input_other: 100, output: 50, input_cache_read: 300, input_cache_creation: 100 },
        cost_usd_estimated: 0,
        cost_unknown: false,
      }),
    ).toBeCloseTo(0.6, 10);
    expect(
      cacheHitRateOf({
        tokens: { input_other: 0, output: 5, input_cache_read: 0, input_cache_creation: 0 },
        cost_usd_estimated: 0,
        cost_unknown: false,
      }),
    ).toBeNull();
  });

  it('sums all four token counters', () => {
    expect(
      totalTokensOf({
        tokens: { input_other: 1, output: 2, input_cache_read: 4, input_cache_creation: 8 },
        cost_usd_estimated: 0,
        cost_unknown: false,
      }),
    ).toBe(15);
  });

  it('labels 5h buckets with day and hour span', () => {
    const start = new Date(2026, 8, 2, 10, 0, 0).getTime();
    const label = bucketLabel(
      { start_at: start, end_at: start + 5 * 3600_000 },
      'five_hour',
      'en',
    );
    expect(label).toContain('10:00');
    expect(label).toContain('15:00');
  });

  it('computes burn rate over hours elapsed today with a floor', () => {
    const now = new Date(2026, 8, 2, 12, 0, 0).getTime();
    expect(burnRatePerHour(1200, now)).toBeCloseTo(100, 5);
    // Just after midnight: the 15-minute floor keeps the rate finite.
    const early = new Date(2026, 8, 2, 0, 5, 0).getTime();
    expect(burnRatePerHour(100, early)).toBeCloseTo(400, 5);
  });

  it('builds the prefiltered session deep link', () => {
    expect(usageSessionDeepLink('s 1')).toBe('/usage?dimension=session&session=s%201');
  });
});
