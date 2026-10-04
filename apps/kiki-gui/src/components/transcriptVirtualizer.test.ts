// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Virtualizer, type VirtualItem } from '@tanstack/react-virtual';

import { installTranscriptAnchoring, shouldCompensateRowResize, type RowResize } from './transcriptVirtualizer';

const base: RowResize = {
  itemStart: 0,
  itemSize: 120,
  firstMeasure: false,
  scrollOffset: 1000,
  distanceFromEnd: 500,
  endThreshold: 80,
};

describe('shouldCompensateRowResize', () => {
  it('keeps the bottom pinned while following the end, wherever the row is', () => {
    expect(shouldCompensateRowResize({ ...base, itemStart: 1200, distanceFromEnd: 40 })).toBe(true);
  });

  it('compensates a re-measured row that sits entirely above the viewport', () => {
    expect(shouldCompensateRowResize({ ...base, itemStart: 700, itemSize: 300 })).toBe(true);
  });

  it('does not drag the view for a row spanning the viewport top', () => {
    // A long answer streaming, or a block the reader just expanded.
    expect(shouldCompensateRowResize({ ...base, itemStart: 900, itemSize: 400 })).toBe(false);
  });

  it('does not move the view for rows below the viewport top', () => {
    expect(shouldCompensateRowResize({ ...base, itemStart: 1100 })).toBe(false);
  });

  it('corrects a first measurement whose estimated top was above the viewport', () => {
    expect(shouldCompensateRowResize({ ...base, itemStart: 950, firstMeasure: true })).toBe(true);
    expect(shouldCompensateRowResize({ ...base, itemStart: 1000, firstMeasure: true })).toBe(false);
  });
});


describe('in-row prose anchoring', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

  function setup() {
    const scroll = document.createElement('div');
    const row = document.createElement('div');
    row.dataset['index'] = '0';
    row.innerHTML = '<div class="kiki-md"><p>Reading paragraph</p></div>';
    scroll.append(row);
    document.body.append(scroll);
    scroll.scrollTop = 1000;
    Object.defineProperties(scroll, { clientHeight: { value: 500, configurable: true }, scrollHeight: { value: 4000, configurable: true } });
    const rect = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 760, width: 760, height, toJSON: () => ({}) });
    let inset = 130;
    vi.spyOn(scroll, 'getBoundingClientRect').mockImplementation(() => rect(0, scroll.clientHeight));
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(900 - scroll.scrollTop, 2000));
    vi.spyOn(row.querySelector('p')!, 'getBoundingClientRect').mockImplementation(() => rect(900 + inset - scroll.scrollTop, 70));
    const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 1, getScrollElement: () => scroll, estimateSize: () => 2000, getItemKey: () => 'answer',
      scrollToFn: () => {}, observeElementRect: () => {}, observeElementOffset: () => {},
    });
    instance.scrollElement = scroll;
    instance.scrollOffset = scroll.scrollTop;
    instance.elementsCache.set('answer', row);
    instance.itemSizeCache.set('answer', 2000);
    const move = vi.spyOn(instance, 'scrollToOffset').mockImplementation((offset) => { scroll.scrollTop = offset; });
    const cleanup = installTranscriptAnchoring(instance);
    cleanups.push(() => { cleanup(); scroll.remove(); });
    const item: VirtualItem = { index: 0, key: 'answer', start: 900, size: 2000, end: 2900, lane: 0 };
    const resize = (delta = 440, changed = item) => instance.shouldAdjustScrollPositionOnItemSizeChange!(changed, delta, instance);
    return { scroll, row, instance, item, move, resize, setInset: (value: number) => { inset = value; }, cleanup };
  }

  it('compensates only the prose inset, not the entire row growth, without replaying it', () => {
    const test = setup();
    test.setInset(250);
    expect(test.resize()).toBe(false);
    expect(test.move).toHaveBeenCalledExactlyOnceWith(1120, { align: 'start' });
    expect(test.instance.scrollOffset).toBe(1120);
    expect(test.resize()).toBe(false);
    expect(test.move).toHaveBeenCalledTimes(1);
  });

  it('leaves growth below the visible prose to the original non-compensating row model', () => {
    const test = setup();
    expect(test.resize()).toBe(false);
    expect(test.move).not.toHaveBeenCalled();
  });

  it('retains the original entire-row-above and near-bottom compensation without a second command', () => {
    const test = setup();
    test.setInset(250);
    expect(test.resize(440, { ...test.item, start: 0, size: 500, end: 500 })).toBe(true);
    test.scroll.scrollTop = 3450;
    test.instance.scrollOffset = 3450;
    expect(test.resize()).toBe(true);
    expect(test.move).not.toHaveBeenCalled();
  });

  it('does not reuse stale prose after user movement, replacement, hidden layout or disposal', () => {
    const moved = setup();
    moved.scroll.scrollTop += 100;
    moved.setInset(250);
    expect(moved.resize()).toBe(false);
    expect(moved.move).not.toHaveBeenCalled();
    const replaced = setup();
    replaced.instance.elementsCache.set('answer', document.createElement('div'));
    replaced.setInset(250);
    expect(replaced.resize()).toBe(false);
    expect(replaced.move).not.toHaveBeenCalled();
    const hidden = setup();
    Object.defineProperty(hidden.scroll, 'clientHeight', { value: 0 });
    hidden.setInset(250);
    expect(hidden.resize()).toBe(false);
    expect(hidden.move).not.toHaveBeenCalled();
    const disposed = setup();
    disposed.cleanup();
    disposed.setInset(250);
    expect(disposed.resize()).toBe(false);
    expect(disposed.move).not.toHaveBeenCalled();
  });
});
