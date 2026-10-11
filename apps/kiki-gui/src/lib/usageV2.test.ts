// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateDimensionGroups,
  aggregateSourceRows,
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
  usageBucketCompareWindow,
  usageCompareWindow,
  usageDetailViewToSearch,
  usageFiltersHaveScope,
  usageFiltersToSearch,
  usagePointChange,
  usageRangeWindow,
  usageRatioChange,
  usageSeriesKeys,
  usageSessionDeepLink,
  usageSourceKey,
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
  it('defaults to local today / 5h rhythm / model with no query', () => {
    expect(parseUsageFilters('')).toEqual(USAGE_FILTER_DEFAULTS);
    expect(USAGE_FILTER_DEFAULTS.range).toBe('today');
    expect(USAGE_FILTER_DEFAULTS.granularity).toBe('five_hour');
  });

  it('parses every axis from the URL', () => {
    const filters = parseUsageFilters(
      '?granularity=five_hour&range=last_7_days&group_by=provider&workspace=wd_1&include_archived=false&model=example-model&profile=explore&profile=general',
    );
    expect(filters).toEqual({
      granularity: 'five_hour',
      range: 'last_7_days',
      groupBy: 'provider',
      advancedDimension: undefined,
      workspaceId: 'wd_1',
      model: 'example-model',
      provider: undefined,
      profiles: ['explore', 'general'],
      agentIds: [],
      includeArchived: false,
      startAt: undefined,
      endAt: undefined,
    });
  });

  it('keeps an explicit agent/session dimension as the advanced reading', () => {
    // The advanced per-agent tree is reached by an explicit link and is not
    // folded into the profile axis, which reads a different set of records.
    expect(parseUsageFilters('?dimension=agent')).toMatchObject({
      advancedDimension: 'agent',
      groupBy: 'model',
    });
    expect(parseUsageFilters('?dimension=session')).toMatchObject({
      advancedDimension: 'session',
      groupBy: 'model',
    });
    // provider and profile are native axes now, not the agent tree.
    expect(parseUsageFilters('?dimension=profile')).toMatchObject({
      advancedDimension: undefined,
      groupBy: 'profile',
    });
    expect(parseUsageFilters('?dimension=provider')).toMatchObject({
      advancedDimension: undefined,
      groupBy: 'provider',
    });
    // group_by names the axis; dimension= still names the advanced reading.
    expect(parseUsageFilters('?dimension=agent&group_by=provider')).toMatchObject({
      advancedDimension: 'agent',
      groupBy: 'provider',
    });
  });

  it('drops unknown values individually instead of failing the whole URL', () => {
    const filters = parseUsageFilters('?granularity=hourly&range=bogus&group_by=team');
    expect(filters.granularity).toBe('five_hour');
    expect(filters.range).toBe('today');
    expect(filters.groupBy).toBe('model');
  });

  it('accepts custom only with valid bounds', () => {
    expect(parseUsageFilters('?range=custom').range).toBe('today');
    expect(parseUsageFilters('?range=custom&start_at=2000&end_at=1000').range).toBe('today');
    const valid = parseUsageFilters('?range=custom&start_at=1000&end_at=2000');
    expect(valid).toMatchObject({ range: 'custom', startAt: 1000, endAt: 2000 });
  });
});

describe('detail view deep links', () => {
  it('defaults to the source table and degrades unknown values', () => {
    expect(parseUsageDetailView('')).toBe('sources');
    expect(parseUsageDetailView('?view=bogus')).toBe('sources');
    expect(parseUsageDetailView('?view=sessions')).toBe('sessions');
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
    expect(usageDetailViewToSearch('sessions', '?view=breakdown')).toBe('?view=sessions');
    expect(usageDetailViewToSearch('sources', '?view=breakdown')).toBe('');
  });
});

describe('usageFiltersToSearch', () => {
  it('omits defaults so the canonical local-today URL has no query', () => {
    expect(usageFiltersToSearch(USAGE_FILTER_DEFAULTS)).toBe('');
  });

  it('round-trips a fully specified selection', () => {
    const filters: UsageFilters = {
      granularity: 'week',
      range: 'custom',
      groupBy: 'workspace',
      advancedDimension: undefined,
      workspaceId: 'wd_9',
      model: undefined,
      provider: 'example-provider',
      profiles: ['explore'],
      agentIds: ['agent-1'],
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
      { ...USAGE_FILTER_DEFAULTS, range: 'last_7_days' },
      '?server=http%3A%2F%2Fexample.com&token=abc&session=s_1',
    );
    const params = new URLSearchParams(search);
    expect(params.get('server')).toBe('http://example.com');
    expect(params.get('token')).toBe('abc');
    expect(params.get('session')).toBe('s_1');
    expect(params.get('range')).toBe('last_7_days');
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
    expect(readStoredUsageFilters()?.range).toBe('today');
  });
});

describe('buildUsageApiQuery', () => {
  it('sends every axis explicitly with the east-positive timezone offset', () => {
    const query = buildUsageApiQuery(
      { ...USAGE_FILTER_DEFAULTS, range: 'today', includeArchived: false },
      { timezoneOffsetMinutes: 480, pageSize: 25 },
    );
    expect(query).toMatchObject({
      granularity: 'five_hour',
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

  it('omits an explicit all-history range so the server marks defaulted_to_all_history', () => {
    const query = buildUsageApiQuery(
      { ...USAGE_FILTER_DEFAULTS, range: 'all' },
      { timezoneOffsetMinutes: 0 },
    );
    expect(query['range']).toBeUndefined();
  });

  it('asks for the native provider/profile dimensions, never a derived one', () => {
    expect(
      buildUsageApiQuery({ ...USAGE_FILTER_DEFAULTS, groupBy: 'provider' }, { timezoneOffsetMinutes: 0 })['dimension'],
    ).toBe('provider');
    const profile = buildUsageApiQuery(
      { ...USAGE_FILTER_DEFAULTS, groupBy: 'profile', profiles: ['explore', 'general'] },
      { timezoneOffsetMinutes: 0 },
    );
    expect(profile['dimension']).toBe('profile');
    expect(profile['profile']).toEqual(['explore', 'general']);
    expect(
      buildUsageApiQuery({ ...USAGE_FILTER_DEFAULTS, groupBy: 'workspace' }, { timezoneOffsetMinutes: 0 })['dimension'],
    ).toBe('project');
  });

  it('keeps the advanced agent dimension instead of the profile axis', () => {
    const query = buildUsageApiQuery(
      { ...USAGE_FILTER_DEFAULTS, groupBy: 'profile', advancedDimension: 'agent' },
      { timezoneOffsetMinutes: 0 },
    );
    expect(query['dimension']).toBe('agent');
  });

  it('an explicit window overrides the preset bounds without dropping the range', () => {
    const query = buildUsageApiQuery(
      { ...USAGE_FILTER_DEFAULTS, range: 'last_7_days' },
      { timezoneOffsetMinutes: 0, window: { startAt: 500, endAt: 900 } },
    );
    expect(query['start_at']).toBe(500);
    expect(query['end_at']).toBe(900);
    expect(query['range']).toBe('last_7_days');
  });

  it('knows which filter sets narrow records, so a scoped summary is not reused', () => {
    expect(usageFiltersHaveScope(USAGE_FILTER_DEFAULTS)).toBe(false);
    // Grouping and granularity only change how the same records are read.
    expect(usageFiltersHaveScope({ ...USAGE_FILTER_DEFAULTS, groupBy: 'profile' })).toBe(false);
    expect(usageFiltersHaveScope({ ...USAGE_FILTER_DEFAULTS, granularity: 'day' })).toBe(false);
    // Any real filter narrows the result set.
    expect(usageFiltersHaveScope({ ...USAGE_FILTER_DEFAULTS, model: 'example-model' })).toBe(true);
    expect(usageFiltersHaveScope({ ...USAGE_FILTER_DEFAULTS, provider: 'example-provider' })).toBe(true);
    expect(usageFiltersHaveScope({ ...USAGE_FILTER_DEFAULTS, profiles: ['explore'] })).toBe(true);
    expect(usageFiltersHaveScope({ ...USAGE_FILTER_DEFAULTS, workspaceId: 'wd_1' })).toBe(true);
    expect(usageFiltersHaveScope({ ...USAGE_FILTER_DEFAULTS, agentIds: ['agent-1'] })).toBe(true);
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

  it('treats omitted token provenance as a known true zero', () => {
    const rows = aggregateDimensionGroups([
      bucket(1000, [group({ key: 'true-zero', cost_usd_estimated: 0 })]),
    ]);
    expect(rows[0]).toMatchObject({ totalTokens: 0, tokensUnknown: false });
  });

  it('propagates unknown token provenance while retaining a positive known subtotal', () => {
    const rows = aggregateDimensionGroups([
      bucket(1000, [
        group({
          key: 'mixed',
          tokens: { input_other: 7, output: 0, input_cache_read: 0, input_cache_creation: 0 },
          tokens_unknown: true,
          cost_usd_estimated: 2,
        }),
      ]),
    ]);
    expect(rows[0]).toMatchObject({ totalTokens: 7, tokensUnknown: true, costUsdEstimated: 2 });
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


describe('usageSourceKey', () => {
  it('keeps a real "unknown" value apart from a missing one', () => {
    // The server mints opaque identities; a record whose provider really is
    // spelled "unknown" must not collapse into the missing row.
    const literal = usageSourceKey(group({ key: 'p1', provider: 'unknown' }), 'provider');
    const missing = usageSourceKey(group({ key: 'p2', provider: null }), 'provider');
    expect(literal).not.toBe(missing);
    expect(literal).toBe(usageSourceKey(group({ key: 'p9', provider: 'unknown' }), 'provider'));
    expect(missing).toBe('unknown');
  });

  it('namespaces the provider and profile identities', () => {
    expect(usageSourceKey(group({ key: 'x', profile_name: 'explore' }), 'profile'))
      .toBe('profile:"explore"');
    expect(usageSourceKey(group({ key: 'x', provider: 'example-provider' }), 'provider'))
      .toBe('provider:"example-provider"');
  });

  it('uses the wire key directly on the model and workspace axes', () => {
    expect(usageSourceKey(group({ key: 'k2-thinking', model_alias: 'k2-thinking' }), 'model')).toBe('k2-thinking');
    expect(usageSourceKey(group({ key: 'wd_1' }), 'workspace')).toBe('wd_1');
  });
});

describe('aggregateSourceRows', () => {
  const trend = [
    bucket(1000, [
      group({ key: 'm1', model_alias: 'm1', provider: 'example-provider', profile_name: 'explore', cost_usd_estimated: 2, tokens: { input_other: 100, output: 0, input_cache_read: 0, input_cache_creation: 0 } }),
      group({ key: 'unknown', cost_usd_estimated: 0.5, cost_unknown: true }),
    ]),
    bucket(2000, [
      group({ key: 'm1', model_alias: 'm1', provider: 'example-provider', profile_name: 'explore', cost_usd_estimated: 1 }),
      group({ key: 'm2', model_alias: 'm2', provider: 'other-provider', profile_name: null, cost_usd_estimated: 3 }),
    ]),
  ];

  it('sums one row per source and keeps a missing source as its own row with its amount', () => {
    const rows = aggregateSourceRows(trend, 'provider');
    // Cost-descending; the unknown row keeps its amount rather than dropping.
    expect(rows.map((row) => row.costUsdEstimated)).toEqual([3, 3, 0.5]);
    expect(rows.map((row) => row.value)).toEqual([
      'example-provider',
      'other-provider',
      null,
    ]);
    // The unknown row keeps its money and its unknown flag; it is not a zero.
    const unknown = rows.at(-1)!;
    expect(unknown.key).toBe('unknown');
    expect(unknown.costUsdEstimated).toBe(0.5);
    expect(unknown.costUnknown).toBe(true);
  });

  it('offers a filter only from the raw record attribution, never the row key', () => {
    const rows = aggregateSourceRows(trend, 'profile');
    const explore = rows.find((row) => row.value === 'explore')!;
    expect(explore.filter).toEqual({ field: 'profile', value: 'explore' });
    // A profile with no attribution has no exact filter and no sentinel.
    expect(rows.find((row) => row.key === 'unknown')!.filter).toBeNull();
    const workspaceRows = aggregateSourceRows([bucket(1, [group({ key: 'wd_9' })])], 'workspace');
    expect(workspaceRows[0]?.filter).toEqual({ field: 'workspace.id', value: 'wd_9' });
  });

  it('lists the models behind a non-model row for its secondary line', () => {
    const rows = aggregateSourceRows(trend, 'provider');
    expect(rows.find((row) => row.value === 'example-provider')!.modelAliases).toEqual(['m1']);
    expect(rows.find((row) => row.value === 'other-provider')!.modelAliases).toEqual(['m2']);
  });

  it('flags a partial token subtotal without hiding the known tokens', () => {
    const rows = aggregateSourceRows(
      [bucket(1, [group({ key: 'm1', model_alias: 'm1', tokens_unknown: true, tokens: { input_other: 7, output: 0, input_cache_read: 0, input_cache_creation: 0 }, cost_usd_estimated: 2 })])],
      'model',
    );
    expect(rows[0]).toMatchObject({ totalTokens: 7, tokensUnknown: true, costUsdEstimated: 2 });
  });
});

describe('usageSeriesKeys', () => {
  it('ranks the whole range and caps the series, keeping the rest for the table', () => {
    const trend = [
      bucket(1, [
        group({ key: 'a', model_alias: 'a', cost_usd_estimated: 1 }),
        group({ key: 'b', model_alias: 'b', cost_usd_estimated: 5 }),
      ]),
      bucket(2, [
        group({ key: 'c', model_alias: 'c', cost_usd_estimated: 3 }),
        group({ key: 'd', model_alias: 'd', cost_usd_estimated: 0.1 }),
      ]),
    ];
    expect(usageSeriesKeys(trend, 'model', 'cost', 2)).toEqual(['b', 'c']);
    // The cache metric plots a rate, so it never produces a series.
    expect(usageSeriesKeys(trend, 'model', 'cache', 2)).toEqual([]);
  });
});

describe('comparison windows', () => {
  const DAY = 86_400_000;

  it('compares today against yesterday up to the same local time', () => {
    const nowMs = new Date(2026, 9, 7, 18, 0, 0).getTime();
    const startAt = new Date(2026, 9, 7, 0, 0, 0).getTime();
    const prior = usageCompareWindow({ startAt, endAt: startAt + DAY }, 480, nowMs)!;
    expect(prior.startAt).toBe(new Date(2026, 9, 6, 0, 0, 0).getTime());
    expect(prior.endAt).toBe(new Date(2026, 9, 6, 18, 0, 0).getTime());
  });

  it('moves whole local days across a DST change instead of assuming 24h', () => {
    // US DST ends on 2026-11-01; the offset that day is still the summer one,
    // so a naive 24h shift would land an hour off the previous local midnight.
    const tz = 240;
    const startAt = new Date(2026, 10, 1, 0, 0, 0).getTime() + tz * 60_000 - 240 * 60_000;
    const prior = usageCompareWindow({ startAt, endAt: startAt + DAY }, tz, new Date(2026, 10, 2).getTime());
    expect(prior).not.toBeNull();
    // The prior window's local length follows the clock, not a fixed 24h.
    expect(prior!.endAt - prior!.startAt).toBeLessThanOrEqual(DAY);
  });

  it('has no predecessor for unbounded all-history', () => {
    expect(usageCompareWindow({ startAt: 0, endAt: 0 }, 0, Date.now())).toBeNull();
  });

  it('derives the selected bucket its own exact window, clipped to the range', () => {
    const nowMs = new Date(2026, 9, 7, 18, 0, 0).getTime();
    const rangeStart = new Date(2026, 9, 1, 0, 0, 0).getTime();
    const rangeEnd = new Date(2026, 9, 8, 0, 0, 0).getTime();
    const bucket = { start_at: new Date(2026, 9, 4, 0, 0, 0).getTime(), end_at: new Date(2026, 9, 5, 0, 0, 0).getTime() };
    // The bucket's own day, moved back by the seven-day span: 10/04 -> 09/27.
    const prior = usageBucketCompareWindow({ startAt: rangeStart, endAt: rangeEnd }, bucket, 480, nowMs)!;
    expect(prior).toEqual({
      startAt: new Date(2026, 8, 27, 0, 0, 0).getTime(),
      endAt: new Date(2026, 8, 28, 0, 0, 0).getTime(),
    });
  });

  it('shifts sub-day windows by their exact length', () => {
    const startAt = new Date(2026, 9, 7, 5, 0, 0).getTime();
    const endAt = new Date(2026, 9, 7, 10, 0, 0).getTime();
    const prior = usageCompareWindow({ startAt, endAt }, 0, endAt)!;
    expect(prior.startAt).toBe(new Date(2026, 9, 7, 0, 0, 0).getTime());
    expect(prior.endAt).toBe(new Date(2026, 9, 7, 5, 0, 0).getTime());
  });

  it('resolves preset ranges to local calendar windows and leaves all-history unbounded', () => {
    const nowMs = new Date(2026, 9, 7, 12, 0, 0).getTime();
    const today = usageRangeWindow({ ...USAGE_FILTER_DEFAULTS, range: 'today' }, 480, nowMs)!;
    expect(today.startAt).toBe(new Date(2026, 9, 7, 0, 0, 0).getTime());
    expect(today.endAt).toBe(new Date(2026, 9, 8, 0, 0, 0).getTime());
    expect(usageRangeWindow({ ...USAGE_FILTER_DEFAULTS, range: 'all' }, 480, nowMs)).toBeNull();
    const custom = usageRangeWindow(
      { ...USAGE_FILTER_DEFAULTS, range: 'custom', startAt: 1000, endAt: 2000 },
      0,
      nowMs,
    );
    expect(custom).toEqual({ startAt: 1000, endAt: 2000 });
  });
});

describe('comparison deltas', () => {
  it('refuses to divide by a zero prior period', () => {
    expect(usageRatioChange(5, 0)).toEqual({ kind: 'priorZero' });
    expect(usageRatioChange(5, 4)).toEqual({ kind: 'delta', ratio: 0.25 });
  });

  it('refuses to compare an unknown measurement', () => {
    expect(usageRatioChange(Number.NaN, 4)).toEqual({ kind: 'unavailable' });
  });

  it('reports cache hit rate in percentage points', () => {
    expect(usagePointChange(0.5, 0.4)).toEqual({ kind: 'delta', ratio: 10 });
    expect(usagePointChange(0.238, 0.4)).toEqual({ kind: 'delta', ratio: -16.2 });
    expect(usagePointChange(null, 0.4)).toEqual({ kind: 'unavailable' });
  });
});
