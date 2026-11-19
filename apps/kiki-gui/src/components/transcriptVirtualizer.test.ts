// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Virtualizer, type VirtualItem } from '@tanstack/react-virtual';

import {
  installTranscriptAnchoring,
  observeRowMutations,
  shouldCompensateRowResize,
  type RowResize,
  type TranscriptStickController,
} from './transcriptVirtualizer';

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

describe('stick-to-bottom + shouldAdjustScrollPositionOnItemSizeChange integration', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

  function setup({ sizer, scrollTop, following = true }: { sizer: number; scrollTop: number; following?: boolean }) {
    const scroll = document.createElement('div');
    document.body.append(scroll);
    let top = scrollTop;
    let isFollowing = following;
    const changes: number[] = [];
    Object.defineProperty(scroll, 'clientHeight', { get: () => 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { get: () => sizer, configurable: true });
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        const next = Math.max(0, Math.min(value, sizer - 500));
        if (next === top) return;
        top = next;
        changes.push(next);
        scroll.dispatchEvent(new Event('scroll'));
      },
      configurable: true,
    });
    const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 4,
      getScrollElement: () => scroll,
      estimateSize: () => 300,
      getItemKey: (index) => `k${index}`,
      scrollEndThreshold: 80,
      scrollToFn: (offset, options) => { scroll.scrollTop = offset + (options.adjustments ?? 0); },
      observeElementRect: () => {},
      observeElementOffset: () => {},
    });
    instance.scrollElement = scroll;
    instance.scrollOffset = top;
    for (let i = 0; i < 4; i += 1) {
      instance.itemSizeCache.set(`k${i}`, 300);
      const row = document.createElement('div');
      row.setAttribute('data-transcript-virtual-item', '');
      row.dataset['index'] = String(i);
      row.dataset['rowKey'] = `k${i}`;
      scroll.append(row);
      instance.elementsCache.set(`k${i}`, row);
    }
    instance.getTotalSize();

    const landAtEnd = vi.fn(() => {
      isFollowing = true;
      scroll.scrollTop = sizer - 500;
      instance.scrollOffset = scroll.scrollTop;
    });
    const stop = vi.fn(() => {
      isFollowing = false;
    });
    const stick: TranscriptStickController = {
      isFollowing: () => isFollowing,
      stop,
      landAtEnd,
    };

    const cleanup = installTranscriptAnchoring(instance, stick);
    cleanups.push(() => { cleanup(); scroll.remove(); });
    return { scroll, instance, changes, stick, stop, landAtEnd };
  }

  it('keeps the bottom pinned on row growth while following bottom', () => {
    const test = setup({ sizer: 1400, scrollTop: 860, following: true });
    test.instance.resizeItem(3, 500);
    expect(test.scroll.scrollTop).toBe(900);
    expect(test.changes).toEqual([900]);
  });

  it('never yanks scrollTop downward after upward wheel, touch, scrollbar drag, or PageUp', () => {
    // 4 rows × 300px = 1200px virtual content; scrollTop 660 puts row 3 at [900..1200] (in/below viewport).
    const test = setup({ sizer: 1200, scrollTop: 660, following: true });
    test.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 }));
    expect(test.stop).toHaveBeenCalledTimes(1);
    expect(test.stick.isFollowing()).toBe(false);
    // Streaming row at bottom expands by +400px: must NOT move scrollTop.
    test.instance.resizeItem(3, 700);
    expect(test.scroll.scrollTop).toBe(660);
    expect(test.changes).toEqual([]);
  });

  it('disengages immediately on keyboard PageUp/ArrowUp/Home when not typing in an input', () => {
    const test = setup({ sizer: 1200, scrollTop: 660, following: true });
    test.scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(test.stick.isFollowing()).toBe(false);
    test.instance.resizeItem(3, 700);
    expect(test.scroll.scrollTop).toBe(660);
  });

  it('compensates above-viewport row resizes with 0px jump while scrolled away from bottom', () => {
    const test = setup({ sizer: 2000, scrollTop: 650, following: false });
    // Row 0 sits at [0..300], entirely above scrollTop 650. Growing it by +150px
    // shifts scrollTop by +150px so the visible reading line stays at 0px jump.
    test.instance.resizeItem(0, 450);
    expect(test.scroll.scrollTop).toBe(800);
    // Row 3 sits below scrollTop: growing it must NOT move scrollTop.
    test.instance.resizeItem(3, 900);
    expect(test.scroll.scrollTop).toBe(800);
  });

  it('does not yank when a disclosure click disengages stick-to-bottom right before expansion', () => {
    const test = setup({ sizer: 1400, scrollTop: 860, following: true });
    test.stick.stop();
    // Clicked row 3 (visible in viewport, not above scrollTop) expands from 300 -> 700.
    test.instance.resizeItem(3, 700);
    expect(test.scroll.scrollTop).toBe(860);
    expect(test.changes).toEqual([]);
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
    let following = false;
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
    const stick: TranscriptStickController = {
      isFollowing: () => following,
      stop: () => { following = false; },
      landAtEnd: () => { following = true; },
    };
    const cleanup = installTranscriptAnchoring(instance, stick);
    cleanups.push(() => { cleanup(); scroll.remove(); });
    const item: VirtualItem = { index: 0, key: 'answer', start: 900, size: 2000, end: 2900, lane: 0 };
    const resize = (delta = 440, changed = item) => instance.shouldAdjustScrollPositionOnItemSizeChange!(changed, delta, instance);
    return { scroll, row, instance, item, move, resize, setInset: (value: number) => { inset = value; }, setFollowing: (value: boolean) => { following = value; }, cleanup };
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
    test.setFollowing(true);
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

describe('a shrinking viewport', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function setup(scrollTop: number, initialFollowing: boolean) {
    const observers: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    const scroll = document.createElement('div');
    document.body.append(scroll);
    let height = 800;
    let following = initialFollowing;
    scroll.scrollTop = scrollTop;
    Object.defineProperties(scroll, {
      clientHeight: { get: () => height, configurable: true },
      scrollHeight: { value: 4000, configurable: true },
    });
    const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 0, getScrollElement: () => scroll, estimateSize: () => 100,
      scrollToFn: () => {}, observeElementRect: () => {}, observeElementOffset: () => {},
    });
    instance.scrollElement = scroll;
    const landAtEnd = vi.fn(() => { scroll.scrollTop = 4000 - height; following = true; });
    const stick: TranscriptStickController = {
      isFollowing: () => following,
      stop: () => { following = false; },
      landAtEnd,
    };
    const cleanup = installTranscriptAnchoring(instance, stick);
    const shrink = (next: number) => { height = next; for (const observer of observers) observer(); };
    return { scroll, landAtEnd, shrink, cleanup };
  }

  it('keeps a reader following the end at the end when the keyboard opens', () => {
    const test = setup(3200, true);
    test.shrink(450);
    expect(test.landAtEnd).toHaveBeenCalledOnce();
    expect(test.scroll.scrollTop).toBe(3550);
    test.cleanup();
  });

  it('does not pull an explicit history jump back to the end before its scroll event arrives', () => {
    const test = setup(3200, true);
    test.scroll.scrollTop = 1200;
    test.shrink(700);
    expect(test.landAtEnd).not.toHaveBeenCalled();
    expect(test.scroll.scrollTop).toBe(1200);
    test.shrink(450);
    expect(test.landAtEnd).not.toHaveBeenCalled();
    expect(test.scroll.scrollTop).toBe(1200);
    test.cleanup();
  });

  it('leaves a reader scrolled into history where they were', () => {
    const test = setup(1200, false);
    test.shrink(450);
    expect(test.landAtEnd).not.toHaveBeenCalled();
    expect(test.scroll.scrollTop).toBe(1200);
    test.cleanup();
  });

  it('never drags a reader back down when wheel-up is followed by a viewport shrink', () => {
    const test = setup(3200, true);
    test.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
    test.scroll.scrollTop = 2600;
    test.shrink(450);
    expect(test.landAtEnd).not.toHaveBeenCalled();
    expect(test.scroll.scrollTop).toBe(2600);
    test.cleanup();
  });
});

describe('hydrated row measurement', () => {
  it('reconciles text/disclosure mutations before the next paint and ignores disposed work', async () => {
    const scroll = document.createElement('div');
    const row = document.createElement('div');
    row.dataset['index'] = '0';
    scroll.append(row);
    document.body.append(scroll);
    let height = 120;
    Object.defineProperty(row, 'offsetHeight', { get: () => height });
    const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 1, getScrollElement: () => scroll, estimateSize: () => 120, getItemKey: () => 'row',
      scrollToFn: () => {}, observeElementRect: () => {}, observeElementOffset: () => {},
    });
    instance.elementsCache.set('row', row);
    instance.itemSizeCache.set('row', 120);
    const resize = vi.spyOn(instance, 'resizeItem');
    const dispose = observeRowMutations(scroll, instance);
    const text = document.createTextNode('preview');
    row.append(text);
    height = 640;
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
    expect(resize).toHaveBeenLastCalledWith(0, 640);
    resize.mockClear();
    height = 880;
    text.data = 'the complete asynchronous body';
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
    expect(resize).toHaveBeenLastCalledWith(0, 880);
    resize.mockClear();
    row.className = 'expanded';
    dispose();
    height = 1000;
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
    expect(resize).not.toHaveBeenCalled();
    scroll.remove();
  });
});
