import { describe, expect, it } from 'vitest';

import { formatCostUsd, formatGrouped, formatTokensPerSecond } from './usage';

describe('formatCostUsd', () => {
  it('scales precision with magnitude', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(0.00432)).toBe('$0.0043');
    expect(formatCostUsd(0.4321)).toBe('$0.432');
    expect(formatCostUsd(12.345)).toBe('$12.35'); // rounds up from the third decimal
    expect(formatCostUsd(12.344)).toBe('$12.34');
  });

  it('groups thousands and keeps a carried cent in the integer part', () => {
    expect(formatCostUsd(1234.56)).toBe('$1,234.56');
    expect(formatCostUsd(999.999)).toBe('$1,000.00');
  });
});

describe('formatGrouped', () => {
  it('separates thousands without locale dependence', () => {
    expect(formatGrouped(0)).toBe('0');
    expect(formatGrouped(999)).toBe('999');
    expect(formatGrouped(12483201)).toBe('12,483,201');
  });
});

describe('formatTokensPerSecond', () => {
  it('keeps one decimal below ten and rounds larger rates', () => {
    expect(formatTokensPerSecond(3.26)).toBe('3.3');
    expect(formatTokensPerSecond(9.95)).toBe('10');
    expect(formatTokensPerSecond(19.6)).toBe('20');
    expect(formatTokensPerSecond(Number.NaN)).toBe('0');
  });
});
