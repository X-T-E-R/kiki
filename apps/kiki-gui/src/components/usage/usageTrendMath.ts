import {
  totalTokensOf,
  usageSourceKey,
  type UsageGroupBy,
  type UsageMetric,
  type UsageTrendBucketWire,
  type UsageWindow,
} from '../../lib/usageV2';
import { USAGE_RING_OTHER_KEY } from './usageChartPalette';
import {
  bucketCacheHit,
  bucketCost,
  bucketTokens,
  bucketTokenTotalIsUnknown,
} from './usageShared';

export type BucketPointState =
  | 'positive'
  | 'measured_zero'
  | 'missing_gap'
  | 'unknown'
  | 'future'
  | 'in_progress';

export interface BucketPlotPoint {
  readonly index: number;
  readonly key: string;
  readonly x: number;
  /** Left edge of the chronological bucket slot in SVG coordinates [0..width]. */
  readonly slotLeft: number;
  /** Width of the chronological bucket slot in SVG coordinates. */
  readonly slotWidth: number;
  /** Primary metric value: tokens, cost USD, or cache hit ratio [0..1]; null when unmeasured (e.g. 0 input cache rate or unknown cost). */
  readonly total: number | null;
  /** Lower stacked layer value (e.g. cache_read tokens, or highlighted source value); 0 when single-layer. */
  readonly lower: number;
  /** Upper stacked layer value (total - lower); >= 0 always. */
  readonly upper: number;
  readonly yBase: number;
  readonly yLower: number;
  readonly yTotal: number;
  readonly pointState: BucketPointState;
  readonly isEmpty: boolean;
  readonly isFuture: boolean;
  readonly isInProgress: boolean;
  readonly isUnknown: boolean;
  /** Eligible to join a continuous completed Hermite ribbon/curve. */
  readonly joinsRibbon: boolean;
}

export interface RibbonRun {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly points: readonly BucketPlotPoint[];
  readonly lowerAreaPath: string;
  readonly upperBandPath: string;
  readonly topStrokePath: string;
  readonly dividerStrokePath: string;
}

export interface TrendGeometry {
  readonly width: number;
  readonly height: number;
  readonly padTop: number;
  readonly padBottom: number;
  readonly yBase: number;
  readonly maxY: number;
  readonly domainStart: number | null;
  readonly domainEnd: number | null;
  readonly points: readonly BucketPlotPoint[];
  /** Multi-point (>=2) contiguous completed runs rendered as Hermite ribbons/curves. */
  readonly runs: readonly RibbonRun[];
  /** Single isolated completed points that cannot form a ribbon (rendered as crisp vertical stems + dots). */
  readonly isolatedPoints: readonly BucketPlotPoint[];
  /** Current in-progress bucket points with measured data (rendered as dashed stem + open ring dot). */
  readonly inProgressPoints: readonly BucketPlotPoint[];
}

/**
 * Evaluates the shared cubic Hermite blending weight `s(t) = 3t^2 - 2t^3` for `t in [0, 1]`.
 * Because every stacked layer uses the identical monotonic weight s(t) in [0, 1],
 * `Total(t) - Lower(t) = (1 - s(t))*Upper_0 + s(t)*Upper_1 >= 0` everywhere — layers never cross.
 */
export function hermiteSmoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

function appendForwardHermiteSegments(
  coords: readonly { readonly x: number; readonly y: number }[],
): string[] {
  const parts: string[] = [];
  for (let i = 0; i < coords.length - 1; i += 1) {
    const p0 = coords[i]!;
    const p1 = coords[i + 1]!;
    const dx3 = (p1.x - p0.x) / 3;
    parts.push(
      `C ${(p0.x + dx3).toFixed(2)} ${p0.y.toFixed(2)}, ${(p1.x - dx3).toFixed(2)} ${p1.y.toFixed(2)}, ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    );
  }
  return parts;
}

function appendReverseHermiteSegments(
  coords: readonly { readonly x: number; readonly y: number }[],
): string[] {
  const parts: string[] = [];
  for (let i = coords.length - 1; i > 0; i -= 1) {
    const p1 = coords[i]!;
    const p0 = coords[i - 1]!;
    const dx3 = (p1.x - p0.x) / 3;
    parts.push(
      `C ${(p1.x - dx3).toFixed(2)} ${p1.y.toFixed(2)}, ${(p0.x + dx3).toFixed(2)} ${p0.y.toFixed(2)}, ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`,
    );
  }
  return parts;
}

export function buildHermitePolylinePath(
  coords: readonly { readonly x: number; readonly y: number }[],
): string {
  if (coords.length === 0) return '';
  const first = coords[0]!;
  return [`M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`, ...appendForwardHermiteSegments(coords)].join(' ');
}

function areChronologicallyAdjacent(
  prev: UsageTrendBucketWire,
  curr: UsageTrendBucketWire,
): boolean {
  const prevDur = prev.end_at - prev.start_at;
  const currDur = curr.end_at - curr.start_at;
  if (!Number.isFinite(prevDur) || !Number.isFinite(currDur) || prevDur <= 0 || currDur <= 0) {
    return true;
  }
  const gap = curr.start_at - prev.end_at;
  if (gap < -Math.min(prevDur, currDur) * 0.25) return false;
  // Tolerate DST boundary shifts (<= 25% of bucket width) while breaking across any skipped bucket.
  const tolerance = Math.max(120_000, 0.25 * Math.min(prevDur, currDur));
  return gap <= tolerance;
}

function bucketCostAllUnknown(bucket: UsageTrendBucketWire): boolean {
  if (bucket.groups.length === 0) return false;
  if (!bucket.groups.every((g) => g.cost_unknown === true)) return false;
  if (bucketCost(bucket) > 0) return false;
  return bucketTokens(bucket) > 0 || bucket.groups.some((g) => g.tokens_unknown === true);
}

export interface ComputeTrendGeometryInput {
  readonly buckets: readonly UsageTrendBucketWire[];
  readonly metric: UsageMetric;
  readonly groupBy: UsageGroupBy;
  readonly nowMs: number;
  readonly rangeWindow?: UsageWindow | null;
  readonly highlightedKey?: string | null;
  readonly tailKeys?: ReadonlySet<string>;
  readonly width?: number;
  readonly height?: number;
  readonly padTop?: number;
  readonly padBottom?: number;
}

export function computeTrendGeometry({
  buckets,
  metric,
  groupBy,
  nowMs,
  rangeWindow = null,
  highlightedKey = null,
  tailKeys,
  width = 680,
  height = 172,
  padTop = 22,
  padBottom = 6,
}: ComputeTrendGeometryInput): TrendGeometry {
  const n = buckets.length;
  const yBase = height - padBottom;
  const plotH = Math.max(1, yBase - padTop);

  const hasChronologicalBounds =
    n > 0 &&
    buckets.every(
      (b) =>
        Number.isFinite(b.start_at) &&
        Number.isFinite(b.end_at) &&
        b.end_at > b.start_at,
    ) &&
    buckets.every((b, idx) => idx === 0 || b.start_at >= buckets[idx - 1]!.start_at);

  let domainStart: number | null = null;
  let domainEnd: number | null = null;
  if (hasChronologicalBounds) {
    const firstStart = buckets[0]!.start_at;
    const lastEnd = buckets.at(-1)!.end_at;
    if (
      rangeWindow !== null &&
      Number.isFinite(rangeWindow.startAt) &&
      Number.isFinite(rangeWindow.endAt) &&
      rangeWindow.endAt > rangeWindow.startAt &&
      rangeWindow.startAt <= firstStart &&
      rangeWindow.endAt >= lastEnd
    ) {
      domainStart = rangeWindow.startAt;
      domainEnd = rangeWindow.endAt;
    } else {
      domainStart = firstStart;
      domainEnd = lastEnd;
    }
  }
  const domainSpan =
    domainStart !== null && domainEnd !== null && domainEnd > domainStart
      ? domainEnd - domainStart
      : null;

  const rawValues = buckets.map((bucket) => {
    const isSyntheticEmpty = bucket.key.startsWith('empty:');
    const tokenUnknown = bucketTokenTotalIsUnknown(bucket);
    if (tokenUnknown) {
      return { total: null as number | null, lower: 0, isUnknown: true, isMissingGap: false, isSyntheticEmpty };
    }
    if (metric === 'cache') {
      if (isSyntheticEmpty) {
        return { total: null, lower: 0, isUnknown: false, isMissingGap: true, isSyntheticEmpty: true };
      }
      const rate = bucketCacheHit(bucket);
      if (rate === null) {
        return { total: null, lower: 0, isUnknown: false, isMissingGap: true, isSyntheticEmpty: false };
      }
      return { total: rate, lower: 0, isUnknown: false, isMissingGap: false, isSyntheticEmpty: false };
    }
    if (isSyntheticEmpty) {
      return { total: 0, lower: 0, isUnknown: false, isMissingGap: false, isSyntheticEmpty: true };
    }
    if (metric === 'cost' && bucketCostAllUnknown(bucket)) {
      return { total: null, lower: 0, isUnknown: true, isMissingGap: false, isSyntheticEmpty: false };
    }
    const total = metric === 'tokens' ? bucketTokens(bucket) : bucketCost(bucket);
    if (total <= 0) {
      return { total: 0, lower: 0, isUnknown: false, isMissingGap: false, isSyntheticEmpty: false };
    }
    if (highlightedKey !== null) {
      const matchGroup = (key: string) =>
        highlightedKey === USAGE_RING_OTHER_KEY
          ? (tailKeys?.has(key) === true)
          : key === highlightedKey;
      const hi = bucket.groups
        .filter((g) => matchGroup(usageSourceKey(g, groupBy)))
        .reduce((sum, g) => sum + (metric === 'tokens' ? totalTokensOf(g) : g.cost_usd_estimated), 0);
      const clampedLower = Math.max(0, Math.min(total, hi));
      return { total, lower: clampedLower, isUnknown: false, isMissingGap: false, isSyntheticEmpty: false };
    }
    if (metric === 'tokens') {
      const cacheRead = bucket.groups.reduce((sum, g) => sum + g.tokens.input_cache_read, 0);
      return { total, lower: Math.max(0, Math.min(total, cacheRead)), isUnknown: false, isMissingGap: false, isSyntheticEmpty: false };
    }
    return { total, lower: 0, isUnknown: false, isMissingGap: false, isSyntheticEmpty: false };
  });

  const maxY = metric === 'cache'
    ? 1
    : Math.max(
        0,
        ...rawValues.map((v) => (v.total !== null && Number.isFinite(v.total) ? v.total : 0)),
      );

  const yForValue = (val: number): number => {
    if (maxY <= 0 || val <= 0) return yBase;
    const ratio = Math.max(0, Math.min(1, val / maxY));
    return yBase - ratio * plotH;
  };

  const points: BucketPlotPoint[] = buckets.map((bucket, index) => {
    let x: number;
    let slotLeft: number;
    let slotWidth: number;

    if (domainSpan !== null && domainStart !== null) {
      const mid = (bucket.start_at + bucket.end_at) / 2;
      x = Math.max(0, Math.min(width, ((mid - domainStart) / domainSpan) * width));
      const rawLeft = ((bucket.start_at - domainStart) / domainSpan) * width;
      const rawRight = ((bucket.end_at - domainStart) / domainSpan) * width;
      slotLeft = Math.max(0, Math.min(width, rawLeft));
      slotWidth = Math.max(2, Math.min(width - slotLeft, rawRight - rawLeft));
    } else {
      slotWidth = n > 0 ? width / n : width;
      slotLeft = index * slotWidth;
      x = n <= 1 ? width / 2 : ((index + 0.5) * width) / n;
    }

    const raw = rawValues[index]!;
    const isFuture = bucket.start_at > nowMs;
    const isInProgress = !isFuture && bucket.start_at <= nowMs && nowMs < bucket.end_at;

    let pointState: BucketPointState;
    if (isFuture) {
      pointState = 'future';
    } else if (raw.isUnknown) {
      pointState = 'unknown';
    } else if (raw.isMissingGap) {
      pointState = 'missing_gap';
    } else if (isInProgress && (metric === 'cache' ? raw.total !== null : (raw.total ?? 0) > 0)) {
      pointState = 'in_progress';
    } else if (raw.total !== null && raw.total > 0) {
      pointState = 'positive';
    } else {
      pointState = 'measured_zero';
    }

    const isEmpty = !isFuture && !raw.isUnknown && !raw.isMissingGap && (raw.total === 0);

    const numericTotal = raw.total ?? 0;
    const lower = Math.max(0, Math.min(numericTotal, raw.lower));
    const upper = Math.max(0, numericTotal - lower);
    const yLower = yForValue(lower);
    const yTotal = raw.total === null ? yBase : yForValue(numericTotal);

    const joinsRibbon =
      !raw.isSyntheticEmpty &&
      !raw.isUnknown &&
      !raw.isMissingGap &&
      !isFuture &&
      !isInProgress &&
      (metric === 'cache' ? raw.total !== null : raw.total !== null && raw.total > 0);

    return {
      index,
      key: bucket.key,
      x,
      slotLeft,
      slotWidth,
      total: raw.total,
      lower,
      upper,
      yBase,
      yLower,
      yTotal,
      pointState,
      isEmpty,
      isFuture,
      isInProgress,
      isUnknown: raw.isUnknown,
      joinsRibbon,
    };
  });

  const runs: RibbonRun[] = [];
  const isolatedPoints: BucketPlotPoint[] = [];
  const inProgressPoints: BucketPlotPoint[] = [];

  let i = 0;
  while (i < points.length) {
    const pt = points[i]!;
    if (pt.pointState === 'in_progress') {
      inProgressPoints.push(pt);
      i += 1;
      continue;
    }
    if (!pt.joinsRibbon) {
      i += 1;
      continue;
    }
    let j = i;
    while (
      j + 1 < points.length &&
      points[j + 1]!.joinsRibbon &&
      areChronologicallyAdjacent(buckets[j]!, buckets[j + 1]!)
    ) {
      j += 1;
    }
    const slice = points.slice(i, j + 1);
    if (slice.length === 1) {
      isolatedPoints.push(slice[0]!);
    } else {
      const topCoords = slice.map((p) => ({ x: p.x, y: p.yTotal }));
      const lowCoords = slice.map((p) => ({ x: p.x, y: p.yLower }));
      const topStrokePath = buildHermitePolylinePath(topCoords);
      const dividerStrokePath = buildHermitePolylinePath(lowCoords);

      const first = slice[0]!;
      const last = slice.at(-1)!;
      const lowerAreaPath = [
        `M ${first.x.toFixed(2)} ${yBase.toFixed(2)}`,
        `L ${first.x.toFixed(2)} ${first.yLower.toFixed(2)}`,
        ...appendForwardHermiteSegments(lowCoords),
        `L ${last.x.toFixed(2)} ${yBase.toFixed(2)}`,
        'Z',
      ].join(' ');

      const upperBandPath = [
        topStrokePath,
        `L ${last.x.toFixed(2)} ${last.yLower.toFixed(2)}`,
        ...appendReverseHermiteSegments(lowCoords),
        'Z',
      ].join(' ');

      runs.push({
        startIndex: i,
        endIndex: j,
        points: slice,
        lowerAreaPath,
        upperBandPath,
        topStrokePath,
        dividerStrokePath,
      });
    }
    i = j + 1;
  }

  return {
    width,
    height,
    padTop,
    padBottom,
    yBase,
    maxY,
    domainStart,
    domainEnd,
    points,
    runs,
    isolatedPoints,
    inProgressPoints,
  };
}
