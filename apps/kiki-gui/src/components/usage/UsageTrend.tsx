/**
 * UsageTrend — Hermite-blended non-crossing stacked ribbon & stem trajectory plot
 * with a 1-click discrete column toggle (`曲线 | 柱状`), observed midpoint dots,
 * vertical scrubhair tied strictly to observed buckets, and real accessible
 * chronological `button[data-bucket]` hit columns outside `<svg role="img">`.
 */

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  USAGE_OTHER_COLOR,
  USAGE_RING_OTHER_KEY,
  USAGE_SERIES_COLORS,
} from './usageChartPalette';
import {
  bucketCacheHit,
  bucketCost,
  bucketTokens,
  bucketTokenTotalIsUnknown,
  formatCachePercent,
  formatPercent,
  KnownSubtotalMarker,
} from './usageShared';
import { computeTrendGeometry } from './usageTrendMath';
import { UsageTrendPlotSvg, type UsageTrendVisualMode } from './UsageTrendPlotSvg';

export type { UsageTrendVisualMode };

const SERIES_LIMIT = 4;
const PLOT_HEIGHT = 158;
const PAD_TOP = 20;
const PAD_BOTTOM = 6;

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
  pinnedSourceKey,
  onHoverSourceKey,
  onTogglePinSourceKey,
  tailKeys,
  colorByKey,
  overallCacheHit,
  headerMeta,
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
  readonly pinnedSourceKey?: string | null;
  readonly onHoverSourceKey?: (key: string | null) => void;
  readonly onTogglePinSourceKey?: (key: string) => void;
  readonly tailKeys?: ReadonlySet<string>;
  readonly colorByKey?: ReadonlyMap<string, string>;
  readonly overallCacheHit?: number | null;
  readonly headerMeta?: ReactNode;
  readonly labelForKey: (key: string) => string;
}) {
  const { t, locale, time } = useI18n();
  const [visualMode, setVisualMode] = useState<UsageTrendVisualMode>('ribbon');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [localIsolatedKey, setLocalIsolatedKey] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [plotWidth, setPlotWidth] = useState(680);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    const sync = () => {
      const w = Math.round(el.getBoundingClientRect().width || el.clientWidth);
      if (w >= 180) {
        setPlotWidth((prev) => (prev === w ? prev : w));
      }
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  const displayTrend = useMemo(
    () => fillUsageTrendBuckets(trend, filters.granularity, rangeWindow ?? null),
    [trend, filters.granularity, rangeWindow],
  );

  const series = useMemo(
    () => usageSeriesKeys(displayTrend, groupBy, metric, SERIES_LIMIT),
    [displayTrend, groupBy, metric],
  );

  const activeHighlight = useMemo(() => {
    const raw = highlightedSourceKey ?? pinnedSourceKey ?? localIsolatedKey;
    if (raw !== null && tailKeys?.has(raw) === true) {
      return USAGE_RING_OTHER_KEY;
    }
    return raw;
  }, [highlightedSourceKey, pinnedSourceKey, localIsolatedKey, tailKeys]);
  const activePinned = pinnedSourceKey ?? localIsolatedKey;

  const toggleSeriesKey = (key: string) => {
    if (onTogglePinSourceKey !== undefined) {
      onTogglePinSourceKey(key);
    } else {
      setLocalIsolatedKey((prev) => (prev === key ? null : key));
    }
  };

  const colorForSeries = (key: string, idx: number): string => {
    if (key === USAGE_RING_OTHER_KEY) return USAGE_OTHER_COLOR;
    return colorByKey?.get(key) ?? USAGE_SERIES_COLORS[idx % USAGE_SERIES_COLORS.length]!;
  };

  const plotHeight = plotWidth < 460 ? 112 : PLOT_HEIGHT;
  const currentNow = nowMs ?? Date.now();
  const geometry = useMemo(
    () =>
      computeTrendGeometry({
        buckets: displayTrend,
        metric,
        groupBy,
        nowMs: currentNow,
        rangeWindow: rangeWindow ?? null,
        highlightedKey: activeHighlight,
        tailKeys,
        width: plotWidth,
        height: plotHeight,
        padTop: PAD_TOP,
        padBottom: PAD_BOTTOM,
      }),
    [displayTrend, metric, groupBy, currentNow, rangeWindow, activeHighlight, tailKeys, plotWidth, plotHeight],
  );

  const valueOf = (group: UsageTrendBucketWire['groups'][number]) =>
    metric === 'tokens' ? totalTokensOf(group) : group.cost_usd_estimated;

  const numericTotals = useMemo(
    () => geometry.points.map((pt) => pt.total ?? 0),
    [geometry.points],
  );
  const peakValue = useMemo(() => {
    let best = 0;
    for (const pt of geometry.points) {
      if (pt.total !== null && pt.total > best) best = pt.total;
    }
    return best;
  }, [geometry.points]);
  const peakIndex = useMemo(
    () => (peakValue > 0 ? geometry.points.findIndex((pt) => pt.total === peakValue) : -1),
    [geometry.points, peakValue],
  );

  const formatValue = (value: number) =>
    metric === 'cache'
      ? formatCachePercent(value)
      : metric === 'tokens'
        ? time.formatTokens(value)
        : formatCostUsd(value);

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

  const selectedIndex = useMemo(
    () => (selectedKey === null ? -1 : displayTrend.findIndex((b) => b.key === selectedKey)),
    [displayTrend, selectedKey],
  );
  const activeHoverIndex =
    hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < bucketCount
      ? hoveredIndex
      : null;
  const scrubIndex = activeHoverIndex ?? (selectedIndex >= 0 ? selectedIndex : null);
  const hoveredBucket = activeHoverIndex !== null ? displayTrend[activeHoverIndex] : undefined;
  const hoverRatio =
    activeHoverIndex !== null && geometry.points[activeHoverIndex] !== undefined && plotWidth > 0
      ? geometry.points[activeHoverIndex]!.x / plotWidth
      : 0;

  const canDrilldown = filters.granularity === 'day' && onDrilldownDay !== undefined;
  const primaryStroke = metric === 'cost'
    ? 'var(--kiki-chart-2)'
    : metric === 'cache'
      ? 'var(--kiki-chart-4)'
      : 'var(--kiki-chart-1)';
  const highlightColor = activeHighlight !== null
    ? (activeHighlight === USAGE_RING_OTHER_KEY
        ? USAGE_OTHER_COLOR
        : (colorByKey?.get(activeHighlight) ?? 'var(--kiki-chart-2)'))
    : primaryStroke;

  const plotH = geometry.yBase - geometry.padTop;
  const cacheRefRatio = metric === 'cache' && overallCacheHit !== undefined && overallCacheHit !== null
    ? Math.max(0, Math.min(1, overallCacheHit))
    : null;
  const cacheRefY = cacheRefRatio !== null ? geometry.yBase - cacheRefRatio * plotH : null;

  // Coarse-pointer / narrow-screen active bucket stepper indices (non-synthetic buckets)
  const interactiveIndices = useMemo(
    () => displayTrend.map((b, idx) => (b.key.startsWith('empty:') ? -1 : idx)).filter((idx) => idx >= 0),
    [displayTrend],
  );
  const currentStepperIdx = useMemo(() => {
    if (interactiveIndices.length === 0) return -1;
    if (activeHoverIndex !== null && interactiveIndices.includes(activeHoverIndex)) return activeHoverIndex;
    if (selectedIndex >= 0 && interactiveIndices.includes(selectedIndex)) return selectedIndex;
    for (let k = interactiveIndices.length - 1; k >= 0; k -= 1) {
      const idx = interactiveIndices[k]!;
      if ((numericTotals[idx] ?? 0) > 0) return idx;
    }
    return interactiveIndices.at(-1)!;
  }, [interactiveIndices, selectedIndex, activeHoverIndex, numericTotals]);

  const triggerBucketAt = (index: number) => {
    const bucket = displayTrend[index];
    if (bucket === undefined || bucket.key.startsWith('empty:')) return;
    const total = numericTotals[index] ?? 0;
    if (canDrilldown && total > 0) {
      onDrilldownDay(bucket);
      return;
    }
    onSelect(selectedKey === bucket.key ? null : bucket.key);
  };

  const stepBucket = (delta: -1 | 1) => {
    if (interactiveIndices.length === 0) return;
    const pos = interactiveIndices.indexOf(currentStepperIdx);
    const nextPos = pos < 0 ? 0 : (pos + delta + interactiveIndices.length) % interactiveIndices.length;
    const nextBucketIdx = interactiveIndices[nextPos]!;
    setHoveredIndex(nextBucketIdx);
  };

  const svgAriaLabel = `${t('usage.trend.title')} · ${
    peakIndex >= 0 && peakValue > 0
      ? t('usage.trend.peak', { value: formatValue(peakValue) })
      : t('usage.empty')
  }`;

  const minSlotWidth = useMemo(
    () => (geometry.points.length > 0 ? Math.min(...geometry.points.map((p) => p.slotWidth)) : plotWidth),
    [geometry.points, plotWidth],
  );
  const barColWidth = bucketCount > 0
    ? Math.max(4, Math.min(26, minSlotWidth * 0.56))
    : 12;

  const axisTickIndices = useMemo(() => {
    if (geometry.points.length === 0) return new Set<number>();
    const minPxGap = filters.granularity === 'hour' ? 48 : 56;
    const chosen: number[] = [];
    let lastX = Number.NEGATIVE_INFINITY;
    for (let idx = 0; idx < geometry.points.length; idx += 1) {
      if (idx % labelEvery !== 0 && idx !== geometry.points.length - 1) continue;
      const x = geometry.points[idx]!.x;
      if (x - lastX >= minPxGap) {
        chosen.push(idx);
        lastX = x;
      } else if (idx === geometry.points.length - 1 && chosen.length > 1 && x - geometry.points[chosen.at(-2)!]!.x >= minPxGap * 1.35) {
        chosen[chosen.length - 1] = idx;
        lastX = x;
      }
    }
    return new Set(chosen);
  }, [geometry.points, filters.granularity, labelEvery]);

  return (
    <section data-usage-trend-card aria-label={t('usage.trend.title')} className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
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

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t('usage.trend.title')}
            data-usage-trend-mode-switch
            className="inline-flex items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5"
          >
            {(['ribbon', 'bars'] as const).map((mode) => {
              const active = visualMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  data-usage-trend-mode={mode}
                  aria-pressed={active}
                  onClick={() => { setVisualMode(mode); }}
                  className={`h-7 rounded-[5px] px-2.5 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-3 ${
                    active
                      ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                      : 'text-[var(--kiki-chart-label)] hover:text-ink'
                  }`}
                >
                  {t(`usage.trend.mode.${mode}`)}
                </button>
              );
            })}
          </div>

          {onGranularityChange !== undefined ? (
            allowedGranularities.length > 1 ? (
              <span className="flex items-center">
                <span className="sr-only">{t('usage.axis.granularity')}</span>
                <SettingsSelect<UsageGranularity>
                  ariaLabel={t('usage.axis.granularity')}
                  dataAttr="data-axis-select"
                  value={filters.granularity}
                  onChange={onGranularityChange}
                  className="bg-transparent px-2 text-[12px] text-[var(--kiki-chart-label)] hover:bg-ink/[0.04] hover:text-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-2.5"
                  choices={allowedGranularities.map((option) => ({
                    value: option,
                    label: t(`usage.granularity.${option}`),
                  }))}
                />
              </span>
            ) : (
              <span
                data-axis-select="static"
                data-axis-granularity-static={filters.granularity}
                className="px-1 text-[12px] text-[var(--kiki-chart-label)]"
              >
                {t(`usage.granularity.${filters.granularity}`)}
              </span>
            )
          ) : null}
        </div>
      </div>

      {headerMeta !== undefined ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--kiki-chart-label)]">
          {headerMeta}
        </div>
      ) : null}

      <div
        className="relative"
        onMouseLeave={() => { setHoveredIndex(null); }}
      >
        {hoveredBucket !== undefined && activeHoverIndex !== null ? (() => {
          const unknownTotal = bucketTokenTotalIsUnknown(hoveredBucket);
          const bTokens = bucketTokens(hoveredBucket);
          const bCost = bucketCost(hoveredBucket);
          const bCostUnknown = hoveredBucket.groups.length > 0 && hoveredBucket.groups.every((g) => g.cost_unknown === true) && bCost === 0;
          const bCache = bucketCacheHit(hoveredBucket);
          const pt = geometry.points[activeHoverIndex];
          const topRows = metric === 'cache'
            ? []
            : series
                .map((key, sIdx) => ({
                  key,
                  color: colorForSeries(key, sIdx),
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
              className={`pointer-events-none absolute top-1 z-20 w-56 max-w-[calc(100%-1rem)] rounded-lg bg-panel/96 px-3 py-2 text-[11.5px] shadow-[var(--kiki-sheet-shadow)] backdrop-blur-xs transition-opacity duration-100 ${
                hoverRatio > 0.55 ? 'left-2' : 'right-2'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-ink">
                  {bucketLabel(hoveredBucket, filters.granularity, locale)}
                  {pt?.isInProgress ? (
                    <span className="ml-1.5 font-normal text-[var(--kiki-chart-label)]">
                      · {t('usage.trend.inProgress')}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 font-semibold text-ink tabular-nums">
                  {unknownTotal || pt?.total === null || pt?.total === undefined
                    ? '—'
                    : formatValue(pt.total)}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--kiki-chart-label)] tabular-nums">
                {metric !== 'cost' ? <span className="text-ink">{unknownTotal || bCostUnknown ? '—' : formatCostUsd(bCost)}</span> : null}
                {metric !== 'tokens' ? <span className="text-ink">{unknownTotal ? '—' : time.formatTokens(bTokens)}</span> : null}
                {metric !== 'cache' && bCache !== null ? (
                  <span>{`${t('usage.trend.metric.cache')} ${formatCachePercent(bCache)}`}</span>
                ) : null}
                {typeof hoveredBucket.turn_count === 'number' && hoveredBucket.turn_count > 0 ? (
                  <span>{t('usage.drilldown.turns', { count: hoveredBucket.turn_count })}</span>
                ) : null}
              </div>
              {topRows.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5 border-t border-hairline pt-1.5">
                  {topRows.map((entry) => (
                    <li key={entry.key} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="flex min-w-0 items-center gap-1.5 text-[var(--kiki-chart-label)]">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: entry.color }}
                        />
                        <span className="truncate">{labelForKey(entry.key)}</span>
                      </span>
                      <span className="shrink-0 text-ink tabular-nums">{formatValue(entry.value)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {canDrilldown && (numericTotals[activeHoverIndex] ?? 0) > 0 ? (
                <p className="mt-1.5 border-t border-hairline pt-1 text-[10.5px] text-[var(--kiki-chart-label)]">
                  {t('usage.trend.drilldownHourHint')}
                </p>
              ) : null}
            </div>
          );
        })() : null}

        <div className="w-full" data-usage-trend-scroll>
          <div
            ref={stageRef}
            data-usage-trend
            data-usage-trend-rendered-mode={visualMode}
            style={{ height: `${plotHeight}px` }}
            className="relative w-full"
          >
            {/* Pure SVG Graphic Layer (strictly outside <button> ancestry) */}
            <UsageTrendPlotSvg
              svgAriaLabel={svgAriaLabel}
              plotWidth={plotWidth}
              plotHeight={plotHeight}
              geometry={geometry}
              visualMode={visualMode}
              metric={metric}
              activeHighlight={activeHighlight}
              highlightColor={highlightColor}
              primaryStroke={primaryStroke}
              cacheRefY={cacheRefY}
              overallCacheHit={overallCacheHit}
              scrubIndex={scrubIndex}
              selectedKey={selectedKey}
              barColWidth={barColWidth}
            />

            {/* Single Peak Callout Label + Cache Average Label */}
            {peakIndex >= 0 && peakValue > 0 && geometry.points[peakIndex] !== undefined ? (() => {
              const pPt = geometry.points[peakIndex]!;
              const leftPct = (pPt.x / plotWidth) * 100;
              const alignClass = leftPct < 10 ? 'translate-x-0' : leftPct > 90 ? '-translate-x-full' : '-translate-x-1/2';
              return (
                <span
                  aria-hidden
                  data-usage-trend-peak
                  style={{
                    left: `${leftPct}%`,
                    top: `${Math.max(1, pPt.yTotal - 18)}px`,
                  }}
                  className={`pointer-events-none absolute z-10 whitespace-nowrap text-[10.5px] font-medium text-ink tabular-nums ${alignClass}`}
                >
                  {formatValue(peakValue)}
                </span>
              );
            })() : null}

            {cacheRefY !== null && overallCacheHit !== null && overallCacheHit !== undefined ? (() => {
              const peakLeftPct = peakIndex >= 0 && geometry.points[peakIndex] !== undefined
                ? (geometry.points[peakIndex]!.x / plotWidth) * 100
                : 50;
              const sideClass = peakLeftPct < 24 ? 'right-1' : 'left-1';
              const placeBelow = cacheRefY < geometry.yBase - 18;
              const topPx = placeBelow ? cacheRefY + 4 : Math.max(2, cacheRefY - 16);
              return (
                <span
                  aria-hidden
                  style={{ top: `${topPx}px` }}
                  className={`pointer-events-none absolute ${sideClass} z-10 rounded bg-paper/90 px-1 font-sans tracking-normal text-[10px] font-medium text-ink tabular-nums`}
                >
                  {t('usage.trend.cacheAverage', { value: formatCachePercent(overallCacheHit) })}
                </span>
              );
            })() : null}

            {geometry.inProgressPoints[0] !== undefined && geometry.inProgressPoints[0].index !== peakIndex ? (() => {
              const ip = geometry.inProgressPoints[0];
              const leftPct = (ip.x / plotWidth) * 100;
              return (
                <span
                  aria-hidden
                  style={{
                    left: `${leftPct}%`,
                    top: `${Math.max(2, ip.yTotal - 17)}px`,
                  }}
                  className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap font-sans text-[10px] tracking-normal text-[var(--kiki-chart-label)]"
                >
                  {t('usage.trend.inProgress')}
                </span>
              );
            })() : null}

            {/* Real Chronological Interactive Hit Columns (outside SVG role="img") */}
            <div className="relative z-10 h-full w-full">
              {displayTrend.map((bucket, index) => {
                const pt = geometry.points[index]!;
                const isSyntheticEmpty = bucket.key.startsWith('empty:');
                const selected = !isSyntheticEmpty && selectedKey === bucket.key;
                const tokenUnknown = bucketTokenTotalIsUnknown(bucket);
                const costUnknownAll = bucket.groups.length > 0 && bucket.groups.every((g) => g.cost_unknown === true) && bucketCost(bucket) === 0;
                const leftPct = plotWidth > 0 ? (pt.slotLeft / plotWidth) * 100 : 0;
                const widthPct = plotWidth > 0 ? (pt.slotWidth / plotWidth) * 100 : 100;
                const title = [
                  bucketLabel(bucket, filters.granularity, locale),
                  `${tokenUnknown ? '—' : time.formatTokens(bucketTokens(bucket))} ${t('usage.col.tokens')}`,
                  tokenUnknown || costUnknownAll ? '—' : formatCostUsd(bucketCost(bucket)),
                  `${t('usage.trend.metric.cache')} ${formatPercent(bucketCacheHit(bucket))}`,
                  ...(pt.isInProgress ? [t('usage.trend.inProgress')] : []),
                  ...(typeof bucket.turn_count === 'number' && bucket.turn_count > 0 ? [t('usage.drilldown.turns', { count: bucket.turn_count })] : []),
                  ...(typeof bucket.request_count === 'number' && bucket.request_count > 0 ? [t('usage.trend.requests', { count: formatGrouped(bucket.request_count) })] : []),
                  ...(bucket.groups.some((group) => group.tokens_unknown === true || group.cost_unknown === true) ? [t('usage.kpi.partialUnknown')] : []),
                ].join(' · ');

                return (
                  <button
                    key={bucket.key}
                    type="button"
                    data-bucket={isSyntheticEmpty ? undefined : bucket.key}
                    data-bucket-empty={pt.isEmpty ? 'true' : undefined}
                    data-bucket-in-progress={pt.isInProgress ? 'true' : undefined}
                    aria-pressed={selected}
                    aria-controls="usage-source-table"
                    aria-label={title}
                    disabled={isSyntheticEmpty}
                    onMouseEnter={() => { setHoveredIndex(index); }}
                    onFocus={() => { setHoveredIndex(index); }}
                    onBlur={() => { setHoveredIndex((prev) => (prev === index ? null : prev)); }}
                    onClick={() => { triggerBucketAt(index); }}
                    title={title}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                    }}
                    className="group absolute inset-y-0 flex min-w-0 items-end justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selected-ink disabled:cursor-default"
                  >
                    <span
                      aria-hidden
                      className={`pointer-events-none absolute inset-x-[1px] inset-y-0 rounded-xs transition-colors ${
                        selected ? 'bg-selected/25' : 'bg-ink/0 group-hover:bg-ink/[0.03]'
                      }`}
                    />
                    {selected ? (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute -bottom-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-ink"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Chronological X-Axis strictly aligned to pt.x */}
          <div aria-hidden className="relative mt-2 h-4 w-full" data-usage-trend-axis>
            {displayTrend.map((bucket, index) => {
              if (!axisTickIndices.has(index)) return null;
              const pt = geometry.points[index]!;
              const leftPct = plotWidth > 0 ? (pt.x / plotWidth) * 100 : 50;
              const alignClass = leftPct < 6
                ? 'translate-x-0 text-left'
                : leftPct > 94
                  ? '-translate-x-full text-right'
                  : '-translate-x-1/2 text-center';
              return (
                <span
                  key={bucket.key}
                  style={{ left: `${leftPct}%` }}
                  className={`absolute top-0 whitespace-nowrap text-[10.5px] text-[var(--kiki-chart-label)] tabular-nums ${alignClass}`}
                >
                  {compactAxisLabel(bucket, filters.granularity, locale, index > 0 ? displayTrend[index - 1] : undefined)}
                </span>
              );
            })}
          </div>

          {/* Coarse-pointer 44px prev/activate/next controls whenever >1 interactive buckets exist */}
          {interactiveIndices.length > 1 && currentStepperIdx >= 0 && displayTrend[currentStepperIdx] !== undefined ? (() => {
            const stepBucketItem = displayTrend[currentStepperIdx]!;
            const stepPt = geometry.points[currentStepperIdx]!;
            const stepValText = stepPt.isUnknown || stepPt.total === null
              ? '—'
              : formatValue(stepPt.total);
            return (
              <div
                data-usage-trend-mobile-stepper
                className="mt-2 hidden items-center justify-between gap-1.5 pointer-coarse:flex"
              >
                <button
                  type="button"
                  aria-label={t('usage.trend.prevBucket')}
                  onClick={() => { stepBucket(-1); }}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-ink/[0.04] text-ink transition-colors hover:bg-ink/[0.08] focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  <Icon name="arrowLeft" size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => { triggerBucketAt(currentStepperIdx); }}
                  className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-md bg-ink/[0.04] px-3 text-[12px] text-ink transition-colors hover:bg-ink/[0.08] focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  <span className="truncate font-medium">
                    {bucketLabel(stepBucketItem, filters.granularity, locale)}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{stepValText}</span>
                </button>
                <button
                  type="button"
                  aria-label={t('usage.trend.nextBucket')}
                  onClick={() => { stepBucket(1); }}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-ink/[0.04] text-ink transition-colors hover:bg-ink/[0.08] focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  <Icon name="arrowRight" size={14} />
                </button>
              </div>
            );
          })() : null}
        </div>
      </div>

      {/* Legend & Series Isolation Strip */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[12px] text-[var(--kiki-chart-label)]">
        {metric === 'cache' ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--kiki-chart-4)]" />
            <span>{t('usage.cacheHitHint')}</span>
          </span>
        ) : metric === 'tokens' ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2 w-2 rounded-[2px] bg-[var(--kiki-chart-1)]" />
              <span>{t('usage.composition.fresh')} / {t('usage.tokens.output')}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 rounded-[2px] border border-[var(--kiki-chart-5)]"
                style={{ backgroundColor: 'color-mix(in srgb, var(--kiki-chart-5) 22%, var(--color-paper))' }}
              />
              <span>{t('usage.tokens.cacheRead')}</span>
            </span>
            {series.length > 0 ? <span aria-hidden className="h-3 w-px bg-hairline" /> : null}
            {series.map((key, idx) => {
              const isolated = activePinned === key;
              const isHi = activeHighlight === key;
              const col = colorForSeries(key, idx);
              return (
                <button
                  key={key}
                  type="button"
                  data-usage-trend-series={key}
                  aria-pressed={isolated}
                  onMouseEnter={() => { onHoverSourceKey?.(key); }}
                  onMouseLeave={() => { onHoverSourceKey?.(null); }}
                  onFocus={() => { onHoverSourceKey?.(key); }}
                  onBlur={() => { onHoverSourceKey?.(null); }}
                  onClick={() => { toggleSeriesKey(key); }}
                  className={`inline-flex min-w-0 max-w-52 items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-2.5 ${
                    isolated
                      ? 'bg-selected/70 font-medium text-ink'
                      : activeHighlight !== null && !isHi
                        ? 'text-[var(--kiki-chart-muted)]'
                        : ''
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full transition-opacity ${activeHighlight !== null && !isHi ? 'opacity-35' : ''}`}
                    style={{ backgroundColor: col }}
                  />
                  <span className="truncate">{labelForKey(key)}</span>
                </button>
              );
            })}
          </>
        ) : (
          <>
            {series.map((key, idx) => {
              const isolated = activePinned === key;
              const isHi = activeHighlight === key;
              const col = colorForSeries(key, idx);
              return (
                <button
                  key={key}
                  type="button"
                  data-usage-trend-series={key}
                  aria-pressed={isolated}
                  onMouseEnter={() => { onHoverSourceKey?.(key); }}
                  onMouseLeave={() => { onHoverSourceKey?.(null); }}
                  onFocus={() => { onHoverSourceKey?.(key); }}
                  onBlur={() => { onHoverSourceKey?.(null); }}
                  onClick={() => { toggleSeriesKey(key); }}
                  className={`inline-flex min-w-0 max-w-56 items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-2.5 ${
                    isolated
                      ? 'bg-selected/70 font-medium text-ink'
                      : activeHighlight !== null && !isHi
                        ? 'text-[var(--kiki-chart-muted)]'
                        : ''
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full transition-opacity ${activeHighlight !== null && !isHi ? 'opacity-35' : ''}`}
                    style={{ backgroundColor: col }}
                  />
                  <span className="truncate">{labelForKey(key)}</span>
                </button>
              );
            })}
            {displayTrend.some((bucket) => bucket.groups.some((group) => !series.includes(usageSourceKey(group, groupBy)))) ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: USAGE_OTHER_COLOR }} />
                <span>{t('usage.trend.other')}</span>
              </span>
            ) : null}
          </>
        )}
        {metric === 'cost' && displayTrend.some((b) => b.groups.some((g) => g.cost_unknown)) ? (
          <KnownSubtotalMarker />
        ) : null}
      </div>
    </section>
  );
}

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

export function SourceTokenDetails({ label, detail }: { readonly label: string; readonly detail: React.ReactNode }) {
  return (
    <div data-usage-source-details className="border-t border-dashed border-hairline px-3 py-2">
      <p className="text-[11.5px] text-ink-faint">{label}</p>
      {detail}
    </div>
  );
}

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
