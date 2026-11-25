/**
 * Consumption sources — one flat axis at a time (model / provider / workspace /
 * profile) with palette-linked color dots, Plausible-style 1-click row
 * filtering, bidirectional hover/focus/pin highlight linkage with
 * `UsageCompositionRing` & `TrendChart`, and session trace triggers.
 */

import { useMemo, useState } from 'react';

import { formatCostUsd } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { compactIdentifier } from '../../lib/compactIdentifier';
import { DisclosureChevron, Icon } from '../icons';
import {
  aggregateSourceRows,
  cacheHitRateOf,
  USAGE_SOURCE_KEY_UNKNOWN,
  usagePointChange,
  usageRatioChange,
  type UsageCompareOutcome,
  type UsageGroupBy,
  type UsageMetric,
  type UsageSourceRow,
  type UsageTrendBucketWire,
} from '../../lib/usageV2';
import { USAGE_OTHER_COLOR, USAGE_RING_OTHER_KEY } from './usageChartPalette';
import {
  CompareCell,
  formatPercent,
  KnownSubtotalMarker,
} from './usageShared';

export interface UsageSourcePrior {
  readonly priorByKey: ReadonlyMap<string, UsageSourceRow>;
  readonly complete: boolean;
}

export function UsageSources({
  trend,
  groupBy,
  metric,
  prior,
  query = '',
  lookups,
  isFilterActive,
  onFilterSource,
  onOpenSessions,
  onHoverSource,
  highlightedKey = null,
  tailKeys,
  colorByKey,
}: {
  readonly trend: readonly UsageTrendBucketWire[];
  readonly groupBy: UsageGroupBy;
  readonly metric: UsageMetric;
  readonly prior: UsageSourcePrior | undefined;
  readonly query?: string;
  readonly lookups: {
    readonly unknownLabel: string;
    readonly workspaceName: (id: string) => string | undefined;
  };
  readonly isFilterActive?: (row: UsageSourceRow) => boolean;
  readonly onFilterSource: (row: UsageSourceRow) => void;
  readonly onOpenSessions: (row: UsageSourceRow | undefined) => void;
  readonly onHoverSource?: (key: string | null) => void;
  readonly highlightedKey?: string | null;
  readonly tailKeys?: ReadonlySet<string>;
  readonly colorByKey?: ReadonlyMap<string, string>;
}) {
  const { t, time } = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => aggregateSourceRows(trend, groupBy, metric), [trend, groupBy, metric]);
  const totalCost = rows.reduce((sum, row) => sum + row.costUsdEstimated, 0);
  const totalTokensAll = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const needle = query.trim().toLocaleLowerCase();

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visible = needle === ''
    ? rows
    : rows.filter((row) => {
        const display = row.value === null
          ? ''
          : groupBy === 'workspace'
            ? `${lookups.workspaceName(row.value) ?? ''} ${row.value}`
            : row.value;
        return display.toLocaleLowerCase().includes(needle);
      });

  const labelFor = (row: UsageSourceRow): string => {
    if (row.key === USAGE_SOURCE_KEY_UNKNOWN) return lookups.unknownLabel;
    if (row.value === null) return lookups.unknownLabel;
    return groupBy === 'workspace'
      ? (lookups.workspaceName(row.value) ?? compactIdentifier(row.value))
      : row.value;
  };

  const showShareCol = metric !== 'cache';
  const anyCostUnknown = useMemo(() => rows.some((row) => row.costUnknown), [rows]);
  const rowGridClass = showShareCol
    ? prior !== undefined
      ? 'grid grid-cols-[minmax(0,1fr)_5.75rem] items-center gap-x-3 gap-y-1 px-2 sm:grid-cols-[minmax(0,1fr)_5.25rem_5.25rem_4.25rem_5.75rem] lg:grid-cols-[minmax(0,1fr)_5.25rem_5.25rem_4.25rem_4.5rem_4.5rem_5.75rem]'
      : 'grid grid-cols-[minmax(0,1fr)_5.75rem] items-center gap-x-3 gap-y-1 px-2 sm:grid-cols-[minmax(0,1fr)_5.25rem_5.25rem_4.25rem_5.75rem]'
    : prior !== undefined
      ? 'grid grid-cols-[minmax(0,1fr)_5.75rem] items-center gap-x-3 gap-y-1 px-2 sm:grid-cols-[minmax(0,1fr)_5.25rem_4.75rem_5.75rem] lg:grid-cols-[minmax(0,1fr)_5.25rem_4.75rem_4.5rem_4.5rem_5.75rem]'
      : 'grid grid-cols-[minmax(0,1fr)_5.75rem] items-center gap-x-3 gap-y-1 px-2 sm:grid-cols-[minmax(0,1fr)_5.25rem_4.75rem_5.75rem]';

  const renderRow = (row: UsageSourceRow) => {
    const unknownTotal = row.tokensUnknown && row.totalTokens === 0;
    const cacheHit = cacheHitRateOf({ tokens: row.tokens, cost_usd_estimated: 0, cost_unknown: false });
    const share =
      metric === 'cost'
        ? (totalCost > 0 ? row.costUsdEstimated / totalCost : null)
        : metric === 'cache'
          ? cacheHit
          : (totalTokensAll > 0 ? row.totalTokens / totalTokensAll : null);
    const open = expanded.has(row.key);
    const priorRow = prior?.priorByKey.get(row.key);
    const priorOutcome = priorOutcomeFor(metric, row, priorRow, prior, cacheHit);
    const filterActive = isFilterActive?.(row) ?? false;
    const rowName = labelFor(row);
    const swatchColor = colorByKey?.get(row.key) ?? USAGE_OTHER_COLOR;
    const isRowHighlighted =
      highlightedKey !== null &&
      (highlightedKey === row.key ||
        (highlightedKey === USAGE_RING_OTHER_KEY && tailKeys?.has(row.key) === true));
    const isRowDimmed = highlightedKey !== null && !isRowHighlighted;

    return (
      <li
        key={row.key}
        data-usage-breakdown-row={row.key}
        data-usage-row-highlighted={isRowHighlighted ? 'true' : undefined}
        onMouseEnter={() => { onHoverSource?.(row.key); }}
        onMouseLeave={() => { onHoverSource?.(null); }}
        onFocusCapture={() => { onHoverSource?.(row.key); }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            onHoverSource?.(null);
          }
        }}
        className={`group relative border-b border-hairline last:border-b-0 transition-colors ${
          filterActive
            ? 'bg-selected/25'
            : isRowHighlighted
              ? 'bg-ink/[0.045]'
              : 'hover:bg-ink/[0.025]'
        }`}
      >
        <div className={`${rowGridClass} py-2.5`}>
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`usage-source-details-${row.key}`}
              aria-label={t('usage.sources.expand', { name: rowName })}
              onClick={() => { toggle(row.key); }}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded text-[var(--kiki-chart-label)] transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              <DisclosureChevron open={open} className="text-current" />
            </button>

            <span
              aria-hidden
              className={`h-2.5 w-2.5 shrink-0 rounded-full transition-[transform,opacity] ${isRowHighlighted ? 'scale-125' : isRowDimmed ? 'opacity-35' : ''}`}
              style={{ backgroundColor: swatchColor }}
            />

            {row.filter !== null ? (
              <button
                type="button"
                data-usage-row-name-filter={row.key}
                aria-pressed={filterActive}
                title={t('usage.sources.toggleFilter', { name: rowName })}
                onClick={() => { onFilterSource(row); }}
                className="min-w-0 flex-1 text-left transition-colors hover:text-selected-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                <span
                  className={`block truncate text-[13px] leading-5 font-normal ${
                    filterActive
                      ? 'text-selected-ink underline decoration-selected-ink/40 underline-offset-3'
                      : isRowDimmed
                        ? 'text-[var(--kiki-chart-muted)]'
                        : 'text-ink'
                  }`}
                >
                  {rowName}
                </span>
              </button>
            ) : (
              <p
                className={`min-w-0 flex-1 truncate text-[13px] leading-5 font-normal ${
                  row.key === USAGE_SOURCE_KEY_UNKNOWN || isRowDimmed
                    ? 'text-[var(--kiki-chart-muted)]'
                    : 'text-ink'
                }`}
                title={row.value ?? undefined}
              >
                {rowName}
              </p>
            )}

            <div className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
              filterActive ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
            }`}>
              {row.filter !== null ? (
                <button
                  type="button"
                  data-usage-row-filter={row.key}
                  aria-pressed={filterActive}
                  aria-label={t('usage.sources.toggleFilter', { name: rowName })}
                  title={t('usage.sources.toggleFilter', { name: rowName })}
                  onClick={() => { onFilterSource(row); }}
                  className={`flex h-7 w-7 items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11 ${
                    filterActive
                      ? 'bg-selected text-selected-ink'
                      : 'text-[var(--kiki-chart-label)] hover:bg-ink/[0.06] hover:text-ink'
                  }`}
                >
                  <Icon name="filter" size={12} />
                </button>
              ) : null}
              <button
                type="button"
                data-usage-row-sessions={row.key}
                aria-label={t('usage.sources.traceSessions', { name: rowName })}
                title={t('usage.sources.traceSessions', { name: rowName })}
                onClick={() => { onOpenSessions(row); }}
                className="flex h-7 w-7 items-center justify-center rounded text-[var(--kiki-chart-label)] transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
              >
                <Icon name="thread" size={12} />
              </button>
            </div>
          </div>

          {showShareCol ? (
            <span className="hidden text-right text-[12px] leading-4 text-ink tabular-nums sm:block">
              {share === null ? '—' : formatPercent(share)}
            </span>
          ) : null}

          <span
            data-usage-breakdown-tokens={row.key}
            className={`${metric === 'tokens' ? 'block text-[13px] leading-5 font-normal text-ink' : 'hidden text-[12px] leading-4 text-ink sm:block'} text-right tabular-nums`}
          >
            {unknownTotal ? '—' : time.formatTokens(row.totalTokens)}
            {row.tokensUnknown && row.totalTokens > 0 ? <KnownSubtotalMarker /> : null}
          </span>

          <span className={`${metric === 'cache' ? 'block text-[13px] leading-5 font-normal text-ink' : 'hidden text-[12px] leading-4 text-ink sm:block'} text-right tabular-nums`}>
            {formatPercent(cacheHit)}
          </span>

          {prior !== undefined ? (
            <>
              <span className="hidden text-right text-[12px] leading-4 text-ink tabular-nums lg:block">
                {priorRow === undefined ? '—' : metric === 'cache'
                  ? formatPercent(cacheHitOf(priorRow))
                  : metric === 'tokens'
                    ? time.formatTokens(priorRow.totalTokens)
                    : formatCostUsd(priorRow.costUsdEstimated)}
              </span>
              <span className="hidden text-right lg:block">
                {priorOutcome === undefined ? null : <CompareCell outcome={priorOutcome} points={metric === 'cache'} />}
              </span>
            </>
          ) : null}

          <span
            data-usage-breakdown-cost={row.key}
            className={`${metric === 'cost' ? 'inline-flex text-[13px] leading-5 font-normal text-ink' : 'hidden text-[12px] leading-4 text-ink sm:inline-flex'} items-center justify-end gap-0.5 text-right tabular-nums`}
          >
            {unknownTotal || (row.costUnknown && row.costUsdEstimated === 0 && row.totalTokens > 0)
              ? '—'
              : formatCostUsd(row.costUsdEstimated)}
            {row.costUnknown ? (
              <KnownSubtotalMarker
                label={row.costUsdEstimated === 0 && (row.totalTokens > 0 || row.tokensUnknown) ? t('usage.reliability.costUnknown') : undefined}
              />
            ) : null}
          </span>

          <p className="col-span-2 -mt-0.5 pl-10 text-[12px] leading-4 text-[var(--kiki-chart-label)] tabular-nums sm:hidden">
            {metric === 'tokens'
              ? `${share === null ? '—' : formatPercent(share)} · ${row.costUnknown && row.costUsdEstimated === 0 && (row.totalTokens > 0 || row.tokensUnknown) ? '—' : formatCostUsd(row.costUsdEstimated)}`
              : metric === 'cache'
                ? `${unknownTotal ? '—' : time.formatTokens(row.totalTokens)} · ${row.costUnknown && row.costUsdEstimated === 0 && (row.totalTokens > 0 || row.tokensUnknown) ? '—' : formatCostUsd(row.costUsdEstimated)}`
                : t('usage.sources.mobileDetail', {
                    share: share === null ? '—' : formatPercent(share),
                    tokens: unknownTotal ? '—' : time.formatTokens(row.totalTokens),
                  })}
          </p>
        </div>

        {open ? (
          <div id={`usage-source-details-${row.key}`} className="border-t border-dashed border-hairline px-3 py-2.5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] leading-4 tabular-nums sm:grid-cols-4">
              <div><dt className="text-[var(--kiki-chart-label)]">{t('usage.composition.fresh')}</dt><dd className="text-ink">{time.formatTokens(row.tokens.input_other)}</dd></div>
              <div><dt className="text-[var(--kiki-chart-label)]">{t('usage.tokens.output')}</dt><dd className="text-ink">{time.formatTokens(row.tokens.output)}</dd></div>
              <div><dt className="text-[var(--kiki-chart-label)]">{t('usage.tokens.cacheRead')}</dt><dd className="text-ink">{time.formatTokens(row.tokens.input_cache_read)}</dd></div>
              <div><dt className="text-[var(--kiki-chart-label)]">{t('usage.tokens.cacheWrite')}</dt><dd className="text-ink">{time.formatTokens(row.tokens.input_cache_creation)}</dd></div>
            </dl>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {row.filter !== null ? (
                <button
                  type="button"
                  data-usage-source-filter={row.key}
                  onClick={() => { onFilterSource(row); }}
                  className="inline-flex min-h-8 items-center rounded-md bg-ink/[0.045] px-2.5 text-[12px] leading-4 text-ink transition-colors hover:bg-ink/[0.09] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
                >
                  {t(`usage.sources.onlyThis.${row.filter.field === 'workspace.id' ? 'workspace' : row.filter.field}`)}
                </button>
              ) : null}
              <button
                type="button"
                data-usage-source-sessions={row.key}
                onClick={() => { onOpenSessions(row); }}
                className="inline-flex min-h-8 items-center rounded-md bg-ink/[0.045] px-2.5 text-[12px] text-ink transition-colors hover:bg-ink/[0.09] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                {t('usage.sources.openSessions')}
              </button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section id="usage-source-table" aria-label={t('usage.sources.title')} data-usage-sources={groupBy}>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] leading-5 text-[var(--kiki-chart-label)]">{t('usage.empty')}</p>
      ) : (
        <>
          <div aria-hidden className={`${rowGridClass} border-b border-hairline pb-2 text-[12px] leading-4 text-[var(--kiki-chart-label)]`}>
            <span className="pl-10">{t(`usage.sources.grouping.${groupBy}`)}</span>
            {showShareCol ? (
              <span className="hidden items-center justify-end gap-0.5 text-right sm:inline-flex">
                <span>
                  {metric === 'tokens'
                    ? t('usage.trend.shareTokens')
                    : metric === 'cost'
                      ? t('usage.trend.shareCost')
                      : t('usage.col.share')}
                </span>
                {metric === 'cost' && anyCostUnknown ? <KnownSubtotalMarker /> : null}
              </span>
            ) : null}
            <span className={`${metric === 'tokens' ? 'block' : 'hidden sm:block'} text-right`}>{t('usage.col.tokens')}</span>
            <span className={`${metric === 'cache' ? 'block' : 'hidden sm:block'} text-right`}>{t('usage.col.cacheHit')}</span>
            {prior !== undefined ? (
              <>
                <span className="hidden text-right lg:block">{t('usage.compare.prior')}</span>
                <span className="hidden text-right lg:block">{t('usage.compare.change')}</span>
              </>
            ) : null}
            <span className={`${metric === 'cost' ? 'block' : 'hidden sm:block'} text-right`}>{t('usage.col.cost')}</span>
          </div>
          {visible.length === 0 ? (
            <p data-usage-source-empty className="py-8 text-center text-[13px] leading-5 text-[var(--kiki-chart-label)]">
              {t('usage.sources.noMatch')}
            </p>
          ) : (
            <ul>{visible.map(renderRow)}</ul>
          )}
        </>
      )}
    </section>
  );
}

function cacheHitOf(row: UsageSourceRow): number | null {
  return cacheHitRateOf({ tokens: row.tokens, cost_usd_estimated: 0, cost_unknown: false });
}

function priorOutcomeFor(
  metric: UsageMetric,
  row: UsageSourceRow,
  priorRow: UsageSourceRow | undefined,
  prior: UsageSourcePrior | undefined,
  cacheHit: number | null,
): UsageCompareOutcome | undefined {
  if (prior === undefined) return undefined;
  if (!prior.complete) return usageRatioChange(Number.NaN, Number.NaN);
  if (metric === 'cache') return usagePointChange(cacheHit, priorRow === undefined ? null : cacheHitOf(priorRow));
  if (metric === 'tokens') {
    if ((row.tokensUnknown && row.totalTokens === 0) || (priorRow !== undefined && priorRow.tokensUnknown && priorRow.totalTokens === 0)) {
      return usageRatioChange(Number.NaN, Number.NaN);
    }
    return priorRow === undefined ? usageRatioChange(row.totalTokens, 0) : usageRatioChange(row.totalTokens, priorRow.totalTokens);
  }
  if (row.costUnknown && row.costUsdEstimated === 0) return usageRatioChange(Number.NaN, Number.NaN);
  if (priorRow === undefined) return usageRatioChange(row.costUsdEstimated, 0);
  if (priorRow.costUnknown && priorRow.costUsdEstimated === 0) return usageRatioChange(Number.NaN, Number.NaN);
  return usageRatioChange(row.costUsdEstimated, priorRow.costUsdEstimated);
}
