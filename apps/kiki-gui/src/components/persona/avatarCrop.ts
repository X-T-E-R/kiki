/**
 * Avatar crop math, independent of the box it is drawn in.
 *
 * A crop is a square window onto the source image: its centre in source
 * pixels plus a zoom, where zoom 1 is the largest square that fits (the short
 * side). The window never leaves the image, so the frame is always covered —
 * there is no letterboxing to explain. The saved file is always that square;
 * circle or square is how the face is framed, not a second crop.
 */

export interface AvatarCrop {
  readonly cx: number;
  readonly cy: number;
  readonly zoom: number;
}

export interface SourceRect {
  readonly sx: number;
  readonly sy: number;
  readonly size: number;
}

export const AVATAR_MIN_ZOOM = 1;
export const AVATAR_MAX_ZOOM = 4;
/** Edge of the uploaded square; the server keeps at most 256 px anyway. */
export const AVATAR_OUTPUT_SIZE = 256;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Centred, zoomed all the way out. */
export function initialCrop(width: number, height: number): AvatarCrop {
  return { cx: width / 2, cy: height / 2, zoom: AVATAR_MIN_ZOOM };
}

/** The source square a crop selects, kept inside the image. */
export function sourceRect(crop: AvatarCrop, width: number, height: number): SourceRect {
  const size = Math.min(width, height) / clamp(crop.zoom, AVATAR_MIN_ZOOM, AVATAR_MAX_ZOOM);
  return {
    sx: clamp(crop.cx - size / 2, 0, width - size),
    sy: clamp(crop.cy - size / 2, 0, height - size),
    size,
  };
}

/** Pull a crop back inside the image (after a drag or a zoom-out). */
export function clampCrop(crop: AvatarCrop, width: number, height: number): AvatarCrop {
  const zoom = clamp(crop.zoom, AVATAR_MIN_ZOOM, AVATAR_MAX_ZOOM);
  const rect = sourceRect({ ...crop, zoom }, width, height);
  return { cx: rect.sx + rect.size / 2, cy: rect.sy + rect.size / 2, zoom };
}

/** Move by a drag of (dx, dy) screen pixels in a frame `box` pixels wide. */
export function panCrop(crop: AvatarCrop, dx: number, dy: number, box: number, width: number, height: number): AvatarCrop {
  const { size } = sourceRect(crop, width, height);
  const perPixel = size / box;
  return clampCrop({ ...crop, cx: crop.cx - dx * perPixel, cy: crop.cy - dy * perPixel }, width, height);
}

/** Change zoom around the window's centre, so what is in the middle stays there. */
export function zoomCrop(crop: AvatarCrop, zoom: number, width: number, height: number): AvatarCrop {
  const rect = sourceRect(crop, width, height);
  return clampCrop({ cx: rect.sx + rect.size / 2, cy: rect.sy + rect.size / 2, zoom }, width, height);
}

/**
 * How to place the whole image inside a `box`-pixel frame so the crop's
 * window fills it: the image's drawn size and its offset from the frame's
 * top-left corner (negative = shifted up/left).
 */
export function cropLayout(crop: AvatarCrop, width: number, height: number, box: number) {
  const rect = sourceRect(crop, width, height);
  const scale = box / rect.size;
  return { width: width * scale, height: height * scale, left: -rect.sx * scale, top: -rect.sy * scale };
}
