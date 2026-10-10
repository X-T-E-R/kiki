import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  DEFAULT_LAYOUT_PREFERENCES,
  layoutPreferencesSnapshot,
  subscribeLayoutPreferences,
  type LayoutPreferences,
} from '@kiki/session-core/settings';

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

/** Touch-first devices (phones): IME Enter, hit targets and layer history follow the phone contract. */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}

/**
 * Software-keyboard fallback. `interactive-widget=resizes-content` (see
 * index.html) lets Chromium shrink the layout viewport itself; elsewhere
 * (iOS Safari) the layout viewport never shrinks for the keyboard, so this
 * mirrors visualViewport.height into `--kiki-visual-height` on :root. CSS
 * opts in per surface with `height: var(--kiki-visual-height, 100%)` — where
 * the API is absent nothing is set and every rule keeps its 100% fallback.
 */
export function useVisualViewportHeightVar(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) return;
    const root = document.documentElement;
    let frame = 0;
    const write = () => {
      frame = 0;
      root.style.setProperty('--kiki-visual-height', `${Math.round(viewport.height)}px`);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(write);
    };
    write();
    viewport.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      root.style.removeProperty('--kiki-visual-height');
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
        valueRef = clamp(startValue + (clientX - startX) * direction, min, max);
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