// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Virtualizer, type VirtualItem } from '@tanstack/react-virtual';

import { installTranscriptAnchoring, noteReaderDisclosure, shouldCompensateRowResize, type RowResize } from './transcriptVirtualizer';

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


describe('a reader disclosure click', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

  /**
   * A scroll box that records every write it takes in `changes`, and clamps a
   * write to the height its size container currently reports.
   */
  function setup({ sizer, scrollTop }: { sizer: number; scrollTop: number }) {
    const scroll = document.createElement('div');
    document.body.append(scroll);
    const sizerHeight = sizer;
    let top = scrollTop;
    const changes: number[] = [];
    Object.defineProperty(scroll, 'clientHeight', { get: () => 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { get: () => sizerHeight, configurable: true });
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        const next = Math.max(0, Math.min(value, sizerHeight - 500));
        if (next === top) return;
        top = next;
        changes.push(next);
        scroll.dispatchEvent(new Event('scroll'));
      },
      configurable: true,
    });
    const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 2, getScrollElement: () => scroll, estimateSize: () => 300, getItemKey: (index) => `k${index}`,
      anchorTo: 'end', scrollEndThreshold: 80,
      scrollToFn: (offset, options) => { scroll.scrollTop = offset + (options.adjustments ?? 0); },
      observeElementRect: () => {}, observeElementOffset: () => {},
    });
    instance.scrollElement = scroll;
    instance.scrollOffset = top;
    instance.itemSizeCache.set('k0', 300);
    instance.itemSizeCache.set('k1', 300);
    const rows = [0, 1].map((index) => {
      const row = document.createElement('div');
      row.setAttribute('data-transcript-virtual-item', '');
      row.dataset['index'] = String(index);
      row.innerHTML = '<button type="button" data-activity-toggle></button>';
      scroll.append(row);
      return row;
    });
    instance.elementsCache.set('k0', rows[0]!);
    instance.elementsCache.set('k1', rows[1]!);
    instance.getTotalSize();
    const cleanup = installTranscriptAnchoring(instance);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cleanup();
    };
    cleanups.push(() => { dispose(); scroll.remove(); });
    return {
      scroll, instance, changes, rows, dispose,
      settle: () => new Promise<void>((resolve) => { setTimeout(resolve, 40); }),
    };
  }

  it('follows the end when the row that grows is content, not a gesture', async () => {
    // The observed defect this guards: a reader 40px above the end grows a row
    // and the near-end rule carries them the whole delta, to the end.
    const test = setup({ sizer: 1400, scrollTop: 860 });
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([900]);
    expect(test.scroll.scrollTop).toBe(900);
  });

  it('keeps the reader where they clicked when they open a row at the end', async () => {
    const test = setup({ sizer: 1400, scrollTop: 860 });
    noteReaderDisclosure(test.instance, test.rows[1]!.querySelector('[data-activity-toggle]'));
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([900, 860]);
    expect(test.scroll.scrollTop).toBe(860);
    expect(test.instance.scrollOffset).toBe(860);
    await test.settle();
    expect(test.scroll.scrollTop).toBe(860);
  });

  it('spends the hold on the size change the click caused', async () => {
    const test = setup({ sizer: 1400, scrollTop: 860 });
    noteReaderDisclosure(test.instance, test.rows[1]!.querySelector('[data-activity-toggle]'));
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([900, 860]);
    // A later change on that row is content growing, not the gesture: the hold is
    // spent once. (The harness stays near the end, so the follow's write shows
    // here; with the row grown, the reader is past the end in the app.)
    test.instance.resizeItem(1, 760);
    expect(test.changes).toEqual([900, 860, 900]);
    expect(test.scroll.scrollTop).toBe(900);
  });

  it('waits for an actual size change before spending the hold', async () => {
    const test = setup({ sizer: 1400, scrollTop: 860 });
    noteReaderDisclosure(test.instance, test.rows[1]!.querySelector('[data-activity-toggle]'));
    // A measure that reports the size the row already had is not the disclosure.
    test.instance.resizeItem(1, 300);
    expect(test.changes).toEqual([]);
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([900, 860]);
    expect(test.scroll.scrollTop).toBe(860);
  });

  it('carries the reader place with content that moves the viewport', async () => {
    // Another row's growth is followed at the near end, as content should be:
    // the reader moves with it, and the click still holds against their own row
    // instead of restoring an offset that follow has left behind.
    const test = setup({ sizer: 2000, scrollTop: 860 });
    noteReaderDisclosure(test.instance, test.rows[1]!.querySelector('[data-activity-toggle]'));
    test.instance.resizeItem(0, 500);
    expect(test.changes).toEqual([1060]);
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([1060, 1460, 1060]);
    expect(test.scroll.scrollTop).toBe(1060);
  });

  it('gives the viewport back once the reader has scrolled from the click', async () => {
    const test = setup({ sizer: 1400, scrollTop: 860 });
    noteReaderDisclosure(test.instance, test.rows[1]!.querySelector('[data-activity-toggle]'));
    // The reader moves before the row's resize lands. The click's offset is
    // stale: the near-end follow owns the viewport, and the old offset is not
    // written back over the reader's own position.
    test.scroll.scrollTop = 890;
    test.instance.scrollOffset = 890;
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([890, 900]);
    expect(test.scroll.scrollTop).toBe(900);
  });

  it('gives the viewport back when the reader wheels the transcript', async () => {
    const test = setup({ sizer: 1400, scrollTop: 860 });
    noteReaderDisclosure(test.instance, test.rows[1]!.querySelector('[data-activity-toggle]'));
    test.scroll.dispatchEvent(new Event('wheel'));
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([900]);
    expect(test.scroll.scrollTop).toBe(900);
  });

  it('stops holding once the clicked row is gone, and does not keep it for a row that returns', async () => {
    const test = setup({ sizer: 2000, scrollTop: 860 });
    noteReaderDisclosure(test.instance, test.rows[1]!.querySelector('[data-activity-toggle]'));
    // A trim, a fold, or a tab switch replaced the row the reader clicked. The
    // click is dropped there, not kept against the subtree it referenced.
    test.rows[1]!.remove();
    test.instance.resizeItem(0, 500);
    expect(test.changes).toEqual([1060]);
    // A row at that index again is not the click: the follow owns the viewport.
    test.scroll.append(test.rows[1]!);
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([1060, 1460]);
    expect(test.scroll.scrollTop).toBe(1460);
  });

  it('stops holding once the anchoring it belongs to is disposed', async () => {
    const test = setup({ sizer: 1400, scrollTop: 860 });
    noteReaderDisclosure(test.instance, test.rows[1]!.querySelector('[data-activity-toggle]'));
    test.dispose();
    test.instance.resizeItem(1, 700);
    expect(test.changes).toEqual([900]);
    expect(test.scroll.scrollTop).toBe(900);
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
