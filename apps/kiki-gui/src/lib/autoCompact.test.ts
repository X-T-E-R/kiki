import { describe, expect, it } from 'vitest';

import {
  CONTEXT_WINDOW_PRESETS,
  autoCompactBounds,
  clampCompactTokens,
  formatPresetTokens,
  compactInputTokens,
  compactPresetsFor,
  compactUsageLevel,
  formatCompactTokens,
  legacyCompactDefault,
  parseCompactInput,
  shortPercent,
  snapCompactTokens,
} from './autoCompact';

const status = (usable: number, reserved = 50_000) => ({
  tokens: 400_000,
  source: 'session' as const,
  effectiveMaxContextTokens: usable,
  reservedContextTokens: reserved,
});

describe('parseCompactInput', () => {
  it('reads k / m / bare / comma / percent forms', () => {
    expect(parseCompactInput('400k')).toEqual({ kind: 'tokens', tokens: 400_000 });
    expect(parseCompactInput(' 467.5K ')).toEqual({ kind: 'tokens', tokens: 467_500 });
    expect(parseCompactInput('0.4m')).toEqual({ kind: 'tokens', tokens: 400_000 });
    expect(parseCompactInput('400,000')).toEqual({ kind: 'tokens', tokens: 400_000 });
    expect(parseCompactInput('73%')).toEqual({ kind: 'percent', percent: 73 });
  });

  it('rejects empty, zero, negative and out-of-range input', () => {
    for (const raw of ['', 'abc', '0', '-5k', '0%', '120%', '4 0 0 k x']) {
      expect(parseCompactInput(raw).kind).toBe('invalid');
    }
  });

  it('converts a percentage against the usable window only', () => {
    expect(compactInputTokens(parseCompactInput('73%'), 550_000)).toBe(401_500);
    expect(compactInputTokens(parseCompactInput('73%'), 0)).toBeNull();
    expect(compactInputTokens(parseCompactInput('400k'), 0)).toBe(400_000);
  });
});

describe('bounds and clamping', () => {
  it('mirrors the engine: ceil = U − R, floor = max(64k, roundUp8k(B + 32k))', () => {
    expect(autoCompactBounds(status(550_000))).toEqual({ floor: 64_000, ceil: 500_000, locked: false });
    expect(autoCompactBounds(status(550_000), 50_000).floor).toBe(88_000);
  });

  it('locks a window too small to move the point', () => {
    expect(autoCompactBounds(status(96_000)).locked).toBe(true);
  });

  it('clamps and names the edge it clamped to', () => {
    const bounds = autoCompactBounds(status(550_000));
    expect(clampCompactTokens(600_000, bounds)).toEqual({ tokens: 500_000, clamped: 'ceil' });
    expect(clampCompactTokens(10_000, bounds)).toEqual({ tokens: 64_000, clamped: 'floor' });
    expect(clampCompactTokens(300_000, bounds)).toEqual({ tokens: 300_000 });
    expect(snapCompactTokens(401_500, bounds)).toBe(400_000);
  });
});

describe('presets', () => {
  it('adapts ~50/65/80% of the usable window, rounded to a readable step', () => {
    expect(compactPresetsFor(1_000_000, 950_000)).toEqual([500_000, 650_000, 800_000]);
    expect(compactPresetsFor(200_000, 150_000)).toEqual([100_000, 125_000, 150_000]);
    expect(compactPresetsFor(550_000, 500_000)).toEqual([250_000, 350_000, 400_000]);
    expect(compactPresetsFor(262_144, 212_144, 64_000)).toEqual([125_000, 150_000, 200_000]);
    // A small window keeps only what fits between the floor and limit − reserve.
    expect(compactPresetsFor(128_000, 78_000, 64_000)).toEqual([64_000]);
  });

  it('never offers a value above the ceiling or below the floor', () => {
    for (const usable of [96_000, 128_000, 200_000, 262_144, 400_000, 550_000, 1_048_576]) {
      const ceil = usable - 50_000;
      for (const value of compactPresetsFor(usable, ceil, 64_000)) {
        expect(value).toBeLessThanOrEqual(ceil);
        expect(value).toBeGreaterThanOrEqual(64_000);
      }
    }
    expect(compactPresetsFor(96_000, 46_000, 46_000)).toEqual([]);
  });
});

describe('display helpers', () => {
  it('formats compact token labels', () => {
    expect(formatCompactTokens(467_500)).toBe('467.5k');
    expect(formatCompactTokens(400_000)).toBe('400k');
    expect(formatCompactTokens(1_048_576)).toBe('1.05M');
    expect(formatCompactTokens(1_000_000)).toBe('1M');
    expect(shortPercent('72.72727273%')).toBe('72.7%');
    expect(shortPercent('85%')).toBe('85%');
    expect(formatPresetTokens(262_144)).toBe('256k');
    expect(CONTEXT_WINDOW_PRESETS).not.toContain(600_000);
  });

  it('colours the ring against the compaction point', () => {
    expect(compactUsageLevel(300_000, 400_000)).toBe('ok');
    expect(compactUsageLevel(320_000, 400_000)).toBe('warn');
    expect(compactUsageLevel(400_000, 400_000)).toBe('danger');
  });

  it('keeps the legacy default formula', () => {
    expect(legacyCompactDefault(550_000)).toBe(467_500);
    expect(legacyCompactDefault(200_000)).toBe(150_000);
    expect(legacyCompactDefault(1_000_000)).toBe(850_000);
  });
});
