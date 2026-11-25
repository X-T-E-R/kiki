/**
 * Measurement and scroll-anchoring helpers for the virtualized transcript.
 *
 * Ownership split (zero monkey-patching of Virtualizer internals):
 * - `use-stick-to-bottom` owns bottom-stickiness (auto-following appends and
 *   streaming growth while locked to bottom, and immediately disengaging on
 *   upward user intent so streaming never yanks a scrolled-up reader downward).
 * - `@tanstack/react-virtual` owns windowing, `ResizeObserver` measurement,
 *   virtual window sizing/offsetting (rendered via a single shifted normal-flow
 *   window container with `directDomUpdates: false`), and above-viewport
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
import { markTranscriptMounted } from '../lib/bootHydrationGate';
import { cssZoomFactor } from '../lib/uiZoom';

export type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

export const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 120;
export const TRANSCRIPT_ROW_GAP = 16;
export const TRANSCRIPT_TAIL_GAP = 12;
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

const activeScrollUntil = new WeakMap<HTMLElement, number>();
const pendingPostScrollReconcile = new WeakMap<TranscriptVirtualizer, ReturnType<typeof setTimeout>>();
const provisionalRowKeys = new WeakMap<TranscriptVirtualizer, Set<VirtualItem['key']>>();
const batchedDistanceFromEnd = new WeakMap<TranscriptVirtualizer, number>();

function markTranscriptScrolling(scroll: HTMLElement | null): void {
  if (scroll !== null) activeScrollUntil.set(scroll, performance.now() + 160);
}

function isActivelyScrolling(scroll: HTMLElement | null): boolean {
  return scroll !== null && (activeScrollUntil.get(scroll) ?? 0) > performance.now();
}

function hasLiveResizeObserver(instance: TranscriptVirtualizer, element?: Element | null): boolean {
  const win = instance.targetWindow
    ?? instance.scrollElement?.ownerDocument?.defaultView
    ?? element?.ownerDocument?.defaultView
    ?? (typeof window !== 'undefined' ? window : null);
  return win !== null && typeof win.ResizeObserver === 'function' && !/jsdom/i.test(win.navigator?.userAgent ?? '');
}

function getProvisionalSet(instance: TranscriptVirtualizer): Set<VirtualItem['key']> {
  let set = provisionalRowKeys.get(instance);
  if (set === undefined) {
    set = new Set();
    provisionalRowKeys.set(instance, set);
  }
  return set;
}

function readRowHeight(element: HTMLElement, entry?: ResizeObserverEntry): number {
  const boxSize = entry?.borderBoxSize?.[0]?.blockSize;
  if (boxSize !== undefined && boxSize > 0) return boxSize;
  const rectHeight = element.getBoundingClientRect().height;
  if (rectHeight > 0) return rectHeight / cssZoomFactor();
  return element.offsetHeight;
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
    markTranscriptMounted();
    const rawKey = instance.options.getItemKey(index);
    const modelKey = String(rawKey);
    const domKey = element.dataset['rowKey'];
    if (domKey !== undefined && domKey !== modelKey) {
      return instance.itemSizeCache.get(rawKey) ?? instance.options.estimateSize(index);
    }
    if (entry === undefined) {
      const cached = instance.itemSizeCache.get(rawKey);
      if (cached !== undefined && cached > 0) return cached;
      if (hasLiveResizeObserver(instance, element)) {
        // Defer initial row measurement to TanStack's native ResizeObserver so
        // React's ref-mount loop avoids N interleaved synchronous layout passes.
        getProvisionalSet(instance).add(rawKey);
        return instance.options.estimateSize(index);
      }
    } else {
      provisionalRowKeys.get(instance)?.delete(rawKey);
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
  let anchorTimer: ReturnType<typeof setTimeout> | undefined;

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
  // In real browsers avoid forcing synchronous layout on initial commit; the
  // ResizeObserver's initial delivery seeds `viewportHeight` without reflow.
  const liveRo = hasLiveResizeObserver(instance, scroll);
  const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
  let viewportHeight = liveRo && !isJsdom ? 0 : (scroll?.clientHeight ?? 0);
  let viewportOffset = liveRo && !isJsdom ? 0 : (scroll?.scrollTop ?? 0);
  const viewportObserver = scroll === null || typeof ResizeObserver === 'undefined'
    ? undefined
    : new ResizeObserver((entries) => {
      if (!scroll.isConnected) return;
      const nextHeight = (Array.isArray(entries) ? entries[0]?.contentRect?.height : undefined) || scroll.clientHeight;
      if (nextHeight === 0) return;
      if (viewportHeight === 0) {
        viewportHeight = nextHeight;
        viewportOffset = scroll.scrollTop;
        return;
      }
      if (nextHeight === viewportHeight) return;
      const previousHeight = viewportHeight;
      viewportHeight = nextHeight;
      const movedManually =
        Math.abs(scroll.scrollTop - viewportOffset) > 0.5 ||
        scroll.scrollHeight - previousHeight - scroll.scrollTop > TRANSCRIPT_END_THRESHOLD;
      if (movedManually) {
        stick.stop();
      } else if (
        stick.isFollowing() &&
        nextHeight < previousHeight &&
        scroll.scrollHeight - nextHeight - scroll.scrollTop > TRANSCRIPT_END_THRESHOLD
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
    anchor = undefined;
    markTranscriptScrolling(scroll);
    if (scroll !== null && scroll.isConnected) {
      viewportOffset = scroll.scrollTop;
    }
    if (anchorTimer !== undefined) clearTimeout(anchorTimer);
    anchorTimer = setTimeout(() => {
      anchorTimer = undefined;
      captureProseAnchor();
    }, 120);
  };
  const onWheel = (event: WheelEvent) => {
    markTranscriptScrolling(scroll);
    if (event.deltaY < 0) disengage();
  };
  const onTouchStart = (event: TouchEvent) => {
    lastTouchY = event.touches[0]?.clientY;
  };
  const onTouchMove = (event: TouchEvent) => {
    markTranscriptScrolling(scroll);
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
  let initialAnchorRaf: number | undefined;
  if (hasLiveResizeObserver(instance) && typeof requestAnimationFrame === 'function') {
    initialAnchorRaf = requestAnimationFrame(() => {
      initialAnchorRaf = undefined;
      captureProseAnchor();
    });
  } else {
    captureProseAnchor();
  }

  instance.shouldAdjustScrollPositionOnItemSizeChange = (item: VirtualItem) => {
    const element = instance.scrollElement;
    const scrollOffset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    const cachedDist = batchedDistanceFromEnd.get(instance);
    const distanceFromEnd = stick.isFollowing() && element instanceof HTMLElement
      ? (cachedDist ?? (element.scrollHeight - element.clientHeight - element.scrollTop))
      : Number.POSITIVE_INFINITY;
    if (shouldCompensateRowResize({
      itemStart: item.start,
      itemSize: item.size,
      firstMeasure: !instance.itemSizeCache.has(item.key) || (provisionalRowKeys.get(instance)?.has(item.key) ?? false),
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
    if (initialAnchorRaf !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(initialAnchorRaf);
    if (anchorTimer !== undefined) clearTimeout(anchorTimer);
    const postScroll = pendingPostScrollReconcile.get(instance);
    if (postScroll !== undefined) {
      clearTimeout(postScroll);
      pendingPostScrollReconcile.delete(instance);
    }
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
  // In real browsers TanStack's native ResizeObserver observes every mounted
  // row and delivers borderBoxSize before paint on any DOM height change;
  // watching the entire transcript subtree with MutationObserver + forced
  // getBoundingClientRect() causes redundant full-transcript reflows.
  if (hasLiveResizeObserver(instance, scroll)) return () => undefined;
  let queued = false;
  let active = true;
  let lastReconcileMs = 0;
  let scrollingUntil = 0;
  let rafId: number | undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const dirtyRows = new Set<HTMLDivElement>();
  const flush = () => {
    queued = false;
    rafId = undefined;
    timerId = undefined;
    if (!active || !scroll.isConnected) {
      dirtyRows.clear();
      return;
    }
    const now = performance.now();
    if (now < scrollingUntil) {
      if (hasLiveResizeObserver(instance)) {
        dirtyRows.clear();
        return;
      }
      queued = true;
      timerId = setTimeout(flush, Math.max(16, Math.ceil(scrollingUntil - now)));
      return;
    }
    if (dirtyRows.size === 0) return;
    const startedAt = performance.now();
    const rows = [...dirtyRows];
    dirtyRows.clear();
    reconcileMountedRows(instance, rows);
    lastReconcileMs = performance.now() - startedAt;
  };
  const markScrolling = () => {
    scrollingUntil = performance.now() + 140;
    markTranscriptScrolling(scroll);
  };
  scroll.addEventListener('scroll', markScrolling, { passive: true });
  scroll.addEventListener('touchmove', markScrolling, { passive: true });
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      const row = target?.closest<HTMLDivElement>('[data-row-key], [data-index]') ?? null;
      if (row instanceof HTMLDivElement && scroll.contains(row)) {
        dirtyRows.add(row);
      }
    }
    if (queued || dirtyRows.size === 0) return;
    queued = true;
    const now = performance.now();
    if (now < scrollingUntil) {
      if (hasLiveResizeObserver(instance)) {
        queued = false;
        dirtyRows.clear();
        return;
      }
      timerId = setTimeout(flush, Math.max(16, Math.ceil(scrollingUntil - now)));
    } else if ((hasLiveResizeObserver(instance) || lastReconcileMs >= 4) && typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(flush);
    } else {
      queueMicrotask(flush);
    }
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
    scroll.removeEventListener('scroll', markScrolling);
    scroll.removeEventListener('touchmove', markScrolling);
    if (rafId !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (timerId !== undefined) clearTimeout(timerId);
    dirtyRows.clear();
    observer.disconnect();
  };
}

/**
 * Re-read connected mounted rows (or a mutated subset) in a single read pass
 * before applying batched virtualizer resizes so DOM writes never interleave
 * with `offsetHeight` layout reads.
 */
export function reconcileMountedRows(
  instance: TranscriptVirtualizer,
  subset?: readonly HTMLDivElement[],
): boolean {
  const scroll = instance.scrollElement;
  if (scroll instanceof HTMLElement && !scroll.isConnected) return false;
  const liveRo = hasLiveResizeObserver(instance, scroll);
  const provisional = provisionalRowKeys.get(instance);
  // In real browsers TanStack's native ResizeObserver observes every mounted
  // row from attach and delivers exact borderBoxSize before first paint, so a
  // synchronous full-cache getBoundingClientRect() sweep inside useLayoutEffect
  // only forces a blocking Blink layout inside React's commit microtask.
  if (subset === undefined && liveRo) return false;
  if (scroll instanceof HTMLElement && scroll.clientHeight === 0) return false;
  const updates: { index: number; size: number }[] = [];
  if (subset !== undefined) {
    for (const element of subset) {
      if (!element.isConnected) continue;
      const index = instance.indexFromElement(element);
      if (index < 0 || index >= instance.options.count) continue;
      const key = instance.options.getItemKey(index);
      const domKey = element.dataset['rowKey'];
      if (domKey !== undefined && domKey !== String(key)) continue;
      const size = readRowHeight(element);
      provisional?.delete(key);
      const cached = instance.itemSizeCache.get(key);
      if (size > 0 && (cached === undefined || Math.abs(cached - size) > 0.5)) updates.push({ index, size });
    }
  } else {
    for (const [key, element] of instance.elementsCache) {
      if (!element.isConnected) continue;
      const index = instance.indexFromElement(element);
      if (index < 0 || index >= instance.options.count || instance.options.getItemKey(index) !== key) continue;
      const domKey = element.dataset['rowKey'];
      if (domKey !== undefined && domKey !== String(key)) continue;
      const cached = instance.itemSizeCache.get(key);
      // In real browsers TanStack's native ResizeObserver already watches every
      // measured row; re-reading already-measured rows on every rangeKey commit
      // forces redundant full-transcript layouts during scrolling and cold open.
      if (liveRo && cached !== undefined && !(provisional?.has(key) ?? false)) continue;
      const size = readRowHeight(element);
      provisional?.delete(key);
      if (size > 0 && (cached === undefined || Math.abs(cached - size) > 0.5)) updates.push({ index, size });
    }
  }
  if (updates.length > 0) {
    if (scroll instanceof HTMLElement) {
      batchedDistanceFromEnd.set(instance, scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop);
    }
    try {
      if (updates.length > 1) {
        // Suppress intermediate `onChange` notifications so `Transcript`'s
        // `onChange` (which writes `list.style.height` and reads `scrollHeight`)
        // runs once for the entire reconciled batch instead of N interleaved layouts.
        const savedOnChange = instance.options.onChange;
        instance.options.onChange = () => {};
        try {
          for (let i = 0; i < updates.length - 1; i += 1) {
            const update = updates[i]!;
            instance.resizeItem(update.index, update.size);
          }
        } finally {
          if (savedOnChange !== undefined) {
            instance.options.onChange = savedOnChange;
          } else {
            delete (instance.options as { onChange?: unknown }).onChange;
          }
        }
        const last = updates[updates.length - 1]!;
        instance.resizeItem(last.index, last.size);
      } else {
        const only = updates[0]!;
        instance.resizeItem(only.index, only.size);
      }
    } finally {
      batchedDistanceFromEnd.delete(instance);
    }
  }
  return updates.length > 0;
}
