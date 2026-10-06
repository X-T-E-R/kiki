/**
 * Consumption sources — the answer to "what drove this?". One axis at a time
 * (model / provider / agent profile / workspace), never mixed in one list and
 * never as a side card next to another table. It reads either the whole range
 * or the selected bucket's own groups, and says which in its title.
 *
 * Honesty rules that the table itself owns:
 *   - an unknown source keeps its amount and its share; it never renders as
 *     $0.00 or 0%;
 *   - cache hit rate is a rate, so shares never sum to it and it is a column
 *     rather than a stacked segment;
 *   - a prior-period column appears only when the reader asked for a
 *     comparison, and a zero or incomplete prior period is its own short
 *     state rather than a fabricated growth number;
 *   - "only this …" sends the raw record attribution, never the row key, and
 *     an unknown row offers only the common time-window session trace.
 */

import { useMemo, useState } from 'react';

import { formatCostUsd } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { DisclosureChevron } from '../icons';
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
import { segmentClass } from '../WorkspaceScopeControl';
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
  lookups,
  onFilterSource,
  onOpenSessions,
  onSwitchGrouping,
}: {
  readonly trend: readonly UsageTrendBucketWire[];
  readonly groupBy: UsageGroupBy;
  readonly metric: UsageMetric;
  readonly prior: UsageSourcePrior | undefined;
  readonly lookups: {
    readonly unknownLabel: string;
    readonly workspaceName: (id: string) => string | undefined;
  };
  readonly onFilterSource: (row: UsageSourceRow) => void;
  readonly onOpenSessions: (row: UsageSourceRow | undefined) => void;
  readonly onSwitchGrouping: (groupBy: UsageGroupBy) => void;
}) {
  const { t, time } = useI18n();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => aggregateSourceRows(trend, groupBy), [trend, groupBy]);
  const totalCost = rows.reduce((sum, row) => sum + row.costUsdEstimated, 0);
  const needle = query.trim().toLocaleLowerCase();

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Searching filters the rows already in memory; it never changes the totals
  // above or the chart, and a miss stays a local empty state.
  const visible = needle === ''
    ? rows
    : rows.filter((row) => (row.value ?? '').toLocaleLowerCase().includes(needle));

  const labelFor = (row: UsageSourceRow): string => {
    if (row.key === USAGE_SOURCE_KEY_UNKNOWN) return lookups.unknownLabel;
    if (row.value === null) return lookups.unknownLabel;
    return groupBy === 'workspace' ? (lookups.workspaceName(row.value) ?? row.value) : row.value;
  };

  const renderRow = (row: UsageSourceRow) => {
    const unknownTotal = row.tokensUnknown && row.totalTokens === 0;
    const share = totalCost > 0 ? row.costUsdEstimated / totalCost : null;
    const cacheHit = cacheHitRateOf({ tokens: row.tokens, cost_usd_estimated: 0, cost_unknown: false });
    const open = expanded.has(row.key);
    const priorRow = prior?.priorByKey.get(row.key);
    // Each metric is judged on its own completeness: a missing token record
    // does not make a priced cost incomparable, and vice versa.
    const priorOutcome = priorOutcomeFor(metric, row, priorRow, prior, cacheHit);
    return (
      <li key={row.key} data-usage-breakdown-row={row.key} className="border-b border-hairline last:border-b-0">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_8rem_4.5rem_4.5rem_auto]">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`usage-source-details-${row.key}`}
              aria-label={t('usage.sources.expand', { name: labelFor(row) })}
              onClick={() => { toggle(row.key); }}
              className="flex h-8 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
            >
              <DisclosureChevron open={open} className="text-current" />
            </button>
            <div className="min-w-0">
              <p
                className={`truncate text-[13px] ${row.key === USAGE_SOURCE_KEY_UNKNOWN ? 'text-ink-soft italic' : 'font-medium text-ink'}`}
                title={row.value ?? undefined}
              >
                {labelFor(row)}
              </p>
              {row.key === USAGE_SOURCE_KEY_UNKNOWN ? (
                <p className="truncate text-[11px] text-ink-faint">{t('usage.sources.unknownRowHint')}</p>
              ) : row.modelAliases.length > 0 && groupBy !== 'model' ? (
                <p className="truncate font-mono text-[11px] text-ink-faint">
                  {row.modelAliases.length === 1 ? row.modelAliases[0] : t('usage.sources.modelCount', { count: row.modelAliases.length })}
                </p>
              ) : null}
            </div>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <ShareBar ratio={share ?? 0} tone="bg-ink-soft" />
            <span className="w-9 shrink-0 text-right font-mono text-[11px] text-ink-faint tabular-nums">
              {share === null ? '—' : formatPercent(share)}
            </span>
          </div>
          <span
            data-usage-breakdown-tokens={row.key}
            className="hidden text-right font-mono text-[12px] text-ink-soft tabular-nums sm:block"
          >
            {unknownTotal ? '—' : time.formatTokens(row.totalTokens)}
            {row.tokensUnknown && row.totalTokens > 0 ? <KnownSubtotalMarker /> : null}
          </span>
          <span className="hidden text-right font-mono text-[12px] text-ink-soft tabular-nums sm:block">
            {formatPercent(cacheHit)}
          </span>
          <div className="flex items-center justify-end gap-x-3">
            {prior !== undefined ? (
              <>
                <span className="hidden w-16 text-right font-mono text-[12px] text-ink-soft tabular-nums lg:block">
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
              className="text-right font-mono text-[13px] font-semibold text-ink tabular-nums"
            >
              {unknownTotal ? '—' : formatCostUsd(row.costUsdEstimated)}
              {row.costUnknown ? <span className="ml-1 inline-block align-[-1px] text-amber-ink">*</span> : null}
            </span>
          </div>
          {/* 390-wide reading: the name keeps the amount, the second line keeps
              share and tokens — the explanation is not hidden away. */}
          <p className="col-span-2 -mt-0.5 pl-8 font-mono text-[11px] text-ink-faint tabular-nums sm:hidden">
            {t('usage.sources.mobileDetail', {
              share: share === null ? '—' : formatPercent(share),
              tokens: unknownTotal ? '—' : time.formatTokens(row.totalTokens),
            })}
          </p>
        </div>
        {open ? (
          <div id={`usage-source-details-${row.key}`} className="border-t border-dashed border-hairline px-3 py-2.5">
            <p className="text-[11.5px] text-ink-faint">{t('usage.sources.tokenComposition')}</p>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[12px] tabular-nums sm:grid-cols-4">
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
                  className="inline-flex min-h-8 items-center rounded-md border border-hairline px-2.5 text-[12.5px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
                >
                  {t(`usage.sources.onlyThis.${row.filter.field === 'workspace.id' ? 'workspace' : row.filter.field}`)}
                </button>
              ) : (
                <p className="text-[12px] text-ink-faint">{t('usage.sources.noExactFilter')}</p>
              )}
              <button
                type="button"
                data-usage-source-sessions={row.key}
                onClick={() => { onOpenSessions(row); }}
                className="inline-flex min-h-8 items-center rounded-md border border-hairline px-2.5 text-[12.5px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
              >
                {t('usage.sources.openSessions')}
              </button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  const gridHead = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-3 pb-2 text-[11px] text-ink-faint sm:grid-cols-[minmax(0,1fr)_8rem_4.5rem_4.5rem_auto]';

  return (
    <section id="usage-source-table" aria-label={t('usage.sources.title')} data-usage-sources={groupBy}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label={t('usage.sources.grouping')} className="flex flex-wrap items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
          {(['model', 'provider', 'profile', 'workspace'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-usage-grouping={candidate}
              aria-pressed={groupBy === candidate}
              onClick={() => { onSwitchGrouping(candidate); }}
              className={`${segmentClass(groupBy === candidate, 'h-8 px-3 text-[12.5px] pointer-coarse:min-h-11')}`}
            >
              {t(`usage.sources.grouping.${candidate}`)}
            </button>
          ))}
        </div>
        <label className="ml-auto flex min-w-0 items-center gap-1.5">
          <span className="sr-only">{t('usage.sources.search')}</span>
          <input
            type="search"
            data-usage-source-search
            value={query}
            placeholder={t('usage.sources.searchPlaceholder')}
            onChange={(event) => { setQuery(event.target.value); }}
            className="h-8 w-40 max-w-full rounded-md border border-hairline bg-paper px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:border-selected-ink"
          />
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-ink-faint">{t('usage.empty')}</p>
      ) : (
        <>
          <div aria-hidden className={`${gridHead} mt-3`}>
            <span className="pl-8">{t(`usage.sources.grouping.${groupBy}`)}</span>
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
          <p className="mt-2 text-right text-[11.5px] text-ink-faint">{t('usage.sources.sortHint')}</p>
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
    // A token total is unknown when the row has none and says so; a known
    // partial subtotal still compares.
    if ((row.tokensUnknown && row.totalTokens === 0) || (priorRow !== undefined && priorRow.tokensUnknown && priorRow.totalTokens === 0)) {
      return usageRatioChange(Number.NaN, Number.NaN);
    }
    return priorRow === undefined ? usageRatioChange(row.totalTokens, 0) : usageRatioChange(row.totalTokens, priorRow.totalTokens);
  }
  // Cost: unknown only when there is no priced amount to divide.
  if (row.costUnknown && row.costUsdEstimated === 0) return usageRatioChange(Number.NaN, Number.NaN);
  if (priorRow === undefined) return usageRatioChange(row.costUsdEstimated, 0);
  if (priorRow.costUnknown && priorRow.costUsdEstimated === 0) return usageRatioChange(Number.NaN, Number.NaN);
  return usageRatioChange(row.costUsdEstimated, priorRow.costUsdEstimated);
}