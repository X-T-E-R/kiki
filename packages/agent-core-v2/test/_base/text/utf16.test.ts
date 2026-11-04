import { describe, expect, it } from 'vitest';
import { sliceUtf16 } from '#/_base/text/utf16';

describe('sliceUtf16', () => {
  it('moves prefix and suffix boundaries inward without exceeding their caps', () => {
    for (const text of ['a🛰️z', '🛰️'.repeat(8), 'a𐀀b\uDBFF\uDFFFc', 'plain 文本']) {
      for (let size = 0; size <= text.length + 1; size++) {
        const prefix = sliceUtf16(text, 0, size);
        const suffix = sliceUtf16(text, text.length - Math.min(size, text.length));
        expect(prefix.isWellFormed()).toBe(true);
        expect(suffix.isWellFormed()).toBe(true);
        expect(prefix.length).toBeLessThanOrEqual(size);
        expect(suffix.length).toBeLessThanOrEqual(size);
        expect(text.startsWith(prefix)).toBe(true);
        expect(text.endsWith(suffix)).toBe(true);
      }
    }
    expect(sliceUtf16('a🛰z', 0, 2)).toBe('a');
    expect(sliceUtf16('a🛰z', -2)).toBe('z');
    expect(sliceUtf16('a🛰z', 2, 3)).toBe('');
  });

  it('preserves String.slice index semantics at complete code-point boundaries', () => {
    const text = 'abcdef';
    const indices = [-Infinity, -20, -2.9, -1, -0, 0, 1.9, 5, 20, Infinity, NaN];
    for (const start of indices) {
      expect(sliceUtf16(text, start)).toBe(text.slice(start));
      for (const end of indices) {
        expect(sliceUtf16(text, start, end)).toBe(text.slice(start, end));
      }
    }
    expect(sliceUtf16('a🛰z')).toBe('a🛰z');
    expect(sliceUtf16('a🛰z', 1, 3)).toBe('🛰');
    expect(sliceUtf16('')).toBe('');
  });
});
