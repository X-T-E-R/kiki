import { describe, expect, it } from 'vitest';

import { formatBytes } from './bytes';

describe('formatBytes', () => {
  it('formats SI units by default', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(12 * 1024)).toBe('12 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });

  it('formats IEC units when requested', () => {
    expect(formatBytes(512, { unit: 'iec' })).toBe('512 B');
    expect(formatBytes(512 * 1024, { unit: 'iec' })).toBe('512 KiB');
    expect(formatBytes(5 * 1024 * 1024, { unit: 'iec' })).toBe('5 MiB');
    expect(formatBytes(Math.round(1.5 * 1024 * 1024), { unit: 'iec' })).toBe('1.5 MiB');
  });

  it('returns empty string for negative or non-finite values', () => {
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('');
  });
});
