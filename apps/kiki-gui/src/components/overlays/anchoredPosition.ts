/**
 * Viewport placement for a surface anchored to a trigger: the same rules the
 * SearchableSelect panel follows, as one pure function so every anchored
 * surface (popovers, row menus, pickers) flips and shifts the same way.
 *
 * - `side` is the preferred side. It flips to the other side only when the
 *   other side has more room and the preferred one cannot hold the surface.
 * - `align` hangs the surface from the trigger's start or end edge, then the
 *   result is shifted back inside the viewport margin.
 * - The returned `maxHeight` is the room actually there, so a surface near an
 *   edge scrolls inside itself instead of leaving the screen.
 */

export interface AnchorRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

export interface AnchoredPlacement {
  readonly left: number;
  readonly top: number;
  readonly side: 'below' | 'above';
  readonly maxHeight: number;
}

export const ANCHOR_GAP = 6;
export const VIEWPORT_MARGIN = 8;

export function placeAnchored(
  anchor: AnchorRect,
  surface: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  options: { readonly side?: 'below' | 'above'; readonly align?: 'start' | 'end'; readonly gap?: number } = {},
): AnchoredPlacement {
  const { side = 'below', align = 'start', gap = ANCHOR_GAP } = options;
  const width = Math.min(surface.width, viewport.width - VIEWPORT_MARGIN * 2);
  const preferredLeft = align === 'end' ? anchor.right - width : anchor.left;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, viewport.width - width - VIEWPORT_MARGIN));
  const roomBelow = viewport.height - anchor.bottom - gap - VIEWPORT_MARGIN;
  const roomAbove = anchor.top - gap - VIEWPORT_MARGIN;
  const fitsPreferred = (side === 'below' ? roomBelow : roomAbove) >= surface.height;
  const placed: 'below' | 'above' = fitsPreferred ? side
    : side === 'below' ? (roomAbove > roomBelow ? 'above' : 'below')
    : (roomBelow > roomAbove ? 'below' : 'above');
  const room = Math.max(0, placed === 'below' ? roomBelow : roomAbove);
  const height = Math.min(surface.height, room);
  const top = placed === 'below' ? anchor.bottom + gap : anchor.top - gap - height;
  return { left, top, side: placed, maxHeight: room };
}
