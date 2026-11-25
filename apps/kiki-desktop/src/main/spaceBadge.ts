import type { DesktopSpaceStatus } from '#/shared/types';

export const OVERLAY_SIZE = 32;
const SAMPLES = 4;
const BADGE_RGB: readonly [number, number, number] = [0xb3, 0x3a, 0x12];
const RING_RGB: readonly [number, number, number] = [0xff, 0xff, 0xff];

const GLYPHS: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
];

function circleCoverage(x: number, y: number, cx: number, cy: number, radius: number): number {
  let hits = 0;
  const r2 = radius * radius;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const px = x + (sx + 0.5) / SAMPLES - cx;
      const py = y + (sy + 0.5) / SAMPLES - cy;
      if (px * px + py * py <= r2) {
        hits += 1;
      }
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

function blendPixel(
  rgba: Uint8Array,
  offset: number,
  rgb: readonly [number, number, number],
  alpha: number,
): void {
  if (alpha <= 0) return;
  const dstA = rgba[offset + 3]! / 255;
  const outA = alpha + dstA * (1 - alpha);
  for (let ch = 0; ch < 3; ch += 1) {
    const src = rgb[ch]! / 255;
    const dst = rgba[offset + ch]! / 255;
    const value = (src * alpha + dst * dstA * (1 - alpha)) / outA;
    rgba[offset + ch] = Math.round(value * 255);
  }
  rgba[offset + 3] = Math.round(outA * 255);
}

function paintCircle(
  rgba: Uint8Array,
  cx: number,
  cy: number,
  radius: number,
  rgb: readonly [number, number, number],
): void {
  for (let y = 0; y < OVERLAY_SIZE; y += 1) {
    for (let x = 0; x < OVERLAY_SIZE; x += 1) {
      const cover = circleCoverage(x, y, cx, cy, radius);
      if (cover > 0) {
        blendPixel(rgba, (y * OVERLAY_SIZE + x) * 4, rgb, cover);
      }
    }
  }
}

function stampGlyph(
  rgba: Uint8Array,
  glyph: readonly [number, number, number, number, number, number, number],
  left: number,
  top: number,
  width: number,
): void {
  for (let row = 0; row < glyph.length; row += 1) {
    const bits = glyph[row]!;
    for (let col = 0; col < width; col += 1) {
      if ((bits & (1 << (4 - col))) !== 0) {
        const offset = ((top + row) * OVERLAY_SIZE + left + col) * 4;
        rgba[offset] = 255;
        rgba[offset + 1] = 255;
        rgba[offset + 2] = 255;
        rgba[offset + 3] = 255;
      }
    }
  }
}

/**
 * Renders the 32x32 4x4-supersampled RGBA pending-count overlay badge matching `space_badge.rs`.
 */
export function renderPendingBadgeRgba(pending: number): Uint8Array | null {
  const count = Math.max(0, Math.trunc(pending));
  if (count === 0) return null;
  const rgba = new Uint8Array(OVERLAY_SIZE * OVERLAY_SIZE * 4);
  const cx = 19.5;
  const cy = 12.5;
  paintCircle(rgba, cx, cy, 10.0, RING_RGB);
  paintCircle(rgba, cx, cy, 8.5, BADGE_RGB);
  if (count > 9) {
    stampGlyph(rgba, GLYPHS[9]!, 14, 9, 5);
    stampGlyph(rgba, GLYPHS[10]!, 20, 9, 5);
  } else {
    stampGlyph(rgba, GLYPHS[count]!, 17, 9, 5);
  }
  return rgba;
}

/**
 * Converts unpremultiplied RGBA to BGRA bitmap bytes expected by Electron's
 * `nativeImage.createFromBitmap` on little-endian platforms (Windows / macOS / Linux).
 */
export function rgbaToBgraBitmap(rgba: Uint8Array): Buffer {
  const bgra = Buffer.allocUnsafe(rgba.byteLength);
  for (let i = 0; i < rgba.byteLength; i += 4) {
    bgra[i] = rgba[i + 2]!;
    bgra[i + 1] = rgba[i + 1]!;
    bgra[i + 2] = rgba[i]!;
    bgra[i + 3] = rgba[i + 3]!;
  }
  return bgra;
}

export function combineSpaceAttentionTotal(options: {
  readonly scopeUnreadTotal: number;
  readonly scopeSessionIds: ReadonlySet<string>;
  readonly statuses: readonly DesktopSpaceStatus[];
}): number {
  const unionedIds = new Set(options.scopeSessionIds);
  let extraCount = 0;
  for (const status of options.statuses) {
    if (status.active || status.pendingCount <= 0) continue;
    if (status.needsYouSessionIds !== undefined && status.needsYouSessionIds.length > 0) {
      for (const id of status.needsYouSessionIds) {
        if (!unionedIds.has(id)) {
          unionedIds.add(id);
          extraCount += 1;
        }
      }
    } else {
      extraCount += status.pendingCount;
    }
  }
  return Math.max(0, options.scopeUnreadTotal + extraCount);
}
