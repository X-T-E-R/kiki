/**
 * Trend chart + bucket drilldown. Bars stack the top dimension groups (the
 * same axis the breakdown uses) so "what drove this spike" is answered on the
 * chart itself; the cache metric plots each bucket's hit rate on a fixed
 * 0–100% scale. Every bucket is a button: selecting it opens the server's
 * session/turn drilldown for that bucket.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatCostUsd } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import {
  aggregateDimensionGroups,
  bucketLabel,
  totalTokensOf,
  type UsageDrilldownSessionWire,
  type UsageFilters,
  type UsageTrendBucketWire,
} from '../../lib/usageV2';
import { segmentClass } from '../WorkspaceScopeControl';
import {
  bucketCacheHit,
  bucketCost,
  bucketTokens,
  bucketTokenTotalIsUnknown,
  formatPercent,
  UsageCard,
} from './usageShared';

type Metric = 'cost' | 'tokens' | 'cache';

/** Series fills, strongest first, on an ink ladder with one amber step so
 * neighbours stay apart; the accent is kept for "needs you", never a series.
 * The last slot is the "other" remainder. */
const SERIES_FILLS = ['bg-ink-soft', 'bg-amber-rule', 'bg-ink-faint/55', 'bg-ink/20'] as const;
const OTHER_FILL = 'bg-hairline';
const SERIES_LIMIT = SERIES_FILLS.length;

export function TrendChart({
  trend,
  filters,
  selectedKey,
  onSelect,
  labelForKey,
}: {
  readonly trend: readonly UsageTrendBucketWire[];
  readonly filters: UsageFilters;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
  readonly labelForKey: (key: string) => string;
}) {
  const { t, locale, time } = useI18n();
  const [metric, setMetric] = useState<Metric>('cost');

  // Series = the top keys across the whole range, ranked by the active metric.
  const series = useMemo(() => {
    const rows = aggregateDimensionGroups(trend);
    const ranked = metric === 'tokens'
      ? rows.toSorted((a, b) => b.totalTokens - a.totalTokens)
      : rows;
    return ranked.slice(0, SERIES_LIMIT).map((row) => row.key);
  }, [trend, metric]);

  const valueOf = (group: UsageTrendBucketWire['groups'][number]) =>
    metric === 'tokens' ? totalTokensOf(group) : group.cost_usd_estimated;
  const totals = trend.map((bucket) =>
    metric === 'cache' ? (bucketCacheHit(bucket) ?? 0) : metric === 'tokens' ? bucketTokens(bucket) : bucketCost(bucket));
  const max = metric === 'cache' ? 1 : Math.max(0, ...totals);
  const peakIndex = totals.indexOf(Math.max(0, ...totals));
  const formatValue = (value: number) =>
    metric === 'cache' ? formatPercent(value) : metric === 'tokens' ? time.formatTokens(value) : formatCostUsd(value);
  // Label density: aim for ~7 x-axis labels whatever the bucket count.
  const labelEvery = Math.max(1, Math.ceil(trend.length / 7));

  return (
    <UsageCard
      data-usage-trend-card
      title={t('usage.trend.title')}
      aside={
        <div
          role="group"
          aria-label={t('usage.trend.title')}
          className="ml-auto inline-flex rounded-[9px] border border-hairline bg-paper p-0.5"
        >
          {(['cost', 'tokens', 'cache'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-trend-metric={candidate}
              onClick={() => { setMetric(candidate); }}
              aria-pressed={metric === candidate}
              className={segmentClass(metric === candidate, 'h-7 px-2.5 text-[12.5px]')}
            >
              {t(`usage.trend.metric.${candidate}`)}
            </button>
          ))}
        </div>
      }
    >
      <div className="relative">
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
                const value = bucket.groups.filter((group) => group.key === key).reduce((sum, group) => sum + valueOf(group), 0);
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
                aria-label={title}
                onClick={() => { onSelect(selected ? null : bucket.key); }}
                title={title}
                className={`group relative flex h-full min-w-0 max-w-16 flex-1 flex-col justify-end rounded-t-[3px] transition-opacity focus-visible:outline-2 focus-visible:outline-selected-ink ${dimmed ? 'opacity-45 hover:opacity-80' : ''}`}
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
      <div className="mt-3 mr-14 flex justify-center gap-[3px]" aria-hidden>
        {trend.map((bucket, index) => (
          <span key={bucket.key} className="min-w-0 max-w-16 flex-1 truncate text-center font-mono text-[10px] text-ink-faint tabular-nums">
            {index % labelEvery === 0 || index === trend.length - 1 ? bucketLabel(bucket, filters.granularity, locale) : ''}
          </span>
        ))}
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
            {trend.some((bucket) => bucket.groups.some((group) => !series.includes(group.key))) ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className={`h-2 w-2 rounded-[2px] ${OTHER_FILL}`} />
                {t('usage.trend.other')}
              </span>
            ) : null}
          </>
        )}
        <span className="ml-auto text-ink-faint">{t('usage.trend.clickHint')}</span>
      </div>
    </UsageCard>
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
                    className="min-h-6 rounded-md border border-hairline bg-paper px-1.5 font-mono text-[11px] text-ink-soft tabular-nums transition-colors hover:border-accent hover:text-ink"
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

export function DrilldownPanel({
  bucket,
  filters,
  onClose,
  sessionTitle,
}: {
  readonly bucket: UsageTrendBucketWire;
  readonly filters: UsageFilters;
  readonly onClose: () => void;
  readonly sessionTitle: (id: string) => string | undefined;
}) {
  const { t, locale, time } = useI18n();
  const unknownTotal = bucketTokenTotalIsUnknown(bucket);
  return (
    <section
      data-usage-drilldown
      className="rounded-xl border border-accent/30 bg-panel p-4 shadow-[inset_3px_0_0_var(--color-accent)] sm:p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-semibold text-ink">
          {t('usage.drilldown.title')} · {bucketLabel(bucket, filters.granularity, locale)}
        </h3>
        <span className="font-mono text-[12px] text-ink-soft tabular-nums">
          {unknownTotal ? '—' : formatCostUsd(bucketCost(bucket))}
          {' · '}
          {unknownTotal ? '—' : time.formatTokens(bucketTokens(bucket))} {t('usage.col.tokens')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-paper hover:text-ink"
        >
          <Icon name="close" />
        </button>
      </div>
      {bucket.drilldown.sessions.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-faint">{t('usage.empty')}</p>
      ) : (
        <div className="mt-1">
          <DrilldownSessionList sessions={bucket.drilldown.sessions} sessionTitle={sessionTitle} />
        </div>
      )}
      {bucket.drilldown.sessions_truncated ? (
        <p className="mt-2 text-[12px] text-amber-ink">{t('usage.drilldown.sessionsTruncated')}</p>
      ) : null}
    </section>
  );
}
