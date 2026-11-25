/**
 * useCollapsibleOverflow — codeg's use-collapsible-overflow (Apache-2.0)
 * ported to kiki: a clamped container reports whether its content overflows
 * (`scrollHeight > clientHeight + 1`), re-measured via ResizeObserver while
 * collapsed. Once expanded the measurement freezes (expanded clientHeight
 * always equals scrollHeight, which would falsely clear the flag and hide the
 * "show less" toggle mid-read).
 *
 * The clamp itself lives at the call site as a `max-h-*` class — the hook
 * never hardcodes a threshold. jsdom has no layout and (in older versions) no
 * ResizeObserver: the synchronous first measure still runs, so tests drive the
 * flag by defining scroll/clientHeight on the element.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export interface CollapsibleOverflow<T extends HTMLElement> {
  readonly contentRef: React.RefObject<T | null>;
  /** ARIA hookup for the toggle (`aria-controls`). */
  readonly contentId: string;
  readonly isOverflowing: boolean;
  readonly expanded: boolean;
  readonly toggle: () => void;
}

const pendingOverflowMeasures = new Set<() => void>();
let overflowRafId: number | undefined;

function scheduleOverflowMeasure(measure: () => void): () => void {
  pendingOverflowMeasures.add(measure);
  if (overflowRafId === undefined && typeof requestAnimationFrame === 'function') {
    overflowRafId = requestAnimationFrame(() => {
      overflowRafId = undefined;
      const batch = [...pendingOverflowMeasures];
      pendingOverflowMeasures.clear();
      for (const run of batch) run();
    });
  }
  return () => {
    pendingOverflowMeasures.delete(measure);
  };
}

export function useCollapsibleOverflow<T extends HTMLElement>(
  contentKey: unknown,
): CollapsibleOverflow<T> {
  const contentRef = useRef<T>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const mountedMeasuredRef = useRef(false);
  const contentId = useId();

  const measure = useCallback(() => {
    const element = contentRef.current;
    if (element === null || !element.isConnected) return;
    // +1: subpixel slack so a borderline-equal height doesn't report overflow.
    const next = element.scrollHeight > element.clientHeight + 1;
    setIsOverflowing((prev) => (prev === next ? prev : next));
  }, []);

  useLayoutEffect(() => {
    if (expanded) return;
    if (typeof ResizeObserver === 'undefined') {
      mountedMeasuredRef.current = true;
      measure();
      return;
    }
    mountedMeasuredRef.current = true;
    return scheduleOverflowMeasure(measure);
  }, [contentKey, expanded, measure]);

  useEffect(() => {
    if (expanded || typeof ResizeObserver === 'undefined') return;
    const element = contentRef.current;
    if (element === null) return;
    let cancelScheduled: (() => void) | undefined;
    const observer = new ResizeObserver(() => {
      cancelScheduled = scheduleOverflowMeasure(measure);
    });
    observer.observe(element);
    return () => {
      cancelScheduled?.();
      observer.disconnect();
    };
  }, [expanded, measure]);

  const toggle = useCallback(() => {
    setExpanded((value) => !value);
  }, []);

  return {
    contentRef,
    contentId,
    isOverflowing,
    expanded,
    toggle,
  };
}
