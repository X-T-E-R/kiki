/**
 * Usage V2 — the client half of `GET /api/v2/usage` (kap-server
 * `protocol/rest-usage.ts`). This module owns:
 *
 *   - the wire types (mirrored locally; the schema lives in kap-server and is
 *     not re-exported through @moonshot-ai/protocol);
 *   - the three-axis filter model (granularity × range × dimension) plus its
 *     URL query serialization — the URL is the canonical, shareable state;
 *   - localStorage persistence so a query-less revisit restores the last
 *     selection instead of bouncing back to a default;
 *   - pure derivations the page needs: cross-bucket dimension rollups,
 *     agent parent/child trees, cache hit rate, bucket labels, burn rate.
 *
 * Contract notes honored here (see the V2-b consumer contract):
 *   - no implicit 30-day window: the default range is 'all' and the server's
 *     `query.range.defaulted_to_all_history` flag is surfaced, never hidden;
 *   - trend buckets arrive time-ascending, session items cost-descending;
 *   - `cost_usd_estimated` is only the priced part when `cost_unknown`;
 *   - dimension keys are modelAlias for model, 'unknown' for old records —
 *     never reconstructed from billing model/provider;
 *   - provider / parent / profile `null` means missing data, not '';
 *   - start_at / end_at / bucket start_at / end_at are epoch milliseconds;
 *   - timezone_offset_minutes is east-positive: -new Date().getTimezoneOffset().
 */

import type { Locale } from '../i18n/locale';

// ---------------------------------------------------------------------------
// Wire types (mirror of kap-server src/protocol/rest-usage.ts)
// ---------------------------------------------------------------------------

export type UsageGranularity = 'day' | 'week' | 'month' | 'session' | 'five_hour';
export type UsageRangePreset =
  | 'today'
  | 'last_7_days'
  | 'this_week'
  | 'this_month'
  | 'all'
  | 'custom';
export type UsageDimension = 'agent' | 'model' | 'project' | 'session';

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

export interface UsageTokensWire {
  readonly input_other: number;
  readonly output: number;
  readonly input_cache_read: number;
  readonly input_cache_creation: number;
}

export interface UsageAggregateWire {
  readonly tokens: UsageTokensWire;
  readonly cost_usd_estimated: number;
  /** True when some records priced unknown models; the estimate is partial. */
  readonly cost_unknown: boolean;
}

export interface UsageGroupWire extends UsageAggregateWire {
  readonly key: string;
  readonly provider: string | null;
  readonly model_alias: string | null;
  readonly agent_id: string | null;
  readonly parent_agent_id: string | null;
  readonly profile_name: string | null;
}

export interface UsageDrilldownSessionWire {
  readonly session_id: string;
  readonly turn_ids: readonly number[];
  readonly turn_count: number;
  readonly unknown_turn_records: number;
  readonly turn_ids_truncated: boolean;
}

export interface UsageTrendBucketWire {
  readonly key: string;
  readonly start_at: number;
  readonly end_at: number;
  readonly groups: readonly UsageGroupWire[];
  readonly drilldown: {
    readonly sessions: readonly UsageDrilldownSessionWire[];
    readonly sessions_truncated: boolean;
  };
}

export interface UsageSessionItemWire {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly usage: UsageAggregateWire;
  readonly unknown_price_models: readonly string[];
}

export interface UsageResponseWire {
  readonly query: {
    readonly granularity: UsageGranularity;
    readonly range: {
      readonly preset: UsageRangePreset;
      readonly start_at: number | null;
      readonly end_at: number | null;
      readonly defaulted_to_all_history: boolean;
    };
    readonly dimension: UsageDimension;
    readonly workspace_ids: readonly string[];
    readonly include_archived: boolean;
    readonly timezone_offset_minutes: number;
  };
  readonly summary: UsageAggregateWire & { readonly session_count: number };
  readonly trend: readonly UsageTrendBucketWire[];
  readonly sessions: {
    readonly items: readonly UsageSessionItemWire[];
    readonly total: number;
    readonly has_more: boolean;
    readonly next_page_token: string | null;
  };
  readonly reliability: {
    readonly coverage: {
      readonly earliest_at: number | null;
      readonly latest_at: number | null;
    };
    readonly scanned_sessions: number;
    readonly incomplete_sessions: number;
    readonly unknown_price_models: readonly string[];
    readonly includes_deleted_sessions: boolean;
    readonly incomplete_reason: 'session_cap' | 'record_budget' | 'deadline' | null;
  };
}

// ---------------------------------------------------------------------------
// Filter model — granularity × range × dimension, URL-carried and persisted
// ---------------------------------------------------------------------------

export interface UsageFilters {
  readonly granularity: UsageGranularity;
  readonly range: UsageRangePreset;
  readonly dimension: UsageDimension;
  /** Single-workscope pick; the wire accepts repeated ids, the GUI offers one. */
  readonly workspaceId: string | undefined;
  readonly includeArchived: boolean;
  /** Custom range bounds, epoch ms (end exclusive). Only with range=custom. */
  readonly startAt: number | undefined;
  readonly endAt: number | undefined;
}

/** The no-query state: all history, daily trend, model breakdown. */
export const USAGE_FILTER_DEFAULTS: UsageFilters = {
  granularity: 'day',
  range: 'all',
  dimension: 'model',
  workspaceId: undefined,
  includeArchived: true,
  startAt: undefined,
  endAt: undefined,
};

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

function parseNonnegativeInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * URL → filters. Unknown/invalid values fall back to defaults individually so
 * a hand-edited link degrades instead of breaking. start_at/end_at are honored
 * only with range=custom (the server enforces the same pairing).
 */
export function parseUsageFilters(search: string): UsageFilters {
  const params = new URLSearchParams(search);
  const granularity = params.get('granularity');
  const range = params.get('range');
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
    dimension:
      dimension !== null && isDimension(dimension) ? dimension : USAGE_FILTER_DEFAULTS.dimension,
    workspaceId: workspace !== null && workspace !== '' ? workspace : undefined,
    includeArchived:
      archived === null ? USAGE_FILTER_DEFAULTS.includeArchived : archived === 'true',
    startAt: customBoundsValid ? startAt : undefined,
    endAt: customBoundsValid ? endAt : undefined,
  };
}

/** True when the URL carries no usage filter params at all (fresh visit). */
export function searchHasUsageParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return ['granularity', 'range', 'dimension', 'workspace', 'include_archived', 'start_at', 'end_at']
    .some((key) => params.has(key));
}

/**
 * Filters → URL query. Defaults are omitted so the no-query URL stays the
 * canonical all-history state; non-default axes are always explicit so the
 * link is shareable and refresh-stable. Preserves unrelated params (server /
 * token deep-link keys, the session locator).
 */
export function usageFiltersToSearch(filters: UsageFilters, existing?: string): string {
  const params = new URLSearchParams(existing ?? '');
  for (const key of [
    'granularity',
    'range',
    'dimension',
    'workspace',
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
  if (filters.dimension !== USAGE_FILTER_DEFAULTS.dimension) {
    params.set('dimension', filters.dimension);
  }
  if (filters.workspaceId !== undefined) params.set('workspace', filters.workspaceId);
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

/** Persist the last selection so a query-less revisit restores it. */
export function readStoredUsageFilters(): UsageFilters | undefined {
  try {
    const raw = localStorage.getItem(USAGE_FILTERS_STORAGE_KEY);
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
    const rawDimension = record['dimension'];
    const rawWorkspace = record['workspaceId'];
    const rawArchived = record['includeArchived'];
    return {
      granularity:
        typeof rawGranularity === 'string' && isGranularity(rawGranularity)
          ? rawGranularity
          : USAGE_FILTER_DEFAULTS.granularity,
      range: customOk ? range : USAGE_FILTER_DEFAULTS.range,
      dimension:
        typeof rawDimension === 'string' && isDimension(rawDimension)
          ? rawDimension
          : USAGE_FILTER_DEFAULTS.dimension,
      workspaceId:
        typeof rawWorkspace === 'string' && rawWorkspace !== ''
          ? rawWorkspace
          : undefined,
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

export function writeStoredUsageFilters(filters: UsageFilters): void {
  try {
    localStorage.setItem(USAGE_FILTERS_STORAGE_KEY, JSON.stringify(filters));
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
}

/**
 * Filters → `GET /api/v2/usage` query params. `range` is omitted for the
 * all-history default so the server can mark the response
 * `defaulted_to_all_history` (the chip the no-query state is identified by);
 * every other axis is sent explicitly so the server's defaults never diverge
 * from what the UI displays. A page token is passed through untouched (and
 * only ever paired with the filter set that produced it).
 */
export function buildUsageApiQuery(
  filters: UsageFilters,
  options: UsageApiQueryOptions,
): Record<string, string | number | boolean | undefined> {
  return {
    granularity: filters.granularity,
    range: filters.range === 'all' ? undefined : filters.range,
    dimension: filters.dimension,
    'workspace.id': filters.workspaceId,
    include_archived: filters.includeArchived ? 'true' : 'false',
    start_at: filters.range === 'custom' ? filters.startAt : undefined,
    end_at: filters.range === 'custom' ? filters.endAt : undefined,
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

/** cache_read / total input (input_other + cache_read + cache_creation). */
export function cacheHitRateOf(aggregate: UsageAggregateWire): number | null {
  const input =
    aggregate.tokens.input_other +
    aggregate.tokens.input_cache_read +
    aggregate.tokens.input_cache_creation;
  return input > 0 ? aggregate.tokens.input_cache_read / input : null;
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
