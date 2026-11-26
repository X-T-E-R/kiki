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
  if (remainingPercent <= 5 || pace?.state === 'depleting' || pace?.state === 'exhausted') {
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
  subtitle,
  progressDataAttr = false,
}: {
  readonly outerPercent: number;
  readonly outerPace?: RemainingPace | null;
  readonly innerPercent?: number;
  readonly innerPace?: RemainingPace | null;
  readonly muted?: boolean;
  readonly ariaLabel: string;
  readonly centerContent: ReactNode;
  readonly subtitle?: ReactNode;
  readonly progressDataAttr?: boolean;
}) {
  const w = 156;
  const h = 110;
  const cx = 78;
  const cy = 72;
  const rOuter = 56;
  const rInner = 43;

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
      className="flex shrink-0 flex-col items-center"
      {...progressProps}
    >
      <div className="relative h-[110px] w-[156px]">
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

        {/* Center Readout: centered on circle datum (cx, cy) with generous inner-ring clearance */}
        <div className="pointer-events-none absolute inset-x-[38px] top-[72px] flex -translate-y-1/2 flex-col items-center justify-center text-center">
          {centerContent}
        </div>
      </div>

      {/* Subtitle cleanly below the 240deg arc baseline so long labels never collide with inner arc ends */}
      {subtitle !== undefined && subtitle !== null ? (
        <div
          data-quota-dial-subtitle
          className="mt-1 flex max-w-[180px] items-center justify-center text-center font-sans tracking-normal text-[12px] leading-4 text-[var(--kiki-chart-label)]"
        >
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Precision linear Tufte bullet / fuel micro-bar for secondary ledger rows,
 * expanded multi-seat matrices, and compact endangered overflow items.
 * Preserves top 240deg calibration dials as the sole circular focal silhouette
 * while aligning column-wise fuel and expected-remaining pace ticks on a shared X datum.
 */
export function QuotaFuelMicroBar({
  remainingPercent,
  unknown = false,
  pace,
  muted = false,
  width = 68,
  dataAttr,
}: {
  readonly remainingPercent?: number;
  readonly unknown?: boolean;
  readonly pace?: RemainingPace | null;
  readonly muted?: boolean;
  readonly width?: number;
  readonly dataAttr?: 'data-quota-progress' | 'data-bucket-progress';
}) {
  const pct = remainingPercent !== undefined
    ? Math.max(0, Math.min(100, remainingPercent))
    : undefined;

  const containerProps =
    !unknown && pct !== undefined
      ? dataAttr === 'data-quota-progress'
        ? { 'data-quota-progress': true, 'data-remaining-percent': formatQuotaPercentNumber(pct) }
        : dataAttr === 'data-bucket-progress'
          ? { 'data-bucket-progress': true }
          : {}
      : {};

  const activeFill = pct !== undefined ? resolveQuotaArcStroke(pct, pace, muted, false) : undefined;
  const usableSpan = Math.max(12, width - 2);
  const fillWidth =
    !unknown && pct !== undefined && pct > 0
      ? Math.min(usableSpan, Math.max(3, Number(((usableSpan * pct) / 100).toFixed(2))))
      : 0;
  const paceX =
    !unknown && pct !== undefined && pace !== null && pace !== undefined && !muted
      ? Number((1 + (usableSpan * Math.max(0, Math.min(100, pace.expectedRemainingPct))) / 100).toFixed(2))
      : undefined;

  return (
    <span
      aria-hidden
      style={{ width, height: 14 }}
      className="relative inline-flex shrink-0 items-center"
      {...containerProps}
    >
      <svg viewBox={`0 0 ${width} 14`} className="h-full w-full overflow-visible">
        {unknown ? (
          <rect
            x={1.5}
            y={4.5}
            width={width - 3}
            height={5}
            rx={1.5}
            fill="none"
            stroke="var(--kiki-gauge-tick)"
            strokeWidth="1.15"
            strokeDasharray="3.5 2.5"
          />
        ) : (
          <rect
            x={1.5}
            y={4.5}
            width={width - 3}
            height={5}
            rx={1.5}
            fill="color-mix(in srgb, var(--kiki-gauge-track) 16%, transparent)"
            stroke="var(--kiki-gauge-track)"
            strokeWidth="1"
          />
        )}

        {fillWidth > 0 && activeFill !== undefined ? (
          <rect
            x={1}
            y={4}
            width={fillWidth}
            height={6}
            rx={1.75}
            fill={activeFill}
          />
        ) : null}

        {paceX !== undefined ? (
          <g data-quota-pace-tick>
            <line
              x1={paceX}
              y1={1.5}
              x2={paceX}
              y2={12.5}
              stroke="var(--color-paper)"
              strokeWidth="3.2"
              strokeLinecap="round"
            />
            <line
              x1={paceX}
              y1={1.5}
              x2={paceX}
              y2={12.5}
              stroke="var(--color-ink)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>
        ) : null}
      </svg>
    </span>
  );
}
