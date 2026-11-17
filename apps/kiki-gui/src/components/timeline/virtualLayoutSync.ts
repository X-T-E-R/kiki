import type { Virtualizer } from '@tanstack/react-virtual';

import { measureTranscriptRow } from '../transcriptVirtualizer';

export type TranscriptDomVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

const pendingBatchSizes = new WeakMap<HTMLDivElement, number>();
let batchDomSyncDepth = 0;

export function isInTranscriptBatchDomSync(): boolean {
  return batchDomSyncDepth > 0;
}

const NOOP_ON_CHANGE: TranscriptDomVirtualizer['options']['onChange'] = () => {};

function readLaidOutHeight(element: HTMLElement): number {
  return Math.round(element.offsetHeight);
}

/**
 * Guard `ResizeObserver` / `measureElement` reads against React render-phase
 * `instance.setOptions(...)` updates that advance `getItemKey(index)` before
 * React commits the new `data-index` attributes onto mounted row elements.
 */
export function guardTranscriptRowMeasure(
  element: HTMLDivElement,
  entry: ResizeObserverEntry | undefined,
  instance: TranscriptDomVirtualizer,
): number {
  const index = instance.indexFromElement(element);
  if (index >= 0 && index < instance.options.count) {
    const modelKey = String(instance.options.getItemKey(index));
    const domKey = element.dataset['rowKey'];
    if (domKey !== undefined && domKey !== modelKey) {
      return instance.itemSizeCache.get(modelKey) ?? instance.options.estimateSize(index);
    }
  }
  const batched = pendingBatchSizes.get(element);
  if (batched !== undefined && entry === undefined) {
    return batched;
  }
  return measureTranscriptRow(element, entry, instance);
}

/**
 * Ensure a mounted row is registered in `elementsCache` and measured
 * synchronously even while `instance.isScrolling` is true (where
 * `@tanstack/virtual-core` skips synchronous `measureElement` measurement and
 * leaves newly mounted scroll rows at the 120px height estimate).
 */
export function measureMountedTranscriptRow(
  element: HTMLDivElement,
  index: number,
  rowKey: string,
  instance: TranscriptDomVirtualizer,
): void {
  if (!element.isConnected || index < 0 || index >= instance.options.count) return;
  if (String(instance.options.getItemKey(index)) !== rowKey) return;
  const scroll = instance.scrollElement;
  const canMeasure = !(scroll instanceof HTMLElement && (!scroll.isConnected || scroll.clientHeight === 0));
  const size = canMeasure ? readLaidOutHeight(element) : 0;
  if (size > 0) pendingBatchSizes.set(element, size);
  try {
    if (instance.elementsCache.get(rowKey) !== element) {
      instance.measureElement(element);
    }
    if (size > 0 && instance.itemSizeCache.get(rowKey) !== size) {
      instance.resizeItem(index, size);
    }
  } finally {
    if (size > 0) pendingBatchSizes.delete(element);
  }
}

export function virtualWindowSignature(instance: TranscriptDomVirtualizer): string {
  return instance.getVirtualItems().map((item) => `${item.index}:${String(item.key)}`).join('\n');
}

function writeTranscriptVirtualPositions(
  content: HTMLElement,
  instance: TranscriptDomVirtualizer,
  mounted: Iterable<HTMLDivElement>,
): void {
  const totalSize = instance.getTotalSize();
  const measurements = instance.measurementsCache;
  const scrollMargin = instance.options.scrollMargin;
  const expectedHeight = `${totalSize}px`;
  if (content.style.height !== expectedHeight) {
    content.style.height = expectedHeight;
  }
  const seenKeys = new Set<string>();
  for (const element of mounted) {
    const index = instance.indexFromElement(element);
    const domKey = element.dataset['rowKey'];
    const measurement = index >= 0 && index < measurements.length ? measurements[index] : undefined;
    const modelKey = measurement === undefined ? undefined : String(measurement.key);
    const valid =
      measurement !== undefined &&
      modelKey !== undefined &&
      (domKey === undefined || domKey === modelKey) &&
      !seenKeys.has(modelKey);
    if (valid) {
      seenKeys.add(modelKey);
      const expectedTop = `${measurement.start - scrollMargin}px`;
      if (element.style.top !== expectedTop) {
        element.style.top = expectedTop;
      }
      if (element.style.visibility === 'hidden') {
        element.style.visibility = '';
        element.style.pointerEvents = '';
      }
    } else {
      element.style.visibility = 'hidden';
      element.style.pointerEvents = 'none';
    }
  }
}

/**
 * Synchronize every mounted `[data-transcript-virtual-item]` element's `style.top`
 * against the virtualizer's authoritative measurements.
 */
export function syncTranscriptVirtualPositions(
  scroll: HTMLElement | null,
  instance: TranscriptDomVirtualizer,
): void {
  if (scroll === null || !scroll.isConnected || scroll.clientHeight === 0) return;
  const content = scroll.querySelector<HTMLElement>('[data-transcript-virtual-content]');
  if (content === null) return;
  const mounted = content.querySelectorAll<HTMLDivElement>('[data-transcript-virtual-item]');
  writeTranscriptVirtualPositions(content, instance, mounted);
}

/**
 * Reconcile mounted row heights and synchronize virtualized `style.top` offsets
 * using a strict two-phase batch-read (`offsetHeight`) then batch-write (`style.top`)
 * pass to avoid interleaved layout reflows during streaming or history expansion.
 */
export function syncTranscriptVirtualDom(
  scroll: HTMLElement | null,
  instance: TranscriptDomVirtualizer,
): string {
  if (scroll === null || !scroll.isConnected || scroll.clientHeight === 0) {
    return virtualWindowSignature(instance);
  }
  const content = scroll.querySelector<HTMLElement>('[data-transcript-virtual-content]');
  const mounted = content === null
    ? []
    : [...content.querySelectorAll<HTMLDivElement>('[data-transcript-virtual-item]')];

  // Phase 1: pure DOM layout reads across all connected rows before any style mutation.
  const visited = new Set<HTMLDivElement>();
  const candidates: HTMLDivElement[] = [];
  for (const element of mounted) {
    if (!visited.has(element)) {
      visited.add(element);
      candidates.push(element);
    }
  }
  for (const cached of instance.elementsCache.values()) {
    if (cached.isConnected && !visited.has(cached)) {
      visited.add(cached);
      candidates.push(cached);
    }
  }

  const reads: Array<{ element: HTMLDivElement; index: number; modelKey: string; size: number }> = [];
  for (const element of candidates) {
    if (!element.isConnected) continue;
    const index = instance.indexFromElement(element);
    if (index < 0 || index >= instance.options.count) continue;
    const modelKey = String(instance.options.getItemKey(index));
    const domKey = element.dataset['rowKey'];
    if (domKey !== undefined && domKey !== modelKey) continue;
    const size = readLaidOutHeight(element);
    if (size > 0) pendingBatchSizes.set(element, size);
    reads.push({ element, index, modelKey, size });
  }

  // Phase 2: silence `instance.options.onChange` while applying resizes so
  // `@tanstack/react-virtual` neither runs `applyDirectStyles` nor triggers
  // `captureTranscriptAnchor` per row, then batch-write DOM positions once.
  const savedOnChange = instance.options.onChange;
  let anyResized = false;
  batchDomSyncDepth += 1;
  instance.options.onChange = NOOP_ON_CHANGE;
  try {
    for (const { element, modelKey } of reads) {
      if (instance.elementsCache.get(modelKey) !== element) {
        instance.measureElement(element);
      }
    }
    for (const { index, modelKey, size } of reads) {
      if (size > 0 && instance.itemSizeCache.get(modelKey) !== size) {
        anyResized = true;
        instance.resizeItem(index, size);
      }
    }
  } finally {
    instance.options.onChange = savedOnChange;
    batchDomSyncDepth -= 1;
    for (const { element } of reads) {
      pendingBatchSizes.delete(element);
    }
  }

  if (content !== null) {
    writeTranscriptVirtualPositions(content, instance, mounted);
  }
  if (anyResized && savedOnChange !== undefined) {
    savedOnChange(instance, false);
  }
  return virtualWindowSignature(instance);
}
