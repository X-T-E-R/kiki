import { describe, expect, it } from 'vitest';
import type { ProviderQuotaMeter } from '@kiki/protocol';
import type { HarnessQuotaAccountGroup } from '../../../lib/providerQuota';
import {
  classifySeatHealth,
  computeRemainingPace,
  meterPrimaryReading,
  normalizeMeterLabel,
  parseWindowDurationSeconds,
  partitionPoolWindows,
  quotaPercentToAngleDeg,
  splitSeatIdentity,
  summarizePoolHealth,
} from './quotaModel';

function meter(patch: Partial<ProviderQuotaMeter> = {}): ProviderQuotaMeter {
  return {
    id: 'm1',
    label: 'Balance',
    unit: 'money',
    unit_label: 'USD',
    currency: 'USD',
    used: null,
    limit: null,
    remaining: null,
    scope: 'account',
    ...patch,
  };
}

describe('quotaModel', () => {
  it('parses window duration labels and respects explicit duration_seconds', () => {
    expect(parseWindowDurationSeconds('5h')).toBe(18_000);
    expect(parseWindowDurationSeconds('7d')).toBe(604_800);
    expect(parseWindowDurationSeconds('1m')).toBe(60);
    expect(parseWindowDurationSeconds('5h', 7_200)).toBe(7_200);
    expect(parseWindowDurationSeconds('custom')).toBeUndefined();
  });

  it('computes remaining-fuel pace with CodexBar-style early-window suppression', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const duration = 18_000; // 5h

    // 1% elapsed (<3% threshold for <24h windows) -> suppressed
    const earlyReset = now + (duration * 0.99) * 1000;
    expect(computeRemainingPace({ remainingPercent: 80, durationSeconds: duration, resetAtMs: earlyReset, nowMs: now })).toBeNull();

    // 50% elapsed (expected remaining = 50%), actual 52% -> on_track
    const halfReset = now + (duration * 0.5) * 1000;
    const onTrack = computeRemainingPace({ remainingPercent: 52, durationSeconds: duration, resetAtMs: halfReset, nowMs: now });
    expect(onTrack?.state).toBe('on_track');
    expect(onTrack?.expectedRemainingPct).toBeCloseTo(50, 1);

    // 25% elapsed (expected remaining = 75%), actual 66% (deficit = 9, eta > remainingWindow? used 34% in 1.25h => ~27.2%/h => eta=2.4h < 3.75h -> fast because deficit 9 < 10)
    const quarterReset = now + (duration * 0.75) * 1000;
    const fast = computeRemainingPace({ remainingPercent: 66, durationSeconds: duration, resetAtMs: quarterReset, nowMs: now });
    expect(fast?.state).toBe('fast');

    // 50% elapsed (expected remaining = 50%), actual 14% -> depleting before reset
    const depleting = computeRemainingPace({ remainingPercent: 14, durationSeconds: duration, resetAtMs: halfReset, nowMs: now });
    expect(depleting?.state).toBe('depleting');
    expect(depleting?.willExhaustBeforeReset).toBe(true);
    expect(depleting?.etaSeconds).not.toBeNull();

    // 0% remaining (already exhausted) -> state 'exhausted', never 'depleting' with bogus ETA
    const exhausted = computeRemainingPace({ remainingPercent: 0, durationSeconds: 604_800, resetAtMs: now + 100_800_000, nowMs: now });
    expect(exhausted?.state).toBe('exhausted');
    expect(exhausted?.willExhaustBeforeReset).toBe(false);
    expect(exhausted?.etaSeconds).toBeNull();

    // 100% remaining (0% used) -> on_track with no depletion warning
    const unused = computeRemainingPace({ remainingPercent: 100, durationSeconds: 604_800, resetAtMs: now + 100_800_000, nowMs: now });
    expect(unused?.state).toBe('on_track');
    expect(unused?.willExhaustBeforeReset).toBe(false);
    expect(unused?.etaSeconds).toBeNull();
  });

  it('formats money/credits amount-first and hides bars on pure balances without limits', () => {
    const pureBalance = meterPrimaryReading(meter({ unit: 'money', currency: 'CNY', remaining: 82.4, limit: null }), 'Unknown');
    expect(pureBalance.showBar).toBe(false);
    expect(pureBalance.primaryText).toBe('82.40 CNY');

    const cappedBalance = meterPrimaryReading(meter({ unit: 'money', currency: 'USD', remaining: 4.1, limit: 5, used: 0.9 }), 'Unknown');
    expect(cappedBalance.showBar).toBe(true);
    expect(cappedBalance.primaryText).toBe('$4.10 / $5.00');
    expect(cappedBalance.secondaryText).toBe('82%');

    const pctMeter = meterPrimaryReading(meter({ unit: 'percent', unit_label: '%', currency: undefined, remaining: 62, limit: 100 }), 'Unknown');
    expect(pctMeter.showBar).toBe(true);
    expect(pctMeter.primaryText).toBe('62%');
  });

  it('normalizes common English meter labels in zh while preserving raw label in title', () => {
    expect(normalizeMeterLabel('Remaining Balance', 'zh')).toEqual({ display: '剩余余额', rawTitle: 'Remaining Balance' });
    expect(normalizeMeterLabel('Prepaid Credits', 'zh')).toEqual({ display: '预付额度', rawTitle: 'Prepaid Credits' });
    expect(normalizeMeterLabel('Remaining Balance', 'en')).toEqual({ display: 'Remaining Balance' });
  });

  it('summarizes fleet pools by tightest usable window paired with its own reset (never avgPercent)', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const groups: HarnessQuotaAccountGroup[] = [
      {
        accountId: 'seat-01',
        accountLabel: 'Seat 01 · alpha@example.test',
        showAccountId: true,
        readings: [
          { accountId: 'seat-01', pool: 'Claude / GPT', window: '5h', remaining: 14, unit: 'percent', resetAt: '2026-11-24T14:00:00Z' },
        ],
      },
      {
        accountId: 'seat-02',
        accountLabel: 'Seat 02 · beta@example.test',
        showAccountId: true,
        readings: [
          { accountId: 'seat-02', pool: 'Claude / GPT', window: '5h', remaining: 0, unit: 'percent', resetAt: '2026-11-24T13:00:00Z' },
        ],
      },
      {
        accountId: 'seat-03',
        accountLabel: 'Seat 03 · gamma@example.test',
        showAccountId: true,
        readings: [
          { accountId: 'seat-03', pool: 'Claude / GPT', window: '5h', remaining: 88, unit: 'percent', resetAt: '2026-11-24T16:00:00Z' },
        ],
      },
    ];
    const summary = summarizePoolHealth(groups, 'Quota', now);
    expect(summary.readySeats).toBe(2);
    expect(summary.totalSeats).toBe(3);
    expect(summary.pools[0]?.tightestPercent).toBe(14);
    expect(summary.pools[0]?.tightestResetAt).toBe('2026-11-24T14:00:00Z');
    expect(summary.pools[0]?.allExhausted).toBe(false);
  });

  it('never counts unknown seats as ready and never marks mixed zero+unknown pools as allExhausted', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const groups: HarnessQuotaAccountGroup[] = [
      {
        accountId: 'seat-01',
        accountLabel: 'Seat 01',
        showAccountId: false,
        readings: [
          { accountId: 'seat-01', pool: 'Claude / GPT', window: '5h', remaining: 0, unit: 'percent', resetAt: '2026-11-24T13:00:00Z' },
        ],
      },
      {
        accountId: 'seat-02',
        accountLabel: 'Seat 02',
        showAccountId: false,
        readings: [
          { accountId: 'seat-02', pool: 'Claude / GPT', window: '5h', unit: 'percent' },
        ],
      },
    ];
    const summary = summarizePoolHealth(groups, 'Quota', now);
    expect(summary.readySeats).toBe(0);
    expect(summary.unknownSeats).toBe(1);
    expect(summary.totalSeats).toBe(2);
    expect(summary.pools[0]?.knownSeatCount).toBe(1);
    expect(summary.pools[0]?.unknownSeatCount).toBe(1);
    expect(summary.pools[0]?.usableSeatCount).toBe(0);
    expect(summary.pools[0]?.allExhausted).toBe(false);
    expect(summary.pools[0]?.tightestPercent).toBeUndefined();
  });

  it('marks a pool as allExhausted only when every seat is known and exhausted', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const groups: HarnessQuotaAccountGroup[] = [
      {
        accountId: 'seat-01',
        accountLabel: 'Seat 01',
        showAccountId: false,
        readings: [
          { accountId: 'seat-01', pool: 'Claude / GPT', window: '5h', remaining: 0, unit: 'percent', resetAt: '2026-11-24T13:00:00Z' },
        ],
      },
      {
        accountId: 'seat-02',
        accountLabel: 'Seat 02',
        showAccountId: false,
        readings: [
          { accountId: 'seat-02', pool: 'Claude / GPT', window: '5h', remaining: 0, unit: 'percent', resetAt: '2026-11-24T14:00:00Z' },
        ],
      },
    ];
    const summary = summarizePoolHealth(groups, 'Quota', now);
    expect(summary.readySeats).toBe(0);
    expect(summary.unknownSeats).toBe(0);
    expect(summary.pools[0]?.allExhausted).toBe(true);
    expect(summary.pools[0]?.tightestPercent).toBe(0);
    expect(summary.pools[0]?.tightestResetAt).toBe('2026-11-24T13:00:00Z');
  });

  it('does not classify a mixed known+unknown seat as ready or green across rollup and matrix', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const groups: HarnessQuotaAccountGroup[] = [
      {
        accountId: 'seat-mixed',
        accountLabel: 'Seat Mixed',
        showAccountId: false,
        readings: [
          { accountId: 'seat-mixed', pool: 'Gemini 4', window: '5h', remaining: 84, unit: 'percent', resetAt: '2026-11-24T15:00:00Z' },
          { accountId: 'seat-mixed', pool: 'Claude / GPT', window: '5h', unit: 'percent' },
        ],
      },
    ];
    const summary = summarizePoolHealth(groups, 'Quota', now);
    expect(summary.readySeats).toBe(0);
    expect(summary.unknownSeats).toBe(1);
    expect(classifySeatHealth(groups[0]!.readings, summary.poolByKey, 'Quota')).toBe('partial_unknown');
  });

  it('splits seat identity into two clean lines without repeating redundant slug', () => {
    expect(splitSeatIdentity('Seat 01 · alpha@example.test', 'seat-01', true)).toEqual({
      primary: 'Seat 01',
      secondary: 'alpha@example.test',
    });
    expect(splitSeatIdentity('Seat 01', 'seat-01', true)).toEqual({
      primary: 'Seat 01',
      secondary: undefined,
    });
    expect(splitSeatIdentity('Work', 'work@example.test', true)).toEqual({
      primary: 'Work',
      secondary: 'work@example.test',
    });
  });

  it('classifies a low + unknown seat as partial_unknown and increments unknownSeats instead of readySeats', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const groups: HarnessQuotaAccountGroup[] = [
      {
        accountId: 'seat-low-unknown',
        accountLabel: 'Seat Low Unknown',
        showAccountId: false,
        readings: [
          { accountId: 'seat-low-unknown', pool: 'Claude / GPT', window: '5h', remaining: 14, unit: 'percent', resetAt: '2026-11-24T14:00:00Z' },
          { accountId: 'seat-low-unknown', pool: 'Weekly Cap', window: '7d', unit: 'percent' },
        ],
      },
    ];
    const summary = summarizePoolHealth(groups, 'Quota', now);
    expect(classifySeatHealth(groups[0]!.readings, summary.poolByKey, 'Quota')).toBe('partial_unknown');
    expect(summary.readySeats).toBe(0);
    expect(summary.unknownSeats).toBe(1);
  });

  it('maps 240deg calibration angles monotonically from 150deg (0%) to 390deg (100%)', () => {
    expect(quotaPercentToAngleDeg(0)).toBe(150);
    expect(quotaPercentToAngleDeg(25)).toBe(210);
    expect(quotaPercentToAngleDeg(50)).toBe(270);
    expect(quotaPercentToAngleDeg(75)).toBe(330);
    expect(quotaPercentToAngleDeg(100)).toBe(390);
  });

  it('partitions multi-window harness pools into tightest short outer arc, longer cap inner arc, and visible sibling windows', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const groups: HarnessQuotaAccountGroup[] = [
      {
        accountId: 'seat-01',
        accountLabel: 'Seat 01',
        showAccountId: false,
        readings: [
          { accountId: 'seat-01', pool: 'Gemini 4', window: '5h', remaining: 71, unit: 'percent', resetAt: '2026-11-24T15:00:00Z' },
          { accountId: 'seat-01', pool: 'Claude / GPT', window: '5h', remaining: 14, unit: 'percent', resetAt: '2026-11-24T14:00:00Z' },
          { accountId: 'seat-01', pool: 'Weekly Cap', window: '7d', remaining: 42, unit: 'percent', resetAt: '2026-11-27T12:00:00Z' },
        ],
      },
    ];
    const summary = summarizePoolHealth(groups, 'Quota', now);
    const partition = partitionPoolWindows(summary.pools, now);
    expect(partition).not.toBeNull();
    expect(partition!.outerWindow.pool.label).toBe('Claude / GPT');
    expect(partition!.outerWindow.remainingPercent).toBe(14);
    expect(partition!.innerWindow?.pool.label).toBe('Weekly Cap');
    expect(partition!.innerWindow?.remainingPercent).toBe(42);
    expect(partition!.worstWindow.pool.label).toBe('Claude / GPT');
    expect(partition!.siblingWindows.map((s) => `${s.pool.label}:${s.remainingPercent}`)).toEqual(['Gemini 4:71']);
  });

  it('keeps sub-1% fractional readings (0.4%) usable and non-exhausted across reading, seat, and pool summaries', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const groups: HarnessQuotaAccountGroup[] = [
      {
        accountId: 'seat-frac',
        accountLabel: 'Seat Frac',
        showAccountId: false,
        readings: [
          {
            accountId: 'seat-frac',
            pool: 'Claude / GPT',
            window: '5h',
            remaining: 0.4,
            unit: 'percent',
            resetAt: '2026-11-24T14:00:00Z',
          },
        ],
      },
    ];
    const summary = summarizePoolHealth(groups, 'Quota', now);
    expect(summary.readySeats).toBe(1);
    expect(summary.pools[0]?.usableSeatCount).toBe(1);
    expect(summary.pools[0]?.allExhausted).toBe(false);
    expect(summary.pools[0]?.tightestPercent).toBe(0.4);
    expect(classifySeatHealth(groups[0]!.readings, summary.poolByKey, 'Quota')).toBe('low');

    const moneyDisplay = meterPrimaryReading(
      {
        id: 'kimi-bal',
        label: 'Remaining balance',
        unit: 'money',
        unit_label: 'USD',
        currency: 'USD',
        used: 18.4,
        limit: 100,
        remaining: 81.6,
        scope: 'account',
      },
      'Unknown',
    );
    expect(moneyDisplay.remainingPercent).toBeCloseTo(81.6, 5);
    expect(moneyDisplay.secondaryText).toBe('82%');
  });

  it('identifies an exhausted 7d cap as worstWindow even when the 5h outerWindow is healthy', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const groups: HarnessQuotaAccountGroup[] = [
      {
        accountId: 'seat-01',
        accountLabel: 'Seat 01',
        showAccountId: false,
        readings: [
          { accountId: 'seat-01', pool: 'Burst', window: '5h', remaining: 78, unit: 'percent', resetAt: '2026-11-24T16:00:00Z' },
          { accountId: 'seat-01', pool: 'Weekly Cap', window: '7d', remaining: 0, unit: 'percent', resetAt: '2026-11-27T12:00:00Z' },
        ],
      },
    ];
    const summary = summarizePoolHealth(groups, 'Quota', now);
    const partition = partitionPoolWindows(summary.pools, now)!;
    expect(partition.outerWindow.pool.label).toBe('Burst');
    expect(partition.innerWindow?.pool.label).toBe('Weekly Cap');
    expect(partition.worstWindow.pool.label).toBe('Weekly Cap');
    expect(partition.worstWindow.remainingPercent).toBe(0);
    expect(partition.worstBucket).toBe(0);
  });

  it('hands off refresh slots directly so synchronous same-microtask arrivals never exceed concurrency 4 across scope gates', async () => {
    const { runInQuotaScopeRefreshSlot } = await import('./quotaModel');
    const flush = () => new Promise<void>((r) => { setTimeout(r, 0); });
    const scopeKey = 'test-scope-concurrency-4';
    let inFlight = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];

    const launch = () =>
      runInQuotaScopeRefreshSlot(scopeKey, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        inFlight -= 1;
      });

    // Fill 4 active slots + 1 queued waiter
    const p1 = launch();
    const p2 = launch();
    const p3 = launch();
    const p4 = launch();
    const p5 = launch();
    await flush();
    expect(inFlight).toBe(4);
    expect(resolvers).toHaveLength(4);

    // Release slot 1 and immediately enqueue p6 in the same synchronous turn
    resolvers.shift()!();
    const p6 = launch();
    await flush();
    expect(peak).toBe(4);
    expect(inFlight).toBe(4);

    // Drain remaining tasks
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await flush();
    }
    await Promise.all([p1, p2, p3, p4, p5, p6]);
    expect(peak).toBe(4);
    expect(inFlight).toBe(0);
  });
});
