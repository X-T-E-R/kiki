/**
 * Single demand path for sidebar pagination: virtual tail arrival, underfill
 * fill probes, accessible Load More button, and Retry all flow through one
 * synchronous `(sourceKey, queryGeneration, cursor)` flight lock.
 *
 * Auto-demand requires a real positive measured viewport height (never fires
 * in zero-height jsdom, Search, Inbox, collapsed rail, inert drawer, or a
 * hidden tab). Downward entry into the end zone permits at most one page;
 * re-renders, collapse scroll-clamps, and staying intersected do not re-arm.
 * Sequential underfill probes stop as soon as viewport + overscan is filled,
 * the cursor repeats, a page adds zero visible extent (e.g. coldFold), or an
 * error/EOF occurs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface SidebarDemandTarget {
  readonly sourceKey: string;
  readonly cursor: string;
  readonly fetch: () => Promise<unknown>;
}

export interface UseSidebarInfiniteDemandOptions {
  /** True only when the Sessions virtual list is active, expanded, non-inert, and not searching. */
  readonly active: boolean;
  /** Monotonic identity key for the active query/filter/scope generation. */
  readonly queryGeneration: string;
  /** Real measured viewport height in CSS pixels (0 in jsdom / unmeasured containers). */
  readonly measuredViewportHeight: number;
  /** Current total virtualized content height in CSS pixels (excluding loader row). */
  readonly visibleContentHeight: number;
  /** Approximate overscan budget in CSS pixels (matches virtualizer overscan). */
  readonly overscanPx: number;
  /** Current scroll container scrollTop in CSS pixels. */
  readonly scrollTop: number;
  /** Index of the last rendered virtual item (-1 when empty). */
  readonly lastVirtualIndex: number;
  /** Total count of content rows (excluding the trailing loader/sentinel row). */
  readonly contentRowCount: number;
  /** Next pageable target (local or remote), or undefined when at EOF. */
  readonly target: SidebarDemandTarget | undefined;
  /** True while the underlying query reports an active next-page fetch. */
  readonly isFetchingNext: boolean;
}

export interface SidebarInfiniteDemandState {
  readonly isFetching: boolean;
  readonly error: string | null;
  readonly requestNextPage: (reason: 'manual' | 'retry') => void;
  readonly notifyScroll: (nextScrollTop: number) => void;
}

interface FlightLock {
  readonly sourceKey: string;
  readonly queryGeneration: string;
  readonly cursor: string;
}

function sameLock(a: FlightLock | null, b: FlightLock): boolean {
  return (
    a !== null
    && a.sourceKey === b.sourceKey
    && a.queryGeneration === b.queryGeneration
    && a.cursor === b.cursor
  );
}

export function useSidebarInfiniteDemand({
  active,
  queryGeneration,
  measuredViewportHeight,
  visibleContentHeight,
  overscanPx,
  scrollTop,
  lastVirtualIndex,
  contentRowCount,
  target,
  isFetchingNext,
}: UseSidebarInfiniteDemandOptions): SidebarInfiniteDemandState {
  const [localFetching, setLocalFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lockRef = useRef<FlightLock | null>(null);
  const generationRef = useRef(queryGeneration);
  generationRef.current = queryGeneration;

  // Scroll direction & end-zone entry edge detector (prevents collapse clamp / re-render re-arm).
  const prevScrollTopRef = useRef(scrollTop);
  const scrolledDownRef = useRef(false);
  const wasInEndZoneRef = useRef(false);

  // Bounded underfill probe state.
  const underfillRef = useRef<{
    stopped: boolean;
    lastCursor: string | null;
    heightBeforeProbe: number | null;
    probedOnce: boolean;
  }>({
    stopped: false,
    lastCursor: null,
    heightBeforeProbe: null,
    probedOnce: false,
  });

  // Reset demand & error state whenever query generation changes (scope, filter, sort, rebase).
  useEffect(() => {
    lockRef.current = null;
    setLocalFetching(false);
    setError(null);
    wasInEndZoneRef.current = false;
    scrolledDownRef.current = false;
    prevScrollTopRef.current = 0;
    underfillRef.current = {
      stopped: false,
      lastCursor: null,
      heightBeforeProbe: null,
      probedOnce: false,
    };
  }, [queryGeneration]);

  const dispatchDemand = useCallback(
    (demandTarget: SidebarDemandTarget, kind: 'scroll' | 'underfill' | 'manual' | 'retry') => {
      const nextLock: FlightLock = {
        sourceKey: demandTarget.sourceKey,
        queryGeneration: generationRef.current,
        cursor: demandTarget.cursor,
      };
      if (lockRef.current !== null || sameLock(lockRef.current, nextLock)) return;
      lockRef.current = nextLock;
      setLocalFetching(true);
      setError(null);
      if (kind === 'underfill') {
        underfillRef.current.lastCursor = demandTarget.cursor;
        underfillRef.current.heightBeforeProbe = visibleContentHeight;
        underfillRef.current.probedOnce = true;
      } else if (kind === 'manual' || kind === 'retry') {
        underfillRef.current.stopped = false;
        underfillRef.current.heightBeforeProbe = null;
      }
      const capturedGeneration = nextLock.queryGeneration;
      let promise: Promise<unknown>;
      try {
        promise = Promise.resolve(demandTarget.fetch());
      } catch (syncError: unknown) {
        promise = Promise.reject(syncError);
      }
      void promise
        .then(() => {
          if (generationRef.current !== capturedGeneration) return;
          setError(null);
        })
        .catch((cause: unknown) => {
          if (generationRef.current !== capturedGeneration) return;
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(message || 'Failed to load more sessions');
          underfillRef.current.stopped = true;
        })
        .finally(() => {
          if (lockRef.current === nextLock) {
            lockRef.current = null;
          }
          if (generationRef.current === capturedGeneration) {
            setLocalFetching(false);
          }
        });
    },
    [visibleContentHeight],
  );

  const notifyScroll = useCallback((nextScrollTop: number) => {
    const prev = prevScrollTopRef.current;
    prevScrollTopRef.current = nextScrollTop;
    if (nextScrollTop > prev) {
      scrolledDownRef.current = true;
    } else if (nextScrollTop < prev) {
      scrolledDownRef.current = false;
    }
  }, []);

  const requestNextPage = useCallback(
    (reason: 'manual' | 'retry') => {
      if (target === undefined || isFetchingNext || lockRef.current !== null) return;
      dispatchDemand(target, reason);
    },
    [target, isFetchingNext, dispatchDemand],
  );

  const tabHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const hasPositiveViewport = measuredViewportHeight > 0;
  const inEndZone = contentRowCount > 0 && lastVirtualIndex >= contentRowCount - 1;

  // Effect 1: Downward end-zone entry auto-demand (single page per entry, positive viewport required).
  useEffect(() => {
    const previouslyInEndZone = wasInEndZoneRef.current;
    wasInEndZoneRef.current = inEndZone;

    if (!active || tabHidden || !hasPositiveViewport || target === undefined) return;
    if (isFetchingNext || localFetching || lockRef.current !== null || error !== null) return;

    if (inEndZone && !previouslyInEndZone && scrolledDownRef.current) {
      scrolledDownRef.current = false;
      dispatchDemand(target, 'scroll');
    }
  }, [
    active,
    tabHidden,
    hasPositiveViewport,
    inEndZone,
    target,
    isFetchingNext,
    localFetching,
    error,
    dispatchDemand,
  ]);

  // Effect 2: Bounded underfill probe when measured viewport + overscan is not yet filled.
  useEffect(() => {
    if (!active || tabHidden || !hasPositiveViewport || target === undefined) return;
    if (isFetchingNext || localFetching || lockRef.current !== null || error !== null) return;
    if (contentRowCount === 0) return;

    const underfill = underfillRef.current;
    if (underfill.stopped) return;

    // Viewport + overscan already filled: stop underfill probing.
    if (visibleContentHeight >= measuredViewportHeight + overscanPx) {
      underfill.stopped = true;
      underfill.heightBeforeProbe = null;
      return;
    }

    // Check progress after the previous underfill probe completed.
    if (underfill.heightBeforeProbe !== null) {
      if (visibleContentHeight <= underfill.heightBeforeProbe) {
        // Zero visible growth (e.g. coldFold hid all appended rows): stop immediately.
        underfill.stopped = true;
        underfill.heightBeforeProbe = null;
        return;
      }
      underfill.heightBeforeProbe = null;
    }

    // Cursor repeated: stop immediately.
    if (underfill.lastCursor !== null && underfill.lastCursor === target.cursor) {
      underfill.stopped = true;
      return;
    }

    dispatchDemand(target, 'underfill');
  }, [
    active,
    tabHidden,
    hasPositiveViewport,
    measuredViewportHeight,
    visibleContentHeight,
    overscanPx,
    contentRowCount,
    target,
    isFetchingNext,
    localFetching,
    error,
    dispatchDemand,
  ]);

  return {
    isFetching: localFetching || isFetchingNext,
    error,
    requestNextPage,
    notifyScroll,
  };
}
