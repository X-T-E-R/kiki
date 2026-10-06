// @vitest-environment jsdom

import { act, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canGoBack, canGoForward, clearNavHistory, getCurrentVisit, getVisitForLocation, recordNavigation } from './navHistory';
import { getReadingSnapshot, previewSnapshotKey, readPreviewSnapshot, readTimelineSnapshot, saveReadingSnapshot, timelineSnapshotKey, type TimelineReadingSnapshot } from './navViewState';
import { restoreTimelineReading, type TimelineReadingAdapter } from './timelineReading';
import { locateInTimeline, locateSpawnTarget, registerTimelineLocator, resetTimelineLocatorsForTests, timelineTargetKey, type TimelineTarget } from './timelineLocate';
import { useNavSnapshotAdapter } from './useNavSnapshot';
import { useTimelineNavigation, useTimelineVisitLocator } from './useTimelineNavigation';
import { DirtyGuardContext, useDirtyGuardState, type GuardedNavigate } from '../components/dirtyGuard';

const scope = { homeId: 'main', scopeId: 'local' };
const reading = (key: string, atEnd = false): TimelineReadingSnapshot => ({ anchor: { key, atEnd, offset: 17 }, openFolds: ['fold:t1'] });
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearNavHistory();
  resetTimelineLocatorsForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => { root?.unmount(); });
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

function recordVisit(key: string, pathname = '/s/example') {
  return recordNavigation({ location: { key, pathname, search: '', hash: '' }, scope, action: 'PUSH' });
}

function adapter(overrides: Partial<TimelineReadingAdapter> = {}): TimelineReadingAdapter {
  return {
    applyFolds: vi.fn(), hasAnchor: () => true, hasMore: () => false, loadOlder: async () => false,
    hasLoadError: () => false, nextFrame: async () => {}, restoreAnchor: vi.fn(), beginRestore: vi.fn(), endRestore: vi.fn(), ...overrides,
  };
}

describe('N2 reading snapshots', () => {
  it('keeps separate old positions for two visits to the same session', () => {
    const first = recordVisit('a');
    saveReadingSnapshot(first.visitId, timelineSnapshotKey('example'), reading('old'));
    const second = recordVisit('b');
    saveReadingSnapshot(second.visitId, timelineSnapshotKey('example'), reading('new'));
    expect(getReadingSnapshot<TimelineReadingSnapshot>(first.visitId, timelineSnapshotKey('example'))?.anchor.key).toBe('old');
    expect(getReadingSnapshot<TimelineReadingSnapshot>(second.visitId, timelineSnapshotKey('example'))?.anchor.key).toBe('new');
    expect(getVisitForLocation({ key: 'a', pathname: '/s/example', search: '', hash: '' })?.visitId).toBe(first.visitId);
    expect(getCurrentVisit()?.visitId).toBe(second.visitId);
  });

  it('whitelists reading geometry, not messages, credentials or edit buffers', () => {
    const visit = recordVisit('a');
    saveReadingSnapshot(visit.visitId, timelineSnapshotKey('example'), { ...reading('row'), text: 'private-message', token: 'private-token' });
    saveReadingSnapshot(visit.visitId, previewSnapshotKey('example'), {
      tabsState: { tabs: [{ kind: 'file', path: '/example.md', buffer: 'private-draft' }, { kind: 'panel', agentId: 'child' }], active: 'panel:child' },
      panelOpen: true, positions: { '/example.md': { top: 87 }, 'panel:child': { top: 120 }, removed: { top: 20 } }, buffer: 'private-draft',
    });
    const persisted = sessionStorage.getItem('kiki.navHistory.v1')!;
    expect(persisted).not.toMatch(/private-message|private-token|private-draft|removed/);
    const preview = getReadingSnapshot(visit.visitId, previewSnapshotKey('example'));
    expect(preview).toEqual({ tabsState: { tabs: [{ kind: 'file', path: '/example.md' }, { kind: 'panel', agentId: 'child', title: undefined }], active: 'panel:child' }, panelOpen: true,
      positions: { '/example.md': { top: 87, left: undefined }, 'panel:child': { top: 120, left: undefined } } });
    expect(readTimelineSnapshot({ ...reading('row'), anchor: { atEnd: false, offset: Infinity } })).toBeUndefined();
    expect(readPreviewSnapshot({ tabsState: { tabs: [] }, panelOpen: true })?.panelOpen).toBe(false);
  });

  it('restores folds before paging and exact anchor; old reader is never landed at end', async () => {
    const order: string[] = [];
    let loaded = false;
    const a = adapter({ applyFolds: () => { order.push('folds'); }, hasAnchor: () => loaded, hasMore: () => !loaded,
      loadOlder: async () => { order.push('page'); loaded = true; return true; },
      restoreAnchor: (anchor) => { order.push(`anchor:${anchor.key}:${anchor.offset}:${anchor.atEnd}`); } });
    expect(await restoreTimelineReading(reading('old'), a)).toEqual({ status: 'found' });
    expect(order).toEqual(['folds', 'page', 'anchor:old:17:false']);
    expect(a.beginRestore).toHaveBeenCalledWith(false);
  });

  it('atEnd follows latest without fetching stale history', async () => {
    const a = adapter({ hasAnchor: () => false, loadOlder: vi.fn(async () => true) });
    expect(await restoreTimelineReading(reading('old', true), a)).toEqual({ status: 'found' });
    expect(a.loadOlder).not.toHaveBeenCalled();
    expect(a.restoreAnchor).toHaveBeenCalledWith(reading('old', true).anchor);
  });

  it('returns to a saved visit beyond forty pages, stopping at its exact anchor', async () => {
    const saved = reading('far-history');
    let pages = 0;
    const a = adapter({ hasAnchor: () => pages === 43, hasMore: () => true,
      loadOlder: vi.fn(async () => { pages += 1; return true; }) });
    expect(await restoreTimelineReading(saved, a)).toEqual({ status: 'found' });
    expect(a.loadOlder).toHaveBeenCalledTimes(43);
    expect(a.restoreAnchor).toHaveBeenCalledWith(saved.anchor);
    expect(saved.anchor).toEqual({ key: 'far-history', atEnd: false, offset: 17 });
  });

  it('separates deletion from temporary page failure, and permits retry', async () => {
    const missing = adapter({ hasAnchor: () => false });
    expect(await restoreTimelineReading(reading('deleted'), missing)).toEqual({ status: 'not-found' });
    expect(missing.restoreAnchor).not.toHaveBeenCalled();
    let loaded = false;
    let fails = true;
    const retryable = adapter({ hasAnchor: () => loaded, hasMore: () => true, hasLoadError: () => fails,
      loadOlder: async () => { if (fails) throw new Error('offline'); loaded = true; return true; } });
    expect(await restoreTimelineReading(reading('old'), retryable)).toEqual({ status: 'load-failed' });
    fails = false;
    expect(await restoreTimelineReading(reading('old'), retryable)).toEqual({ status: 'found' });
    expect(retryable.endRestore).toHaveBeenNthCalledWith(1, { status: 'load-failed' });
  });

  it('stops a cancelled reading intent after its shared page returns, without scrolling or continuing', async () => {
    let cancelled = false;
    const a = adapter({ hasAnchor: () => false, hasMore: () => true, isCancelled: () => cancelled,
      loadOlder: vi.fn(async () => { cancelled = true; return true; }) });
    expect(await restoreTimelineReading(reading('far'), a)).toEqual({ status: 'no-timeline' });
    expect(a.loadOlder).toHaveBeenCalledTimes(1);
    expect(a.restoreAnchor).not.toHaveBeenCalled();
  });

  it('nested locateSpawn includes parent agent and this child card', () => {
    expect(locateSpawnTarget('example', 'child', 'parent')).toEqual({ route: '/s/example/agent/parent', target: { kind: 'subagent', agentId: 'child' }, options: { sessionId: 'example', agentId: 'parent' } });
    expect(locateSpawnTarget('example', 'child').route).toBe('/s/example');
    expect(timelineTargetKey({ kind: 'turn', turnId: '3' })).toBe(timelineTargetKey({ kind: 'turn', turnId: 't3' }));
  });
});

describe('N2 Router + snapshot adapter', () => {
  it('holds a failed snapshot through departure and exposes a retry for that same visit', async () => {
    const location = { key: 'saved-reading', pathname: '/s/example', search: '', hash: '' };
    const visit = recordNavigation({ location, scope, action: 'PUSH' });
    const key = timelineSnapshotKey('example');
    saveReadingSnapshot(visit.visitId, key, reading('original'));
    let position = reading('temporary');
    let fails = true;
    let retry!: () => void;
    const errors = vi.fn();
    const signals: AbortSignal[] = [];
    const restore = vi.fn(async (value: TimelineReadingSnapshot, signal: AbortSignal) => {
      signals.push(signal);
      if (fails) throw new Error('offline');
      position = value;
    });
    function Content() {
      retry = useNavSnapshotAdapter(key, { capture: () => position, restore, onRestoreError: errors }).retryRestore;
      return <div>reading</div>;
    }
    function Page() {
      const location = useLocation();
      const action = useNavigationType();
      useLayoutEffect(() => { recordNavigation({ location, scope, action }); }, [location, action]);
      return location.pathname === '/away' ? <div>away</div> : <Content />;
    }
    const router = createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: [location] });
    root = createRoot(container);
    await act(async () => { root!.render(<RouterProvider router={router} />); });
    expect(errors).toHaveBeenCalledOnce();
    await act(async () => { await router.navigate('/away'); });
    expect(signals[0]!.aborted).toBe(true);
    expect(getReadingSnapshot<TimelineReadingSnapshot>(visit.visitId, key)?.anchor.key).toBe('original');
    await act(async () => { await router.navigate(-1); });
    expect(restore).toHaveBeenCalledTimes(2);
    fails = false;
    await act(async () => { retry(); });
    expect(restore).toHaveBeenCalledTimes(3);
    expect(position.anchor.key).toBe('original');
    position = reading('after-success');
    await act(async () => { await router.navigate('/away'); });
    expect(getReadingSnapshot<TimelineReadingSnapshot>(visit.visitId, key)?.anchor.key).toBe('after-success');
  });

  it('same URL jumps return/forward per visit, deduplicate current targets and discard forward on a new jump', async () => {
    let position = reading('start');
    let activeTarget: TimelineTarget | undefined;
    let jump: ReturnType<typeof useTimelineNavigation>;
    const located: string[] = [];
    const restored: string[] = [];
    function Page() {
      const location = useLocation();
      const action = useNavigationType();
      useLayoutEffect(() => { recordNavigation({ location, scope, action }); }, [location, action]);
      useNavSnapshotAdapter(timelineSnapshotKey('example'), {
        capture: () => position,
        restore: (value: TimelineReadingSnapshot) => { position = value; activeTarget = undefined; restored.push(value.anchor.key!); },
      });
      jump = useTimelineNavigation();
      useLayoutEffect(() => {
        return registerTimelineLocator('example', 'main', { isVisible: () => true,
          isAtTarget: (target) => activeTarget !== undefined && timelineTargetKey(activeTarget) === timelineTargetKey(target),
          locate: async (target) => { activeTarget = target; const key = timelineTargetKey(target); located.push(key); position = reading(key); return { status: 'found' }; },
        });
      }, []);
      useTimelineVisitLocator('example');
      return <div>{location.key}</div>;
    }
    const router = createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: ['/s/example'] });
    root = createRoot(container);
    await act(async () => { root!.render(<RouterProvider router={router} />); });
    const start = getCurrentVisit()!.visitId;
    await act(async () => { jump!({ kind: 'turn', turnId: '5' }, { sessionId: 'example' }); });
    const middle = getCurrentVisit()!.visitId;
    expect(middle).not.toBe(start);
    expect(located).toHaveLength(1);
    await act(async () => { jump!({ kind: 'turn', turnId: 't5' }, { sessionId: 'example' }); });
    expect(getCurrentVisit()!.visitId).toBe(middle);
    await act(async () => { jump!({ kind: 'turn', turnId: '8' }, { sessionId: 'example' }); });
    await act(async () => { await router.navigate(-1); });
    expect(restored.at(-1)).toBe(timelineTargetKey({ kind: 'turn', turnId: '5' }));
    expect(located).toHaveLength(2); // returning does not replay the stale locator
    expect(canGoForward()).toBe(true);
    await act(async () => { await router.navigate(-1); });
    expect(restored.at(-1)).toBe('start');
    expect(canGoBack()).toBe(false);
    await act(async () => { await router.navigate(1); });
    expect(getCurrentVisit()!.visitId).toBe(middle);
    await act(async () => { jump!({ kind: 'turn', turnId: '9' }, { sessionId: 'example' }); });
    expect(canGoForward()).toBe(false);
  });
});

describe('N2 same-URL dirty POP', () => {
  it('cancel keeps the visit, preview and unsaved editor owner on same-URL Back', async () => {
    let guard: ReturnType<typeof useDirtyGuardState>;
    let jump: ReturnType<typeof useTimelineNavigation>;
    const buffer = { text: 'unsaved-local-draft' };
    const tabs = { tabsState: { tabs: [{ kind: 'file' as const, path: '/example.md' }, { kind: 'panel' as const, agentId: 'child' }], active: 'panel:child' }, panelOpen: true, positions: { '/example.md': { top: 56 } } };
    let restored = 0;
    function Content() {
      jump = useTimelineNavigation();
      useNavSnapshotAdapter(previewSnapshotKey('example'), { capture: () => tabs, restore: () => { restored += 1; } });
      return <textarea defaultValue={buffer.text} />;
    }
    function Shell() {
      const location = useLocation();
      const action = useNavigationType();
      const navigate = useNavigate();
      const rawNavigate: GuardedNavigate = (to, options) => { if (typeof to === 'number') void navigate(to); else void navigate(to, options); };
      guard = useDirtyGuardState(location, rawNavigate);
      useLayoutEffect(() => { recordNavigation({ location, scope, action }); }, [location, action]);
      return <DirtyGuardContext.Provider value={guard.value}><Content /></DirtyGuardContext.Provider>;
    }
    const router = createMemoryRouter([{ path: '*', element: <Shell /> }], { initialEntries: ['/s/example'] });
    root = createRoot(container);
    await act(async () => { root!.render(<RouterProvider router={router} />); });
    await act(async () => { jump!({ kind: 'turn', turnId: '5' }, { sessionId: 'example' }); });
    const visitId = getCurrentVisit()!.visitId;
    const editor = container.querySelector('textarea');
    await act(async () => { guard!.value.reportDirty('file:/example.md', true); });
    await act(async () => { await router.navigate(-1); });
    expect(guard!.pending).toBe(true);
    expect(getCurrentVisit()!.visitId).toBe(visitId);
    act(() => { guard!.cancel(); });
    expect(guard!.pending).toBe(false);
    expect(getCurrentVisit()!.visitId).toBe(visitId);
    expect(container.querySelector('textarea')).toBe(editor);
    expect(container.querySelector('textarea')!.value).toBe(buffer.text);
    expect(restored).toBe(0);
    expect(sessionStorage.getItem('kiki.navHistory.v1')).not.toContain(buffer.text);
    await act(async () => { jump!({ kind: 'subagent', agentId: 'child' }, { sessionId: 'example', agentId: 'child', route: '/s/example/agent/child' }); });
    expect(guard!.pending).toBe(true);
    expect(getCurrentVisit()!.visitId).toBe(visitId);
    act(() => { guard!.cancel(); });
    expect(router.state.location.pathname).toBe('/s/example');
  });
});

describe('N2 cancelled visits', () => {
  it('aborts a pending mount locator before a later visit mounts the same agent', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => { callback(0); }, 1));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { window.clearTimeout(id); });
    try {
      const controller = new AbortController();
      const pending = locateInTimeline({ kind: 'turn', turnId: 'old' }, { sessionId: 'example', notify: false, signal: controller.signal });
      controller.abort();
      expect(await pending).toEqual({ status: 'no-timeline' });
      const locate = vi.fn(async () => ({ status: 'found' as const }));
      registerTimelineLocator('example', 'main', { isVisible: () => true, locate });
      expect(locate).not.toHaveBeenCalled();
      expect(await locateInTimeline({ kind: 'turn', turnId: 'new' }, { sessionId: 'example', notify: false })).toEqual({ status: 'found' });
      expect(locate).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not scroll a cancelled anchor after a historical page resolves', async () => {
    let cancelled = false;
    let loaded = false;
    const a = adapter({ hasAnchor: () => loaded, hasMore: () => true, isCancelled: () => cancelled,
      loadOlder: async () => { cancelled = true; loaded = true; return true; } });
    expect(await restoreTimelineReading(reading('old'), a)).toEqual({ status: 'no-timeline' });
    expect(a.restoreAnchor).not.toHaveBeenCalled();
    const alreadyCancelled = adapter({ isCancelled: () => true });
    expect(await restoreTimelineReading(reading('old'), alreadyCancelled)).toEqual({ status: 'no-timeline' });
    expect(alreadyCancelled.applyFolds).not.toHaveBeenCalled();
  });
});

describe('N2 routed main and agent visits', () => {
  it('captures raw Router departures and returns each agent to its own older position', async () => {
    let currentReading: TimelineReadingSnapshot;
    let setReading: (value: TimelineReadingSnapshot) => void;
    function Content({ agentId }: { agentId: string }) {
      const readingRef = useRef(reading(`initial:${agentId}`));
      setReading = (value) => { readingRef.current = value; currentReading = value; };
      useNavSnapshotAdapter(timelineSnapshotKey('example', agentId), {
        capture: () => readingRef.current,
        restore: (value: TimelineReadingSnapshot) => { readingRef.current = value; currentReading = value; },
      });
      return <div>{agentId}</div>;
    }
    function Shell() {
      const location = useLocation();
      const action = useNavigationType();
      const agentId = location.pathname.split('/agent/')[1] ?? 'main';
      useLayoutEffect(() => { recordNavigation({ location, scope, action }); }, [location, action]);
      return <Content key={agentId} agentId={agentId} />;
    }
    const router = createMemoryRouter([{ path: '*', element: <Shell /> }], { initialEntries: ['/s/example'] });
    root = createRoot(container);
    await act(async () => { root!.render(<RouterProvider router={router} />); });
    setReading!(reading('main:old'));
    await act(async () => { await router.navigate('/s/example/agent/first'); });
    setReading!(reading('first:old'));
    await act(async () => { await router.navigate('/s/example/agent/second'); });
    setReading!(reading('second:old'));
    await act(async () => { await router.navigate(-1); });
    expect(currentReading!.anchor.key).toBe('first:old');
    await act(async () => { await router.navigate(-1); });
    expect(currentReading!.anchor.key).toBe('main:old');
    await act(async () => { await router.navigate(1); });
    expect(currentReading!.anchor.key).toBe('first:old');
  });
});
