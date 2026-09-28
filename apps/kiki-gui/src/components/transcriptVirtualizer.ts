/**
 * Measurement and scroll-anchoring model for the virtualized transcript.
 *
 * Invariant: for every mounted row, the virtualizer's size model equals the
 * row's rendered height. Rows are positioned absolutely from that model, so
 * any divergence paints as overlap (model too small) or a hole (too large).
 *
 * The model is fed from three places, and each has a known way to diverge:
 * - the per-row ResizeObserver. It fires once per real size change; virtual-
 *   core drops that entry while a `behavior: 'smooth'` programmatic scroll is
 *   in flight (`shouldMeasureDuringScroll`), and the observer never repeats
 *   it. Programmatic jumps therefore never use smooth behavior.
 * - a hidden ancestor (`display: none` tab or panel) makes the observer
 *   report 0 for every mounted row. Those readings are ignored.
 * - `Virtualizer.measure()` clears every cached size while mounted rows keep
 *   their height, so the observer stays silent and estimates stick. It is
 *   never called; `reconcileMountedRows` re-reads mounted rows instead.
 *
 * Scroll anchoring follows CSS scroll anchoring: while the viewport follows
 * the end, every size change keeps the bottom pinned; otherwise only a change
 * that happens entirely above the first visible row moves `scrollTop`.
 */

import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual';

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

export const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 120;
export const TRANSCRIPT_END_THRESHOLD = 80;

/**
 * A row inside a `display: none` subtree (hidden tab/panel) reports a 0 box.
 * Rows always render content or padding, so 0 means "not laid out", never a
 * real size.
 */
function readRowHeight(element: HTMLElement, entry?: ResizeObserverEntry): number {
  return Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
}

export function measureTranscriptRow(
  element: HTMLDivElement,
  entry: ResizeObserverEntry | undefined,
  instance: TranscriptVirtualizer,
): number {
  const size = readRowHeight(element, entry);
  if (size > 0) return size;
  const index = instance.indexFromElement(element);
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
 * Whether a row's size change should move `scrollTop` by the same delta.
 * - Following the end: always, so the newest content stays in view.
 * - A never-measured row whose estimated top sat above the viewport: yes —
 *   the estimate was a guess about space the reader has already passed.
 * - Otherwise only rows entirely above the viewport top. A row that spans the
 *   top edge (a long answer still streaming, a block the reader just
 *   expanded) changes below the reader's anchor and must not drag the view.
 */
export function shouldCompensateRowResize(resize: RowResize): boolean {
  if (resize.distanceFromEnd <= resize.endThreshold) return true;
  if (resize.firstMeasure) return resize.itemStart < resize.scrollOffset;
  return resize.itemStart + resize.itemSize <= resize.scrollOffset;
}

/** Install the anchoring model on a virtualizer instance (instance field, not an option). */
export function installTranscriptAnchoring(instance: TranscriptVirtualizer): void {
  instance.shouldAdjustScrollPositionOnItemSizeChange = (item: VirtualItem) => {
    const element = instance.scrollElement;
    const scrollOffset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    const distanceFromEnd = element instanceof HTMLElement
      ? element.scrollHeight - element.clientHeight - element.scrollTop
      : Number.POSITIVE_INFINITY;
    return shouldCompensateRowResize({
      itemStart: item.start,
      itemSize: item.size,
      firstMeasure: !instance.itemSizeCache.has(item.key),
      scrollOffset,
      distanceFromEnd,
      endThreshold: TRANSCRIPT_END_THRESHOLD,
    });
  };
}

/**
 * Programmatic jump to the end that keeps the virtualizer's own offset in
 * step with the DOM. The `scrollTop` write lands synchronously but
 * `scrollOffset` only catches up on the async scroll event; a render in that
 * window whose edge keys change (rows arriving, a group folding) resolves its
 * end anchor from the stale offset — the item at the top — and scrolls there.
 */
export function landAtEnd(instance: TranscriptVirtualizer): void {
  instance.scrollToEnd();
  const element = instance.scrollElement;
  if (element instanceof HTMLElement) instance.scrollOffset = element.scrollTop;
}

/**
 * Re-read every mounted row and correct the model where it diverged. Rows that
 * are disconnected or hidden keep their last real size.
 */
export function reconcileMountedRows(instance: TranscriptVirtualizer): void {
  for (const [key, element] of instance.elementsCache) {
    if (!element.isConnected) continue;
    const index = instance.indexFromElement(element);
    if (index < 0 || index >= instance.options.count || instance.options.getItemKey(index) !== key) continue;
    const size = readRowHeight(element);
    if (size > 0 && instance.itemSizeCache.get(key) !== size) instance.resizeItem(index, size);
  }
}
