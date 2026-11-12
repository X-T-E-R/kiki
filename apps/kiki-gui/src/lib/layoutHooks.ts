import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  DEFAULT_LAYOUT_PREFERENCES,
  layoutPreferencesSnapshot,
  subscribeLayoutPreferences,
  type LayoutPreferences,
} from '@kiki/session-core/settings';

import { cssZoomFactor, KIKI_ZOOM_CHANGE_EVENT } from './uiZoom';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => { setMatches(media.matches); };
    update();
    media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); };
  }, [query]);
  return matches;
}

export function useLayoutPreferences(): LayoutPreferences {
  const getSnapshot = useCallback(() => layoutPreferencesSnapshot(), []);
  const getServerSnapshot = useCallback(() => DEFAULT_LAYOUT_PREFERENCES, []);
  return useSyncExternalStore(subscribeLayoutPreferences, getSnapshot, getServerSnapshot);
}

/**
 * One-shot read of the same query `useCoarsePointer` tracks, for event
 * handlers and effects that only need the answer at the moment they run.
 */
export function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/** Touch-first devices (phones): IME Enter, hit targets and layer history follow the phone contract. */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}

/**
 * Phone mode: a touch screen that is also narrow. Touch alone (`useCoarsePointer`)
 * decides input behaviour — keyboard hints, hover-only controls, drag handles —
 * and width alone decides layout; this is the one name for "both", used where a
 * feature is left out, folded a level down or off by default on a phone. A
 * tablet, a phone held sideways, a touch laptop and a narrow desktop window
 * are all outside it. Keep in step with the `phone:` variant in index.css.
 */
export const PHONE_QUERY = '(pointer: coarse) and (max-width: 639px)';

/** One-shot `PHONE_QUERY`, for event handlers and effects. */
export function isPhoneMode(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/** Reactive `PHONE_QUERY`. */
export function usePhoneMode(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/**
 * Software-keyboard fallback. `interactive-widget=resizes-content` (see
 * index.html) lets Chromium shrink the layout viewport itself; elsewhere
 * (iOS Safari, embedded Android WebView under edge-to-edge WindowInsets) the
 * layout viewport may stay full-screen while `visualViewport` shrinks or shifts,
 * so this mirrors `visualViewport.height` into `--kiki-visual-height` and any
 * positive keyboard inset into `--kiki-ime-offset` on `:root`. CSS opts in per
 * surface with `height: var(--kiki-visual-height, 100%)` — where the API is
 * absent nothing is set and every rule keeps its 100% fallback.
 */
export function useVisualViewportHeightVar(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) return;
    const root = document.documentElement;
    const coarse = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
    let frame = 0;
    const write = () => {
      frame = 0;
      // A pinch-zoom shrinks the visual viewport exactly like a keyboard does.
      // It is not one: keep the last unzoomed measurements instead of laying
      // the whole app out into the zoomed-in window.
      if (viewport.scale > 1.01) return;
      const zoom = cssZoomFactor();
      const height = Math.max(0, Math.round(viewport.height / zoom));
      // On coarse pointers the app's height chain already follows
      // --kiki-visual-height (index.css), so the keyboard is accounted for
      // once there. Reporting it again as an inset would lift the composer a
      // second keyboard-height; the inset is for surfaces whose box still
      // spans the unshrunk layout viewport.
      const imeInset = coarse?.matches === true
        ? 0
        : Math.max(0, Math.round((window.innerHeight - viewport.height - viewport.offsetTop) / zoom));
      root.style.setProperty('--kiki-visual-height', `${height}px`);
      root.style.setProperty('--kiki-ime-offset', `${imeInset}px`);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(write);
    };
    write();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('orientationchange', schedule);
    window.addEventListener(KIKI_ZOOM_CHANGE_EVENT, schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.removeEventListener(KIKI_ZOOM_CHANGE_EVENT, schedule);
      root.style.removeProperty('--kiki-visual-height');
      root.style.removeProperty('--kiki-ime-offset');
    };
  }, []);
}

function setDragging(active: boolean) {
  document.body.dataset['paneResizing'] = active ? 'true' : 'false';
}

function clearDragging() {
  delete document.body.dataset['paneResizing'];
}

export function usePaneResize(options: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number, final: boolean) => void;
  onReset?: () => void;
  direction?: 1 | -1;
}) {
  const { value, min, max, onChange, onReset, direction = 1 } = options;

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startValue = value;
      handle.setPointerCapture(event.pointerId);
      handle.dataset['dragging'] = 'true';
      setDragging(true);

      const up = () => {
        clearDragging();
        onChange(clamp(valueRef, min, max), true);
        handle.dataset['dragging'] = 'false';
        handle.removeEventListener('pointermove', trackedMove);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      let valueRef = startValue;
      const trackedMove = (moveEvent: Event) => {
        const clientX = (moveEvent as PointerEvent).clientX;
        valueRef = clamp(startValue + ((clientX - startX) / cssZoomFactor()) * direction, min, max);
        onChange(valueRef, false);
      };
      handle.addEventListener('pointermove', trackedMove);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    },
    [value, min, max, onChange, direction],
  );

  const reset = useCallback(() => {
    onReset?.();
  }, [onReset]);

  return { startResize, reset };
}