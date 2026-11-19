/**
 * Trend chart + the explicit session trace. The chart plots one metric over
 * time, stacked by the source axis, and a bar is a *time selector*: choosing
 * one scopes the source table below to that period and leaves the headline
 * total alone. Hovering or focusing any bar surfaces an immediate paper readout
 * card with per-series breakdown.
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
  bucketLabel,
  totalTokensOf,
  usageSeriesKeys,
  usageSourceKey,
  USAGE_GRANULARITIES,
  type UsageDrilldownSessionWire,
  type UsageFilters,
  type UsageGranularity,
  type UsageGroupBy,
  type UsageMetric,
  type UsageTrendBucketWire,
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

/** Warm editorial paper-and-ink + mineral series palette so adjacent stacks stay distinct. */
const SERIES_FILLS = [
  'bg-ink/70',
  'bg-accent/75',
  'bg-selected-ink/60',
  'bg-amber-rule/80',
] as const;
const OTHER_FILL = 'bg-ink/18';
const SERIES_LIMIT = SERIES_FILLS.length;
const MIN_BUCKET_PX = 36;

export function TrendChart({
  trend,
  filters,
  groupBy,
  metric,
  onMetricChange,
  onGranularityChange,
  selectedKey,
  onSelect,
  labelForKey,
}: {
  readonly trend: readonly UsageTrendBucketWire[];
  readonly filters: UsageFilters;
  readonly groupBy: UsageGroupBy;
  readonly metric: UsageMetric;
  readonly onMetricChange: (metric: UsageMetric) => void;
  readonly onGranularityChange?: (granularity: UsageGranularity) => void;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
  readonly labelForKey: (key: string) => string;
}) {
  const { t, locale, time } = useI18n();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

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
    metric === 'cache' ? formatCachePercent(value) : metric === 'tokens' ? time.formatTokens(value) : formatCostUsd(value);

  const chartWidth = Math.max(trend.length * MIN_BUCKET_PX, 0);
  const visibleBars = Math.max(1, Math.ceil(chartWidth / MIN_BUCKET_PX));
  const labelEvery = Math.max(1, Math.ceil(trend.length / Math.max(2, Math.min(7, visibleBars))));

  const activeHoverIndex =
    hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < trend.length
      ? hoveredIndex
      : null;
  const hoveredBucket = activeHoverIndex !== null ? trend[activeHoverIndex] : undefined;
  const hoverRatio =
    activeHoverIndex !== null && trend.length > 1
      ? activeHoverIndex / (trend.length - 1)
      : 0;

  return (
    <section data-usage-trend-card aria-label={t('usage.trend.title')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SettingsSegmented<UsageMetric>
          ariaLabel={t('usage.trend.title')}
          dataAttr="data-trend-metric"
          value={metric}
          onChange={onMetricChange}
          choices={(['cost', 'tokens', 'cache'] as const).map((candidate) => ({
            value: candidate,
            label: t(`usage.trend.metric.${candidate}`),
          }))}
        />
        {onGranularityChange !== undefined ? (
          <span className="flex items-center gap-2">
            <span className="shrink-0 text-[12.5px] text-ink-soft">{t('usage.axis.granularity')}</span>
            <SettingsSelect<UsageGranularity>
              ariaLabel={t('usage.axis.granularity')}
              dataAttr="data-axis-select"
              value={filters.granularity}
              onChange={onGranularityChange}
              choices={USAGE_GRANULARITIES.map((option) => ({
                value: option,
                label: t(`usage.granularity.${option}`),
              }))}
            />
          </span>
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
                  fill: SERIES_FILLS[sIdx]!,
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
                {typeof hoveredBucket.turn_count === 'number' ? (
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
            </div>
          );
        })() : null}

        <div className="overflow-x-auto">
          <div className="relative" style={chartWidth > 0 ? { minWidth: chartWidth } : undefined}>
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 bottom-0 flex flex-col justify-between">
              {[1, 0.5, 0].map((fraction) => (
                <div key={fraction} className="h-px border-t border-hairline/70" />
              ))}
            </div>
            <div
              className="relative flex h-36 items-end justify-center gap-1.5 px-1 pt-3"
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
                  ...(typeof bucket.turn_count === 'number' ? [t('usage.drilldown.turns', { count: bucket.turn_count })] : []),
                  ...(typeof bucket.request_count === 'number' ? [t('usage.trend.requests', { count: formatGrouped(bucket.request_count) })] : []),
                  ...(bucket.groups.some((group) => group.tokens_unknown === true) ? [t('usage.kpi.partialUnknown')] : []),
                ].join(' · ');
                const heightPct = total > 0 && max > 0 ? Math.max(3, (total / max) * 100) : 0;
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
                    onMouseEnter={() => { setHoveredIndex(index); }}
                    onFocus={() => { setHoveredIndex(index); }}
                    onBlur={() => { setHoveredIndex((prev) => (prev === index ? null : prev)); }}
                    onClick={() => { onSelect(selected ? null : bucket.key); }}
                    title={title}
                    style={{ flexBasis: MIN_BUCKET_PX, minWidth: MIN_BUCKET_PX }}
                    className={`group relative flex h-full shrink-0 grow flex-col items-center justify-end transition-opacity focus-visible:outline-2 focus-visible:outline-selected-ink ${dimmed ? 'opacity-35 hover:opacity-85' : ''}`}
                  >
                    <span aria-hidden className="absolute inset-0 rounded-[3px] bg-ink/0 transition-colors group-hover:bg-ink/[0.04]" />
                    {total <= 0 ? (
                      <span className="block h-[2px] w-full max-w-[44px] rounded-full bg-hairline" />
                    ) : metric === 'cache' ? (
                      <span
                        className={`block w-full max-w-[44px] rounded-t-[3px] transition-colors ${selected ? 'bg-success/75' : 'bg-success/55 group-hover:bg-success/70'}`}
                        style={{ height: `${heightPct}%` }}
                      />
                    ) : (
                      <span
                        className="flex w-full max-w-[44px] flex-col-reverse overflow-hidden rounded-t-[3px]"
                        style={{ height: `${heightPct}%` }}
                      >
                        {segments.map((segment, segmentIndex) => (
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
        </div>
      </div>

      <div className="mt-2 overflow-x-auto">
        <div aria-hidden className="flex justify-center gap-1.5 px-1" style={chartWidth > 0 ? { minWidth: chartWidth } : undefined}>
          {trend.map((bucket, index) => (
            <span key={bucket.key} style={{ flexBasis: MIN_BUCKET_PX, minWidth: MIN_BUCKET_PX }} className="shrink-0 grow truncate text-center text-[10.5px] text-ink-faint tabular-nums">
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
