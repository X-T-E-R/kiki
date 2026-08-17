/**
 * Usage-dashboard aggregation — pure functions over the polled Session
 * records. The wire ships only lifetime cumulative `session.usage`, so:
 *
 *   - time ranges filter sessions by `updated_at` (last activity);
 *   - per-day buckets group sessions by their last-active local day and sum
 *     those sessions' lifetime figures — the page labels them as such;
 *   - deleted sessions are invisible to the REST surface and never counted.
 *
 * Cache hit rate is defined as cache_read / total_input, where total_input is
 * input + cache_read + cache_creation. All four engine usage components are
 * disjoint, so cache writes must stay in both the input denominator and total.
 */

import type { Session } from '@moonshot-ai/protocol';

export type UsageRange = 'today' | '7d' | '30d' | 'all';

export const USAGE_RANGES: readonly UsageRange[] = ['today', '7d', '30d', 'all'];

/** Local-midnight start of the day containing `ms`. */
export function localDayStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY_MS = 24 * 3600_000;

/**
 * Inclusive range start (local midnight) for a range, or undefined for 'all'.
 * '7d' covers today plus the six preceding days; '30d' likewise.
 */
export function usageRangeStart(range: UsageRange, nowMs: number): number | undefined {
  const today = localDayStart(nowMs);
  switch (range) {
    case 'today':
      return today;
    case '7d':
      return today - 6 * DAY_MS;
    case '30d':
      return today - 29 * DAY_MS;
    case 'all':
      return undefined;
  }
}

/**
 * Sessions in range: `updated_at` at or after the range start ('all' keeps
 * everything). Archived sessions are dropped only when asked.
 */
export function filterSessionsByRange(
  sessions: readonly Session[],
  range: UsageRange,
  nowMs: number,
  options: { includeArchived?: boolean } = {},
): Session[] {
  const start = usageRangeStart(range, nowMs);
  const includeArchived = options.includeArchived ?? true;
  return sessions.filter((session) => {
    if (!includeArchived && session.archived === true) return false;
    if (start === undefined) return true;
    const updated = new Date(session.updated_at).getTime();
    return !Number.isNaN(updated) && updated >= start;
  });
}

export interface UsageTotals {
  readonly sessions: number;
  readonly turns: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** input + output + cache read + cache write. */
  readonly totalTokens: number;
  /** cache_read / (input + cache_read + cache_creation); null with no input. */
  readonly cacheHitRate: number | null;
}

function sessionTotalTokens(session: Session): number {
  const usage = session.usage;
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_tokens +
    usage.cache_creation_tokens
  );
}

export function aggregateUsage(sessions: readonly Session[]): UsageTotals {
  let turns = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const session of sessions) {
    const usage = session.usage;
    turns += usage.turn_count;
    costUsd += usage.total_cost_usd;
    inputTokens += usage.input_tokens;
    outputTokens += usage.output_tokens;
    cacheReadTokens += usage.cache_read_tokens;
    cacheCreationTokens += usage.cache_creation_tokens;
  }
  const totalInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    sessions: sessions.length,
    turns,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: totalInputTokens + outputTokens,
    cacheHitRate: totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : null,
  };
}

export interface ModelUsage {
  /** Wire model id; '' means the session inherits the server default. */
  readonly model: string;
  readonly sessions: number;
  readonly turns: number;
  readonly costUsd: number;
  readonly totalTokens: number;
}

/** Per-model rollup, most expensive first (ties broken by token volume). */
export function groupUsageByModel(sessions: readonly Session[]): ModelUsage[] {
  const byModel = new Map<string, { sessions: number; turns: number; costUsd: number; totalTokens: number }>();
  for (const session of sessions) {
    const model = session.agent_config.model;
    const entry = byModel.get(model) ?? { sessions: 0, turns: 0, costUsd: 0, totalTokens: 0 };
    entry.sessions += 1;
    entry.turns += session.usage.turn_count;
    entry.costUsd += session.usage.total_cost_usd;
    entry.totalTokens += sessionTotalTokens(session);
    byModel.set(model, entry);
  }
  return [...byModel.entries()]
    .map(([model, entry]) => ({ model, ...entry }))
    .toSorted((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
}

export interface DayBucket {
  /** Local midnight identifying the day. */
  readonly dayStartMs: number;
  readonly sessions: number;
  readonly costUsd: number;
  readonly totalTokens: number;
}

/**
 * Zero-filled per-day buckets from `fromDayMs` to `toDayMs` (both inclusive,
 * snapped to local midnights). Sessions land in the local day of their
 * `updated_at`; sessions outside the span are ignored.
 */
export function bucketSessionsByDay(
  sessions: readonly Session[],
  fromDayMs: number,
  toDayMs: number,
): DayBucket[] {
  const from = localDayStart(fromDayMs);
  const to = localDayStart(toDayMs);
  if (to < from) return [];
  const buckets: { dayStartMs: number; sessions: number; costUsd: number; totalTokens: number }[] = [];
  const indexByDay = new Map<number, number>();
  for (let day = from; day <= to; day += DAY_MS) {
    indexByDay.set(day, buckets.length);
    buckets.push({ dayStartMs: day, sessions: 0, costUsd: 0, totalTokens: 0 });
  }
  for (const session of sessions) {
    const updated = new Date(session.updated_at).getTime();
    if (Number.isNaN(updated)) continue;
    const index = indexByDay.get(localDayStart(updated));
    if (index === undefined) continue;
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    bucket.sessions += 1;
    bucket.costUsd += session.usage.total_cost_usd;
    bucket.totalTokens += sessionTotalTokens(session);
  }
  return buckets;
}

/** Earliest last-active local day across the set; undefined when empty. */
export function earliestActivityDay(sessions: readonly Session[]): number | undefined {
  let earliest: number | undefined;
  for (const session of sessions) {
    const updated = new Date(session.updated_at).getTime();
    if (Number.isNaN(updated)) continue;
    if (earliest === undefined || updated < earliest) earliest = updated;
  }
  return earliest === undefined ? undefined : localDayStart(earliest);
}

/** Sessions ordered by lifetime cost, most expensive first. */
export function rankSessionsByCost(sessions: readonly Session[]): Session[] {
  return sessions.toSorted(
    (a, b) => b.usage.total_cost_usd - a.usage.total_cost_usd || b.updated_at.localeCompare(a.updated_at),
  );
}

/**
 * Deterministic USD formatting (no Intl locale drift in tests):
 *   $0.00 · $0.0043 (<$0.01) · $0.432 (<$1) · $12.34 · $1,234.56
 */
export function formatCostUsd(usd: number): string {
  const rounded = Math.max(0, usd);
  if (rounded === 0) return '$0.00';
  if (rounded < 0.01) return `$${rounded.toFixed(4)}`;
  if (rounded < 1) return `$${rounded.toFixed(3)}`;
  // Group the integer part of the rounded string so a carried cent
  // (999.999 → "1000.00") lands in the integer part instead of truncating.
  const [intPart, cents] = rounded.toFixed(2).split('.');
  return `$${formatGrouped(Number(intPart))}.${cents}`;
}

/** Integer with thousands separators, locale-independent: 12,483,201. */
export function formatGrouped(value: number): string {
  return Math.round(value).toString().replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
}
