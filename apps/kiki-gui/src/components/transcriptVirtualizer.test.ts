import { describe, expect, it } from 'vitest';

import { shouldCompensateRowResize, type RowResize } from './transcriptVirtualizer';

const base: RowResize = {
  itemStart: 0,
  itemSize: 120,
  firstMeasure: false,
  scrollOffset: 1000,
  distanceFromEnd: 500,
  endThreshold: 80,
};

describe('shouldCompensateRowResize', () => {
  it('keeps the bottom pinned while following the end, wherever the row is', () => {
    expect(shouldCompensateRowResize({ ...base, itemStart: 1200, distanceFromEnd: 40 })).toBe(true);
  });

  it('compensates a re-measured row that sits entirely above the viewport', () => {
    expect(shouldCompensateRowResize({ ...base, itemStart: 700, itemSize: 300 })).toBe(true);
  });

  it('does not drag the view for a row spanning the viewport top', () => {
    // A long answer streaming, or a block the reader just expanded.
    expect(shouldCompensateRowResize({ ...base, itemStart: 900, itemSize: 400 })).toBe(false);
  });

  it('does not move the view for rows below the viewport top', () => {
    expect(shouldCompensateRowResize({ ...base, itemStart: 1100 })).toBe(false);
  });

  it('corrects a first measurement whose estimated top was above the viewport', () => {
    expect(shouldCompensateRowResize({ ...base, itemStart: 950, firstMeasure: true })).toBe(true);
    expect(shouldCompensateRowResize({ ...base, itemStart: 1000, firstMeasure: true })).toBe(false);
  });
});
