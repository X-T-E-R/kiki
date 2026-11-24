import type { Locale } from '@kiki/session-core/i18n';
import {
  formatHarnessQuotaReading,
  formatQuotaResetShort,
  meterRemainingPercent,
  meterValue,
  type HarnessQuotaAccountGroup,
  type HarnessQuotaReading,
  type ProviderQuotaMeter,
} from '../../../lib/providerQuota';

export type RemainingPaceState = 'on_track' | 'fast' | 'depleting';

export interface RemainingPace {
  readonly state: RemainingPaceState;
  readonly expectedRemainingPct: number;
  readonly deficitPct: number;
  readonly etaSeconds: number | null;
  readonly willExhaustBeforeReset: boolean;
}

export interface ComputeRemainingPaceInput {
  readonly remainingPercent: number;
  readonly durationSeconds: number;
  readonly resetAtMs: number;
  readonly nowMs: number;
}

const WINDOW_DURATION_RE = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day|w|wk)$/i;

const UNIT_TO_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  m: 60,
  min: 60,
  h: 3_600,
  hr: 3_600,
  d: 86_400,
  day: 86_400,
  w: 604_800,
  wk: 604_800,
};

/** Resolve window duration in seconds from explicit duration_seconds or a compact window label like "5h" or "7d". */
export function parseWindowDurationSeconds(
  windowLabel?: string,
  explicitDurationSeconds?: number,
): number | undefined {
  if (typeof explicitDurationSeconds === 'number' && Number.isFinite(explicitDurationSeconds) && explicitDurationSeconds > 0) {
    return explicitDurationSeconds;
  }
  if (!windowLabel) return undefined;
  const match = WINDOW_DURATION_RE.exec(windowLabel.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const factor = UNIT_TO_SECONDS[match[2]!.toLowerCase()];
  if (!Number.isFinite(amount) || amount <= 0 || factor === undefined) return undefined;
  return Math.round(amount * factor);
}

/**
 * Compute remaining-fuel pace against linear time consumption (CodexBar UsagePace inverted to Remaining Fuel).
 * Returns null for balances, invalid windows, or early-window noise (<1% elapsed for >=24h, <3% for <24h).
 */
export function computeRemainingPace(input: ComputeRemainingPaceInput): RemainingPace | null {
  const { remainingPercent, durationSeconds, resetAtMs, nowMs } = input;
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) return null;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  if (!Number.isFinite(resetAtMs) || !Number.isFinite(nowMs)) return null;

  const remainingWindowSeconds = (resetAtMs - nowMs) / 1000;
  if (remainingWindowSeconds <= 0 || remainingWindowSeconds >= durationSeconds) return null;

  const elapsedSeconds = durationSeconds - remainingWindowSeconds;
  const elapsedRatio = elapsedSeconds / durationSeconds;
  const minElapsedRatio = durationSeconds >= 86_400 ? 0.01 : 0.03;
  if (elapsedRatio < minElapsedRatio) return null;

  const expectedRemainingPct = Math.max(0, Math.min(100, (1 - elapsedRatio) * 100));
  const delta = remainingPercent - expectedRemainingPct;
  const deficitPct = Math.max(0, -delta);
  const usedPct = Math.max(0, 100 - remainingPercent);
  const burnRatePerSec = usedPct / elapsedSeconds;
  const etaSeconds = burnRatePerSec > 0 ? remainingPercent / burnRatePerSec : null;
  const willExhaustBeforeReset =
    etaSeconds !== null && remainingPercent > 0 && etaSeconds < remainingWindowSeconds;

  let state: RemainingPaceState = 'on_track';
  if (
    remainingPercent <= 0 ||
    (willExhaustBeforeReset && deficitPct >= 10 && (remainingPercent <= 25 || (etaSeconds !== null && etaSeconds <= 3_600)))
  ) {
    state = 'depleting';
  } else if (deficitPct >= 8) {
    state = 'fast';
  }

  return {
    state,
    expectedRemainingPct,
    deficitPct,
    etaSeconds,
    willExhaustBeforeReset,
  };
}

export function formatPaceEta(seconds: number | null, locale: Locale): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return locale === 'zh' ? '即将耗尽' : 'soon';
  }
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

export interface MeterPrimaryDisplay {
  readonly primaryText: string;
  readonly secondaryText?: string;
  readonly hoverDetail?: string;
  readonly remainingPercent?: number;
  readonly showBar: boolean;
  readonly exhausted: boolean;
  readonly unknown: boolean;
}

function formatMoneyUnit(value: number, currency?: string, unitLabel?: string): string {
  const fixed = value.toFixed(2);
  if (currency === 'USD') return `$${fixed}`;
  if (currency === 'CNY') return `¥${fixed}`;
  if (currency === 'EUR') return `€${fixed}`;
  const unit = currency ?? unitLabel;
  return unit ? `${fixed} ${unit}` : fixed;
}

/**
 * Amount-first presentation by meter unit:
 * - money / credits with no limit: amount only, NO fake progress bar
 * - money / credits with limit: remaining / limit primary + muted % secondary + bar
 * - percent / tokens / requests / count: remaining % primary (when limit exists) or amount
 */
export function meterPrimaryReading(meter: ProviderQuotaMeter, unknownLabel: string): MeterPrimaryDisplay {
  const remainingPercent = meterRemainingPercent(meter);
  const reading = meterValue(meter);

  if (reading.kind === 'unknown') {
    return {
      primaryText: unknownLabel,
      showBar: false,
      exhausted: false,
      unknown: true,
    };
  }

  const exhausted =
    (remainingPercent !== undefined && remainingPercent <= 0) ||
    (meter.remaining !== null && meter.remaining <= 0);

  if (meter.unit === 'money') {
    const remaining = meter.remaining ?? (meter.limit !== null && meter.used !== null ? Math.max(0, meter.limit - meter.used) : null);
    if (meter.limit === null || meter.limit <= 0) {
      return {
        primaryText: reading.value,
        showBar: false,
        exhausted,
        unknown: false,
      };
    }
    const primary = remaining !== null
      ? `${formatMoneyUnit(remaining, meter.currency, meter.unit_label)} / ${formatMoneyUnit(meter.limit, meter.currency, meter.unit_label)}`
      : reading.value;
    return {
      primaryText: primary,
      secondaryText: remainingPercent !== undefined ? `${remainingPercent}%` : undefined,
      hoverDetail: reading.kind === 'ratio' ? reading.value : undefined,
      remainingPercent,
      showBar: remainingPercent !== undefined,
      exhausted,
      unknown: false,
    };
  }

  if (meter.unit === 'credits') {
    if (meter.limit === null || meter.limit <= 0) {
      return {
        primaryText: reading.value,
        showBar: false,
        exhausted,
        unknown: false,
      };
    }
    const remaining = meter.remaining ?? (meter.used !== null ? Math.max(0, meter.limit - meter.used) : null);
    const primary = remaining !== null
      ? `${remaining} / ${meter.limit} ${meter.unit_label}`
      : reading.value;
    return {
      primaryText: primary,
      secondaryText: remainingPercent !== undefined ? `${remainingPercent}%` : undefined,
      hoverDetail: reading.kind === 'ratio' ? reading.value : undefined,
      remainingPercent,
      showBar: remainingPercent !== undefined,
      exhausted,
      unknown: false,
    };
  }

  return {
    primaryText: remainingPercent !== undefined ? `${remainingPercent}%` : reading.value,
    hoverDetail: remainingPercent !== undefined && reading.kind === 'ratio' ? reading.value : undefined,
    remainingPercent,
    showBar: remainingPercent !== undefined,
    exhausted,
    unknown: false,
  };
}

const ZH_METER_LABEL_MAP: Record<string, string> = {
  'remaining balance': '剩余余额',
  'prepaid credits': '预付额度',
  'balance': '账户余额',
  'credits': '积分余额',
  'weekly cap': '每周上限',
  'requests': '请求限额',
  'rolling tokens': '滚动 Tokens',
};

/** Normalize common English vendor meter labels cleanly in zh while preserving raw labels in tooltips. */
export function normalizeMeterLabel(label: string, locale: Locale): { readonly display: string; readonly rawTitle?: string } {
  if (locale !== 'zh') return { display: label };
  const mapped = ZH_METER_LABEL_MAP[label.trim().toLowerCase()];
  if (mapped === undefined) return { display: label };
  return { display: mapped, rawTitle: label };
}

export function resolveReadingPoolLabel(reading: HarnessQuotaReading, defaultPoolLabel: string): string {
  const models = reading.modelIds ?? [];
  const singleModelAsLabel = reading.pool === undefined && models.length === 1;
  return reading.pool ?? (singleModelAsLabel ? models[0]! : defaultPoolLabel);
}

export function readingPoolKey(reading: HarnessQuotaReading, defaultPoolLabel: string): string {
  return `${resolveReadingPoolLabel(reading, defaultPoolLabel)}::${reading.window ?? ''}`;
}

export interface FleetPoolBottleneckItem {
  readonly key: string;
  readonly label: string;
  readonly window?: string;
  readonly durationSeconds?: number;
  readonly tightestPercent?: number;
  readonly tightestResetAt?: string;
  readonly tightestResetShort?: string;
  readonly fallbackValue?: string;
  readonly usableSeatCount: number;
  readonly knownSeatCount: number;
  readonly unknownSeatCount: number;
  readonly totalSeatCount: number;
  readonly allExhausted: boolean;
}

export interface FleetHealthSummary {
  readonly readySeats: number;
  readonly unknownSeats: number;
  readonly totalSeats: number;
  readonly pools: readonly FleetPoolBottleneckItem[];
  readonly poolByKey: ReadonlyMap<string, FleetPoolBottleneckItem>;
}

export type SeatHealthState =
  | 'ready'
  | 'low'
  | 'skipped_exhausted'
  | 'blocking_exhausted'
  | 'partial_unknown'
  | 'unknown';

/**
 * Single seat health classification shared by fleet rollups and matrix seat dots.
 * A seat is only `ready` when it has at least one reading and every window is known and non-exhausted.
 */
export function classifySeatHealth(
  readings: readonly HarnessQuotaReading[],
  poolByKey: ReadonlyMap<string, FleetPoolBottleneckItem>,
  defaultPoolLabel: string,
): SeatHealthState {
  let hasKnown = false;
  let hasUnknown = false;
  let anyBlockingExhausted = false;
  let anySkippedExhausted = false;
  let anyLow = false;

  for (const reading of readings) {
    const val = formatHarnessQuotaReading(reading);
    if (val.kind === 'unknown') {
      hasUnknown = true;
      continue;
    }
    hasKnown = true;
    if (val.exhausted) {
      const pool = poolByKey.get(readingPoolKey(reading, defaultPoolLabel));
      if (pool !== undefined && pool.usableSeatCount > 0) anySkippedExhausted = true;
      else anyBlockingExhausted = true;
    } else if (val.remainingPercent !== undefined && val.remainingPercent < 30) {
      anyLow = true;
    }
  }

  if (!hasKnown) return 'unknown';
  if (anyBlockingExhausted) return 'blocking_exhausted';
  if (anyLow) return 'low';
  if (anySkippedExhausted) return 'skipped_exhausted';
  if (hasUnknown) return 'partial_unknown';
  return 'ready';
}

export function hasAnyExhaustedPool(readings: readonly HarnessQuotaReading[]): boolean {
  for (const reading of readings) {
    const val = formatHarnessQuotaReading(reading);
    if (val.kind === 'known' && val.exhausted) return true;
  }
  return false;
}

/**
 * Bottleneck-first fleet aggregation (never averages remaining % across seats).
 * Reports usable seats (ready/total) and, per pool+window, the tightest usable seat's
 * remaining % paired with THAT SAME window's reset timestamp.
 */
export function summarizePoolHealth(
  accountGroups: readonly HarnessQuotaAccountGroup[],
  defaultPoolLabel: string,
  nowMs: number = Date.now(),
): FleetHealthSummary {
  const map = new Map<string, {
    label: string;
    window?: string;
    usableMinPct: number;
    usableResetAt?: string;
    anyKnownExhausted: boolean;
    anyPositivePct: boolean;
    anyPositiveNonPct: boolean;
    exhaustedResetAt?: string;
    exhaustedResetMs: number;
    usableSeatCount: number;
    knownSeatCount: number;
    unknownSeatCount: number;
    totalSeatCount: number;
    fallbackValue?: string;
  }>();

  for (const group of accountGroups) {
    for (const reading of group.readings) {
      const label = resolveReadingPoolLabel(reading, defaultPoolLabel);
      const key = `${label}::${reading.window ?? ''}`;
      let entry = map.get(key);
      if (entry === undefined) {
        entry = {
          label,
          window: reading.window,
          usableMinPct: Number.POSITIVE_INFINITY,
          anyKnownExhausted: false,
          anyPositivePct: false,
          anyPositiveNonPct: false,
          exhaustedResetMs: Number.POSITIVE_INFINITY,
          usableSeatCount: 0,
          knownSeatCount: 0,
          unknownSeatCount: 0,
          totalSeatCount: 0,
        };
        map.set(key, entry);
      }
      entry.totalSeatCount += 1;
      const val = formatHarnessQuotaReading(reading);
      if (val.kind === 'known') {
        entry.knownSeatCount += 1;
        if (val.remainingPercent !== undefined) {
          if (val.remainingPercent > 0) {
            entry.anyPositivePct = true;
            entry.usableSeatCount += 1;
            if (val.remainingPercent < entry.usableMinPct) {
              entry.usableMinPct = val.remainingPercent;
              entry.usableResetAt = reading.resetAt;
            }
          } else {
            entry.anyKnownExhausted = true;
            if (reading.resetAt) {
              const ms = Date.parse(reading.resetAt);
              if (Number.isFinite(ms) && ms > nowMs && ms < entry.exhaustedResetMs) {
                entry.exhaustedResetMs = ms;
                entry.exhaustedResetAt = reading.resetAt;
              }
            }
          }
        } else {
          if (val.exhausted) {
            entry.anyKnownExhausted = true;
          } else {
            entry.anyPositiveNonPct = true;
            entry.usableSeatCount += 1;
          }
          if (entry.fallbackValue === undefined) entry.fallbackValue = val.value;
        }
      } else {
        entry.unknownSeatCount += 1;
      }
    }
  }

  const pools: FleetPoolBottleneckItem[] = [...map.entries()].map(([key, item]) => {
    const allExhausted =
      item.totalSeatCount > 0 &&
      item.knownSeatCount === item.totalSeatCount &&
      item.anyKnownExhausted &&
      !item.anyPositivePct &&
      !item.anyPositiveNonPct;
    const tightestPercent = item.anyPositivePct
      ? Math.round(item.usableMinPct)
      : allExhausted
        ? 0
        : undefined;
    const tightestResetAt = item.anyPositivePct ? item.usableResetAt : item.exhaustedResetAt;
    return {
      key,
      label: item.label,
      window: item.window,
      durationSeconds: parseWindowDurationSeconds(item.window),
      tightestPercent,
      tightestResetAt,
      tightestResetShort: formatQuotaResetShort(tightestResetAt, nowMs),
      fallbackValue: item.fallbackValue,
      usableSeatCount: item.usableSeatCount,
      knownSeatCount: item.knownSeatCount,
      unknownSeatCount: item.unknownSeatCount,
      totalSeatCount: item.totalSeatCount,
      allExhausted,
    };
  });

  const poolByKey = new Map<string, FleetPoolBottleneckItem>(pools.map((pool) => [pool.key, pool]));

  let readySeats = 0;
  let unknownSeats = 0;
  for (const group of accountGroups) {
    const state = classifySeatHealth(group.readings, poolByKey, defaultPoolLabel);
    if (state === 'ready' || state === 'low') {
      readySeats += 1;
    } else if (state === 'unknown' || state === 'partial_unknown') {
      unknownSeats += 1;
    }
  }

  return {
    readySeats,
    unknownSeats,
    totalSeats: accountGroups.length,
    pools,
    poolByKey,
  };
}

/**
 * Split a seat identity like "Seat 01 · alpha@example.test" into 2 clean stacked lines,
 * dropping redundant slugs like "seat-01" when already represented in primary.
 */
export function splitSeatIdentity(
  accountLabel: string,
  accountId: string,
  showAccountId: boolean,
): { readonly primary: string; readonly secondary?: string } {
  const parts = accountLabel.split(/\s*[·|]\s*/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      primary: parts[0]!,
      secondary: parts.slice(1).join(' · '),
    };
  }
  const normalizedLabel = accountLabel.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  const normalizedId = accountId.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  const secondary = showAccountId && normalizedId !== normalizedLabel ? accountId : undefined;
  return {
    primary: accountLabel,
    secondary,
  };
}
