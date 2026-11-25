// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useSidebarInfiniteDemand,
  type SidebarInfiniteDemandState,
  type UseSidebarInfiniteDemandOptions,
} from './useSidebarInfiniteDemand';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

function renderDemand(initial: UseSidebarInfiniteDemandOptions) {
  let latest!: SidebarInfiniteDemandState;
  function Harness({ props }: { props: UseSidebarInfiniteDemandOptions }) {
    const state = useSidebarInfiniteDemand(props);
    useEffect(() => { latest = state; });
    latest = state;
    return null;
  }
  const update = (next: UseSidebarInfiniteDemandOptions) => {
    act(() => { root.render(<Harness props={next} />); });
  };
  update(initial);
  return {
    get state() { return latest; },
    update,
  };
}

describe('useSidebarInfiniteDemand', () => {
  it('never auto-fetches in zero-height jsdom or inactive states, while manual click still works', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const base: UseSidebarInfiniteDemandOptions = {
      active: true,
      queryGeneration: 'gen-1',
      measuredViewportHeight: 0,
      visibleContentHeight: 200,
      overscanPx: 368,
      scrollTop: 0,
      lastVirtualIndex: 5,
      contentRowCount: 6,
      target: { sourceKey: 'main', cursor: 'c1', fetch: fetchFn },
      isFetchingNext: false,
    };
    const harness = renderDemand(base);
    expect(fetchFn).not.toHaveBeenCalled();

    // Inactive (e.g. Search / Inbox / inert drawer / collapsed rail) with positive viewport also never fetches.
    harness.update({ ...base, active: false, measuredViewportHeight: 640 });
    expect(fetchFn).not.toHaveBeenCalled();

    // Manual button click works even in zero-height jsdom.
    harness.update(base);
    await act(async () => {
      harness.state.requestNextPage('manual');
      await Promise.resolve();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fires at most 1 page on downward end-zone entry and never re-arms on re-render or collapse scroll clamp', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const base: UseSidebarInfiniteDemandOptions = {
      active: true,
      queryGeneration: 'gen-1',
      measuredViewportHeight: 600,
      visibleContentHeight: 2000,
      overscanPx: 368,
      scrollTop: 0,
      lastVirtualIndex: 20,
      contentRowCount: 50,
      target: { sourceKey: 'main', cursor: 'c1', fetch: fetchFn },
      isFetchingNext: false,
    };
    const harness = renderDemand(base);
    expect(fetchFn).not.toHaveBeenCalled();

    // Scroll downward into end zone -> triggers exactly 1 fetch.
    await act(async () => {
      harness.state.notifyScroll(1500);
      harness.update({ ...base, scrollTop: 1500, lastVirtualIndex: 49 });
      await Promise.resolve();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Staying intersected on re-render with new cursor does NOT re-arm without leaving & re-entering downward.
    await act(async () => {
      harness.update({
        ...base,
        scrollTop: 1500,
        lastVirtualIndex: 59,
        contentRowCount: 60,
        target: { sourceKey: 'main', cursor: 'c2', fetch: fetchFn },
      });
      await Promise.resolve();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Collapse scroll clamp (scrollTop decreases) leaving & re-entering does NOT re-arm.
    await act(async () => {
      harness.state.notifyScroll(1200);
      harness.update({
        ...base,
        scrollTop: 1200,
        lastVirtualIndex: 40,
        contentRowCount: 60,
        target: { sourceKey: 'main', cursor: 'c2', fetch: fetchFn },
      });
      harness.update({
        ...base,
        scrollTop: 1200,
        lastVirtualIndex: 59,
        contentRowCount: 60,
        target: { sourceKey: 'main', cursor: 'c2', fetch: fetchFn },
      });
      await Promise.resolve();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stops underfill probes after one zero-growth page (coldFold) and surfaces retry on error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined);
    const base: UseSidebarInfiniteDemandOptions = {
      active: true,
      queryGeneration: 'gen-underfill',
      measuredViewportHeight: 800,
      visibleContentHeight: 300,
      overscanPx: 200,
      scrollTop: 0,
      lastVirtualIndex: 5,
      contentRowCount: 6,
      target: { sourceKey: 'main', cursor: 'c1', fetch: fetchFn },
      isFetchingNext: false,
    };
    const harness = renderDemand(base);
    await act(async () => { await Promise.resolve(); });
    // First underfill probe fires because 300 < 800 + 200.
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Next cursor arrives, but visibleContentHeight stayed 300 (coldFold hid all appended rows) -> STOP!
    await act(async () => {
      harness.update({
        ...base,
        target: { sourceKey: 'main', cursor: 'c2', fetch: fetchFn },
      });
      await Promise.resolve();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Error circuit breaker + explicit manual retry.
    const failing = vi.fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(undefined);
    await act(async () => {
      harness.update({
        ...base,
        queryGeneration: 'gen-err',
        target: { sourceKey: 'main', cursor: 'c_err', fetch: failing },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(harness.state.error).toBe('network blip');

    await act(async () => {
      harness.state.requestNextPage('retry');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(failing).toHaveBeenCalledTimes(2);
    expect(harness.state.error).toBeNull();
  });

  it('locks synchronously on (source, generation, cursor) so competing requests do not duplicate', async () => {
    let resolveFlight!: () => void;
    const fetchFn = vi.fn(() => new Promise<void>((resolve) => { resolveFlight = resolve; }));
    const base: UseSidebarInfiniteDemandOptions = {
      active: true,
      queryGeneration: 'gen-lock',
      measuredViewportHeight: 0,
      visibleContentHeight: 200,
      overscanPx: 300,
      scrollTop: 0,
      lastVirtualIndex: 3,
      contentRowCount: 4,
      target: { sourceKey: 'main', cursor: 'c_lock', fetch: fetchFn },
      isFetchingNext: false,
    };
    const harness = renderDemand(base);
    act(() => {
      harness.state.requestNextPage('manual');
      harness.state.requestNextPage('manual');
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFlight();
      await Promise.resolve();
    });
  });
});
