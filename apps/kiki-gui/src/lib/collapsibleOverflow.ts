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

import { useEffect, useId, useRef, useState } from 'react';

export interface CollapsibleOverflow<T extends HTMLElement> {
  readonly contentRef: React.RefObject<T | null>;
  /** ARIA hookup for the toggle (`aria-controls`). */
  readonly contentId: string;
  readonly isOverflowing: boolean;
  readonly expanded: boolean;
  readonly toggle: () => void;
}

export function useCollapsibleOverflow<T extends HTMLElement>(
  contentKey: unknown,
): CollapsibleOverflow<T> {
  const contentRef = useRef<T>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  useEffect(() => {
    if (expanded) return;
    const element = contentRef.current;
    if (element === null) return;
    // +1: subpixel slack so a borderline-equal height doesn't report overflow.
    const measure = () => {
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [contentKey, expanded]);

  return {
    contentRef,
    contentId,
    isOverflowing,
    expanded,
    toggle: () => { setExpanded((value) => !value); },
  };
}
