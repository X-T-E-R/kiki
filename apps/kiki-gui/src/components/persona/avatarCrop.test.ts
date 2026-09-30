import { describe, expect, it } from 'vitest';

import { AVATAR_MAX_ZOOM, clampCrop, cropLayout, initialCrop, panCrop, sourceRect, zoomCrop } from './avatarCrop';

describe('avatar crop', () => {
  it('starts on the centred short-side square', () => {
    expect(sourceRect(initialCrop(400, 200), 400, 200)).toEqual({ sx: 100, sy: 0, size: 200 });
    expect(sourceRect(initialCrop(300, 600), 300, 600)).toEqual({ sx: 0, sy: 150, size: 300 });
  });

  it('never lets the window leave the image', () => {
    const crop = panCrop(initialCrop(400, 200), 10_000, -10_000, 200, 400, 200);
    expect(sourceRect(crop, 400, 200)).toEqual({ sx: 0, sy: 0, size: 200 });
    expect(clampCrop({ cx: 1e6, cy: 1e6, zoom: 99 }, 400, 200).zoom).toBe(AVATAR_MAX_ZOOM);
  });

  it('pans in source pixels scaled to the frame', () => {
    // 200 px window drawn in a 100 px frame: one screen pixel = two source pixels.
    const crop = panCrop(initialCrop(400, 200), 10, 0, 100, 400, 200);
    expect(sourceRect(crop, 400, 200).sx).toBe(80);
  });

  it('zooms around the middle and pulls back in when zooming out at an edge', () => {
    const zoomed = zoomCrop(initialCrop(400, 400), 2, 400, 400);
    expect(sourceRect(zoomed, 400, 400)).toEqual({ sx: 100, sy: 100, size: 200 });
    const corner = panCrop(zoomed, 10_000, 10_000, 100, 400, 400);
    expect(sourceRect(zoomCrop(corner, 1, 400, 400), 400, 400)).toEqual({ sx: 0, sy: 0, size: 400 });
  });

  it('lays the image out so the window fills the frame', () => {
    expect(cropLayout(initialCrop(400, 200), 400, 200, 100)).toEqual({ width: 200, height: 100, left: -50, top: -0 });
  });
});
