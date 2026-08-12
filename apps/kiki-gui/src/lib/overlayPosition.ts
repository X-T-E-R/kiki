/**
 * Fixed-position overlay placement (context menus): clamp inside the viewport
 * with a small margin so a menu opened near an edge stays fully visible.
 */

export function clampOverlayPosition(
  x: number,
  y: number,
  overlay: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(x, viewport.width - overlay.width - margin)),
    top: Math.max(margin, Math.min(y, viewport.height - overlay.height - margin)),
  };
}
