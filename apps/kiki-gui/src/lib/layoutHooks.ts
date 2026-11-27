import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

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
 * Software-keyboard & native IME seam (`--kiki-ime-height` + `visualViewport`).
 *
 * `interactive-widget=resizes-content` lets Chromium shrink the layout viewport
 * itself; on iOS Safari and edge-to-edge Android WebViews (`WindowInsetsAnimation`)
 * the layout viewport may remain full-screen while either `visualViewport` shrinks
 * or the native bridge writes `--kiki-ime-height` on `:root`. This hook unifies
 * both signals into `--kiki-visual-height`, `--kiki-visual-offset-top`,
 * `--kiki-ime-offset`, and `:root[data-keyboard]`, pins stray `window.scrollY`
 * shifts when the keyboard opens, and dismisses the soft keyboard on a >=32px
 * downward finger drag inside transcript scrollers.
 */
export function useVisualViewportHeightVar(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const viewport = window.visualViewport ?? null;
    const root = document.documentElement;
    const coarse = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;

    // 100lvh reference probe so occlusion detection compares against the unshrunk
    // large viewport even when `resizes-content` shrinks `window.innerHeight`.
    const lvhProbe = document.createElement('div');
    lvhProbe.setAttribute('aria-hidden', 'true');
    lvhProbe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none;z-index:-1;';
    document.body?.appendChild(lvhProbe);

    let frame = 0;
    let keyboardSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastObservedImeRaw = root.style.getPropertyValue('--kiki-ime-height').trim();

    const readNativeImePx = (zoom: number): number => {
      const inlineRaw = root.style.getPropertyValue('--kiki-ime-height').trim();
      const raw = inlineRaw !== '' ? inlineRaw : getComputedStyle(root).getPropertyValue('--kiki-ime-height').trim();
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed / zoom : 0;
    };

    const setKeyboardOpen = (open: boolean) => {
      if (open) {
        if (keyboardSettleTimer !== null) {
          clearTimeout(keyboardSettleTimer);
          keyboardSettleTimer = null;
        }
        if (!root.hasAttribute('data-keyboard')) {
          root.setAttribute('data-keyboard', '');
        }
        return;
      }
      if (!root.hasAttribute('data-keyboard') || keyboardSettleTimer !== null) return;
      // 40ms settle prevents transient hardware-keyboard candidate bar dips from flickering layout.
      keyboardSettleTimer = setTimeout(() => {
        keyboardSettleTimer = null;
        root.removeAttribute('data-keyboard');
      }, 40);
    };

    const write = () => {
      frame = 0;
      const zoom = cssZoomFactor();
      const imePx = readNativeImePx(zoom);

      // Distinguish two-finger pinch-zoom from desktop Ctrl+ page zoom:
      // pinch-zoom increases `viewport.scale > 1.01` while `viewport.width`
      // diverges from `root.clientWidth`.
      if (
        viewport !== null &&
        viewport.scale > 1.01 &&
        Math.abs(viewport.width - root.clientWidth) >= 2 &&
        imePx <= 0
      ) {
        return;
      }

      const probeHeight = lvhProbe.clientHeight > 0 ? lvhProbe.clientHeight / zoom : 0;
      const innerHeight = Math.max(0, window.innerHeight / zoom);
      const refHeight = Math.max(probeHeight, innerHeight);

      if (viewport === null && imePx <= 0) {
        setKeyboardOpen(false);
        return;
      }

      const vvHeight = viewport !== null ? Math.max(0, Math.round(viewport.height / zoom)) : Math.round(innerHeight);
      const offsetTop = viewport !== null ? Math.max(0, Math.round(viewport.offsetTop / zoom)) : 0;
      // When the native Android/iOS host animates `--kiki-ime-height` ahead of or
      // instead of WebView visualViewport resize, subtract `imePx` from `refHeight`
      // without double-counting when `visualViewport` has already shrunk.
      const vvAlreadyShrunk = refHeight - vvHeight > 48;
      const height =
        imePx > 0 && !vvAlreadyShrunk
          ? Math.max(120, Math.round(refHeight - imePx))
          : vvHeight;

      const occluded = imePx > 60 || refHeight - height > 100;
      setKeyboardOpen(occluded);

      if (occluded && offsetTop === 0 && window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }

      const imeInset =
        coarse?.matches === true
          ? 0
          : Math.max(0, Math.round(innerHeight - height - offsetTop));

      root.style.setProperty('--kiki-visual-height', `${height}px`);
      root.style.setProperty('--kiki-visual-offset-top', `${offsetTop}px`);
      root.style.setProperty('--kiki-ime-offset', `${imeInset}px`);
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(write);
    };

    const styleObserver = new MutationObserver(() => {
      const nextRaw = root.style.getPropertyValue('--kiki-ime-height').trim();
      if (nextRaw !== lastObservedImeRaw) {
        lastObservedImeRaw = nextRaw;
        write();
      }
    });
    styleObserver.observe(root, { attributes: true, attributeFilter: ['style'] });

    // 32px downward touch-drag on transcript scroller dismisses focused composer keyboard.
    let touchDrag: { x: number; y: number; active: boolean } | null = null;
    const isFocusedComposerField = (el: Element | null): el is HTMLElement =>
      el instanceof HTMLElement &&
      (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) &&
      el.closest('[data-composer-root], [data-mobile-composer]') !== null;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !isFocusedComposerField(document.activeElement)) {
        touchDrag = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-transcript-scroll], [data-mobile-transcript]') === null) {
        touchDrag = null;
        return;
      }
      const touch = event.touches[0]!;
      touchDrag = { x: touch.clientX, y: touch.clientY, active: true };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (touchDrag === null || !touchDrag.active || event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      const dx = touch.clientX - touchDrag.x;
      const dy = touch.clientY - touchDrag.y;
      if (dy >= 32 && dy > Math.abs(dx) * 1.2) {
        const selection = typeof window.getSelection === 'function' ? window.getSelection()?.toString() ?? '' : '';
        if (selection === '' && isFocusedComposerField(document.activeElement)) {
          touchDrag.active = false;
          document.activeElement.blur();
        }
      }
    };

    const onTouchEnd = () => {
      touchDrag = null;
    };

    write();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.addEventListener(KIKI_ZOOM_CHANGE_EVENT, schedule);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (keyboardSettleTimer !== null) clearTimeout(keyboardSettleTimer);
      styleObserver.disconnect();
      lvhProbe.remove();
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.removeEventListener(KIKI_ZOOM_CHANGE_EVENT, schedule);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      root.removeAttribute('data-keyboard');
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