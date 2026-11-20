/**
 * Measurement and scroll-anchoring helpers for the virtualized transcript.
 *
 * Ownership split (zero monkey-patching of Virtualizer internals):
 * - `use-stick-to-bottom` owns bottom-stickiness (auto-following appends and
 *   streaming growth while locked to bottom, and immediately disengaging on
 *   upward user intent so streaming never yanks a scrolled-up reader downward).
 * - `@tanstack/react-virtual` owns windowing, `ResizeObserver` measurement,
 *   direct DOM positioning (`directDomUpdates: true`), and above-viewport
 *   scroll compensation via `shouldAdjustScrollPositionOnItemSizeChange`.
 *
 * This module supplies only the pure measurement guard (ignoring 0px readings
 * from hidden `display: none` tabs and pre-commit `data-row-key` mismatches),
 * the `shouldAdjustScrollPositionOnItemSizeChange` predicate (plus local
 * in-row prose anchoring when content inside a viewport-spanning row expands
 * above the reader's visible paragraph), and a MutationObserver microtask pass
 * for async hydration before the next ResizeObserver frame.
 */

import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual';

export type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

export const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 120;
export const TRANSCRIPT_END_THRESHOLD = 80;

/** Bridge from `use-stick-to-bottom` (or a test stub) into virtualizer anchoring. */
export interface TranscriptStickController {
  /** True only while the reader is actively locked to the bottom edge. */
  isFollowing(): boolean;
  /** Immediately disengage bottom lock (upward gesture, disclosure click, history jump). */
  stop(): void;
  /** Re-engage bottom lock and move to the bottom edge (viewport shrink while following). */
  landAtEnd(): void;
}

const READER_SCROLL_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp', 'PageUp', 'Home',
]);

function readRowHeight(element: HTMLElement, entry?: ResizeObserverEntry): number {
  return Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
}

/**
 * Measure a mounted transcript row while guarding two known edge cases:
 * - Pre-commit `data-row-key` mismatch when `setOptions` advances `getItemKey`
 *   before React commits the updated `data-index` onto a mounted row.
 * - Hidden ancestor (`display: none` tab/panel) reporting 0px height; retain
 *   the last measured height from `itemSizeCache` instead of collapsing to 0.
 */
export function measureTranscriptRow(
  element: HTMLDivElement,
  entry: ResizeObserverEntry | undefined,
  instance: TranscriptVirtualizer,
): number {
  const index = instance.indexFromElement(element);
  if (index >= 0 && index < instance.options.count) {
    const modelKey = String(instance.options.getItemKey(index));
    const domKey = element.dataset['rowKey'];
    if (domKey !== undefined && domKey !== modelKey) {
      return instance.itemSizeCache.get(modelKey) ?? instance.options.estimateSize(index);
    }
  }
  const size = readRowHeight(element, entry);
  if (size > 0) return size;
  const key = index >= 0 && index < instance.options.count ? instance.options.getItemKey(index) : undefined;
  return (key === undefined ? undefined : instance.itemSizeCache.get(key)) ?? size;
}

export type RowResize = {
  /** Model start of the row, before this resize. */
  readonly itemStart: number;
  /** Model size of the row, before this resize (an estimate on first measure). */
  readonly itemSize: number;
  /** True when the row has never been measured (its size was an estimate). */
  readonly firstMeasure: boolean;
  /** Current scroll offset including pending adjustments. */
  readonly scrollOffset: number;
  /** Rendered distance between the viewport bottom and the content end. */
  readonly distanceFromEnd: number;
  readonly endThreshold: number;
};

/**
 * Whether a row's size change should shift `scrollTop` by the same delta.
 * - While following the end (`distanceFromEnd <= endThreshold`): yes, keeps the
 *   newest content pinned synchronously.
 * - A never-measured row whose estimated top sat above the viewport: yes,
 *   corrects the estimate-to-actual difference above the reader.
 * - Otherwise only rows entirely above the viewport top (`itemStart + itemSize <= scrollOffset`).
 *   Rows spanning the viewport top or sitting below it must NOT drag the reader.
 */
export function shouldCompensateRowResize(resize: RowResize): boolean {
  if (resize.distanceFromEnd <= resize.endThreshold) return true;
  if (resize.firstMeasure) return resize.itemStart < resize.scrollOffset;
  return resize.itemStart + resize.itemSize <= resize.scrollOffset;
}

/**
 * Install `@tanstack/react-virtual`'s `shouldAdjustScrollPositionOnItemSizeChange`
 * policy, upward-gesture disengage listeners, shrinking-viewport pin, and
 * in-row prose anchoring for viewport-spanning rows.
 */
export function installTranscriptAnchoring(
  instance: TranscriptVirtualizer,
  stick: TranscriptStickController,
): () => void {
  const scroll = instance.scrollElement;
  let anchor: { key: VirtualItem['key']; row: HTMLElement; prose: HTMLElement; inset: number; scrollTop: number } | undefined;
  let frame: number | undefined;

  const captureProseAnchor = () => {
    anchor = undefined;
    if (
      scroll === null ||
      !scroll.isConnected ||
      scroll.clientHeight === 0 ||
      stick.isFollowing() ||
      scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= TRANSCRIPT_END_THRESHOLD
    ) {
      return;
    }
    const viewport = scroll.getBoundingClientRect();
    for (const [key, row] of instance.elementsCache) {
      const index = instance.indexFromElement(row);
      if (!row.isConnected || index < 0 || index >= instance.options.count || instance.options.getItemKey(index) !== key) continue;
      const box = row.getBoundingClientRect();
      if (box.top > viewport.top || box.bottom <= viewport.top) continue;
      const prose = [...row.querySelectorAll<HTMLElement>('.kiki-md p, .kiki-md pre, .kiki-md li, .kiki-md h1, .kiki-md h2, .kiki-md h3, .kiki-md h4, .kiki-md table')]
        .find((element) => {
          const rect = element.getBoundingClientRect();
          return element.textContent !== '' && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
      if (prose !== undefined) {
        anchor = { key, row, prose, inset: prose.getBoundingClientRect().top - box.top, scrollTop: scroll.scrollTop };
      }
      break;
    }
  };

  // Shrinking viewport (mobile soft keyboard, growing composer): keep the
  // bottom pinned ONLY when the reader was genuinely following the end.
  let viewportHeight = scroll?.clientHeight ?? 0;
  let viewportOffset = scroll?.scrollTop ?? 0;
  const viewportObserver = scroll === null || typeof ResizeObserver === 'undefined'
    ? undefined
    : new ResizeObserver(() => {
      if (!scroll.isConnected || scroll.clientHeight === 0 || scroll.clientHeight === viewportHeight) return;
      const previousHeight = viewportHeight;
      viewportHeight = scroll.clientHeight;
      const movedManually =
        Math.abs(scroll.scrollTop - viewportOffset) > 0.5 ||
        scroll.scrollHeight - previousHeight - scroll.scrollTop > TRANSCRIPT_END_THRESHOLD;
      if (movedManually) {
        stick.stop();
      } else if (
        stick.isFollowing() &&
        scroll.clientHeight < previousHeight &&
        scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > TRANSCRIPT_END_THRESHOLD
      ) {
        stick.landAtEnd();
      }
      viewportOffset = scroll.scrollTop;
    });
  if (scroll !== null) viewportObserver?.observe(scroll);

  let lastTouchY: number | undefined;
  let lastPointerY: number | undefined;

  const disengage = () => {
    stick.stop();
    if (scroll !== null && scroll.isConnected) {
      viewportOffset = scroll.scrollTop;
    }
  };

  const onScroll = () => {
    if (scroll !== null && scroll.isConnected && scroll.clientHeight > 0) {
      viewportOffset = scroll.scrollTop;
      viewportHeight = scroll.clientHeight;
    }
    captureProseAnchor();
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = undefined; captureProseAnchor(); });
  };
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) disengage();
  };
  const onTouchStart = (event: TouchEvent) => {
    lastTouchY = event.touches[0]?.clientY;
  };
  const onTouchMove = (event: TouchEvent) => {
    const nextY = event.touches[0]?.clientY;
    if (lastTouchY !== undefined && nextY !== undefined && nextY > lastTouchY) disengage();
    lastTouchY = nextY;
  };
  const onPointerDown = (event: PointerEvent) => {
    lastPointerY = scroll !== null && event.offsetX >= scroll.clientWidth - 20 ? event.clientY : undefined;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (lastPointerY === undefined || event.buttons === 0) return;
    if (event.clientY < lastPointerY) disengage();
    lastPointerY = event.clientY;
  };
  const onPointerUp = () => { lastPointerY = undefined; };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      READER_SCROLL_KEYS.has(event.key) &&
      !(event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))
    ) {
      disengage();
    }
  };

  scroll?.addEventListener('scroll', onScroll, { passive: true });
  scroll?.addEventListener('wheel', onWheel, { passive: true });
  scroll?.addEventListener('touchstart', onTouchStart, { passive: true });
  scroll?.addEventListener('touchmove', onTouchMove, { passive: true });
  scroll?.addEventListener('pointerdown', onPointerDown);
  scroll?.addEventListener('pointermove', onPointerMove);
  scroll?.addEventListener('pointerup', onPointerUp);
  scroll?.addEventListener('keydown', onKeyDown);
  captureProseAnchor();

  instance.shouldAdjustScrollPositionOnItemSizeChange = (item: VirtualItem) => {
    const element = instance.scrollElement;
    const scrollOffset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    const rawDistanceFromEnd = element instanceof HTMLElement
      ? element.scrollHeight - element.clientHeight - element.scrollTop
      : Number.POSITIVE_INFINITY;
    const distanceFromEnd = stick.isFollowing() ? rawDistanceFromEnd : Number.POSITIVE_INFINITY;
    if (shouldCompensateRowResize({
      itemStart: item.start,
      itemSize: item.size,
      firstMeasure: !instance.itemSizeCache.has(item.key),
      scrollOffset,
      distanceFromEnd,
      endThreshold: TRANSCRIPT_END_THRESHOLD,
    })) {
      return true;
    }
    // A measured row spanning the viewport top can grow above OR below the
    // visible paragraph; compensate only the visible prose's local inset shift.
    if (
      anchor !== undefined &&
      anchor.key === item.key &&
      element === scroll &&
      scroll !== null &&
      anchor.row === instance.elementsCache.get(item.key) &&
      anchor.prose.isConnected &&
      anchor.row.contains(anchor.prose) &&
      scroll.clientHeight > 0 &&
      scroll.scrollTop === anchor.scrollTop
    ) {
      const inset = anchor.prose.getBoundingClientRect().top - anchor.row.getBoundingClientRect().top;
      const delta = inset - anchor.inset;
      anchor.inset = inset;
      if (Math.abs(delta) > 0.5) {
        instance.scrollToOffset(scroll.scrollTop + delta, { align: 'start' });
        instance.scrollOffset = scroll.scrollTop;
        anchor.scrollTop = scroll.scrollTop;
      }
    }
    return false;
  };

  return () => {
    scroll?.removeEventListener('scroll', onScroll);
    scroll?.removeEventListener('wheel', onWheel);
    scroll?.removeEventListener('touchstart', onTouchStart);
    scroll?.removeEventListener('touchmove', onTouchMove);
    scroll?.removeEventListener('pointerdown', onPointerDown);
    scroll?.removeEventListener('pointermove', onPointerMove);
    scroll?.removeEventListener('pointerup', onPointerUp);
    scroll?.removeEventListener('keydown', onKeyDown);
    viewportObserver?.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    anchor = undefined;
  };
}

/**
 * Reconcile asynchronously hydrated content at the DOM mutation boundary before
 * the next ResizeObserver frame so neighbors never overlap transiently.
 */
export function observeRowMutations(
  scroll: HTMLElement | null,
  instance: TranscriptVirtualizer,
): () => void {
  if (scroll === null) return () => undefined;
  let queued = false;
  let active = true;
  let fullScan = false;
  const dirtyRows = new Set<HTMLDivElement>();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      const row = target?.closest<HTMLDivElement>('[data-row-key]') ?? null;
      if (row instanceof HTMLDivElement && scroll.contains(row)) {
        dirtyRows.add(row);
      } else {
        fullScan = true;
      }
    }
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!active || !scroll.isConnected) {
        dirtyRows.clear();
        fullScan = false;
        return;
      }
      if (fullScan) {
        fullScan = false;
        dirtyRows.clear();
        reconcileMountedRows(instance);
        return;
      }
      if (dirtyRows.size === 0) return;
      const rows = [...dirtyRows];
      dirtyRows.clear();
      reconcileMountedRows(instance, rows);
    });
  });
  observer.observe(scroll, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'open'],
  });
  return () => {
    active = false;
    dirtyRows.clear();
    observer.disconnect();
  };
}

/**
 * Re-read connected mounted rows (or a mutated subset) and update the virtualizer
 * where a row's rendered height diverged from `itemSizeCache`. Hidden rows keep their last size.
 */
export function reconcileMountedRows(
  instance: TranscriptVirtualizer,
  subset?: readonly HTMLDivElement[],
): void {
  const scroll = instance.scrollElement;
  if (scroll instanceof HTMLElement && (!scroll.isConnected || scroll.clientHeight === 0)) return;
  if (subset !== undefined) {
    for (const element of subset) {
      if (!element.isConnected) continue;
      const index = instance.indexFromElement(element);
      if (index < 0 || index >= instance.options.count) continue;
      const key = instance.options.getItemKey(index);
      const domKey = element.dataset['rowKey'];
      if (domKey !== undefined && domKey !== String(key)) continue;
      const size = readRowHeight(element);
      if (size > 0 && instance.itemSizeCache.get(key) !== size) instance.resizeItem(index, size);
    }
    return;
  }
  for (const [key, element] of instance.elementsCache) {
    if (!element.isConnected) continue;
    const index = instance.indexFromElement(element);
    if (index < 0 || index >= instance.options.count || instance.options.getItemKey(index) !== key) continue;
    const domKey = element.dataset['rowKey'];
    if (domKey !== undefined && domKey !== String(key)) continue;
    const size = readRowHeight(element);
    if (size > 0 && instance.itemSizeCache.get(key) !== size) instance.resizeItem(index, size);
  }
}
