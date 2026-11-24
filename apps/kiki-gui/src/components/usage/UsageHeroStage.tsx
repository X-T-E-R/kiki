import { useMemo, type ReactNode } from 'react';
import { formatCostUsd, formatGrouped } from '@kiki/session-core/util';
import { useI18n } from '../../i18n';
import {
  bucketLabel,
  cacheHitRateOf,
  totalTokensOf,
  usagePointChange,
  usageRatioChange,
  usageTokenTotalIsUnknown,
  type UsageFilters,
  type UsageGranularity,
  type UsageGroupBy,
  type UsageMetric,
  type UsageResponseWire,
  type UsageSourceRow,
  type UsageTrendBucketWire,
  type UsageWindow,
} from '../../lib/usageV2';
import { Icon } from '../icons';
import { type CompositionModel } from './usageChartPalette';
import { UsageCompositionRing } from './UsageCompositionRing';
import { avgCostPerTurn, summarizeActivityCounts } from './usageMetrics';
import {
  bucketCacheHit,
  bucketCost,
  bucketTokens,
  bucketTokenTotalIsUnknown,
  CompareCell,
  formatCachePercent,
  KnownSubtotalMarker,
} from './usageShared';
import { TrendChart } from './UsageTrend';

export function UsageHeroStage({
  summary,
  trend,
  sourceRows,
  composition,
  singleFilters,
  rangeWindow,
  incomplete,
  complete,
  emptyMessage,
  comparing,
  prior,
  unpricedCount,
  onOpenPricing,
  cacheSavingsUsd,
  nowMs,
  groupBy,
  metric,
  onMetricChange,
  onGranularityChange,
  selectedBucketKey,
  selectedBucket,
  showScopedBucketInRing,
  onSelectBucketKey,
  onDrilldownDay,
  activeHighlightKey,
  pinnedSourceKey,
  onHoverSourceKey,
  onTogglePinSourceKey,
  labelForKey,
}: {
  readonly summary: UsageResponseWire['summary'] | undefined;
  readonly trend: readonly UsageTrendBucketWire[];
  readonly sourceRows: readonly UsageSourceRow[];
  readonly composition: CompositionModel;
  readonly singleFilters: UsageFilters;
  readonly rangeWindow: UsageWindow | null;
  readonly incomplete: boolean;
  readonly complete: boolean;
  readonly emptyMessage: string;
  readonly comparing: boolean;
  readonly prior: UsageResponseWire['summary'] | undefined;
  readonly unpricedCount: number;
  readonly onOpenPricing: () => void;
  readonly cacheSavingsUsd: number | undefined;
  readonly nowMs: number;
  readonly groupBy: UsageGroupBy;
  readonly metric: UsageMetric;
  readonly onMetricChange: (metric: UsageMetric) => void;
  readonly onGranularityChange: (granularity: UsageGranularity) => void;
  readonly selectedBucketKey: string | null;
  readonly selectedBucket: UsageTrendBucketWire | undefined;
  readonly showScopedBucketInRing: boolean;
  readonly onSelectBucketKey: (key: string | null) => void;
  readonly onDrilldownDay: (bucket: UsageTrendBucketWire) => void;
  readonly activeHighlightKey: string | null;
  readonly pinnedSourceKey: string | null;
  readonly onHoverSourceKey: (key: string | null) => void;
  readonly onTogglePinSourceKey: (key: string) => void;
  readonly labelForKey: (key: string) => string;
}) {
  const { t, tp, locale, time } = useI18n();

  const bucketActivity = useMemo(() => summarizeActivityCounts(trend), [trend]);

  const scopedCacheHit = useMemo(() => {
    const sum = sourceRows.reduce(
      (acc, row) => ({
        input_other: acc.input_other + row.tokens.input_other,
        output: acc.output + row.tokens.output,
        input_cache_read: acc.input_cache_read + row.tokens.input_cache_read,
        input_cache_creation: acc.input_cache_creation + row.tokens.input_cache_creation,
      }),
      { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    );
    return cacheHitRateOf({ tokens: sum, cost_usd_estimated: 0, cost_unknown: false });
  }, [sourceRows]);

  if (summary === undefined) return null;

  const costUnknown = summary.cost_unknown || incomplete;
  const totalTokens = totalTokensOf(summary);
  const tokensUnknown = usageTokenTotalIsUnknown(summary) || (incomplete && totalTokens === 0);
  const overallCacheHit = cacheHitRateOf(summary);
  const input = summary.tokens.input_other + summary.tokens.input_cache_read + summary.tokens.input_cache_creation;

  const tokenCompositionTitle = !tokensUnknown && input > 0
    ? [
        `${t('usage.tokens.cacheRead')}: ${time.formatTokens(summary.tokens.input_cache_read)}`,
        `${t('usage.tokens.cacheWrite')}: ${time.formatTokens(summary.tokens.input_cache_creation)}`,
        `${t('usage.composition.fresh')}: ${time.formatTokens(summary.tokens.input_other)}`,
      ].join(' · ')
    : undefined;

  const rangeDays = rangeWindow !== null
    ? Math.max(1, Math.round((rangeWindow.endAt - rangeWindow.startAt) / 86_400_000))
    : 1;
  const dailyAvgTokens = !tokensUnknown && totalTokens > 0 && rangeDays >= 2
    ? totalTokens / rangeDays
    : undefined;

  const tokensOutcome = comparing && prior !== undefined
    ? usageRatioChange(totalTokens, totalTokensOf(prior))
    : undefined;
  const costOutcome = comparing && prior !== undefined
    ? (summary.cost_unknown && summary.cost_usd_estimated === 0) || (prior.cost_unknown && prior.cost_usd_estimated === 0)
      ? usageRatioChange(Number.NaN, Number.NaN)
      : usageRatioChange(summary.cost_usd_estimated, prior.cost_usd_estimated)
    : undefined;
  const cacheOutcome = comparing && prior !== undefined
    ? usagePointChange(overallCacheHit, cacheHitRateOf(prior))
    : undefined;

  const turns = typeof summary.turn_count === 'number' ? summary.turn_count : bucketActivity.turns;
  const requests = typeof summary.request_count === 'number' ? summary.request_count : bucketActivity.requests;
  const hasTurns = typeof summary.turn_count === 'number' || bucketActivity.hasTurns;
  const hasRequests = typeof summary.request_count === 'number' || bucketActivity.hasRequests;
  const activity = { turns, requests, hasTurns, hasRequests };
  const perTurnCost = avgCostPerTurn(summary, activity);

  const blendedPerMillion = !tokensUnknown && totalTokens > 0 && !costUnknown
    ? (summary.cost_usd_estimated / totalTokens) * 1_000_000
    : undefined;
  const costTitleParts = [
    ...(blendedPerMillion !== undefined ? [t('usage.kpi.blendedPerM', { cost: formatCostUsd(blendedPerMillion) })] : []),
    ...(unpricedCount > 0 ? [tp('usage.kpi.unpricedCount', unpricedCount)] : []),
    ...(perTurnCost !== undefined ? [t('usage.kpi.avgPerTurn', { cost: formatCostUsd(perTurnCost) })] : []),
  ];
  const costTitle = costTitleParts.length > 0 ? costTitleParts.join(' · ') : undefined;

  const tokensFormatted = tokensUnknown ? '—' : time.formatTokens(totalTokens);
  const allCostUnknown =
    (summary.cost_unknown && summary.cost_usd_estimated === 0 && (totalTokens > 0 || tokensUnknown)) ||
    (incomplete && tokensUnknown && summary.cost_usd_estimated === 0);
  const costFormatted = allCostUnknown
    ? '—'
    : formatCostUsd(summary.cost_usd_estimated);
  const cacheFormatted = tokensUnknown ? '—' : formatCachePercent(overallCacheHit);

  const tokensPartialBadge = summary.tokens_unknown === true ? (
    <span
      data-usage-accounting-known-subtotal
      title={t('usage.accounting.knownSubtotal')}
      aria-label={t('usage.accounting.knownSubtotal')}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-amber-ink"
    >
      <Icon name="partial" size={14} />
    </span>
  ) : undefined;

  const unpricedTriggerButton = unpricedCount > 0 ? (
    <button
      type="button"
      data-usage-unpriced-trigger
      onClick={onOpenPricing}
      title={[
        tp('usage.kpi.unpricedCount', unpricedCount),
        t('usage.reliability.setPrices'),
        ...(blendedPerMillion !== undefined ? [t('usage.kpi.blendedPerM', { cost: formatCostUsd(blendedPerMillion) })] : []),
      ].join(' · ')}
      aria-label={`${tp('usage.kpi.unpricedCount', unpricedCount)} · ${t('usage.reliability.setPrices')}`}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-amber-ink transition-colors hover:bg-amber-card focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      <Icon name="partial" size={14} />
    </button>
  ) : undefined;

  const costUnknownBadge =
    unpricedTriggerButton ??
    (summary.cost_unknown ? (
      <KnownSubtotalMarker label={allCostUnknown ? t('usage.reliability.costUnknown') : undefined} />
    ) : undefined);

  const scopedBucketSummary = showScopedBucketInRing && selectedBucket !== undefined
    ? (() => {
        const bUnknown = bucketTokenTotalIsUnknown(selectedBucket);
        const bCost = bucketCost(selectedBucket);
        const bTok = bucketTokens(selectedBucket);
        const bCache = bucketCacheHit(selectedBucket);
        const bCostAllUnknown =
          bUnknown ||
          (selectedBucket.groups.length > 0 &&
            selectedBucket.groups.every((g) => g.cost_unknown === true) &&
            bCost === 0 &&
            bTok > 0);
        const bCostHasUnknown = selectedBucket.groups.some((g) => g.cost_unknown === true);
        const primaryFigure = bUnknown
          ? '—'
          : metric === 'cost'
            ? (bCostAllUnknown ? '—' : formatCostUsd(bCost))
            : metric === 'cache'
              ? formatCachePercent(bCache)
              : time.formatTokens(bTok);
        const canExpandHours =
          singleFilters.granularity === 'day' && (bTok > 0 || bCost > 0 || bUnknown);
        return {
          scopeLabel: bucketLabel(selectedBucket, singleFilters.granularity, locale),
          primaryFigure,
          subtotalCostText: bCostAllUnknown ? '—' : formatCostUsd(bCost),
          costUnknown: bCostHasUnknown,
          costAllUnknown: bCostAllUnknown,
          onClear: () => { onSelectBucketKey(null); },
          onDrilldownDay: canExpandHours ? () => { onDrilldownDay(selectedBucket); } : undefined,
        };
      })()
    : undefined;

  const isScoped = scopedBucketSummary !== undefined;

  const periodHero =
    metric === 'cost'
      ? {
          kpiId: 'cost' as const,
          dataSummaryAttr: 'data-usage-summary-cost',
          label: t('usage.kpi.estimatedCost'),
          title: costTitle,
          value: (
            <span className="flex flex-col items-center leading-tight">
              <span className="max-w-full truncate">{costFormatted}</span>
              {costOutcome !== undefined ? (
                <span className="mt-0.5 font-sans text-[10.5px] leading-none">
                  <CompareCell outcome={costOutcome} />
                </span>
              ) : null}
            </span>
          ),
          valueAction: costUnknownBadge,
        }
      : metric === 'cache'
        ? {
            kpiId: 'cache' as const,
            dataSummaryAttr: 'data-usage-summary-cache',
            label: t('usage.kpi.cacheHit'),
            title: t('usage.cacheHitHint'),
            value: (
              <span className="flex flex-col items-center leading-tight">
                <span className="max-w-full truncate">{cacheFormatted}</span>
                {cacheOutcome !== undefined ? (
                  <span className="mt-0.5 font-sans text-[10.5px] leading-none">
                    <CompareCell outcome={cacheOutcome} points />
                  </span>
                ) : null}
              </span>
            ),
          }
        : {
            kpiId: 'tokens' as const,
            dataSummaryAttr: 'data-usage-summary-tokens',
            label: t('usage.kpi.totalTokens'),
            title: tokenCompositionTitle,
            value: (
              <span className="flex flex-col items-center leading-tight">
                <span className="max-w-full truncate">{tokensFormatted}</span>
                {tokensOutcome !== undefined ? (
                  <span className="mt-0.5 font-sans text-[10.5px] leading-none">
                    <CompareCell outcome={tokensOutcome} />
                  </span>
                ) : null}
              </span>
            ),
            valueAction: tokensPartialBadge,
          };

  const inlineTokensKpi = (isScoped || metric !== 'tokens') ? (
    <span
      data-usage-kpi="tokens"
      title={tokenCompositionTitle}
      className="inline-flex items-center gap-1 font-sans tracking-normal text-[var(--kiki-chart-label)]"
    >
      <span data-usage-summary-tokens className="font-semibold text-ink tabular-nums">
        {tokensFormatted}
      </span>
      <span>{t('usage.col.tokens')}</span>
      {tokensPartialBadge}
      {tokensOutcome !== undefined ? <CompareCell outcome={tokensOutcome} /> : null}
    </span>
  ) : null;

  const inlineActivityKpi = (
    <span
      data-usage-kpi="activity"
      title={perTurnCost !== undefined ? t('usage.kpi.avgPerTurn', { cost: formatCostUsd(perTurnCost) }) : undefined}
      className="inline-flex items-baseline gap-1 font-sans tracking-normal text-[var(--kiki-chart-label)]"
    >
      <span data-usage-summary-activity className="inline-flex items-baseline gap-1 tabular-nums">
        {hasTurns && hasRequests ? (
          <>
            <span className="font-semibold text-ink">{formatGrouped(requests)}</span>
            <span>{t('usage.kpi.requestsUnit')}</span>
            <span aria-hidden>·</span>
            <span className="font-semibold text-ink">{formatGrouped(turns)}</span>
            <span>{t('usage.kpi.turnsUnit')}</span>
          </>
        ) : hasTurns ? (
          <>
            <span className="font-semibold text-ink">{formatGrouped(turns)}</span>
            <span>{t('usage.kpi.turnsUnit')}</span>
          </>
        ) : (
          <span className="font-medium text-ink">{tp('usage.sessionChip', summary.session_count)}</span>
        )}
      </span>
    </span>
  );

  const inlineCostKpi = (isScoped || metric !== 'cost') ? (
    <span
      data-usage-kpi="cost"
      title={costTitle}
      className="inline-flex items-center gap-1 font-sans tracking-normal text-[var(--kiki-chart-label)]"
    >
      <span>{t('usage.kpi.estimatedCost')}</span>
      <span data-usage-summary-cost className="font-semibold text-ink tabular-nums">
        {costFormatted}
      </span>
      {costUnknownBadge}
      {costOutcome !== undefined ? <CompareCell outcome={costOutcome} /> : null}
    </span>
  ) : null;

  const inlineCacheKpi = (isScoped || metric !== 'cache') ? (
    <span
      data-usage-kpi="cache"
      title={t('usage.cacheHitHint')}
      className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-sans tracking-normal text-[var(--kiki-chart-label)]"
    >
      <span>{t('usage.kpi.cacheHit')}</span>
      <span data-usage-summary-cache className="font-medium text-ink tabular-nums">
        {cacheFormatted}
      </span>
      {cacheOutcome !== undefined ? <CompareCell outcome={cacheOutcome} points /> : null}
      {cacheSavingsUsd !== undefined ? (
        <span data-usage-cache-savings className="text-ink tabular-nums">
          · {t('usage.kpi.cacheSaved', { cost: formatCostUsd(cacheSavingsUsd) })}
        </span>
      ) : null}
    </span>
  ) : cacheSavingsUsd !== undefined ? (
    <span data-usage-cache-savings className="font-sans tracking-normal text-ink tabular-nums">
      {t('usage.kpi.cacheSaved', { cost: formatCostUsd(cacheSavingsUsd) })}
    </span>
  ) : null;

  const inputOutputLine = (
    <span data-usage-summary-input-output className="font-sans tracking-normal tabular-nums">
      {tokensUnknown
        ? '—'
        : [
            t('usage.kpi.inputOutput', {
              input: time.formatTokens(input),
              output: time.formatTokens(summary.tokens.output),
            }),
            ...(dailyAvgTokens !== undefined ? [t('usage.kpi.dailyAvg', { tokens: time.formatTokens(dailyAvgTokens) })] : []),
          ].join(' · ')}
    </span>
  );

  const plotHeaderMeta = (
    <>
      {inputOutputLine}
      {inlineCacheKpi !== null ? (
        <>
          <span aria-hidden className="text-hairline-strong">·</span>
          {inlineCacheKpi}
        </>
      ) : null}
    </>
  );

  const ringSubtitleParts = [
    inlineTokensKpi !== null ? { id: 'tokens', node: inlineTokensKpi as ReactNode } : null,
    inlineActivityKpi !== null ? { id: 'activity', node: inlineActivityKpi as ReactNode } : null,
    inlineCostKpi !== null ? { id: 'cost', node: inlineCostKpi as ReactNode } : null,
  ].filter((item): item is { id: string; node: ReactNode } => item !== null);
  const ringSubtitle = (
    <>
      {ringSubtitleParts.map((part, idx) => (
        <span key={part.id} className="inline-flex items-center gap-2">
          {idx > 0 ? <span aria-hidden className="text-hairline-strong">·</span> : null}
          {part.node}
        </span>
      ))}
    </>
  );

  return (
    <div data-usage-hero className="@container/usage pt-0.5">
      <div className="grid grid-cols-1 items-start gap-y-3.5 @min-[800px]/usage:grid-cols-[minmax(0,1.95fr)_minmax(268px,1fr)] @min-[800px]/usage:gap-x-10 @min-[800px]/usage:gap-y-6">
        {/* Right Zone (>=800px; stacked first <800px): Composition Donut Ring */}
        <div className="min-w-0 @min-[800px]/usage:order-2">
          <UsageCompositionRing
            composition={composition}
            metric={metric}
            groupBy={groupBy}
            overallCacheHit={isScoped ? scopedCacheHit : overallCacheHit}
            periodHero={periodHero}
            scopedBucket={scopedBucketSummary}
            subtitleContent={ringSubtitle}
            activeHighlightKey={activeHighlightKey}
            pinnedKey={pinnedSourceKey}
            onHoverKey={onHoverSourceKey}
            onTogglePinKey={onTogglePinSourceKey}
            labelForKey={labelForKey}
          />
        </div>

        {/* Left Zone (>=800px): Flowing Hermite Ribbon + Discrete Column Toggle */}
        <div className="min-w-0 @min-[800px]/usage:order-1">
          {trend.length === 0 ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--kiki-chart-label)]">
                {plotHeaderMeta}
              </div>
              {complete ? (
                <p data-usage-empty className="py-10 text-center text-[13px] text-[var(--kiki-chart-label)]">
                  {emptyMessage}
                </p>
              ) : null}
            </div>
          ) : (
            <TrendChart
              trend={trend}
              filters={singleFilters}
              rangeWindow={rangeWindow}
              nowMs={nowMs}
              groupBy={groupBy}
              metric={metric}
              onMetricChange={onMetricChange}
              onGranularityChange={onGranularityChange}
              selectedKey={selectedBucketKey}
              onSelect={onSelectBucketKey}
              onDrilldownDay={onDrilldownDay}
              highlightedSourceKey={activeHighlightKey}
              pinnedSourceKey={pinnedSourceKey}
              onHoverSourceKey={onHoverSourceKey}
              onTogglePinSourceKey={onTogglePinSourceKey}
              tailKeys={composition.tailKeys}
              colorByKey={composition.colorByKey}
              overallCacheHit={overallCacheHit}
              headerMeta={plotHeaderMeta}
              labelForKey={labelForKey}
            />
          )}
        </div>
      </div>
    </div>
  );
}
