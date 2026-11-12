/**
 * Interface zoom synchronization and CSS-zoom-safe viewport geometry.
 *
 * Desktop Tauri windows apply native WebView zoom (`host.setZoom(factor)`),
 * which scales CSS pixels, layout breakpoints, canvas and xterm uniformly with
 * zero CSS `zoom` side effects. Browser / headless web surfaces have no native
 * WebView handle, so they set `document.documentElement.style.zoom` instead.
 *
 * When CSS `zoom` is active on `<html>`, `getBoundingClientRect()`, `clientX/Y`
 * and `window.innerWidth/innerHeight` are reported in zoomed viewport pixels,
 * whereas `position: fixed` `left`/`top`/`width`/`maxHeight` inside `<html>`
 * are multiplied by the root CSS zoom factor again. Dividing viewport-space
 * measurements by `cssZoomFactor()` keeps portaled popovers, menus and quote
 * pills aligned to the exact pixel under CSS zoom while remaining a 1:1 no-op
 * at 100% and in Tauri native zoom.
 */

import {
  DEFAULT_UI_ZOOM,
  normalizeUiZoom,
  readSettings,
  stepUiZoom,
  subscribeSettings,
  writeSettings,
  type UiZoomPercent,
} from '@kiki/session-core/settings';

import type { HostAdapter } from '../host/host';

export interface UnzoomedRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

export const KIKI_ZOOM_CHANGE_EVENT = 'kiki:zoomchange';

export function applyCssRootZoom(zoomPercent: UiZoomPercent): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset['kikiZoom'] = String(zoomPercent);
  const next = zoomPercent === DEFAULT_UI_ZOOM ? '' : String(zoomPercent / 100);
  const changed = root.style.zoom !== next;
  root.style.zoom = next;
  if (changed && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(KIKI_ZOOM_CHANGE_EVENT));
  }
}

export function clearCssRootZoom(zoomPercent: UiZoomPercent): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset['kikiZoom'] = String(zoomPercent);
  const changed = root.style.zoom !== '';
  root.style.zoom = '';
  if (changed && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(KIKI_ZOOM_CHANGE_EVENT));
  }
}

/** Active CSS `zoom` multiplier on `<html>` (`1` when unset or native zoom is used). */
export function cssZoomFactor(): number {
  if (typeof document === 'undefined') return 1;
  const inline = Number.parseFloat(document.documentElement.style.zoom);
  if (Number.isFinite(inline) && inline > 0) return inline;
  return 1;
}

/** Viewport dimensions in the root fixed-positioning coordinate space. */
export function unzoomedViewport(): { readonly width: number; readonly height: number } {
  if (typeof window === 'undefined') return { width: 1024, height: 768 };
  const zoom = cssZoomFactor();
  if (zoom === 1) return { width: window.innerWidth, height: window.innerHeight };
  return { width: window.innerWidth / zoom, height: window.innerHeight / zoom };
}

/** Convert a `DOMRect`-like box into the root fixed-positioning coordinate space. */
export function unzoomedRect(rect: {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
}): UnzoomedRect {
  const zoom = cssZoomFactor();
  if (zoom === 1) {
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      x: rect.x ?? rect.left,
      y: rect.y ?? rect.top,
    };
  }
  return {
    top: rect.top / zoom,
    bottom: rect.bottom / zoom,
    left: rect.left / zoom,
    right: rect.right / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
    x: (rect.x ?? rect.left) / zoom,
    y: (rect.y ?? rect.top) / zoom,
  };
}

/** Convert a pointer `clientX` / `clientY` pair into the root fixed coordinate space. */
export function unzoomedPoint(x: number, y: number): { readonly x: number; readonly y: number } {
  const zoom = cssZoomFactor();
  return zoom === 1 ? { x, y } : { x: x / zoom, y: y / zoom };
}

/**
 * Keep interface zoom synchronized with `DesktopSettings.uiZoom` for the life
 * of the document. In Tauri desktop, native webview zoom is used and CSS root
 * zoom stays cleared so scaling is never doubled; if a host has no native zoom
 * (or rejects it), CSS root zoom applies cleanly.
 */
export function startZoomSync(host: Pick<HostAdapter, 'setZoom'>): () => void {
  let generation = 0;
  const sync = (): void => {
    const token = ++generation;
    const zoom = normalizeUiZoom(readSettings().uiZoom);
    if (host.setZoom === undefined) {
      applyCssRootZoom(zoom);
      return;
    }
    if (typeof document !== 'undefined') {
      document.documentElement.dataset['kikiZoom'] = String(zoom);
    }
    void host.setZoom(zoom / 100).then((applied) => {
      if (token !== generation) return;
      if (applied) clearCssRootZoom(zoom);
      else applyCssRootZoom(zoom);
    }, () => {
      if (token !== generation) return;
      applyCssRootZoom(zoom);
    });
  };
  sync();
  const unsubscribe = subscribeSettings(sync);
  return () => {
    generation += 1;
    unsubscribe();
  };
}

export type DesktopZoomShortcutAction = 'in' | 'out' | 'reset';

/**
 * Match standard desktop zoom chords (`Mod+=` / `Mod++`, `Mod+-` / `Mod+_`,
 * `Mod+0`, plus numpad `+`/`-`/`0`). Returns `null` when Alt is pressed or IME
 * composition is active.
 */
export function desktopZoomShortcut(event: {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}): DesktopZoomShortcutAction | null {
  if (event.isComposing === true || event.altKey) return null;
  if (!event.ctrlKey && !event.metaKey) return null;
  if (event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd') {
    return 'in';
  }
  if (event.key === '-' || event.key === '_' || event.code === 'Minus' || event.code === 'NumpadSubtract') {
    return 'out';
  }
  if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') {
    return 'reset';
  }
  return null;
}

/** Apply one desktop zoom action (`in`, `out`, `reset`) to `DesktopSettings.uiZoom`. */
export function applyUiZoomAction(action: DesktopZoomShortcutAction): UiZoomPercent {
  const current = readSettings().uiZoom;
  const next = action === 'reset'
    ? DEFAULT_UI_ZOOM
    : stepUiZoom(current, action === 'in' ? 1 : -1);
  if (next !== current) writeSettings({ uiZoom: next });
  return next;
}
