import { useCallback, useSyncExternalStore } from 'react';

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

export function useLayoutPreferences(): LayoutPreferences {
  const getSnapshot = useCallback(() => layoutPreferencesSnapshot(), []);
  const getServerSnapshot = useCallback(() => DEFAULT_LAYOUT_PREFERENCES, []);
  return useSyncExternalStore(subscribeLayoutPreferences, getSnapshot, getServerSnapshot);
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