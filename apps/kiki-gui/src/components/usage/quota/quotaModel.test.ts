import { describe, expect, it } from 'vitest';
import type { ProviderQuotaMeter } from '@kiki/protocol';
import type { HarnessQuotaAccountGroup } from '../../../lib/providerQuota';
import {
  classifySeatHealth,
  computeRemainingPace,
  meterPrimaryReading,
  normalizeMeterLabel,
  parseWindowDurationSeconds,
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
});
