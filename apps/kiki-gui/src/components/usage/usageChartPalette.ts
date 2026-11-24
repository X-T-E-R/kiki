import type { UsageMetric, UsageSourceRow } from '../../lib/usageV2';

/**
 * Chart-local warm paper-and-ink palette tokens.
 * Each CSS variable resolves to an APCA/WCAG-verified pair on light (#FBFAF6 / #FFFDFA)
 * and dark (#1B2226 / #252D31) surfaces; vermilion (--kiki-chart-danger) is reserved
 * strictly for actionable quota danger / depletion alerts, never ordinary series.
 */
export const USAGE_SERIES_COLORS = [
  'var(--kiki-chart-1)',
  'var(--kiki-chart-2)',
  'var(--kiki-chart-3)',
  'var(--kiki-chart-4)',
  'var(--kiki-chart-5)',
] as const;

export const USAGE_OTHER_COLOR = 'var(--kiki-chart-other)';
export const USAGE_RING_OTHER_KEY = '__other';
export const USAGE_RING_TOP_LIMIT = USAGE_SERIES_COLORS.length;

export interface CompositionSlice {
  readonly key: string;
  readonly value: number;
  readonly ratio: number;
  readonly startAngleDeg: number;
  readonly endAngleDeg: number;
  readonly color: string;
  readonly isOther: boolean;
  readonly memberKeys: readonly string[];
}

export interface CompositionModel {
  readonly subtotal: number;
  readonly slices: readonly CompositionSlice[];
  readonly tailKeys: ReadonlySet<string>;
  readonly colorByKey: ReadonlyMap<string, string>;
  readonly unpricedPositiveRowCount: number;
}

export function sourceRowMetricValue(row: UsageSourceRow, metric: UsageMetric): number {
  return metric === 'cost' ? row.costUsdEstimated : row.totalTokens;
}

/**
 * Builds the exact proportional composition model (top 5 positive slices + exact `其他` tail)
 * over aggregated source rows. Angles start at -90deg (12 o'clock) and sweep 360deg clockwise
 * with zero minimum-wedge distortion.
 */
export function buildCompositionModel(
  rows: readonly UsageSourceRow[],
  metric: UsageMetric,
): CompositionModel {
  const colorByKey = new Map<string, string>();
  const tailKeys = new Set<string>();
  let unpricedPositiveRowCount = 0;

  for (const row of rows) {
    if (row.costUnknown && row.costUsdEstimated === 0 && (row.totalTokens > 0 || row.tokensUnknown)) {
      unpricedPositiveRowCount += 1;
    }
  }

  if (metric === 'cache') {
    rows.slice(0, USAGE_RING_TOP_LIMIT).forEach((row, idx) => {
      colorByKey.set(row.key, USAGE_SERIES_COLORS[idx]!);
    });
    for (const row of rows.slice(USAGE_RING_TOP_LIMIT)) {
      colorByKey.set(row.key, USAGE_OTHER_COLOR);
      tailKeys.add(row.key);
    }
    return {
      subtotal: 0,
      slices: [],
      tailKeys,
      colorByKey,
      unpricedPositiveRowCount,
    };
  }

  const positive = rows
    .map((row) => ({ row, val: sourceRowMetricValue(row, metric) }))
    .filter((entry) => Number.isFinite(entry.val) && entry.val > 0);

  const subtotal = positive.reduce((sum, entry) => sum + entry.val, 0);
  if (subtotal <= 0) {
    return {
      subtotal: 0,
      slices: [],
      tailKeys,
      colorByKey,
      unpricedPositiveRowCount,
    };
  }

  const head = positive.slice(0, USAGE_RING_TOP_LIMIT);
  const tail = positive.slice(USAGE_RING_TOP_LIMIT);

  const rawItems: Array<{
    key: string;
    value: number;
    color: string;
    isOther: boolean;
    memberKeys: readonly string[];
  }> = head.map((entry, idx) => {
    const color = USAGE_SERIES_COLORS[idx]!;
    colorByKey.set(entry.row.key, color);
    return {
      key: entry.row.key,
      value: entry.val,
      color,
      isOther: false,
      memberKeys: [entry.row.key],
    };
  });

  if (tail.length > 0) {
    const tailSum = tail.reduce((sum, entry) => sum + entry.val, 0);
    const members: string[] = [];
    for (const entry of tail) {
      colorByKey.set(entry.row.key, USAGE_OTHER_COLOR);
      tailKeys.add(entry.row.key);
      members.push(entry.row.key);
    }
    colorByKey.set(USAGE_RING_OTHER_KEY, USAGE_OTHER_COLOR);
    if (tailSum > 0) {
      rawItems.push({
        key: USAGE_RING_OTHER_KEY,
        value: tailSum,
        color: USAGE_OTHER_COLOR,
        isOther: true,
        memberKeys: members,
      });
    }
  }

  // Also assign muted stone swatch to zero-valued rows (e.g. unpriced in cost mode)
  for (const row of rows) {
    if (!colorByKey.has(row.key)) {
      colorByKey.set(row.key, USAGE_OTHER_COLOR);
    }
  }

  let cursorDeg = -90;
  const slices: CompositionSlice[] = rawItems.map((item, idx) => {
    const ratio = item.value / subtotal;
    const sweepDeg = idx === rawItems.length - 1
      ? Math.max(0, 270 - cursorDeg)
      : ratio * 360;
    const startAngleDeg = cursorDeg;
    const endAngleDeg = cursorDeg + sweepDeg;
    cursorDeg = endAngleDeg;
    return {
      key: item.key,
      value: item.value,
      ratio,
      startAngleDeg,
      endAngleDeg,
      color: item.color,
      isOther: item.isOther,
      memberKeys: item.memberKeys,
    };
  });

  return {
    subtotal,
    slices,
    tailKeys,
    colorByKey,
    unpricedPositiveRowCount,
  };
}

/** Polar SVG helper (angleDeg in screen degrees: 0 = 3 o'clock, -90 = 12 o'clock). */
export function polarPoint(cx: number, cy: number, radius: number, angleDeg: number): { readonly x: number; readonly y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

/** Annular donut sector path from startAngleDeg to endAngleDeg (clockwise). */
export function describeDonutSlicePath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const sweep = Math.max(0, Math.min(359.999, endAngleDeg - startAngleDeg));
  if (sweep <= 0) return '';
  const largeArc = sweep > 180 ? 1 : 0;
  const outerStart = polarPoint(cx, cy, outerRadius, startAngleDeg);
  const outerEnd = polarPoint(cx, cy, outerRadius, startAngleDeg + sweep);
  const innerEnd = polarPoint(cx, cy, innerRadius, startAngleDeg + sweep);
  const innerStart = polarPoint(cx, cy, innerRadius, startAngleDeg);
  return [
    `M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}`,
    `L ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}`,
    'Z',
  ].join(' ');
}
