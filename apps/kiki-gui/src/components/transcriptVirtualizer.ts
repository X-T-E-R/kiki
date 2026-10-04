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
 * While following the end, size changes keep the bottom pinned. Away from the
 * end, whole rows above the viewport retain the original compensation; within
 * the first visible row, only movement of the reader's visible prose moves
 * scrollTop. Growth below that prose must not drag the reader.
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
 * - Otherwise only rows entirely above the viewport top. A row spanning the
 *   top edge cannot use its entire delta: streaming growth may be below the
 *   reader. Its visible prose's local displacement is handled separately.
 */
export function shouldCompensateRowResize(resize: RowResize): boolean {
  if (resize.distanceFromEnd <= resize.endThreshold) return true;
  if (resize.firstMeasure) return resize.itemStart < resize.scrollOffset;
  return resize.itemStart + resize.itemSize <= resize.scrollOffset;
}

/** Install row anchoring and retain the visible prose's inset within its row. */
export function installTranscriptAnchoring(instance: TranscriptVirtualizer): () => void {
  const scroll = instance.scrollElement;
  let anchor: { key: VirtualItem['key']; row: HTMLElement; prose: HTMLElement; inset: number; scrollTop: number } | undefined;
  let frame: number | undefined;
  const capture = () => {
    anchor = undefined;
    if (scroll === null || !scroll.isConnected || scroll.clientHeight === 0
      || scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= TRANSCRIPT_END_THRESHOLD) return;
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
      if (prose !== undefined) anchor = { key, row, prose, inset: prose.getBoundingClientRect().top - box.top, scrollTop: scroll.scrollTop };
      break;
    }
  };
  const onScroll = () => {
    capture();
    // Newly mounted rows settle after the scroll delivery.
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = undefined; capture(); });
  };
  scroll?.addEventListener('scroll', onScroll, { passive: true });
  capture();
  instance.shouldAdjustScrollPositionOnItemSizeChange = (item: VirtualItem) => {
    const element = instance.scrollElement;
    const scrollOffset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    const distanceFromEnd = element instanceof HTMLElement
      ? element.scrollHeight - element.clientHeight - element.scrollTop
      : Number.POSITIVE_INFINITY;
    if (shouldCompensateRowResize({
      itemStart: item.start,
      itemSize: item.size,
      firstMeasure: !instance.itemSizeCache.has(item.key),
      scrollOffset,
      distanceFromEnd,
      endThreshold: TRANSCRIPT_END_THRESHOLD,
    })) return true;
    // A measured row spanning the viewport can change above OR below the reader.
    // Compare local prose geometry, not the row's full delta or its translated top.
    if (anchor !== undefined && anchor.key === item.key && element === scroll && scroll !== null
      && anchor.row === instance.elementsCache.get(item.key) && anchor.prose.isConnected
      && anchor.row.contains(anchor.prose) && scroll.clientHeight > 0 && scroll.scrollTop === anchor.scrollTop) {
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
    if (frame !== undefined) cancelAnimationFrame(frame);
    anchor = undefined;
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
