import { describe, expect, it } from 'vitest';

import { clampOverlayPosition } from './overlayPosition';

const VIEWPORT = { width: 1000, height: 700 };
const MENU = { width: 176, height: 230 };

describe('clampOverlayPosition', () => {
  it('keeps a mid-viewport position untouched', () => {
    expect(clampOverlayPosition(300, 200, MENU, VIEWPORT)).toEqual({ left: 300, top: 200 });
  });

  it('pulls the menu up when it would overflow the bottom edge', () => {
    // 700 - 230 - 8 = 462
    expect(clampOverlayPosition(300, 690, MENU, VIEWPORT)).toEqual({ left: 300, top: 462 });
  });

  it('pulls the menu left when it would overflow the right edge', () => {
    // 1000 - 176 - 8 = 816
    expect(clampOverlayPosition(990, 200, MENU, VIEWPORT)).toEqual({ left: 816, top: 200 });
  });

  it('clamps to the margin when the cursor sits inside it', () => {
    expect(clampOverlayPosition(2, 1, MENU, VIEWPORT)).toEqual({ left: 8, top: 8 });
  });

  it('falls back to the margin when the overlay is taller than the viewport', () => {
    expect(
      clampOverlayPosition(300, 600, { width: 176, height: 900 }, VIEWPORT),
    ).toEqual({ left: 300, top: 8 });
  });
});
