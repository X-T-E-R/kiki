/**
 * Trend chart + the explicit session trace. The chart plots one metric over
 * time, stacked by the source axis, and a bar is a *time selector*: choosing
 * one scopes the source table below to that period and leaves the headline
 * total alone. It never opens a dialog, never shows turn counts, and never
 * reads a per-session endpoint on its own.
 *
 * `DrilldownSessionList` stays as the raw-record locator for the session trace
 * panel, where each turn id still lands on `/s/{id}?turn=n`.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatCostUsd } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import {
  bucketLabel,
  totalTokensOf,
  usageSeriesKeys,
  usageSourceKey,
  USAGE_SOURCE_KEY_UNKNOWN,
  type UsageDrilldownSessionWire,
  type UsageFilters,
  type UsageGroupBy,
  type UsageMetric,
  type UsageTrendBucketWire,
} from '../../lib/usageV2';
import { segmentClass } from '../WorkspaceScopeControl';
import {
  bucketCacheHit,
  bucketCost,
  bucketTokens,
  bucketTokenTotalIsUnknown,
  formatPercent,
} from './usageShared';

/** Series fills, strongest first, on an ink ladder with one amber step so
 * neighbours stay apart; the accent is kept for "needs you", never a series.
 * The last slot is the "other" remainder. */
const SERIES_FILLS = ['bg-ink-soft', 'bg-amber-rule', 'bg-ink-faint/55', 'bg-ink/20'] as const;
const OTHER_FILL = 'bg-hairline';
const SERIES_LIMIT = SERIES_FILLS.length;
/** Pointer/touch floor for one selectable bar; the row scrolls instead of
 * squeezing bars below the target size. */
const MIN_BAR_PX = 44;

export function TrendChart({
  trend,
  filters,
  groupBy,
  metric,
  onMetricChange,
  selectedKey,
  onSelect,
  labelForKey,
}: {
  readonly trend: readonly UsageTrendBucketWire[];
  readonly filters: UsageFilters;
  readonly groupBy: UsageGroupBy;
  readonly metric: UsageMetric;
  readonly onMetricChange: (metric: UsageMetric) => void;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
  readonly labelForKey: (key: string) => string;
}) {
  const { t, locale, time } = useI18n();

  // Series = the top keys across the whole range, fixed by range and metric so
  // colour and order stay put when a bucket is selected.
  const series = useMemo(
    () => usageSeriesKeys(trend, groupBy, metric, SERIES_LIMIT),
    [trend, groupBy, metric],
  );

  const valueOf = (group: UsageTrendBucketWire['groups'][number]) =>
    metric === 'tokens' ? totalTokensOf(group) : group.cost_usd_estimated;
  const totals = trend.map((bucket) =>
    metric === 'cache' ? (bucketCacheHit(bucket) ?? 0) : metric === 'tokens' ? bucketTokens(bucket) : bucketCost(bucket));
  const max = metric === 'cache' ? 1 : Math.max(0, ...totals);
  const peakIndex = totals.indexOf(Math.max(0, ...totals));
  const formatValue = (value: number) =>
    metric === 'cache' ? formatPercent(value) : metric === 'tokens' ? time.formatTokens(value) : formatCostUsd(value);
  // Each bar keeps at least a thumb-sized target; a long series scrolls inside
  // the chart instead of squeezing the bars below it.
  const chartWidth = Math.max(trend.length * MIN_BAR_PX, 0);
  // Label density: keep roughly 7 labels across the visible plot width. When
  // the chart scrolls, only the labels that are actually on screen count, so a
  // long series thins out instead of printing a date under every bar.
  const visibleBars = Math.max(1, Math.ceil(chartWidth / MIN_BAR_PX));
  const labelEvery = Math.max(1, Math.ceil(trend.length / Math.max(2, Math.min(7, visibleBars))));

  return (
    <section data-usage-trend-card aria-label={t('usage.trend.title')}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="group"
          aria-label={t('usage.trend.title')}
          className="inline-flex rounded-[9px] border border-hairline bg-paper p-0.5"
        >
          {(['cost', 'tokens', 'cache'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-trend-metric={candidate}
              onClick={() => { onMetricChange(candidate); }}
              aria-pressed={metric === candidate}
              className={`${segmentClass(metric === candidate, 'h-8 px-3 text-[12.5px] pointer-coarse:min-h-11')}`}
            >
              {t(`usage.trend.metric.${candidate}`)}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-ink-faint">{t('usage.trend.clickHint')}</span>
      </div>
      <div className="overflow-x-auto">
        <div className="relative" style={chartWidth > 0 ? { minWidth: chartWidth + 56 } : undefined}>
          {/* Gridlines at 0 / 50 / 100% of the scale, labelled on the right. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 bottom-0 flex flex-col justify-between">
            {[1, 0.5, 0].map((fraction) => (
              <div key={fraction} className="flex items-center gap-2">
                <span className="h-px flex-1 border-t border-dashed border-hairline" />
                <span className="w-12 text-right font-mono text-[10px] text-ink-faint tabular-nums">
                  {max > 0 ? formatValue(max * fraction) : ''}
                </span>
              </div>
            ))}
          </div>
          <div
            className="relative mr-14 flex h-44 items-end justify-center gap-[3px]"
            role="img"
            aria-label={`${t('usage.trend.title')} · ${peakIndex >= 0 && totals[peakIndex] !== undefined && totals[peakIndex]! > 0 ? t('usage.trend.peak', { value: formatValue(totals[peakIndex]!) }) : t('usage.empty')}`}
            data-usage-trend
          >
            {trend.map((bucket, index) => {
              const total = totals[index] ?? 0;
              const selected = selectedKey === bucket.key;
              const dimmed = selectedKey !== null && !selected;
              const unknownTotal = bucketTokenTotalIsUnknown(bucket);
              const title = [
                bucketLabel(bucket, filters.granularity, locale),
                `${unknownTotal ? '—' : time.formatTokens(bucketTokens(bucket))} ${t('usage.col.tokens')}`,
                unknownTotal ? '—' : formatCostUsd(bucketCost(bucket)),
                `${t('usage.trend.metric.cache')} ${formatPercent(bucketCacheHit(bucket))}`,
                ...(bucket.groups.some((group) => group.tokens_unknown === true) ? [t('usage.kpi.partialUnknown')] : []),
              ].join(' · ');
              const heightPct = total > 0 && max > 0 ? Math.max(3, (total / max) * 100) : 0;
              // Stack segments bottom-up: known series first, remainder last.
              const segments: { key: string; fill: string; value: number }[] = [];
              if (metric !== 'cache' && total > 0) {
                let rest = total;
                series.forEach((key, seriesIndex) => {
                  const value = bucket.groups
                    .filter((group) => usageSourceKey(group, groupBy) === key)
                    .reduce((sum, group) => sum + valueOf(group), 0);
                  if (value > 0) {
                    segments.push({ key, fill: SERIES_FILLS[seriesIndex]!, value });
                    rest -= value;
                  }
                });
                if (rest > total * 0.001) segments.push({ key: '__other', fill: OTHER_FILL, value: rest });
              }
              return (
                <button
                  key={bucket.key}
                  type="button"
                  data-bucket={bucket.key}
                  aria-pressed={selected}
                  aria-controls="usage-source-table"
                  aria-label={title}
                  onClick={() => { onSelect(selected ? null : bucket.key); }}
                  title={title}
                  style={{ flexBasis: MIN_BAR_PX, minWidth: MIN_BAR_PX }}
                  className={`group relative flex h-full shrink-0 grow flex-col justify-end rounded-t-[3px] transition-opacity focus-visible:outline-2 focus-visible:outline-selected-ink ${dimmed ? 'opacity-45 hover:opacity-80' : ''}`}
                >
                  <span aria-hidden className="absolute inset-0 rounded-[3px] bg-ink/0 transition-colors group-hover:bg-ink/[0.035]" />
                  {total <= 0 ? (
                    <span className="block h-[2px] w-full rounded-full bg-hairline" />
                  ) : metric === 'cache' ? (
                    <span
                      className={`block w-full rounded-t-[3px] ${selected ? 'bg-success' : 'bg-success/60 group-hover:bg-success/80'}`}
                      style={{ height: `${heightPct}%` }}
                    />
                  ) : (
                    <span className="flex w-full flex-col-reverse overflow-hidden rounded-t-[3px]" style={{ height: `${heightPct}%` }}>
                      {segments.map((segment) => (
                        <span
                          key={segment.key}
                          className={`block w-full ${segment.fill}`}
                          style={{ height: `${(segment.value / total) * 100}%` }}
                        />
                      ))}
                    </span>
                  )}
                  {selected ? <span aria-hidden className="absolute -bottom-1.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-ink" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <div aria-hidden className="mr-14 flex justify-center gap-[3px]" style={chartWidth > 0 ? { minWidth: chartWidth + 56 } : undefined}>
          {trend.map((bucket, index) => (
            <span key={bucket.key} style={{ flexBasis: MIN_BAR_PX, minWidth: MIN_BAR_PX }} className="shrink-0 grow truncate text-center font-mono text-[10px] text-ink-faint tabular-nums">
              {index % labelEvery === 0 || index === trend.length - 1 ? bucketLabel(bucket, filters.granularity, locale) : ''}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-soft">
        {metric === 'cache' ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-[2px] bg-success/70" />
            {t('usage.cacheHitHint')}
          </span>
        ) : (
          <>
            {series.map((key, index) => (
              <span key={key} data-usage-trend-series={key} className="inline-flex min-w-0 max-w-56 items-center gap-1.5">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-[2px] ${SERIES_FILLS[index]}`} />
                <span className="truncate">{labelForKey(key)}</span>
              </span>
            ))}
            {trend.some((bucket) => bucket.groups.some((group) => !series.includes(usageSourceKey(group, groupBy)))) ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className={`h-2 w-2 rounded-[2px] ${OTHER_FILL}`} />
                {t('usage.trend.other')}
              </span>
            ) : null}
          </>
        )}
      </div>
      {series.some((key) => key === USAGE_SOURCE_KEY_UNKNOWN) ? (
        <p className="mt-2 text-[11.5px] text-ink-faint">{t('usage.sources.unknownNote')}</p>
      ) : null}
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
                {title ?? <span className="font-mono text-[12px]">{session.session_id}</span>}
                {title !== undefined ? (
                  <span className="ml-2 font-mono text-[11px] text-ink-faint">{session.session_id}</span>
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