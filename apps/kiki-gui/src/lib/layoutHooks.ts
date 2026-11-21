import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

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

interface MediaQueryChannel {
  readonly media: MediaQueryList;
  readonly listeners: Set<() => void>;
  readonly onChange: () => void;
  matches: boolean;
  attached: boolean;
}

const mediaChannelsByImpl = new WeakMap<typeof window.matchMedia, Map<string, MediaQueryChannel>>();

function getMediaQueryChannel(query: string): MediaQueryChannel | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  const matchMediaImpl = window.matchMedia;
  let byQuery = mediaChannelsByImpl.get(matchMediaImpl);
  if (byQuery === undefined) {
    byQuery = new Map();
    mediaChannelsByImpl.set(matchMediaImpl, byQuery);
  }
  let channel = byQuery.get(query);
  if (channel === undefined) {
    const media = matchMediaImpl.call(window, query);
    const listeners = new Set<() => void>();
    const entry: MediaQueryChannel = {
      media,
      listeners,
      matches: media.matches,
      attached: false,
      onChange: () => {
        entry.matches = media.matches;
        for (const listener of listeners) listener();
      },
    };
    channel = entry;
    byQuery.set(query, channel);
  }
  return channel;
}

function subscribeMediaQuery(query: string, listener: () => void): () => void {
  const channel = getMediaQueryChannel(query);
  if (channel === null) return () => {};
  channel.listeners.add(listener);
  if (!channel.attached) {
    channel.matches = channel.media.matches;
    if (typeof channel.media.addEventListener === 'function') {
      channel.media.addEventListener('change', channel.onChange);
    } else if (typeof channel.media.addListener === 'function') {
      channel.media.addListener(channel.onChange);
    }
    channel.attached = true;
  }
  return () => {
    channel.listeners.delete(listener);
    if (channel.listeners.size === 0 && channel.attached) {
      if (typeof channel.media.removeEventListener === 'function') {
        channel.media.removeEventListener('change', channel.onChange);
      } else if (typeof channel.media.removeListener === 'function') {
        channel.media.removeListener(channel.onChange);
      }
      channel.attached = false;
    }
  };
}

function readMediaQuerySnapshot(query: string): boolean {
  const channel = getMediaQueryChannel(query);
  if (channel === null) return false;
  return channel.attached ? channel.matches : channel.media.matches;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((listener: () => void) => subscribeMediaQuery(query, listener), [query]);
  const getSnapshot = useCallback(() => readMediaQuerySnapshot(query), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
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
      const offsetTop = Math.max(0, Math.round(viewport.offsetTop / zoom));
      // On coarse pointers the app's height chain already follows
      // --kiki-visual-height (index.css), so the keyboard is accounted for
      // once there. Reporting it again as an inset would lift the composer a
      // second keyboard-height; the inset is for surfaces whose box still
      // spans the unshrunk layout viewport.
      const imeInset = coarse?.matches === true
        ? 0
        : Math.max(0, Math.round((window.innerHeight - viewport.height - viewport.offsetTop) / zoom));
      root.style.setProperty('--kiki-visual-height', `${height}px`);
      root.style.setProperty('--kiki-visual-offset-top', `${offsetTop}px`);
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
      root.style.removeProperty('--kiki-visual-offset-top');
      root.style.removeProperty('--kiki-ime-offset');
    };
  }, []);
}

function setDragging(active: boolean, axis: 'horizontal' | 'vertical' = 'horizontal') {
  document.body.dataset['paneResizing'] = active ? 'true' : 'false';
  if (active && axis === 'vertical') {
    document.body.dataset['paneResizeAxis'] = 'row';
  } else {
    delete document.body.dataset['paneResizeAxis'];
  }
}

function clearDragging() {
  delete document.body.dataset['paneResizing'];
  delete document.body.dataset['paneResizeAxis'];
}

export interface PaneResizeDynamicBounds {
  readonly min?: number;
  readonly max?: number;
  readonly startValue?: number;
}

export function usePaneResize(options: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number, final: boolean) => void;
  onReset?: () => void;
  direction?: 1 | -1;
  axis?: 'horizontal' | 'vertical';
  onDraggingChange?: (dragging: boolean) => void;
  resolveBounds?: (handle: HTMLElement) => PaneResizeDynamicBounds | undefined;
}) {
  const {
    value,
    min,
    max,
    onChange,
    onReset,
    direction = 1,
    axis = 'horizontal',
    onDraggingChange,
    resolveBounds,
  } = options;
  const activeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      activeCleanupRef.current?.();
    };
  }, []);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      activeCleanupRef.current?.();
      const handle = event.currentTarget;
      const startCoord = axis === 'vertical' ? event.clientY : event.clientX;
      const resolved = resolveBounds?.(handle);
      const activeMin = resolved?.min ?? min;
      const activeMax = Math.max(activeMin, resolved?.max ?? max);
      const startValue = resolved?.startValue ?? value;
      let valueRef = startValue;
      let ended = false;
      handle.setPointerCapture(event.pointerId);
      handle.dataset['dragging'] = 'true';
      setDragging(true, axis);
      onDraggingChange?.(true);

      const detachListeners = () => {
        clearDragging();
        handle.dataset['dragging'] = 'false';
        onDraggingChange?.(false);
        handle.removeEventListener('pointermove', trackedMove);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', cancel);
        handle.removeEventListener('lostpointercapture', cancel);
        window.removeEventListener('blur', cancel);
      };
      const coordOf = (pointerEvent: Event) =>
        axis === 'vertical' ? (pointerEvent as PointerEvent).clientY : (pointerEvent as PointerEvent).clientX;
      const trackedMove = (moveEvent: Event) => {
        if (ended) return;
        const coord = coordOf(moveEvent);
        valueRef = clamp(startValue + ((coord - startCoord) / cssZoomFactor()) * direction, activeMin, activeMax);
        onChange(valueRef, false);
      };
      const up = (upEvent: Event) => {
        if (ended) return;
        ended = true;
        activeCleanupRef.current = null;
        const coord = coordOf(upEvent);
        valueRef = clamp(startValue + ((coord - startCoord) / cssZoomFactor()) * direction, activeMin, activeMax);
        detachListeners();
        onChange(valueRef, true);
      };
      const cancel = () => {
        if (ended) return;
        ended = true;
        activeCleanupRef.current = null;
        detachListeners();
        onChange(clamp(valueRef, activeMin, activeMax), true);
      };
      activeCleanupRef.current = () => {
        if (ended) return;
        ended = true;
        activeCleanupRef.current = null;
        detachListeners();
      };
      handle.addEventListener('pointermove', trackedMove);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', cancel);
      handle.addEventListener('lostpointercapture', cancel);
      window.addEventListener('blur', cancel);
    },
    [value, min, max, onChange, direction, axis, onDraggingChange, resolveBounds],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? 48 : 16;
      const decKey = axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
      const incKey = axis === 'vertical' ? 'ArrowDown' : 'ArrowRight';
      if (event.key !== decKey && event.key !== incKey && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const resolved = resolveBounds?.(event.currentTarget);
      const activeMin = resolved?.min ?? min;
      const activeMax = Math.max(activeMin, resolved?.max ?? max);
      const current = resolved?.startValue ?? value;
      const next = event.key === 'Home'
        ? activeMin
        : event.key === 'End'
          ? activeMax
          : clamp(current + (event.key === incKey ? step : -step) * direction, activeMin, activeMax);
      onChange(next, true);
    },
    [axis, direction, max, min, onChange, resolveBounds, value],
  );

  const reset = useCallback(() => {
    onReset?.();
  }, [onReset]);

  return { startResize, onKeyDown, reset };
}