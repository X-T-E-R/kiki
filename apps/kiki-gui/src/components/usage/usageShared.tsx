/**
 * Shared building blocks for the /usage dashboard: the section card, the
 * segmented axis control, the per-bucket/per-row derivations the chart and
 * tables share, and the display rules for "unknown" usage (a dash, never a
 * reconstructed zero).
 */

import type { ReactNode } from 'react';

import { formatCostUsd } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import {
  cacheHitRateOf,
  totalTokensOf,
  usageTokenTotalIsUnknown,
  type UsageAggregateWire,
  type UsageDimensionRow,
  type UsageFilters,
  type UsageTrendBucketWire,
} from '../../lib/usageV2';
import { segmentClass } from '../WorkspaceScopeControl';

export function UsageCard({ title, aside, children, className = '', ...rest }: {
  readonly title?: ReactNode;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly [data: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <section
      {...rest}
      className={`rounded-xl border border-hairline bg-panel p-4 sm:p-5 ${className}`}
    >
      {title !== undefined || aside !== undefined ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          {title !== undefined ? (
            <h2 className="font-display text-[18px] leading-tight font-semibold text-ink">{title}</h2>
          ) : null}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function AxisGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  labelFor,
  dataAxis,
}: {
  readonly label: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly labelFor: (option: T) => string;
  readonly dataAxis: string;
}) {
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <span className="shrink-0 text-[12px] text-ink-faint">{label}</span>
      <div
        role="group"
        aria-label={label}
        data-axis={dataAxis}
        className="flex min-w-0 max-w-full flex-wrap items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5"
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            data-axis-value={option}
            onClick={() => { onChange(option); }}
            aria-pressed={value === option}
            className={segmentClass(value === option, 'h-7 px-3 text-[12.5px]')}
          >
            {labelFor(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

export function bucketTokens(bucket: UsageTrendBucketWire): number {
  return bucket.groups.reduce((sum, group) => sum + totalTokensOf(group), 0);
}

export function bucketCost(bucket: UsageTrendBucketWire): number {
  return bucket.groups.reduce((sum, group) => sum + group.cost_usd_estimated, 0);
}

export function bucketTokenTotalIsUnknown(bucket: UsageTrendBucketWire): boolean {
  return bucketTokens(bucket) === 0 && bucket.groups.some((group) => group.tokens_unknown === true);
}

/** Cache hit for a whole bucket: summed cache reads over summed input. */
export function bucketCacheHit(bucket: UsageTrendBucketWire): number | null {
  const sum = bucket.groups.reduce(
    (acc, group) => ({
      input_other: acc.input_other + group.tokens.input_other,
      output: acc.output + group.tokens.output,
      input_cache_read: acc.input_cache_read + group.tokens.input_cache_read,
      input_cache_creation: acc.input_cache_creation + group.tokens.input_cache_creation,
    }),
    { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
  );
  return cacheHitRateOf({ tokens: sum, cost_usd_estimated: 0, cost_unknown: false });
}

export function rowCacheHit(row: UsageDimensionRow): number | null {
  return cacheHitRateOf({ tokens: row.tokens, cost_usd_estimated: 0, cost_unknown: false });
}

export function hasUnknownTokenSubtotal(aggregate: UsageAggregateWire): boolean {
  return aggregate.tokens_unknown === true && !usageTokenTotalIsUnknown(aggregate);
}

export function formatPercent(ratio: number | null): string {
  if (ratio === null) return '—';
  if (ratio > 0 && ratio < 0.01) return '<1%';
  return `${Math.round(ratio * 100)}%`;
}

export function formatCostOrDash(cost: number, unknown: boolean): string {
  return unknown ? '—' : formatCostUsd(cost);
}

/**
 * Human label for a dimension key. Model/agent keys carry their own names;
 * project keys are workspace ids and session keys are session ids, so those
 * resolve through the lookups the page already holds (never guessed).
 */
export function dimensionKeyLabel(
  row: Pick<UsageDimensionRow, 'key' | 'modelAlias' | 'profileName' | 'agentId'>,
  dimension: UsageFilters['dimension'],
  lookups: {
    readonly unknownLabel: string;
    readonly workspaceName: (id: string) => string | undefined;
    readonly sessionTitle: (id: string) => string | undefined;
  },
): string {
  if (row.key === 'unknown') return lookups.unknownLabel;
  if (dimension === 'model') return row.modelAlias ?? row.key;
  if (dimension === 'agent') return row.profileName ?? row.agentId ?? row.key;
  if (dimension === 'project') return lookups.workspaceName(row.key) ?? row.key;
  return lookups.sessionTitle(row.key) ?? row.key;
}

export function KnownSubtotalMarker() {
  const { t } = useI18n();
  return (
    <span
      data-usage-accounting-known-subtotal
      title={t('usage.accounting.knownSubtotal')}
      aria-label={t('usage.accounting.knownSubtotal')}
      className="ml-1 inline-flex align-[-1px] text-amber-ink"
    >
      <Icon name="partial" size={12} />
    </span>
  );
}

/** Horizontal share bar; `ratio` is clamped and a non-zero share keeps a sliver. */
export function ShareBar({ ratio, tone = 'bg-accent' }: { readonly ratio: number; readonly tone?: string }) {
  const width = ratio <= 0 ? 0 : Math.max(2, Math.min(100, ratio * 100));
  return (
    <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-hairline/70">
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
    </span>
  );
}
