import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { UsageGroupBy, UsageMetric } from '../../lib/usageV2';
import { Icon } from '../icons';
import {
  describeDonutSlicePath,
  polarPoint,
  USAGE_RING_OTHER_KEY,
  type CompositionModel,
} from './usageChartPalette';
import { formatCachePercent, formatPercent, KnownSubtotalMarker } from './usageShared';

function describeOpen240Arc(cx: number, cy: number, radius: number): string {
  const start = polarPoint(cx, cy, radius, 150);
  const end = polarPoint(cx, cy, radius, 390);
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${radius} ${radius} 0 1 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
}

export interface ScopedBucketRingSummary {
  readonly scopeLabel: string;
  readonly primaryFigure: string;
  readonly subtotalCostText: string;
  readonly costUnknown?: boolean;
  readonly costAllUnknown?: boolean;
  readonly onClear: () => void;
  readonly onDrilldownDay?: () => void;
}

export function UsageCompositionRing({
  composition,
  metric,
  groupBy,
  overallCacheHit,
  periodHero,
  scopedBucket,
  subtitleContent,
  activeHighlightKey,
  pinnedKey,
  onHoverKey,
  onTogglePinKey,
  labelForKey,
}: {
  readonly composition: CompositionModel;
  readonly metric: UsageMetric;
  readonly groupBy: UsageGroupBy;
  readonly overallCacheHit: number | null;
  readonly periodHero: {
    readonly kpiId: 'tokens' | 'cost' | 'cache';
    readonly dataSummaryAttr: string;
    readonly label: string;
    readonly value: ReactNode;
    readonly valueAction?: ReactNode;
    readonly title?: string;
  };
  readonly scopedBucket?: ScopedBucketRingSummary;
  readonly subtitleContent?: ReactNode;
  readonly activeHighlightKey: string | null;
  readonly pinnedKey: string | null;
  readonly onHoverKey: (key: string | null) => void;
  readonly onTogglePinKey: (key: string) => void;
  readonly labelForKey: (key: string) => string;
}) {
  const { t } = useI18n();
  const size = 188;
  const cx = 94;
  const cy = 94;
  const rInner = 66;
  const rOuter = 82;
  const rMid = (rInner + rOuter) / 2;
  const bandWidth = rOuter - rInner;

  const slices = composition.slices;
  const cachePct = overallCacheHit !== null ? Math.max(0, Math.min(100, overallCacheHit * 100)) : null;

  const ringAriaLabel =
    metric === 'cache'
      ? `${t('usage.kpi.cacheHit')} · ${formatCachePercent(overallCacheHit)}`
      : `${t(`usage.sources.grouping.${groupBy}`)} · ${
          metric === 'cost' ? t('usage.trend.shareCost') : t('usage.trend.shareTokens')
        }`;

  const summaryAttrProps = { [periodHero.dataSummaryAttr]: true };

  return (
    <div
      data-usage-composition-ring
      data-usage-ring-metric={metric}
      className="flex min-w-0 flex-col items-center"
    >
      <div
        className="relative flex h-[144px] w-[144px] shrink-0 items-center justify-center sm:h-[176px] sm:w-[176px] @min-[800px]/usage:h-[188px] @min-[800px]/usage:w-[188px]"
        onMouseLeave={() => { onHoverKey(null); }}
      >
        <svg
          role="img"
          aria-label={ringAriaLabel}
          viewBox={`0 0 ${size} ${size}`}
          className="h-full w-full overflow-visible"
        >
          {metric === 'cache' ? (
            <>
              <path
                d={describeOpen240Arc(cx, cy, rMid)}
                fill="none"
                stroke="var(--kiki-gauge-track)"
                strokeWidth={bandWidth * 0.55}
                strokeLinecap="butt"
              />
              {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
                const deg = 150 + 240 * tick;
                const innerTick = polarPoint(cx, cy, rOuter + 1, deg);
                const outerTick = polarPoint(cx, cy, rOuter + 5, deg);
                return (
                  <line
                    key={tick}
                    x1={innerTick.x}
                    y1={innerTick.y}
                    x2={outerTick.x}
                    y2={outerTick.y}
                    stroke="var(--kiki-gauge-tick)"
                    strokeWidth="1.35"
                  />
                );
              })}
              {cachePct !== null && cachePct > 0 ? (
                <path
                  d={describeOpen240Arc(cx, cy, rMid)}
                  fill="none"
                  pathLength={100}
                  strokeDasharray={`${cachePct} 100`}
                  stroke="var(--kiki-chart-4)"
                  strokeWidth={bandWidth * 0.8}
                  strokeLinecap="butt"
                />
              ) : null}
            </>
          ) : slices.length === 0 ? (
            <circle
              cx={cx}
              cy={cy}
              r={rMid}
              fill="none"
              stroke="var(--kiki-gauge-track)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          ) : slices.length === 1 ? (
            <circle
              cx={cx}
              cy={cy}
              r={rMid}
              fill="none"
              stroke={slices[0]!.color}
              strokeWidth={bandWidth}
              className="cursor-pointer transition-opacity duration-150"
              onMouseEnter={() => { onHoverKey(slices[0]!.key); }}
              onClick={() => { onTogglePinKey(slices[0]!.key); }}
            />
          ) : (
            <>
              {slices.map((slice) => {
                const isHighlighted =
                  activeHighlightKey !== null &&
                  (activeHighlightKey === slice.key ||
                    (slice.isOther && slice.memberKeys.includes(activeHighlightKey)));
                const isDimmed = activeHighlightKey !== null && !isHighlighted;
                const d = describeDonutSlicePath(
                  cx,
                  cy,
                  rInner,
                  isHighlighted ? rOuter + 3 : rOuter,
                  slice.startAngleDeg,
                  slice.endAngleDeg,
                );
                return (
                  <path
                    key={slice.key}
                    d={d}
                    fill={slice.color}
                    opacity={isDimmed ? 0.34 : 1}
                    className="cursor-pointer transition-opacity duration-150"
                    onMouseEnter={() => { onHoverKey(slice.key); }}
                    onClick={() => { onTogglePinKey(slice.key); }}
                  />
                );
              })}
              {slices.map((slice) => {
                const p0 = polarPoint(cx, cy, rInner - 1, slice.startAngleDeg);
                const p1 = polarPoint(cx, cy, rOuter + 4, slice.startAngleDeg);
                return (
                  <line
                    key={`sep:${slice.key}`}
                    x1={p0.x}
                    y1={p0.y}
                    x2={p1.x}
                    y2={p1.y}
                    stroke="var(--color-paper)"
                    strokeWidth="1.5"
                    pointerEvents="none"
                  />
                );
              })}
            </>
          )}
        </svg>

        <div className="pointer-events-none absolute inset-[31px] flex flex-col items-center justify-center text-center sm:inset-[35px] @min-[800px]/usage:inset-[38px]">
          {scopedBucket !== undefined ? (
            <>
              <button
                type="button"
                data-usage-clear-bucket
                onClick={scopedBucket.onClear}
                className="pointer-events-auto inline-flex min-h-5 max-w-[78px] items-center gap-1 rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-ink transition-colors hover:bg-ink/[0.12] focus-visible:outline-2 focus-visible:outline-selected-ink sm:min-h-6 sm:max-w-[110px] sm:px-2 sm:text-[10.5px] pointer-coarse:-my-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <span data-usage-source-scope className="truncate">{scopedBucket.scopeLabel}</span>
                <Icon name="close" size={12} className="shrink-0 text-[var(--kiki-chart-label)]" />
              </button>
              <div className="mt-0.5 flex max-w-full items-center justify-center gap-0.5">
                <div className="max-w-full truncate font-display text-[16.5px] leading-tight text-ink tabular-nums sm:text-[21px]">
                  {scopedBucket.primaryFigure}
                </div>
                {metric === 'cost' && scopedBucket.costUnknown ? (
                  <KnownSubtotalMarker
                    label={scopedBucket.costAllUnknown ? t('usage.reliability.costUnknown') : undefined}
                  />
                ) : null}
              </div>
              <span
                data-usage-source-subtotal
                className="mt-0.5 inline-flex max-w-full items-center gap-0.5 truncate text-[10.5px] font-medium text-ink tabular-nums sm:text-[11.5px]"
              >
                <span className="truncate">{scopedBucket.subtotalCostText}</span>
                {metric !== 'cost' && scopedBucket.costUnknown ? (
                  <KnownSubtotalMarker
                    label={scopedBucket.costAllUnknown ? t('usage.reliability.costUnknown') : undefined}
                  />
                ) : null}
              </span>
            </>
          ) : (
            <div
              data-usage-kpi={periodHero.kpiId}
              title={periodHero.title}
              className="flex max-w-full flex-col items-center justify-center"
            >
              <span className="max-w-full truncate font-sans text-[10px] font-medium tracking-normal text-[var(--kiki-chart-label)] sm:text-[11px]">
                {periodHero.label}
              </span>
              <div className="mt-0.5 flex max-w-full items-center justify-center gap-0.5">
                <div
                  {...summaryAttrProps}
                  className="max-w-full truncate font-display text-[17.5px] leading-tight text-ink tabular-nums sm:text-[24px]"
                >
                  {periodHero.value}
                </div>
                {periodHero.valueAction !== undefined ? (
                  <span className="pointer-events-auto shrink-0 flex items-center pointer-coarse:-my-2.5 pointer-coarse:-mr-2">
                    {periodHero.valueAction}
                  </span>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>

      {scopedBucket?.onDrilldownDay !== undefined ? (
        <button
          type="button"
          data-usage-drilldown-day
          onClick={scopedBucket.onDrilldownDay}
          className="mt-1.5 inline-flex min-h-7 items-center gap-1 rounded-full border border-hairline-strong bg-paper px-2.5 py-0.5 font-sans tracking-normal text-[11.5px] font-medium text-ink transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-3.5"
        >
          <span>{t('usage.trend.drilldownHourAction')}</span>
          <Icon name="arrowRight" size={12} className="shrink-0 text-[var(--kiki-chart-label)]" />
        </button>
      ) : null}

      {/* Wrap-safe Period KPI Subtitle */}
      {subtitleContent !== undefined ? (
        <div className="mt-1 flex w-full flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 text-center text-[11.5px] leading-snug sm:mt-2.5 sm:gap-x-3 sm:text-[12px]">
          {subtitleContent}
        </div>
      ) : null}

      {/* Proportional Slice Legend Chips (bidirectional hover/focus/pin without URL filter mutation) */}
      {metric !== 'cache' && slices.length > 0 ? (
        <div
          data-usage-ring-legend
          className="mt-1 flex w-full flex-wrap items-center justify-center gap-x-1 gap-y-0 sm:mt-3 sm:gap-x-2 sm:gap-y-1"
        >
          {slices.map((slice) => {
            const label = slice.isOther || slice.key === USAGE_RING_OTHER_KEY
              ? t('usage.trend.other')
              : labelForKey(slice.key);
            const isPinned =
              pinnedKey !== null &&
              (pinnedKey === slice.key || (slice.isOther && slice.memberKeys.includes(pinnedKey)));
            const isHi =
              activeHighlightKey !== null &&
              (activeHighlightKey === slice.key ||
                (slice.isOther && slice.memberKeys.includes(activeHighlightKey)));
            const isDim = activeHighlightKey !== null && !isHi;
            return (
              <button
                key={slice.key}
                type="button"
                data-usage-ring-slice={slice.key}
                aria-pressed={isPinned}
                onMouseEnter={() => { onHoverKey(slice.key); }}
                onMouseLeave={() => { onHoverKey(null); }}
                onFocus={() => { onHoverKey(slice.key); }}
                onBlur={() => { onHoverKey(null); }}
                onClick={() => { onTogglePinKey(slice.key); }}
                title={`${label} · ${formatPercent(slice.ratio)}`}
                className={`inline-flex max-w-[10.5rem] min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-2 sm:max-w-[11rem] sm:px-2 sm:text-[11.5px] ${
                  isPinned
                    ? 'bg-selected/75 font-medium text-ink'
                    : isHi
                      ? 'bg-ink/[0.06] text-ink'
                      : isDim
                        ? 'text-[var(--kiki-chart-muted)] hover:text-ink'
                        : 'text-[var(--kiki-chart-label)] hover:text-ink'
                }`}
              >
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full transition-opacity ${isDim ? 'opacity-35' : ''}`}
                  style={{ backgroundColor: slice.color }}
                />
                <span className="min-w-0 truncate font-sans tracking-normal">{label}</span>
                <span className="shrink-0 font-medium text-ink tabular-nums">{formatPercent(slice.ratio)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
