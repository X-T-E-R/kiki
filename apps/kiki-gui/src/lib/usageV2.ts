/**
 * Usage dashboard — the client half of `GET /api/usage`. This module owns:
 *
 *   - wire type aliases from the shared @kiki/protocol schema;
 *   - the filter model (granularity × range × grouping × source filters) plus
 *     its URL query serialization — the URL is the canonical, shareable state;
 *   - localStorage persistence for filter selections; the page intentionally
 *     ignores stored bounds on query-less visits so the default stays bounded;
 *   - pure derivations the page needs: cross-bucket dimension rollups,
 *     agent parent/child trees, cache hit rate, bucket labels, burn rate.
 *
 * Contract notes honored here (see the V2-b consumer contract):
 *   - the GUI no-query default range is 'today'; an explicit 'all' range still
 *     omits `range` so the server's `query.range.defaulted_to_all_history` flag
 *     is surfaced, never hidden;
 *   - trend buckets arrive time-ascending, session items cost-descending;
 *   - `cost_usd_estimated` is only the priced part when `cost_unknown`;
 *   - dimension keys are modelAlias for model, 'unknown' for old records —
 *     never reconstructed from billing model/provider;
 *   - provider / parent / profile `null` means missing data, not '';
 *   - start_at / end_at / bucket start_at / end_at are epoch milliseconds;
 *   - timezone_offset_minutes is east-positive: -new Date().getTimezoneOffset().
 *
 * Grouping vs. filtering: `groupBy` is the reading axis (model / provider /
 * agent profile / workspace) and never narrows the result set, while
 * `model` / `provider` / `agentIds` are real API filters. The GUI grouping name
 * rides the URL as `group_by`; the wire `dimension` is derived from it and is
 * never sent as `provider` (the service has no such enum).
 */

import type { Locale } from '@kiki/session-core/i18n';

import { spaceStorage } from './spaceStorage';

// ---------------------------------------------------------------------------
// Shared wire type aliases
// ---------------------------------------------------------------------------

export type UsageGranularity = UsageResponseWire['query']['granularity'];
export type UsageRangePreset = UsageResponseWire['query']['range']['preset'];
export type UsageDimension = UsageResponseWire['query']['dimension'];

/** What the source table groups by. One axis at a time, never mixed. */
export type UsageGroupBy = 'model' | 'provider' | 'profile' | 'workspace';

/**
 * The four legacy wire dimensions, kept as their own reading: an explicit
 * `dimension=agent|session` deep link asks for the advanced agent tree or the
 * per-session view, and `group_by` must not swallow that intent.
 */
export type UsageLegacyDimension = 'agent' | 'session';

/** What the trend chart and the source table measure. */
export type UsageMetric = 'cost' | 'tokens' | 'cache';

export const USAGE_GROUPINGS: readonly UsageGroupBy[] = ['model', 'provider', 'profile', 'workspace'];
export const USAGE_METRICS: readonly UsageMetric[] = ['cost', 'tokens', 'cache'];

/**
 * The wire dimension each GUI grouping reads. provider and profile are native
 * server dimensions with exact per-record attribution, so the page never
 * rolls attribution up from a response that cannot express it.
 */
export const USAGE_GROUP_BY_DIMENSION: Readonly<Record<UsageGroupBy, UsageDimension>> = {
  model: 'model',
  provider: 'provider',
  profile: 'profile',
  workspace: 'project',
};

export const USAGE_GRANULARITIES: readonly UsageGranularity[] = [
  'day',
  'week',
  'month',
  'session',
  'five_hour',
];
export const USAGE_RANGE_PRESETS: readonly UsageRangePreset[] = [
  'today',
  'last_7_days',
  'this_week',
  'this_month',
  'all',
  'custom',
];
export const USAGE_DIMENSIONS: readonly UsageDimension[] = [
  'model',
  'agent',
  'project',
  'session',
];

/** The group-by axes that have no legacy-dimension counterpart. */
export const USAGE_SIMPLE_GROUPINGS: readonly UsageGroupBy[] = ['model', 'provider', 'profile', 'workspace'];

export type UsageResponseWire = import('@kiki/protocol').UsageResponse;
export type UsageAggregateWire = import('@kiki/protocol').UsageAggregateWire;
export type UsageTokensWire = UsageAggregateWire['tokens'];
export type UsageTrendBucketWire = UsageResponseWire['trend'][number];
export type UsageGroupWire = UsageTrendBucketWire['groups'][number];
export type UsageDrilldownSessionWire = UsageTrendBucketWire['drilldown']['sessions'][number];
export type UsageSessionItemWire = UsageResponseWire['sessions']['items'][number];

// ---------------------------------------------------------------------------
// Filter model — granularity × range × dimension, URL-carried and persisted
// ---------------------------------------------------------------------------

export interface UsageFilters {
  readonly granularity: UsageGranularity;
  readonly range: UsageRangePreset;
  /** Reading axis for the source table; the wire dimension derives from it. */
  readonly groupBy: UsageGroupBy;
  /**
   * The advanced per-agent or per-session reading, reached only by an explicit
   * `dimension=agent|session` link. It replaces the axis rather than mixing
   * with it, so the agent tree and per-session view stay off the main path.
   */
  readonly advancedDimension: UsageLegacyDimension | undefined;
  /** Single-workscope pick; the wire accepts repeated ids, the GUI offers one. */
  readonly workspaceId: string | undefined;
  /** Real API source filters. Values are ids the API actually matches. */
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly profiles: readonly string[];
  readonly agentIds: readonly string[];
  readonly includeArchived: boolean;
  /** Custom range bounds, epoch ms (end exclusive). Only with range=custom. */
  readonly startAt: number | undefined;
  readonly endAt: number | undefined;
}

/** The no-query state: local today, 5h rhythm, model grouping. */
export const USAGE_FILTER_DEFAULTS: UsageFilters = {
  granularity: 'five_hour',
  range: 'today',
  groupBy: 'model',
  advancedDimension: undefined,
  workspaceId: undefined,
  model: undefined,
  provider: undefined,
  profiles: [],
  agentIds: [],
  includeArchived: true,
  startAt: undefined,
  endAt: undefined,
};

/**
 * Whether a filter set narrows records. The Live strip's today summary is only
 * interchangeable with the main query when nothing narrows it: a summary for
 * one model is not "all of today", so the strip must not claim it is.
 */
export function usageFiltersHaveScope(filters: UsageFilters): boolean {
  return (
    filters.workspaceId !== undefined ||
    filters.model !== undefined ||
    filters.provider !== undefined ||
    filters.profiles.length > 0 ||
    filters.agentIds.length > 0
  );
}

export const USAGE_FILTERS_STORAGE_KEY = 'kiki.usage.filters.v2';

function isGranularity(value: string): value is UsageGranularity {
  return (USAGE_GRANULARITIES as readonly string[]).includes(value);
}
function isRangePreset(value: string): value is UsageRangePreset {
  return (USAGE_RANGE_PRESETS as readonly string[]).includes(value);
}
function isDimension(value: string): value is UsageDimension {
  return (USAGE_DIMENSIONS as readonly string[]).includes(value);
}
function isGroupBy(value: string): value is UsageGroupBy {
  return (USAGE_GROUPINGS as readonly string[]).includes(value);
}

function parseNonnegativeInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalParam(value: string | null): string | undefined {
  return value !== null && value !== '' ? value : undefined;
}

/**
 * URL → filters. Unknown/invalid values fall back to defaults individually so
 * a hand-edited link degrades instead of breaking. start_at/end_at are honored
 * only with range=custom (the server enforces the same pairing).
 *
 * `dimension=agent|session` is an explicit advanced reading and is preserved
 * as-is. A legacy `dimension=model|project` link maps onto the axis that reads
 * the same data; provider/profile are native dimensions now, so a link naming
 * either lands on its own axis.
 */
export function parseUsageFilters(search: string): UsageFilters {
  const params = new URLSearchParams(search);
  const granularity = params.get('granularity');
  const range = params.get('range');
  const groupBy = params.get('group_by');
  const dimension = params.get('dimension');
  const workspace = params.get('workspace');
  const archived = params.get('include_archived');
  const parsedRange = range !== null && isRangePreset(range) ? range : USAGE_FILTER_DEFAULTS.range;
  const startAt = parseNonnegativeInt(params.get('start_at'));
  const endAt = parseNonnegativeInt(params.get('end_at'));
  const customBoundsValid =
    parsedRange === 'custom' && startAt !== undefined && endAt !== undefined && startAt < endAt;
  return {
    granularity:
      granularity !== null && isGranularity(granularity)
        ? granularity
        : USAGE_FILTER_DEFAULTS.granularity,
    range: parsedRange === 'custom' && !customBoundsValid ? USAGE_FILTER_DEFAULTS.range : parsedRange,
    groupBy:
      groupBy !== null && isGroupBy(groupBy)
        ? groupBy
        : dimension !== null && isGroupBy(dimension)
          ? dimension
          : USAGE_FILTER_DEFAULTS.groupBy,
    advancedDimension:
      dimension === 'agent' || dimension === 'session' ? dimension : undefined,
    workspaceId: optionalParam(workspace),
    model: optionalParam(params.get('model')),
    provider: optionalParam(params.get('provider')),
    profiles: params.getAll('profile').filter((id) => id !== ''),
    agentIds: params.getAll('agent.id').filter((id) => id !== ''),
    includeArchived:
      archived === null ? USAGE_FILTER_DEFAULTS.includeArchived : archived === 'true',
    startAt: customBoundsValid ? startAt : undefined,
    endAt: customBoundsValid ? endAt : undefined,
  };
}

/** True when the URL carries no usage filter params at all (fresh visit). */
export function searchHasUsageParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return [
    'granularity', 'range', 'group_by', 'dimension', 'workspace', 'model', 'provider',
    'profile', 'agent.id', 'include_archived', 'start_at', 'end_at',
  ].some((key) => params.has(key));
}

// ---------------------------------------------------------------------------
// Detail view — which detail tab the page shows; URL-carried like the filters
// so a shared link (e.g. ?view=breakdown&dimension=agent) restores the tab.
// ---------------------------------------------------------------------------

export type UsageDetailView = 'sources' | 'sessions' | 'breakdown' | 'five_hour';

export const USAGE_DETAIL_VIEWS: readonly UsageDetailView[] = [
  'sources',
  'sessions',
  'breakdown',
  'five_hour',
];

export const USAGE_DETAIL_VIEW_DEFAULT: UsageDetailView = 'sources';

/** URL → detail view; an unknown/absent value degrades to the source table. */
export function parseUsageDetailView(search: string): UsageDetailView {
  const view = new URLSearchParams(search).get('view');
  return view !== null && (USAGE_DETAIL_VIEWS as readonly string[]).includes(view)
    ? (view as UsageDetailView)
    : USAGE_DETAIL_VIEW_DEFAULT;
}

/**
 * Detail view → URL query, preserving unrelated params (server/token keys,
 * the session locator, the filter axes). The default source table is omitted so
 * the canonical URL stays clean.
 */
export function usageDetailViewToSearch(view: UsageDetailView, existing?: string): string {
  const params = new URLSearchParams(existing ?? '');
  params.delete('view');
  if (view !== USAGE_DETAIL_VIEW_DEFAULT) params.set('view', view);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * Filters → URL query. Defaults are omitted so the no-query URL stays the
 * canonical local-today state; non-default axes are always explicit so the
 * link is shareable and refresh-stable. Preserves unrelated params (server /
 * token deep-link keys, the session locator). The reading axis rides as
 * `group_by`; legacy `dimension=` links are read, not written.
 */
export function usageFiltersToSearch(filters: UsageFilters, existing?: string): string {
  const params = new URLSearchParams(existing ?? '');
  for (const key of [
    'granularity',
    'range',
    'group_by',
    'dimension',
    'workspace',
    'model',
    'provider',
    'profile',
    'agent.id',
    'include_archived',
    'start_at',
    'end_at',
  ]) {
    params.delete(key);
  }
  if (filters.granularity !== USAGE_FILTER_DEFAULTS.granularity) {
    params.set('granularity', filters.granularity);
  }
  if (filters.range !== USAGE_FILTER_DEFAULTS.range) params.set('range', filters.range);
  if (filters.advancedDimension !== undefined) {
    params.set('dimension', filters.advancedDimension);
  } else if (filters.groupBy !== USAGE_FILTER_DEFAULTS.groupBy) {
    params.set('group_by', filters.groupBy);
  }
  if (filters.workspaceId !== undefined) params.set('workspace', filters.workspaceId);
  if (filters.model !== undefined) params.set('model', filters.model);
  if (filters.provider !== undefined) params.set('provider', filters.provider);
  for (const profile of filters.profiles) params.append('profile', profile);
  for (const agentId of filters.agentIds) params.append('agent.id', agentId);
  if (filters.includeArchived !== USAGE_FILTER_DEFAULTS.includeArchived) {
    params.set('include_archived', String(filters.includeArchived));
  }
  if (filters.range === 'custom' && filters.startAt !== undefined && filters.endAt !== undefined) {
    params.set('start_at', String(filters.startAt));
    params.set('end_at', String(filters.endAt));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** Read a persisted selection; query-less `/usage` visits intentionally ignore it. */
export function readStoredUsageFilters(): UsageFilters | undefined {
  try {
    const raw = spaceStorage.getItem(USAGE_FILTERS_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const rawRange = record['range'];
    const range = typeof rawRange === 'string' && isRangePreset(rawRange)
      ? rawRange
      : USAGE_FILTER_DEFAULTS.range;
    const rawStart = record['startAt'];
    const rawEnd = record['endAt'];
    const startAt = typeof rawStart === 'number' ? rawStart : undefined;
    const endAt = typeof rawEnd === 'number' ? rawEnd : undefined;
    const customOk = range !== 'custom' || (startAt !== undefined && endAt !== undefined && startAt < endAt);
    const rawGranularity = record['granularity'];
    // A selection stored by the dimension-era layout keeps its reading axis.
    const rawGroupBy = record['groupBy'] ?? record['dimension'];
    const rawWorkspace = record['workspaceId'];
    const rawArchived = record['includeArchived'];
    const rawProfiles = record['profiles'];
    const rawAgentIds = record['agentIds'];
    const rawAdvanced = record['advancedDimension'];
    const rawModel = record['model'];
    const rawProvider = record['provider'];
    return {
      granularity:
        typeof rawGranularity === 'string' && isGranularity(rawGranularity)
          ? rawGranularity
          : USAGE_FILTER_DEFAULTS.granularity,
      range: customOk ? range : USAGE_FILTER_DEFAULTS.range,
      groupBy: storedGroupBy(rawGroupBy),
      advancedDimension:
        rawAdvanced === 'agent' || rawAdvanced === 'session' ? rawAdvanced : undefined,
      workspaceId:
        typeof rawWorkspace === 'string' && rawWorkspace !== ''
          ? rawWorkspace
          : undefined,
      model: typeof rawModel === 'string' && rawModel !== '' ? rawModel : undefined,
      provider: typeof rawProvider === 'string' && rawProvider !== '' ? rawProvider : undefined,
      profiles: storedStrings(rawProfiles),
      agentIds: storedStrings(rawAgentIds),
      includeArchived:
        typeof rawArchived === 'boolean'
          ? rawArchived
          : USAGE_FILTER_DEFAULTS.includeArchived,
      startAt: customOk ? startAt : undefined,
      endAt: customOk ? endAt : undefined,
    };
  } catch {
    return undefined;
  }
}

function storedGroupBy(value: unknown): UsageGroupBy {
  if (typeof value !== 'string') return USAGE_FILTER_DEFAULTS.groupBy;
  if (isGroupBy(value)) return value;
  if (value === 'project') return 'workspace';
  return USAGE_FILTER_DEFAULTS.groupBy;
}

function storedStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}

export function writeStoredUsageFilters(filters: UsageFilters): void {
  try {
    spaceStorage.setItem(USAGE_FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Storage can be unavailable (private mode); the URL still carries state.
  }
}

// ---------------------------------------------------------------------------
// API query assembly
// ---------------------------------------------------------------------------

export interface UsageApiQueryOptions {
  readonly timezoneOffsetMinutes: number;
  readonly pageSize?: number;
  readonly pageToken?: string;
  /** Explicit window override, epoch ms [start, end). Used by prior-period reads. */
  readonly window?: { readonly startAt: number; readonly endAt: number };
}

/**
 * Filters → `GET /api/usage` query params. An explicit `range=all` is
 * omitted so the server can mark the response `defaulted_to_all_history`;
 * every other axis is sent explicitly so the server's defaults never diverge
 * from what the UI displays. A page token is passed through untouched (and
 * only ever paired with the filter set that produced it).
 *
 * `groupBy` never reaches the wire as itself: it names the reading axis, and
 * the wire `dimension` follows. provider and profile are native server
 * dimensions with per-record attribution, so the page asks for them directly
 * instead of rolling attribution out of the model or agent response.
 */
export function buildUsageApiQuery(
  filters: UsageFilters,
  options: UsageApiQueryOptions,
): Record<string, string | number | boolean | string[] | undefined> {
  const window = options.window;
  const customWindow = window ?? (
    filters.range === 'custom' && filters.startAt !== undefined && filters.endAt !== undefined
      ? { startAt: filters.startAt, endAt: filters.endAt }
      : undefined
  );
  return {
    granularity: filters.granularity,
    range: window === undefined && filters.range === 'all' ? undefined : filters.range,
    dimension: filters.advancedDimension ?? USAGE_GROUP_BY_DIMENSION[filters.groupBy],
    'workspace.id': filters.workspaceId,
    model: filters.model,
    provider: filters.provider,
    profile: filters.profiles.length > 0 ? [...filters.profiles] : undefined,
    'agent.id': filters.agentIds.length > 0 ? [...filters.agentIds] : undefined,
    include_archived: filters.includeArchived ? 'true' : 'false',
    start_at: customWindow?.startAt,
    end_at: customWindow?.endAt,
    timezone_offset_minutes: options.timezoneOffsetMinutes,
    page_size: options.pageSize,
    page_token: options.pageToken,
  };
}

/** East-positive browser offset, matching the wire convention. */
export function browserTimezoneOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

// ---------------------------------------------------------------------------
// Prior-period window
// ---------------------------------------------------------------------------

export interface UsageWindow {
  /** Epoch ms, inclusive. */
  readonly startAt: number;
  /** Epoch ms, exclusive. */
  readonly endAt: number;
}

/** The wire bucket shape the comparison window needs. */
type UsageBucketWindow = { readonly start_at: number; readonly end_at: number };

/**
 * The window a comparison reads: the same calendar span moved back, clipped so
 * an in-progress range compares like-for-like up to the current moment (today
 * 00:00–18:00 against yesterday 00:00–18:00).
 *
 * Ranges bounded by local midnights shift by whole local days, so a DST change
 * inside the range moves the wall clock the same way instead of assuming 24h;
 * anything shorter (5h windows, custom sub-day ranges) shifts by its exact
 * length. All-history has no bounded predecessor and yields null.
 */
export function usageCompareWindow(
  range: UsageWindow,
  timezoneOffsetMinutes: number,
  nowMs: number,
): UsageWindow | null {
  const { startAt, endAt } = range;
  if (startAt <= 0 || endAt <= startAt) return null;
  const effectiveEnd = Math.min(endAt, nowMs);
  if (effectiveEnd <= startAt) return null;
  const shiftMs = usageWindowShiftMs(startAt, endAt, timezoneOffsetMinutes);
  return { startAt: startAt + shiftMs, endAt: effectiveEnd + shiftMs };
}

/**
 * The negative offset that moves a window back by its own span. Exported so a
 * selected bucket derives the exact window the contract requires —
 * `[bucket.start - shift, min(bucket.end, now) - shift)` — rather than reusing
 * day buckets that do not line up.
 */
export function usageWindowShiftMs(
  startAt: number,
  endAt: number,
  timezoneOffsetMinutes: number,
): number {
  const dayMs = 86_400_000;
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const midnightAligned = (startAt + offsetMs) % dayMs === 0 && (endAt + offsetMs) % dayMs === 0;
  const daySpan = (endAt - startAt) / dayMs;
  return midnightAligned && Number.isInteger(daySpan) && daySpan >= 1
    ? shiftLocalDays(startAt, -daySpan, timezoneOffsetMinutes) - startAt
    : -(endAt - startAt);
}

/** The comparison window for one bucket inside the selected range. */
export function usageBucketCompareWindow(
  range: UsageWindow,
  bucket: UsageBucketWindow,
  timezoneOffsetMinutes: number,
  nowMs: number,
): UsageWindow | null {
  const shiftMs = usageWindowShiftMs(range.startAt, range.endAt, timezoneOffsetMinutes);
  const startAt = Math.max(bucket.start_at, range.startAt) + shiftMs;
  const endAt = Math.min(bucket.end_at, range.endAt, nowMs) + shiftMs;
  return endAt > startAt ? { startAt, endAt } : null;
}

/** Move an instant by whole local days, staying on the same wall clock. */
function shiftLocalDays(ms: number, days: number, timezoneOffsetMinutes: number): number {
  const shifted = new Date(ms + timezoneOffsetMinutes * 60_000);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.getTime() - timezoneOffsetMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

export function totalTokensOf(aggregate: UsageAggregateWire): number {
  return (
    aggregate.tokens.input_other +
    aggregate.tokens.output +
    aggregate.tokens.input_cache_read +
    aggregate.tokens.input_cache_creation
  );
}

/** True when the aggregate has no known token total to display. */
export function usageTokenTotalIsUnknown(aggregate: UsageAggregateWire): boolean {
  return aggregate.tokens_unknown === true && totalTokensOf(aggregate) === 0;
}

/** cache_read / total input (input_other + cache_read + cache_creation). */
export function cacheHitRateOf(aggregate: UsageAggregateWire): number | null {
  const input =
    aggregate.tokens.input_other +
    aggregate.tokens.input_cache_read +
    aggregate.tokens.input_cache_creation;
  return input > 0 ? aggregate.tokens.input_cache_read / input : null;
}

/** The single key each source axis groups by, or null for missing/mixed data. */
export const USAGE_SOURCE_KEY_UNKNOWN = 'unknown';

/**
 * The row key for one group on the given axis. Model and workspace groups are
 * keyed by their own identity already; provider and profile keys are opaque
 * identities the server minted (`provider:"…"` / `profile:"…"`), so a real
 * value spelled "unknown" never collapses into the missing row. Missing
 * attribution on any axis gets its own single unknown row.
 */
export function usageSourceKey(group: UsageGroupWire, groupBy: UsageGroupBy): string {
  if (groupBy === 'provider') return group.provider === null ? USAGE_SOURCE_KEY_UNKNOWN : `provider:${JSON.stringify(group.provider)}`;
  if (groupBy === 'profile') return group.profile_name === null ? USAGE_SOURCE_KEY_UNKNOWN : `profile:${JSON.stringify(group.profile_name)}`;
  return group.key;
}

/**
 * The value a filter may send, or null when the row has no exact filter.
 * Only the raw record attribution is ever sent: an unknown or mixed row has no
 * filter at all rather than a sentinel the API would silently ignore.
 */
export function usageSourceFilterValue(
  group: UsageGroupWire,
  groupBy: UsageGroupBy,
): string | null {
  if (groupBy === 'model') return group.model_alias;
  if (groupBy === 'provider') return group.provider;
  if (groupBy === 'profile') return group.profile_name;
  return group.key;
}

export interface UsageSourceRow {
  /** Stable row key; the unknown row is `unknown`. */
  readonly key: string;
  /** The display value, or null when the record has no attribution at all. */
  readonly value: string | null;
  readonly tokens: UsageTokensWire;
  readonly totalTokens: number;
  readonly tokensUnknown: boolean;
  readonly costUsdEstimated: number;
  readonly costUnknown: boolean;
  /** Model aliases contributing to this row, for the row's secondary line. */
  readonly modelAliases: readonly string[];
  /** Ids the source filter can express exactly, when the row has one. */
  readonly filter: UsageSourceFilter | null;
}

export interface UsageSourceFilter {
  readonly field: 'model' | 'provider' | 'profile' | 'workspace.id';
  readonly value: string;
}

function sourceFilterFor(key: string, group: UsageGroupWire, groupBy: UsageGroupBy): UsageSourceFilter | null {
  if (key === USAGE_SOURCE_KEY_UNKNOWN) return null;
  const value = usageSourceFilterValue(group, groupBy);
  if (value === null) return null;
  if (groupBy === 'workspace') return { field: 'workspace.id', value };
  return { field: groupBy, value };
}

/**
 * One source row per key for the chosen axis, summed over the buckets the
 * caller passed. Cost-descending with tokens as the tie-break, matching the
 * server's within-bucket ordering. A key with no attribution keeps its amount
 * under one `unknown` row rather than being dropped or guessed.
 */
export function aggregateSourceRows(
  trend: readonly UsageTrendBucketWire[],
  groupBy: UsageGroupBy,
): UsageSourceRow[] {
  const rows = new Map<
    string,
    {
      display: string | null;
      tokens: UsageTokensWire;
      totalTokens: number;
      tokensUnknown: boolean;
      costUsdEstimated: number;
      costUnknown: boolean;
      modelAliases: Set<string>;
      filter: UsageSourceFilter | null;
    }
  >();
  for (const group of trend.flatMap((bucket) => bucket.groups)) {
    const key = usageSourceKey(group, groupBy);
    const display = usageSourceFilterValue(group, groupBy);
    const entry = rows.get(key) ?? {
      display,
      tokens: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
      totalTokens: 0,
      tokensUnknown: false,
      costUsdEstimated: 0,
      costUnknown: false,
      modelAliases: new Set<string>(),
      filter: sourceFilterFor(key, group, groupBy),
    };
    entry.tokens.input_other += group.tokens.input_other;
    entry.tokens.output += group.tokens.output;
    entry.tokens.input_cache_read += group.tokens.input_cache_read;
    entry.tokens.input_cache_creation += group.tokens.input_cache_creation;
    entry.totalTokens += totalTokensOf(group);
    entry.costUsdEstimated += group.cost_usd_estimated;
    entry.tokensUnknown ||= group.tokens_unknown === true;
    entry.costUnknown ||= group.cost_unknown;
    if (group.model_alias !== null) entry.modelAliases.add(group.model_alias);
    rows.set(key, entry);
  }
  return [...rows.entries()]
    .map(([key, entry]) => ({
      key,
      value: entry.display,
      tokens: entry.tokens,
      totalTokens: entry.totalTokens,
      tokensUnknown: entry.tokensUnknown,
      costUsdEstimated: entry.costUsdEstimated,
      costUnknown: entry.costUnknown,
      modelAliases: [...entry.modelAliases].toSorted((a, b) => a.localeCompare(b)),
      filter: entry.filter,
    }))
    .toSorted((a, b) => b.costUsdEstimated - a.costUsdEstimated || b.totalTokens - a.totalTokens);
}

/**
 * Top keys for the chart series, fixed across the whole range so colours and
 * order do not shuffle when a bucket is selected. The remainder stays in the
 * source table rather than being passed off as the whole.
 */
export function usageSeriesKeys(
  trend: readonly UsageTrendBucketWire[],
  groupBy: UsageGroupBy,
  metric: UsageMetric,
  limit: number,
): string[] {
  const valueOf = (group: UsageGroupWire): number | null =>
    metric === 'tokens' ? totalTokensOf(group) : metric === 'cache' ? null : group.cost_usd_estimated;
  const totals = new Map<string, number>();
  for (const bucket of trend) {
    for (const group of bucket.groups) {
      const value = valueOf(group);
      if (value === null) continue;
      const key = usageSourceKey(group, groupBy);
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
  }
  return [...totals.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
}

export interface UsageDimensionRow {
  readonly key: string;
  readonly provider: string | null;
  readonly modelAlias: string | null;
  readonly agentId: string | null;
  readonly parentAgentId: string | null;
  readonly profileName: string | null;
  readonly tokens: UsageTokensWire;
  readonly totalTokens: number;
  readonly tokensUnknown: boolean;
  readonly costUsdEstimated: number;
  readonly costUnknown: boolean;
  /** True when rows for this key reported conflicting providers/etc. */
  readonly mixedAttribution: boolean;
}

/**
 * Roll up per-bucket dimension groups into one row per key (the response has
 * no top-level groups array; trend buckets are the authoritative source).
 * Cost-descending, matching the server's within-bucket ordering. Attribution
 * fields take the first non-null value seen in cost order; a key with
 * conflicting values is flagged `mixedAttribution` instead of guessing.
 */
export function aggregateDimensionGroups(
  trend: readonly UsageTrendBucketWire[],
): UsageDimensionRow[] {
  const rows = new Map<
    string,
    {
      tokens: { input_other: number; output: number; input_cache_read: number; input_cache_creation: number };
      tokensUnknown: boolean;
      costUsdEstimated: number;
      costUnknown: boolean;
      provider: string | null;
      modelAlias: string | null;
      agentId: string | null;
      parentAgentId: string | null;
      profileName: string | null;
      mixedAttribution: boolean;
    }
  >();
  const pick = (
    current: string | null,
    next: string | null,
  ): { value: string | null; mixed: boolean } => {
    if (next === null) return { value: current, mixed: false };
    if (current === null) return { value: next, mixed: false };
    return current === next ? { value: current, mixed: false } : { value: current, mixed: true };
  };
  for (const bucket of trend) {
    for (const group of bucket.groups) {
      const row =
        rows.get(group.key) ??
        {
          tokens: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
          tokensUnknown: false,
          costUsdEstimated: 0,
          costUnknown: false,
          provider: null,
          modelAlias: null,
          agentId: null,
          parentAgentId: null,
          profileName: null,
          mixedAttribution: false,
        };
      row.tokens.input_other += group.tokens.input_other;
      row.tokens.output += group.tokens.output;
      row.tokens.input_cache_read += group.tokens.input_cache_read;
      row.tokens.input_cache_creation += group.tokens.input_cache_creation;
      row.costUsdEstimated += group.cost_usd_estimated;
      row.tokensUnknown ||= group.tokens_unknown === true;
      row.costUnknown ||= group.cost_unknown;
      for (const [field, next] of [
        ['provider', group.provider],
        ['modelAlias', group.model_alias],
        ['agentId', group.agent_id],
        ['parentAgentId', group.parent_agent_id],
        ['profileName', group.profile_name],
      ] as const) {
        const picked = pick(row[field], next);
        row[field] = picked.value;
        row.mixedAttribution ||= picked.mixed;
      }
      rows.set(group.key, row);
    }
  }
  return [...rows.entries()]
    .map(([key, row]) => ({
      key,
      provider: row.provider,
      modelAlias: row.modelAlias,
      agentId: row.agentId,
      parentAgentId: row.parentAgentId,
      profileName: row.profileName,
      tokens: row.tokens,
      totalTokens:
        row.tokens.input_other +
        row.tokens.output +
        row.tokens.input_cache_read +
        row.tokens.input_cache_creation,
      tokensUnknown: row.tokensUnknown,
      costUsdEstimated: row.costUsdEstimated,
      costUnknown: row.costUnknown,
      mixedAttribution: row.mixedAttribution,
    }))
    .toSorted((a, b) => b.costUsdEstimated - a.costUsdEstimated || b.totalTokens - a.totalTokens);
}

export interface UsageAgentTree {
  /** Rows whose parent is unknown/absent — the main-agent level. */
  readonly roots: readonly UsageDimensionRow[];
  /** Children keyed by parent agent id (from `parentAgentId`). */
  readonly childrenByParent: ReadonlyMap<string, readonly UsageDimensionRow[]>;
}

/**
 * Parent/child shape for the agent breakdown: a row is a child when
 * `parentAgentId` is set. Children whose parent row is not in the result stay
 * visible under a synthetic grouping at root level (they are still real usage;
 * the parent simply fell outside the current range).
 */
export function buildAgentTree(rows: readonly UsageDimensionRow[]): UsageAgentTree {
  const children = new Map<string, UsageDimensionRow[]>();
  const roots: UsageDimensionRow[] = [];
  for (const row of rows) {
    if (row.parentAgentId === null) {
      roots.push(row);
    } else {
      const list = children.get(row.parentAgentId) ?? [];
      list.push(row);
      children.set(row.parentAgentId, list);
    }
  }
  return { roots, childrenByParent: children };
}

// ---------------------------------------------------------------------------
// Labels & rates
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Human label for a trend bucket. Bucket start_at/end_at are epoch ms; the
 * browser's local zone matches the offset we sent, so local formatting is the
 * same wall clock the server bucketed by.
 */
export function bucketLabel(
  bucket: Pick<UsageTrendBucketWire, 'start_at' | 'end_at'>,
  granularity: UsageGranularity,
  locale: Locale,
): string {
  const tag = locale === 'zh' ? 'zh-CN' : 'en';
  const start = new Date(bucket.start_at);
  switch (granularity) {
    case 'day':
      return start.toLocaleDateString(tag, { month: 'short', day: 'numeric' });
    case 'week':
      return start.toLocaleDateString(tag, { month: 'short', day: 'numeric' });
    case 'month':
      return start.toLocaleDateString(tag, { year: 'numeric', month: 'short' });
    case 'five_hour': {
      const end = new Date(bucket.end_at);
      const day = start.toLocaleDateString(tag, { month: 'short', day: 'numeric' });
      return `${day} ${pad2(start.getHours())}:00–${pad2(end.getHours())}:00`;
    }
    case 'session':
      return start.toLocaleDateString(tag, { month: 'short', day: 'numeric' });
  }
}

/**
 * Statusline-style burn rate: today's token volume over the hours elapsed
 * since local midnight (floor of 15 minutes so early-morning reads don't
 * explode). Returns tokens per hour.
 */
export function burnRatePerHour(tokensToday: number, nowMs: number): number {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const elapsedHours = Math.max(0.25, (nowMs - midnight.getTime()) / 3_600_000);
  return tokensToday / elapsedHours;
}

/** Deep link target for "view this session in /usage" (ContextMeter §9.5). */
export function usageSessionDeepLink(sessionId: string): string {
  return `/usage?dimension=session&session=${encodeURIComponent(sessionId)}`;
}

// ---------------------------------------------------------------------------
// Range window
// ---------------------------------------------------------------------------

/**
 * The window a preset resolves to, in the browser's local calendar. Today and
 * 5h presets prefer the `five_hour` bucket so the first screen is a real
 * rhythm instead of one flat day bar; the server answers the query range
 * either way, so this only decides the comparison window.
 */
export function usageRangeWindow(
  filters: UsageFilters,
  timezoneOffsetMinutes: number,
  nowMs: number,
): UsageWindow | null {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const dayMs = 86_400_000;
  const midnight = (ms: number): number => Math.floor((ms + offsetMs) / dayMs) * dayMs - offsetMs;
  const local = new Date(nowMs + offsetMs);
  const shiftDays = (base: number, days: number): number => {
    const shifted = new Date(base + offsetMs);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.getTime() - offsetMs;
  };
  switch (filters.range) {
    case 'today': {
      const startAt = midnight(nowMs);
      return { startAt, endAt: startAt + dayMs };
    }
    case 'last_7_days': {
      const endAt = midnight(nowMs) + dayMs;
      return { startAt: shiftDays(endAt, -7), endAt };
    }
    case 'this_week': {
      const startAt = shiftDays(midnight(nowMs), -local.getUTCDay());
      return { startAt, endAt: startAt + 7 * dayMs };
    }
    case 'this_month': {
      const startAt = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offsetMs;
      const endAt = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - offsetMs;
      return { startAt, endAt };
    }
    case 'custom':
      return filters.startAt !== undefined && filters.endAt !== undefined && filters.startAt < filters.endAt
        ? { startAt: filters.startAt, endAt: filters.endAt }
        : null;
    case 'all':
      // Unbounded history has no bounded predecessor to compare against.
      return null;
  }
}

/** Inclusive calendar-day span for display, epoch ms. */
export function usageWindowLabel(window: UsageWindow, locale: Locale): string {
  const tag = locale === 'zh' ? 'zh-CN' : 'en';
  const format = (ms: number, withYear: boolean): string =>
    new Date(ms).toLocaleDateString(tag, {
      ...(withYear ? { year: 'numeric' as const } : {}),
      month: 'short',
      day: 'numeric',
    });
  const lastDay = window.endAt - 1;
  const sameDay = localDateKeyOf(window.startAt) === localDateKeyOf(lastDay);
  if (sameDay) return format(window.startAt, true);
  const sameYear = new Date(window.startAt).getFullYear() === new Date(lastDay).getFullYear();
  return `${format(window.startAt, !sameYear)} – ${format(lastDay, true)}`;
}

function localDateKeyOf(ms: number): string {
  const date = new Date(ms);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-');
}

// ---------------------------------------------------------------------------
// Comparison deltas
// ---------------------------------------------------------------------------

export type UsageCompareOutcome =
  /** Both periods are complete and the prior value is non-zero. */
  | { readonly kind: 'delta'; readonly ratio: number }
  /** The prior period measured zero — a ratio would divide by zero. */
  | { readonly kind: 'priorZero' }
  /** Either period is incomplete or the measured value is unknown. */
  | { readonly kind: 'unavailable' };

/**
 * Relative change for cost and tokens. A zero prior is its own state rather
 * than an infinite ratio, and any unknown input refuses to produce a number —
 * the table shows that instead of a growth claim derived from a subtotal.
 */
export function usageRatioChange(current: number, prior: number): UsageCompareOutcome {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return { kind: 'unavailable' };
  if (prior === 0) return { kind: 'priorZero' };
  return { kind: 'delta', ratio: (current - prior) / prior };
}

/**
 * Cache hit rate compares in percentage points, not a ratio: two rates near
 * each other would otherwise read as a large change.
 */
export function usagePointChange(current: number | null, prior: number | null): UsageCompareOutcome {
  if (current === null || prior === null) return { kind: 'unavailable' };
  // Rounded to a tenth so a binary-float artifact never reaches a column that
  // renders one decimal.
  return { kind: 'delta', ratio: Math.round((current - prior) * 1000) / 10 };
}
