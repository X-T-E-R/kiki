/**
 * Pure compositor-only FLIP animation hook for vertically stacked list items.
 *
 * Measures each `[data-flip-key]` child's `top` before/after key-order changes
 * and transitions only `transform` (`220ms cubic-bezier(0.22, 1, 0.36, 1)`).
 * Automatically skips animation under `prefers-reduced-motion: reduce` or
 * `:root[data-kiki-motion="reduce"]`.
 */

import { useLayoutEffect, useRef, type RefObject } from 'react';

const FLIP_DURATION_MS = 220;
const FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined') {
    const mode = document.documentElement.dataset['kikiMotion'];
    if (mode === 'reduce') return true;
    if (mode === 'full') return false;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}

export function useListFlip(
  orderedKeys: readonly string[],
  containerRef: RefObject<HTMLElement | null>,
): void {
  const prevTopsRef = useRef<Map<string, number>>(new Map());
  const keySignature = orderedKeys.join('\u0000');

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const nodes = container.querySelectorAll<HTMLElement>('[data-flip-key]');
    const nextTops = new Map<string, number>();
    const elementsByKey = new Map<string, HTMLElement>();
    for (const node of nodes) {
      const key = node.dataset['flipKey'];
      if (key === undefined || key === '') continue;
      nextTops.set(key, node.getBoundingClientRect().top);
      elementsByKey.set(key, node);
    }

    const prevTops = prevTopsRef.current;
    prevTopsRef.current = nextTops;

    if (prevTops.size === 0 || prefersReducedMotion()) return;

    const moving: Array<{ readonly el: HTMLElement; readonly deltaY: number }> = [];
    for (const [key, nextTop] of nextTops) {
      const prevTop = prevTops.get(key);
      if (prevTop === undefined) continue;
      const deltaY = prevTop - nextTop;
      if (Math.abs(deltaY) < 1) continue;
      const el = elementsByKey.get(key);
      if (el !== undefined) moving.push({ el, deltaY });
    }

    if (moving.length === 0) return;

    for (const { el, deltaY } of moving) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${deltaY}px)`;
      el.style.willChange = 'transform';
    }

    // Flush the inverted transforms in one read before enabling the transition.
    container.getBoundingClientRect();

    const cleanups: Array<() => void> = [];
    for (const { el } of moving) {
      el.style.transition = `transform ${FLIP_DURATION_MS}ms ${FLIP_EASING}`;
      el.style.transform = '';
      const clear = () => {
        el.style.transition = '';
        el.style.transform = '';
        el.style.willChange = '';
      };
      const onEnd = (event: TransitionEvent) => {
        if (event.target === el && event.propertyName === 'transform') {
          clear();
          el.removeEventListener('transitionend', onEnd);
        }
      };
      el.addEventListener('transitionend', onEnd);
      const timer = window.setTimeout(() => {
        el.removeEventListener('transitionend', onEnd);
        clear();
      }, FLIP_DURATION_MS + 60);
      cleanups.push(() => {
        window.clearTimeout(timer);
        el.removeEventListener('transitionend', onEnd);
        clear();
      });
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [keySignature, containerRef]);
}
