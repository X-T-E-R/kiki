/**
 * Consumption sources — one flat axis at a time (model / provider / workspace /
 * profile) with inline proportional share bars, Plausible-style 1-click row
 * filtering, and session trace triggers.
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
import {
  CompareCell,
  formatPercent,
  KnownSubtotalMarker,
  ShareBar,
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
}) {
  const { t, time } = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => aggregateSourceRows(trend, groupBy), [trend, groupBy]);
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

  const renderRow = (row: UsageSourceRow) => {
    const unknownTotal = row.tokensUnknown && row.totalTokens === 0;
    const share =
      totalCost > 0
        ? row.costUsdEstimated / totalCost
        : totalTokensAll > 0
          ? row.totalTokens / totalTokensAll
          : null;
    const cacheHit = cacheHitRateOf({ tokens: row.tokens, cost_usd_estimated: 0, cost_unknown: false });
    const open = expanded.has(row.key);
    const priorRow = prior?.priorByKey.get(row.key);
    const priorOutcome = priorOutcomeFor(metric, row, priorRow, prior, cacheHit);
    const filterActive = isFilterActive?.(row) ?? false;
    const rowName = labelFor(row);
    const bgFillPct = share !== null && share > 0 ? Math.max(1.5, Math.min(100, share * 100)) : 0;

    return (
      <li
        key={row.key}
        data-usage-breakdown-row={row.key}
        className={`group relative border-b border-hairline last:border-b-0 ${
          filterActive ? 'bg-selected/25' : ''
        }`}
      >
        <div className="relative overflow-hidden">
          {bgFillPct > 0 && !filterActive ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-[3px] left-0 rounded-r-sm bg-accent/[0.06] transition-all duration-200"
              style={{ width: `${bgFillPct}%` }}
            />
          ) : null}

          <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_6.5rem_4.75rem_4rem_auto]">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`usage-source-details-${row.key}`}
                aria-label={t('usage.sources.expand', { name: rowName })}
                onClick={() => { toggle(row.key); }}
                className="flex h-7 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                <DisclosureChevron open={open} className="text-current" />
              </button>

              {row.filter !== null ? (
                <button
                  type="button"
                  data-usage-row-name-filter={row.key}
                  aria-pressed={filterActive}
                  title={t('usage.sources.toggleFilter', { name: rowName })}
                  onClick={() => { onFilterSource(row); }}
                  className="min-w-0 flex-1 text-left transition-colors hover:text-selected-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  <span className={`block truncate text-[13px] font-medium ${filterActive ? 'text-selected-ink underline decoration-selected-ink/40 underline-offset-3' : 'text-ink'}`}>
                    {rowName}
                  </span>
                </button>
              ) : (
                <p
                  className={`min-w-0 flex-1 truncate text-[13px] ${row.key === USAGE_SOURCE_KEY_UNKNOWN ? 'text-ink-soft italic' : 'font-medium text-ink'}`}
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
                    className={`flex h-7 w-7 items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-9 pointer-coarse:w-9 ${
                      filterActive
                        ? 'bg-selected text-selected-ink'
                        : 'text-ink-faint hover:bg-ink/[0.06] hover:text-ink'
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
                  className="flex h-7 w-7 items-center justify-center rounded text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-9 pointer-coarse:w-9"
                >
                  <Icon name="thread" size={12} />
                </button>
              </div>
            </div>

            <div className="hidden items-center gap-2 sm:flex">
              <ShareBar ratio={share ?? 0} tone="bg-ink/55" />
              <span className="w-8 shrink-0 text-right text-[11px] text-ink-faint tabular-nums">
                {share === null ? '—' : formatPercent(share)}
              </span>
            </div>

            <span
              data-usage-breakdown-tokens={row.key}
              className="hidden text-right text-[12px] text-ink-soft tabular-nums sm:block"
            >
              {unknownTotal ? '—' : time.formatTokens(row.totalTokens)}
              {row.tokensUnknown && row.totalTokens > 0 ? <KnownSubtotalMarker /> : null}
            </span>

            <span className="hidden text-right text-[12px] text-ink-soft tabular-nums sm:block">
              {formatPercent(cacheHit)}
            </span>

            <div className="flex items-center justify-end gap-x-3">
              {prior !== undefined ? (
                <>
                  <span className="hidden w-16 text-right text-[12px] text-ink-soft tabular-nums lg:block">
                    {priorRow === undefined ? '—' : metric === 'cache'
                      ? formatPercent(cacheHitOf(priorRow))
                      : metric === 'tokens'
                        ? time.formatTokens(priorRow.totalTokens)
                        : formatCostUsd(priorRow.costUsdEstimated)}
                  </span>
                  <span className="hidden w-16 text-right lg:block">
                    {priorOutcome === undefined ? null : <CompareCell outcome={priorOutcome} points={metric === 'cache'} />}
                  </span>
                </>
              ) : null}
              <span
                data-usage-breakdown-cost={row.key}
                className="text-right text-[13px] font-semibold text-ink tabular-nums"
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
            </div>

            <p className="col-span-2 -mt-0.5 pl-7 text-[11px] text-ink-faint tabular-nums sm:hidden">
              {t('usage.sources.mobileDetail', {
                share: share === null ? '—' : formatPercent(share),
                tokens: unknownTotal ? '—' : time.formatTokens(row.totalTokens),
              })}
            </p>
          </div>
        </div>

        {open ? (
          <div id={`usage-source-details-${row.key}`} className="border-t border-dashed border-hairline px-3 py-2.5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] tabular-nums sm:grid-cols-4">
              <div><dt className="text-ink-faint">{t('usage.composition.fresh')}</dt><dd className="text-ink">{time.formatTokens(row.tokens.input_other)}</dd></div>
              <div><dt className="text-ink-faint">{t('usage.tokens.output')}</dt><dd className="text-ink">{time.formatTokens(row.tokens.output)}</dd></div>
              <div><dt className="text-ink-faint">{t('usage.tokens.cacheRead')}</dt><dd className="text-ink">{time.formatTokens(row.tokens.input_cache_read)}</dd></div>
              <div><dt className="text-ink-faint">{t('usage.tokens.cacheWrite')}</dt><dd className="text-ink">{time.formatTokens(row.tokens.input_cache_creation)}</dd></div>
            </dl>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {row.filter !== null ? (
                <button
                  type="button"
                  data-usage-source-filter={row.key}
                  onClick={() => { onFilterSource(row); }}
                  className="inline-flex min-h-8 items-center rounded-md border border-hairline px-2.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
                >
                  {t(`usage.sources.onlyThis.${row.filter.field === 'workspace.id' ? 'workspace' : row.filter.field}`)}
                </button>
              ) : null}
              <button
                type="button"
                data-usage-source-sessions={row.key}
                onClick={() => { onOpenSessions(row); }}
                className="inline-flex min-h-8 items-center rounded-md border border-hairline px-2.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                {t('usage.sources.openSessions')}
              </button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  const gridHead = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-2 pb-2 text-[11px] text-ink-faint sm:grid-cols-[minmax(0,1fr)_6.5rem_4.75rem_4rem_auto]';

  return (
    <section id="usage-source-table" aria-label={t('usage.sources.title')} data-usage-sources={groupBy}>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-ink-faint">{t('usage.empty')}</p>
      ) : (
        <>
          <div aria-hidden className={`${gridHead} border-b border-hairline`}>
            <span className="pl-7">{t(`usage.sources.grouping.${groupBy}`)}</span>
            <span className="hidden sm:block">{t('usage.col.share')}</span>
            <span className="hidden text-right sm:block">{t('usage.col.tokens')}</span>
            <span className="hidden text-right sm:block">{t('usage.col.cacheHit')}</span>
            <span className="flex justify-end gap-x-3">
              {prior !== undefined ? (
                <>
                  <span className="hidden w-16 lg:block">{t('usage.compare.prior')}</span>
                  <span className="hidden w-16 lg:block">{t('usage.compare.change')}</span>
                </>
              ) : null}
              <span className="text-right">{t('usage.col.cost')}</span>
            </span>
          </div>
          {visible.length === 0 ? (
            <p data-usage-source-empty className="py-8 text-center text-[13px] text-ink-faint">
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
