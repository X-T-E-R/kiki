import type { ReactNode } from 'react';
import { formatQuotaPercentNumber, quotaFuelTier } from '../../../lib/providerQuota';
import { polarPoint } from '../usageChartPalette';
import { quotaPercentToAngleDeg, type RemainingPace } from './quotaModel';

function describeOpen240ArcPath(cx: number, cy: number, radius: number): string {
  const start = polarPoint(cx, cy, radius, 150);
  const end = polarPoint(cx, cy, radius, 390);
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${radius} ${radius} 0 1 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
}

export function resolveQuotaArcStroke(
  remainingPercent: number,
  pace?: RemainingPace | null,
  muted = false,
  isSecondaryRing = false,
): string {
  if (muted) return 'var(--kiki-chart-other)';
  const tier = quotaFuelTier(remainingPercent);
  if (remainingPercent <= 5 || pace?.state === 'depleting') {
    return 'var(--kiki-chart-danger)';
  }
  if (tier === 'critical' || tier === 'low' || pace?.state === 'fast') {
    return 'var(--kiki-chart-3)';
  }
  return isSecondaryRing ? 'var(--kiki-chart-5)' : 'var(--kiki-chart-1)';
}

function PaceRadialTick({
  cx,
  cy,
  radius,
  halfSpan,
  expectedRemainingPct,
}: {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly halfSpan: number;
  readonly expectedRemainingPct: number;
}) {
  const deg = quotaPercentToAngleDeg(expectedRemainingPct);
  const inner = polarPoint(cx, cy, radius - halfSpan, deg);
  const outer = polarPoint(cx, cy, radius + halfSpan, deg);
  return (
    <g data-quota-pace-tick>
      <line
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
        stroke="var(--color-paper)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <line
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
        stroke="var(--color-ink)"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </g>
  );
}

/**
 * Full 240deg open calibration dial (`theta = 150deg + 240deg * p`) with
 * precision major/minor ticks, radial expected-remaining-time pace tick,
 * optional inner concentric cap ring, and focal inner readout.
 */
export function QuotaCalibrationDial({
  outerPercent,
  outerPace,
  innerPercent,
  innerPace,
  muted = false,
  ariaLabel,
  centerContent,
  progressDataAttr = false,
}: {
  readonly outerPercent: number;
  readonly outerPace?: RemainingPace | null;
  readonly innerPercent?: number;
  readonly innerPace?: RemainingPace | null;
  readonly muted?: boolean;
  readonly ariaLabel: string;
  readonly centerContent: ReactNode;
  readonly progressDataAttr?: boolean;
}) {
  const w = 156;
  const h = 128;
  const cx = 78;
  const cy = 74;
  const rOuter = 57;
  const rInner = 43.5;

  const pctOuter = Math.max(0, Math.min(100, outerPercent));
  const pctInner = innerPercent !== undefined ? Math.max(0, Math.min(100, innerPercent)) : undefined;
  const pctOuterArc = Number(pctOuter.toFixed(2));
  const pctInnerArc = pctInner !== undefined ? Number(pctInner.toFixed(2)) : undefined;

  const outerStroke = resolveQuotaArcStroke(pctOuter, outerPace, muted, false);
  const innerStroke = pctInner !== undefined ? resolveQuotaArcStroke(pctInner, innerPace, muted, true) : undefined;

  const outerArcD = describeOpen240ArcPath(cx, cy, rOuter);
  const innerArcD = pctInner !== undefined ? describeOpen240ArcPath(cx, cy, rInner) : undefined;

  const progressProps = progressDataAttr
    ? { 'data-quota-progress': true, 'data-remaining-percent': formatQuotaPercentNumber(pctOuter) }
    : {};

  return (
    <div
      className="relative flex h-[128px] w-[156px] shrink-0 items-center justify-center"
      {...progressProps}
    >
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${w} ${h}`}
        className="h-full w-full overflow-visible"
      >
        {/* Sparse precision calibration ticks: major at 0, 25, 50, 75, 100%; minor midpoints */}
        {[0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100].map((tickPct) => {
          const major = tickPct % 25 === 0;
          const deg = quotaPercentToAngleDeg(tickPct);
          const p0 = polarPoint(cx, cy, rOuter + 6.5, deg);
          const p1 = polarPoint(cx, cy, rOuter + (major ? 11.5 : 9), deg);
          return (
            <line
              key={tickPct}
              x1={p0.x}
              y1={p0.y}
              x2={p1.x}
              y2={p1.y}
              stroke={major ? 'var(--kiki-gauge-tick)' : 'var(--kiki-gauge-track)'}
              strokeWidth={major ? '1.45' : '1.05'}
            />
          );
        })}

        <path
          d={outerArcD}
          fill="none"
          stroke="var(--kiki-gauge-track)"
          strokeWidth="6"
          strokeLinecap="butt"
        />

        {pctOuter > 0 ? (
          <path
            d={outerArcD}
            fill="none"
            pathLength={100}
            strokeDasharray={`${pctOuterArc} 100`}
            stroke={outerStroke}
            strokeWidth="9.5"
            strokeLinecap="butt"
          />
        ) : null}

        {outerPace !== null && outerPace !== undefined && !muted ? (
          <PaceRadialTick
            cx={cx}
            cy={cy}
            radius={rOuter}
            halfSpan={7.25}
            expectedRemainingPct={outerPace.expectedRemainingPct}
          />
        ) : null}

        {innerArcD !== undefined && pctInner !== undefined ? (
          <>
            <path
              d={innerArcD}
              fill="none"
              stroke="var(--kiki-gauge-track)"
              strokeWidth="4.25"
              strokeLinecap="butt"
            />
            {pctInner > 0 && pctInnerArc !== undefined && innerStroke !== undefined ? (
              <path
                d={innerArcD}
                fill="none"
                pathLength={100}
                strokeDasharray={`${pctInnerArc} 100`}
                stroke={innerStroke}
                strokeWidth="6.5"
                strokeLinecap="butt"
              />
            ) : null}
            {innerPace !== null && innerPace !== undefined && !muted ? (
              <PaceRadialTick
                cx={cx}
                cy={cy}
                radius={rInner}
                halfSpan={5.25}
                expectedRemainingPct={innerPace.expectedRemainingPct}
              />
            ) : null}
          </>
        ) : null}
      </svg>

      {/* Center Readout */}
      <div className="pointer-events-none absolute inset-x-[28px] top-[34px] bottom-[12px] flex flex-col items-center justify-center text-center">
        {centerContent}
      </div>
    </div>
  );
}

/**
 * Compact 32-36px 240deg mini ring gauge for seat matrix cells, ledger meters,
 * and endangered overflow rows. Supports Unknown (unfilled dashed track),
 * 0% (empty solid track), and radial pace ticks.
 */
export function QuotaMiniArc({
  remainingPercent,
  unknown = false,
  pace,
  muted = false,
  size = 34,
  dataAttr,
}: {
  readonly remainingPercent?: number;
  readonly unknown?: boolean;
  readonly pace?: RemainingPace | null;
  readonly muted?: boolean;
  readonly size?: number;
  readonly dataAttr?: 'data-quota-progress' | 'data-bucket-progress';
}) {
  const cx = 17;
  const cy = 18.5;
  const r = 12.75;
  const arcD = describeOpen240ArcPath(cx, cy, r);

  const pct = remainingPercent !== undefined
    ? Math.max(0, Math.min(100, remainingPercent))
    : undefined;
  const pctArc = pct !== undefined ? Number(pct.toFixed(2)) : undefined;

  const containerProps =
    !unknown && pct !== undefined
      ? dataAttr === 'data-quota-progress'
        ? { 'data-quota-progress': true, 'data-remaining-percent': formatQuotaPercentNumber(pct) }
        : dataAttr === 'data-bucket-progress'
          ? { 'data-bucket-progress': true }
          : {}
      : {};

  const activeStroke = pct !== undefined ? resolveQuotaArcStroke(pct, pace, muted, false) : undefined;

  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="relative inline-flex shrink-0 items-center justify-center"
      {...containerProps}
    >
      <svg viewBox="0 0 34 34" className="h-full w-full overflow-visible">
        <path
          d={arcD}
          fill="none"
          stroke={unknown ? 'var(--kiki-gauge-tick)' : 'var(--kiki-gauge-track)'}
          strokeWidth="2.4"
          strokeLinecap="butt"
          strokeDasharray={unknown ? '2.5 2.5' : undefined}
        />
        {!unknown && pct !== undefined && pctArc !== undefined && pct > 0 && activeStroke !== undefined ? (
          <path
            d={arcD}
            fill="none"
            pathLength={100}
            strokeDasharray={`${pctArc} 100`}
            stroke={activeStroke}
            strokeWidth="3.5"
            strokeLinecap="butt"
          />
        ) : null}
        {!unknown && pct !== undefined && pace !== null && pace !== undefined && !muted ? (() => {
          const deg = quotaPercentToAngleDeg(pace.expectedRemainingPct);
          const p0 = polarPoint(cx, cy, r - 3.1, deg);
          const p1 = polarPoint(cx, cy, r + 3.1, deg);
          return (
            <g data-quota-pace-tick>
              <line
                x1={p0.x}
                y1={p0.y}
                x2={p1.x}
                y2={p1.y}
                stroke="var(--color-paper)"
                strokeWidth="2.8"
                strokeLinecap="round"
              />
              <line
                x1={p0.x}
                y1={p0.y}
                x2={p1.x}
                y2={p1.y}
                stroke="var(--color-ink)"
                strokeWidth="1.45"
                strokeLinecap="round"
              />
            </g>
          );
        })() : null}
      </svg>
    </span>
  );
}
