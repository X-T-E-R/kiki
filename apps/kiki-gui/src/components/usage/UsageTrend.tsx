/**
 * Trend chart + the explicit session trace. The chart plots one metric over
 * time on a true, zero-filled time axis with calm ink tonal columns (zero
 * horizontal scroll overflow, zero vermilion on ordinary bars). Hovering a
 * source row below or clicking a legend item cross-highlights that slice; in
 * day view, clicking a bar drills down to hourly buckets with a back crumb.
 *
 * `DrilldownSessionList` stays as the raw-record locator for the session trace
 * panel, where each turn id still lands on `/s/{id}?turn=n`.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatCostUsd, formatGrouped } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { compactIdentifier } from '../../lib/compactIdentifier';
import { Icon } from '../icons';
import {
  allowedGranularitiesForRange,
  bucketLabel,
  fillUsageTrendBuckets,
  totalTokensOf,
  usageSeriesKeys,
  usageSourceKey,
  USAGE_METRICS,
  type UsageDrilldownSessionWire,
  type UsageFilters,
  type UsageGranularity,
  type UsageGroupBy,
  type UsageMetric,
  type UsageTrendBucketWire,
  type UsageWindow,
} from '../../lib/usageV2';
import { SettingsSegmented, SettingsSelect } from '../settings/SettingsPrimitives';
import {
  bucketCacheHit,
  bucketCost,
  bucketTokens,
  bucketTokenTotalIsUnknown,
  formatCachePercent,
  formatPercent,
} from './usageShared';

/** Calm paper-and-ink tonal series palette (zero vermilion on ordinary data bars). */
const SERIES_FILLS = [
  'bg-ink/76',
  'bg-ink/50',
  'bg-ink/30',
  'bg-ink/18',
] as const;
const OTHER_FILL = 'bg-ink/10';
const SERIES_LIMIT = SERIES_FILLS.length;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function compactAxisLabel(
  bucket: Pick<UsageTrendBucketWire, 'start_at' | 'end_at'>,
  granularity: UsageGranularity,
  locale: 'en' | 'zh',
  prevBucket: Pick<UsageTrendBucketWire, 'start_at' | 'end_at'> | undefined,
): string {
  const tag = locale === 'zh' ? 'zh-CN' : 'en';
  const start = new Date(bucket.start_at);
  if (granularity === 'hour') {
    return `${pad2(start.getHours())}:00`;
  }
  if (granularity === 'day') {
    const prev = prevBucket !== undefined ? new Date(prevBucket.start_at) : undefined;
    const monthChanged = prev === undefined || prev.getMonth() !== start.getMonth();
    const weekday = start.toLocaleDateString(tag, { weekday: 'short' });
    if (locale === 'zh') {
      const monthPrefix = monthChanged ? `${start.getMonth() + 1}/` : '';
      return `${monthPrefix}${start.getDate()} ${weekday}`;
    }
    return monthChanged
      ? start.toLocaleDateString(tag, { month: 'short', day: 'numeric' })
      : `${start.getDate()} ${weekday}`;
  }
  return bucketLabel(bucket, granularity, locale);
}

export function TrendChart({
  trend,
  filters,
  rangeWindow,
  nowMs,
  groupBy,
  metric,
  onMetricChange,
  onGranularityChange,
  selectedKey,
  onSelect,
  onDrilldownDay,
  highlightedSourceKey,
  labelForKey,
}: {
  readonly trend: readonly UsageTrendBucketWire[];
  readonly filters: UsageFilters;
  readonly rangeWindow?: UsageWindow | null;
  readonly nowMs?: number;
  readonly groupBy: UsageGroupBy;
  readonly metric: UsageMetric;
  readonly onMetricChange: (metric: UsageMetric) => void;
  readonly onGranularityChange?: (granularity: UsageGranularity) => void;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
  readonly onDrilldownDay?: (bucket: UsageTrendBucketWire) => void;
  readonly highlightedSourceKey?: string | null;
  readonly labelForKey: (key: string) => string;
}) {
  const { t, locale, time } = useI18n();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isolatedSeriesKey, setIsolatedSeriesKey] = useState<string | null>(null);

  const displayTrend = useMemo(
    () => fillUsageTrendBuckets(trend, filters.granularity, rangeWindow ?? null),
    [trend, filters.granularity, rangeWindow],
  );

  const series = useMemo(
    () => usageSeriesKeys(displayTrend, groupBy, metric, SERIES_LIMIT),
    [displayTrend, groupBy, metric],
  );

  const activeHighlight = highlightedSourceKey ?? isolatedSeriesKey;

  const valueOf = (group: UsageTrendBucketWire['groups'][number]) =>
    metric === 'tokens' ? totalTokensOf(group) : group.cost_usd_estimated;
  const totals = useMemo(
    () => displayTrend.map((bucket) => {
      if (metric === 'cache') return bucketCacheHit(bucket) ?? 0;
      return metric === 'tokens' ? bucketTokens(bucket) : bucketCost(bucket);
    }),
    [displayTrend, metric],
  );
  const max = metric === 'cache' ? 1 : Math.max(0, ...totals);
  const peakValue = Math.max(0, ...totals);
  const peakIndex = peakValue > 0 ? totals.indexOf(peakValue) : -1;
  const formatValue = (value: number) =>
    metric === 'cache' ? formatCachePercent(value) : metric === 'tokens' ? time.formatTokens(value) : formatCostUsd(value);

  const allowedGranularities = useMemo(
    () => allowedGranularitiesForRange(filters.range, filters.startAt, filters.endAt),
    [filters.range, filters.startAt, filters.endAt],
  );

  const bucketCount = displayTrend.length;
  const labelEvery = filters.granularity === 'hour'
    ? (bucketCount > 24 ? 6 : bucketCount > 12 ? 3 : 1)
    : bucketCount > 28
      ? 5
      : bucketCount > 14
        ? 3
        : bucketCount > 8
          ? 2
          : 1;

  const activeHoverIndex =
    hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < bucketCount
      ? hoveredIndex
      : null;
  const hoveredBucket = activeHoverIndex !== null ? displayTrend[activeHoverIndex] : undefined;
  const hoverRatio =
    activeHoverIndex !== null && bucketCount > 1
      ? activeHoverIndex / (bucketCount - 1)
      : 0;

  const currentNow = nowMs ?? Date.now();
  const canDrilldown = filters.granularity === 'day' && onDrilldownDay !== undefined;
  const gapClass = bucketCount > 24 ? 'gap-[2px]' : 'gap-[3px]';

  return (
    <section data-usage-trend-card aria-label={t('usage.trend.title')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SettingsSegmented<UsageMetric>
          ariaLabel={t('usage.trend.title')}
          dataAttr="data-trend-metric"
          value={metric}
          onChange={onMetricChange}
          choices={USAGE_METRICS.map((candidate) => ({
            value: candidate,
            label: t(`usage.trend.metric.${candidate}`),
          }))}
        />
        {onGranularityChange !== undefined ? (
          allowedGranularities.length > 1 ? (
            <span className="flex items-center">
              <span className="sr-only">{t('usage.axis.granularity')}</span>
              <SettingsSelect<UsageGranularity>
                ariaLabel={t('usage.axis.granularity')}
                dataAttr="data-axis-select"
                value={filters.granularity}
                onChange={onGranularityChange}
                className="bg-transparent px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-2.5"
                choices={allowedGranularities.map((option) => ({
                  value: option,
                  label: t(`usage.granularity.${option}`),
                }))}
              />
            </span>
          ) : (
            <span data-axis-select="static" data-axis-granularity-static={filters.granularity} className="text-[12px] text-ink-faint">
              {t(`usage.granularity.${filters.granularity}`)}
            </span>
          )
        ) : null}
      </div>

      <div
        className="relative"
        onMouseLeave={() => { setHoveredIndex(null); }}
      >
        {hoveredBucket !== undefined && activeHoverIndex !== null ? (() => {
          const unknownTotal = bucketTokenTotalIsUnknown(hoveredBucket);
          const bTokens = bucketTokens(hoveredBucket);
          const bCost = bucketCost(hoveredBucket);
          const bCache = bucketCacheHit(hoveredBucket);
          const topRows = metric === 'cache'
            ? []
            : series
                .map((key, sIdx) => ({
                  key,
                  fill: activeHighlight === key ? 'bg-selected-ink/80' : SERIES_FILLS[sIdx]!,
                  value: hoveredBucket.groups
                    .filter((g) => usageSourceKey(g, groupBy) === key)
                    .reduce((sum, g) => sum + valueOf(g), 0),
                }))
                .filter((entry) => entry.value > 0)
                .slice(0, 3);
          return (
            <div
              aria-hidden
              data-usage-trend-tooltip
              className={`pointer-events-none absolute top-1 z-20 w-56 max-w-[calc(100%-1rem)] rounded-lg border border-hairline-strong bg-panel/95 px-3 py-2 text-[11.5px] shadow-[var(--kiki-sheet-shadow)] backdrop-blur-xs transition-opacity duration-100 ${
                hoverRatio > 0.55 ? 'left-2' : 'right-2'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-ink">
                  {bucketLabel(hoveredBucket, filters.granularity, locale)}
                </span>
                <span className="shrink-0 font-semibold text-ink tabular-nums">
                  {unknownTotal ? '—' : formatValue(totals[activeHoverIndex] ?? 0)}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint tabular-nums">
                {metric !== 'cost' ? <span>{unknownTotal ? '—' : formatCostUsd(bCost)}</span> : null}
                {metric !== 'tokens' ? <span>{unknownTotal ? '—' : time.formatTokens(bTokens)}</span> : null}
                {metric !== 'cache' && bCache !== null ? <span>{`${t('usage.trend.metric.cache')} ${formatCachePercent(bCache)}`}</span> : null}
                {typeof hoveredBucket.turn_count === 'number' && hoveredBucket.turn_count > 0 ? (
                  <span>{t('usage.drilldown.turns', { count: hoveredBucket.turn_count })}</span>
                ) : null}
              </div>
              {topRows.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5 border-t border-hairline pt-1.5">
                  {topRows.map((entry) => (
                    <li key={entry.key} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="flex min-w-0 items-center gap-1.5 text-ink-soft">
                        <span className={`h-2 w-2 shrink-0 rounded-[2px] ${entry.fill}`} />
                        <span className="truncate">{labelForKey(entry.key)}</span>
                      </span>
                      <span className="shrink-0 text-ink tabular-nums">{formatValue(entry.value)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {canDrilldown && (totals[activeHoverIndex] ?? 0) > 0 ? (
                <p className="mt-1.5 border-t border-hairline pt-1 text-[10.5px] text-ink-faint">
                  {t('usage.trend.drilldownHourHint')}
                </p>
              ) : null}
            </div>
          );
        })() : null}

        <div className="w-full" data-usage-trend-scroll>
          <div className="relative">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-5 bottom-0 flex flex-col justify-between">
              {[1, 0.5, 0].map((fraction) => (
                <div key={fraction} className="h-px border-t border-hairline/70" />
              ))}
            </div>
            <div
              className={`relative flex h-40 w-full items-end pt-5 ${gapClass}`}
              role="img"
              aria-label={`${t('usage.trend.title')} · ${peakIndex >= 0 && totals[peakIndex] !== undefined && totals[peakIndex]! > 0 ? t('usage.trend.peak', { value: formatValue(totals[peakIndex]!) }) : t('usage.empty')}`}
              data-usage-trend
            >
              {displayTrend.map((bucket, index) => {
                const total = totals[index] ?? 0;
                const isSyntheticEmpty = bucket.key.startsWith('empty:');
                const selected = !isSyntheticEmpty && selectedKey === bucket.key;
                const dimmed = selectedKey !== null && !selected;
                const inProgress = bucket.start_at <= currentNow && currentNow < bucket.end_at;
                const unknownTotal = bucketTokenTotalIsUnknown(bucket);
                const title = [
                  bucketLabel(bucket, filters.granularity, locale),
                  `${unknownTotal ? '—' : time.formatTokens(bucketTokens(bucket))} ${t('usage.col.tokens')}`,
                  unknownTotal ? '—' : formatCostUsd(bucketCost(bucket)),
                  `${t('usage.trend.metric.cache')} ${formatPercent(bucketCacheHit(bucket))}`,
                  ...(typeof bucket.turn_count === 'number' && bucket.turn_count > 0 ? [t('usage.drilldown.turns', { count: bucket.turn_count })] : []),
                  ...(typeof bucket.request_count === 'number' && bucket.request_count > 0 ? [t('usage.trend.requests', { count: formatGrouped(bucket.request_count) })] : []),
                  ...(bucket.groups.some((group) => group.tokens_unknown === true) ? [t('usage.kpi.partialUnknown')] : []),
                ].join(' · ');
                const heightPct = total > 0 && max > 0 ? Math.max(3, (total / max) * 100) : 0;

                // Build calm ink bar layers.
                const highlightVal = activeHighlight !== null && metric !== 'cache' && total > 0
                  ? bucket.groups
                      .filter((g) => usageSourceKey(g, groupBy) === activeHighlight)
                      .reduce((sum, g) => sum + valueOf(g), 0)
                  : 0;
                const cacheReadTokens = metric === 'tokens' && total > 0
                  ? bucket.groups.reduce((sum, g) => sum + g.tokens.input_cache_read, 0)
                  : 0;
                const nonCacheTokens = Math.max(0, total - cacheReadTokens);

                const costSegments: { key: string; fill: string; value: number }[] = [];
                if (metric === 'cost' && total > 0 && activeHighlight === null) {
                  let rest = total;
                  series.forEach((key, seriesIndex) => {
                    const value = bucket.groups
                      .filter((group) => usageSourceKey(group, groupBy) === key)
                      .reduce((sum, group) => sum + valueOf(group), 0);
                    if (value > 0) {
                      costSegments.push({ key, fill: SERIES_FILLS[seriesIndex]!, value });
                      rest -= value;
                    }
                  });
                  if (rest > total * 0.001) costSegments.push({ key: '__other', fill: OTHER_FILL, value: rest });
                }

                const showPeakTag = index === peakIndex && total > 0;
                const handleClick = () => {
                  if (isSyntheticEmpty) return;
                  if (canDrilldown && total > 0) {
                    onDrilldownDay(bucket);
                    return;
                  }
                  onSelect(selected ? null : bucket.key);
                };

                return (
                  <button
                    key={bucket.key}
                    type="button"
                    data-bucket={isSyntheticEmpty ? undefined : bucket.key}
                    data-bucket-empty={isSyntheticEmpty ? 'true' : undefined}
                    data-bucket-in-progress={inProgress ? 'true' : undefined}
                    aria-pressed={selected}
                    aria-controls="usage-source-table"
                    aria-label={title}
                    disabled={isSyntheticEmpty}
                    onMouseEnter={() => { setHoveredIndex(index); }}
                    onFocus={() => { setHoveredIndex(index); }}
                    onBlur={() => { setHoveredIndex((prev) => (prev === index ? null : prev)); }}
                    onClick={handleClick}
                    title={title}
                    className={`group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end transition-opacity focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-default ${
                      dimmed ? 'opacity-35 hover:opacity-85' : inProgress ? 'opacity-65 hover:opacity-95' : ''
                    }`}
                  >
                    <span aria-hidden className="absolute inset-x-0 inset-y-0 rounded-[3px] bg-ink/0 transition-colors group-hover:bg-ink/[0.04]" />
                    {showPeakTag ? (
                      <span
                        aria-hidden
                        data-usage-trend-peak
                        className="pointer-events-none absolute -top-4.5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-ink-faint tabular-nums"
                      >
                        {formatValue(total)}
                      </span>
                    ) : null}
                    {total <= 0 ? (
                      <span className="block h-[2px] w-full max-w-[28px] rounded-full bg-hairline" />
                    ) : metric === 'cache' ? (
                      <span
                        className={`block w-full max-w-[28px] rounded-t-[2px] transition-colors ${selected ? 'bg-ink/75' : 'bg-ink/55 group-hover:bg-ink/70'}`}
                        style={{ height: `${heightPct}%` }}
                      />
                    ) : activeHighlight !== null ? (
                      <span
                        className={`flex w-full max-w-[28px] flex-col-reverse overflow-hidden rounded-t-[2px] ${selected ? 'ring-1 ring-selected-ink' : ''}`}
                        style={{ height: `${heightPct}%` }}
                      >
                        {highlightVal > 0 ? (
                          <span
                            className="block w-full bg-selected-ink/80 transition-all duration-150"
                            style={{ height: `${(highlightVal / total) * 100}%` }}
                          />
                        ) : null}
                        {total - highlightVal > 0 ? (
                          <span
                            className="block w-full bg-ink/12 transition-all duration-150"
                            style={{ height: `${((total - highlightVal) / total) * 100}%` }}
                          />
                        ) : null}
                      </span>
                    ) : metric === 'tokens' ? (
                      <span
                        className={`flex w-full max-w-[28px] flex-col-reverse overflow-hidden rounded-t-[2px] ${selected ? 'ring-1 ring-ink/60' : ''}`}
                        style={{ height: `${heightPct}%` }}
                      >
                        {cacheReadTokens > 0 ? (
                          <span
                            className="block w-full bg-ink/24"
                            style={{ height: `${(cacheReadTokens / total) * 100}%` }}
                          />
                        ) : null}
                        {nonCacheTokens > 0 ? (
                          <span
                            className="block w-full bg-ink/72"
                            style={{
                              height: `${(nonCacheTokens / total) * 100}%`,
                              ...(cacheReadTokens > 0 ? { borderBottom: '1px solid var(--color-paper)' } : {}),
                            }}
                          />
                        ) : null}
                      </span>
                    ) : (
                      <span
                        className={`flex w-full max-w-[28px] flex-col-reverse overflow-hidden rounded-t-[2px] ${selected ? 'ring-1 ring-ink/60' : ''}`}
                        style={{ height: `${heightPct}%` }}
                      >
                        {costSegments.map((segment, segmentIndex) => (
                          <span
                            key={segment.key}
                            className={`block w-full ${segment.fill}`}
                            style={{
                              height: `${(segment.value / total) * 100}%`,
                              ...(segmentIndex > 0 ? { borderTop: '1px solid transparent', backgroundClip: 'padding-box' } : {}),
                            }}
                          />
                        ))}
                      </span>
                    )}
                    {selected ? <span aria-hidden className="absolute -bottom-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-ink" /> : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div aria-hidden className={`mt-2 flex w-full ${gapClass}`} data-usage-trend-axis>
            {displayTrend.map((bucket, index) => {
              const showLabel =
                index % labelEvery === 0 ||
                (index === bucketCount - 1 && (bucketCount - 1) % labelEvery >= Math.ceil(labelEvery / 2));
              return (
                <span
                  key={bucket.key}
                  className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[10px] text-ink-faint tabular-nums"
                >
                  {showLabel ? compactAxisLabel(bucket, filters.granularity, locale, index > 0 ? displayTrend[index - 1] : undefined) : ''}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-soft">
        {metric === 'cache' ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-[2px] bg-ink/60" />
            {t('usage.cacheHitHint')}
          </span>
        ) : metric === 'tokens' ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-ink-faint">
              <span aria-hidden className="h-2 w-2 rounded-[2px] bg-ink/72" />
              {t('usage.composition.fresh')} / {t('usage.tokens.output')}
            </span>
            <span className="inline-flex items-center gap-1.5 text-ink-faint">
              <span aria-hidden className="h-2 w-2 rounded-[2px] bg-ink/24" />
              {t('usage.tokens.cacheRead')}
            </span>
            {series.length > 0 ? (
              <span aria-hidden className="h-3 w-px bg-hairline" />
            ) : null}
            {series.map((key) => {
              const isolated = isolatedSeriesKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  data-usage-trend-series={key}
                  aria-pressed={isolated}
                  onClick={() => { setIsolatedSeriesKey((prev) => (prev === key ? null : key)); }}
                  className={`inline-flex min-w-0 max-w-52 items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-2.5 ${
                    isolated ? 'bg-selected/60 font-medium text-selected-ink' : activeHighlight !== null && activeHighlight !== key ? 'opacity-45' : ''
                  }`}
                >
                  <span aria-hidden className={`h-2 w-2 shrink-0 rounded-[2px] ${isolated || activeHighlight === key ? 'bg-selected-ink/80' : 'bg-ink/45'}`} />
                  <span className="truncate">{labelForKey(key)}</span>
                </button>
              );
            })}
          </>
        ) : (
          <>
            {series.map((key, index) => {
              const isolated = isolatedSeriesKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  data-usage-trend-series={key}
                  aria-pressed={isolated}
                  onClick={() => { setIsolatedSeriesKey((prev) => (prev === key ? null : key)); }}
                  className={`inline-flex min-w-0 max-w-56 items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-2.5 ${
                    isolated ? 'bg-selected/60 font-medium text-selected-ink' : activeHighlight !== null && activeHighlight !== key ? 'opacity-45' : ''
                  }`}
                >
                  <span aria-hidden className={`h-2 w-2 shrink-0 rounded-[2px] ${isolated || activeHighlight === key ? 'bg-selected-ink/80' : SERIES_FILLS[index]}`} />
                  <span className="truncate">{labelForKey(key)}</span>
                </button>
              );
            })}
            {displayTrend.some((bucket) => bucket.groups.some((group) => !series.includes(usageSourceKey(group, groupBy)))) ? (
              <span className="inline-flex items-center gap-1.5 text-ink-faint">
                <span aria-hidden className={`h-2 w-2 rounded-[2px] ${OTHER_FILL}`} />
                {t('usage.trend.other')}
              </span>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Drilldown session rows with per-turn locators: the session opens the
 * session, and each returned turn id lands on `/s/{id}?turn={n}`. The wire
 * `turn_ids` are rendered, never collapsed into a bare count.
 */
export function DrilldownSessionList({
  sessions,
  sessionTitle,
}: {
  readonly sessions: readonly UsageDrilldownSessionWire[];
  readonly sessionTitle: (id: string) => string | undefined;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <ul className="divide-y divide-hairline">
      {sessions.map((session) => {
        const title = sessionTitle(session.session_id);
        const compactId = compactIdentifier(session.session_id);
        return (
          <li key={session.session_id} className="py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <button
                type="button"
                data-usage-drilldown-session={session.session_id}
                onClick={() => void navigate(`/s/${session.session_id}`)}
                title={session.session_id}
                className="min-w-0 flex-1 truncate text-left text-[13px] text-ink underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                {title ?? <span className="font-mono text-[12px]">{compactId}</span>}
                {title !== undefined ? (
                  <span className="ml-2 font-mono text-[11px] text-ink-faint">{compactId}</span>
                ) : null}
              </button>
              <span className="shrink-0 text-[12px] text-ink-soft tabular-nums">
                {t('usage.drilldown.turns', { count: session.turn_count })}
                {session.turn_ids_truncated ? ` · ${t('usage.drilldown.turnIdsTruncated')}` : ''}
              </span>
              {session.unknown_turn_records > 0 ? (
                <span className="shrink-0 text-[11.5px] text-amber-ink">
                  {t('usage.drilldown.unknownTurns', { count: session.unknown_turn_records })}
                </span>
              ) : null}
            </div>
            {session.turn_ids.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {session.turn_ids.map((turnId) => (
                  <button
                    key={turnId}
                    type="button"
                    data-usage-turn={turnId}
                    onClick={() => void navigate(`/s/${session.session_id}?turn=${turnId}`)}
                    title={t('usage.drilldown.turnHint')}
                    className="min-h-8 rounded-md border border-hairline bg-paper px-2 font-mono text-[11px] text-ink-soft tabular-nums transition-colors hover:border-accent hover:text-ink pointer-coarse:min-h-11"
                  >
                    {t('usage.drilldown.turnId', { id: turnId })}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** One source row's token composition, shown when the reader expands it. */
export function SourceTokenDetails({ label, detail }: { readonly label: string; readonly detail: React.ReactNode }) {
  return (
    <div data-usage-source-details className="border-t border-dashed border-hairline px-3 py-2">
      <p className="text-[11.5px] text-ink-faint">{label}</p>
      {detail}
    </div>
  );
}

/** Header for the session trace: what is scoped, and how to leave. */
export function TraceHeading({ label, onClose }: { readonly label: string; readonly onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-baseline gap-3">
      <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{label}</h3>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.close')}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
