// @vitest-environment jsdom

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createViewState, type SessionController, type SessionViewState } from '@kiki/session-core/session';
import {
  readComposerState,
  readDraft,
  resetComposerMemoryForTests,
  resetDraftMemoryForTests,
  writeComposerState,
  writeDraft,
} from '@kiki/session-core/composer';
import { API_CODES, ApiError } from './lib/client';
import { clearNavHistory, saveSnapshot } from './lib/navHistory';
import { getReadingSnapshot, timelineSnapshotKey, type TimelineReadingSnapshot } from './lib/navViewState';
import { SpaceViewState } from './components/SpaceViewState';
import { VIEW_CACHE_MAX_BYTES, VIEW_CACHE_MAX_PARKED, VIEW_CACHE_TTL_MS, type LiveControllerRegistry } from './state/connection';

const harness = vi.hoisted(() => ({
  scopeId: 'local',
  client: {
    getSession: (_sessionId: string): Promise<unknown> => Promise.resolve({ id: _sessionId }),
  },
  registry: null as LiveControllerRegistry | null,
}));

vi.mock('./host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('./i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./state/connection', async () => {
  const actual = await vi.importActual<typeof import('./state/connection')>('./state/connection');
  harness.registry = new actual.LiveControllerRegistry();
  return {
    ...actual,
    useConnection: () => ({ scopeId: harness.scopeId, client: harness.client }),
    useOptionalControllerRegistry: () => harness.registry,
  };
});

const TEXTS: Record<string, string> = {
  'sess-a': 'alpha body',
  'sess-b': 'beta body',
};

interface Counts {
  open: number;
  resume: number;
  suspend: number;
  close: number;
  factory: number;
}

const counts: Counts = { open: 0, resume: 0, suspend: 0, close: 0, factory: 0 };
const report: Record<string, unknown> = {};

function makeController(sessionId: string): SessionController {
  const state: SessionViewState = {
    ...createViewState(sessionId),
    loaded: true,
    transcriptReady: true,
    blocks: [{
      kind: 'user',
      id: `${sessionId}-user`,
      text: TEXTS[sessionId] ?? sessionId,
      createdAt: '2026-10-14T00:00:00.000Z',
    }],
  };
  let suspended = false;
  return {
    sessionId,
    open: () => {
      counts.open += 1;
      return Promise.resolve();
    },
    close: () => { counts.close += 1; },
    suspend: () => {
      counts.suspend += 1;
      suspended = true;
    },
    resume: () => {
      counts.resume += 1;
      suspended = false;
      return Promise.resolve();
    },
    get suspended() { return suspended; },
    residentBytes: () => 1024,
    getState: () => state,
    subscribe: () => () => {},
  } as unknown as SessionController;
}

function SessionSurface({ sessionId }: { sessionId: string }) {
  const { useConnection, useOptionalControllerRegistry } = connectionHooks;
  const registry = useOptionalControllerRegistry();
  const { client } = useConnection();
  const [shown, setShown] = useState<{ text: string; draft: string; anchor: string; model: string } | null>(null);
  useEffect(() => {
    if (registry === null) return;
    const lease = registry.acquire(sessionId, client, () => {
      counts.factory += 1;
      return makeController(sessionId);
    });
    const text = lease.controller.getState().blocks
      .flatMap((block) => block.kind === 'user' ? [block.text] : [])
      .join('');
    const anchor = getReadingSnapshot<TimelineReadingSnapshot>(`visit-${sessionId}`, timelineSnapshotKey(sessionId))?.anchor.key ?? '';
    setShown({
      text,
      draft: readDraft(sessionId),
      anchor,
      model: readComposerState(sessionId).modelOverride ?? '',
    });
    return () => { lease.release(); };
  }, [client, registry, sessionId]);
  if (shown === null) return <div data-surface={sessionId} data-phase="mounting" />;
  return (
    <div
      data-surface={sessionId}
      data-transcript={shown.text}
      data-draft={shown.draft}
      data-anchor={shown.anchor}
      data-model={shown.model}
    />
  );
}

let connectionHooks: typeof import('./state/connection');
let navigateRoute: NavigateFunction;
function LocationProbe() {
  navigateRoute = useNavigate();
  const location = useLocation();
  return <output data-path>{location.pathname}</output>;
}
function SessionRoute() {
  const location = useLocation();
  const sessionId = location.pathname.split('/')[2];
  if (sessionId === undefined || sessionId === '') return null;
  return <SpaceViewState><SessionSurface sessionId={sessionId} /></SpaceViewState>;
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let gate: 'open' | 'hold' | 'missing' = 'open';
const held = new Map<string, Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>>();
const sessionReads: string[] = [];

function finishHeld(sessionId: string | undefined, error?: unknown): void {
  const ids = sessionId === undefined ? [...held.keys()] : [sessionId];
  for (const id of ids) {
    const waiting = held.get(id) ?? [];
    held.set(id, []);
    for (const pending of waiting) {
      if (error === undefined) pending.resolve({ id });
      else pending.reject(error);
    }
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(route: string): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <LocationProbe />
          <Routes>
            <Route path="/new" element={<div data-home>Home</div>} />
            <Route path="/settings" element={<div data-page="settings">Settings</div>} />
            <Route path="/s/:id/*" element={<SessionRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function go(route: string): Promise<void> {
  await act(async () => { await navigateRoute(route); });
  await flush();
}

function shown(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-transcript]');
}

function rememberReading(sessionId: string, anchorKey: string): void {
  saveSnapshot(`visit-${sessionId}`, {
    pathname: `/s/${sessionId}`,
    search: '',
    hash: '',
    scope: { homeId: 'main', scopeId: 'local' },
    ui: {
      [timelineSnapshotKey(sessionId)]: {
        anchor: { atEnd: false, key: anchorKey, offset: sessionId === 'sess-a' ? 42 : 7 },
        openFolds: [],
      },
    },
  });
  writeDraft(sessionId, sessionId === 'sess-a' ? 'draft-a' : 'draft-b');
  writeComposerState(sessionId, {
    attachments: [],
    annotations: [],
    quotes: [],
    quote: null,
    permissionMode: undefined,
    planMode: undefined,
    planGate: undefined,
    goalObjective: '',
    modelOverride: sessionId === 'sess-a' ? 'model-a' : 'model-b',
    effortOverride: undefined,
  });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  connectionHooks = await import('./state/connection');
  harness.registry = new connectionHooks.LiveControllerRegistry();
  harness.scopeId = 'local';
  harness.client = {
    getSession: (sessionId: string) => {
      sessionReads.push(sessionId);
      if (gate === 'missing') {
        return Promise.reject(new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null }));
      }
      if (gate === 'hold') {
        return new Promise((resolve, reject) => {
          const waiting = held.get(sessionId) ?? [];
          waiting.push({ resolve, reject });
          held.set(sessionId, waiting);
        });
      }
      return Promise.resolve({ id: sessionId });
    },
  };
  counts.open = 0;
  counts.resume = 0;
  counts.suspend = 0;
  counts.close = 0;
  counts.factory = 0;
  gate = 'open';
  held.clear();
  sessionReads.length = 0;
  resetDraftMemoryForTests();
  resetComposerMemoryForTests();
  clearNavHistory();
  localStorage.clear();
  sessionStorage.clear();
  rememberReading('sess-a', 'anchor-a');
  rememberReading('sess-b', 'anchor-b');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
});

afterEach(async () => {
  await act(async () => { finishHeld(undefined); });
  await act(async () => { root.unmount(); });
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

function measureDirectory(): string {
  let dir = process.cwd();
  for (let hop = 0; hop < 5; hop += 1) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return resolve(dir, '.tmp/session-return-186');
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), '.tmp/session-return-186');
}

afterAll(() => {
  const directory = measureDirectory();
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'measure.json'), `${JSON.stringify(report, null, 2)}\n`);
});

describe('session return admission', () => {
  it('paints a parked conversation before getSession settles and still leaves when the session is gone', async () => {
    await render('/settings');
    gate = 'hold';
    const coldStarted = performance.now();
    await go('/s/sess-a');
    const coldMs = performance.now() - coldStarted;
    expect(shown()).toBeNull();
    expect(container.querySelector('[data-page="settings"]')).toBeNull();
    expect(container.textContent).toContain('sidebar.loadingSessions');
    expect(counts.factory).toBe(0);
    expect(counts.open).toBe(0);

    gate = 'open';
    await act(async () => { finishHeld('sess-a'); });
    await flush();
    expect(shown()?.getAttribute('data-transcript')).toBe('alpha body');
    expect(counts.factory).toBe(1);
    expect(counts.open).toBe(1);
    expect(counts.resume).toBe(0);

    await go('/settings');
    expect(shown()).toBeNull();
    expect(harness.registry?.parkedCount).toBe(1);
    expect([...(harness.registry ?? [])]).toEqual([]);
    expect(harness.registry?.hasRetained('sess-a', harness.client)).toBe(true);
    expect(counts.suspend).toBe(1);
    expect(counts.close).toBe(0);

    const readsBeforeReturn = sessionReads.length;
    gate = 'hold';
    const warmStarted = performance.now();
    await go('/s/sess-a');
    const warmMs = performance.now() - warmStarted;
    const warm = shown();
    expect(warm?.getAttribute('data-transcript')).toBe('alpha body');
    expect(warm?.getAttribute('data-draft')).toBe('draft-a');
    expect(warm?.getAttribute('data-anchor')).toBe('anchor-a');
    expect(warm?.getAttribute('data-model')).toBe('model-a');
    expect(readDraft('sess-b')).toBe('draft-b');
    expect(readComposerState('sess-b').modelOverride).toBe('model-b');
    expect(held.get('sess-a')?.length).toBeGreaterThan(0);
    expect(sessionReads.length).toBe(readsBeforeReturn + 1);
    expect(counts.open).toBe(1);
    expect(counts.factory).toBe(1);
    expect(counts.resume).toBe(1);
    expect(counts.close).toBe(0);

    gate = 'missing';
    await act(async () => {
      finishHeld('sess-a', new ApiError({ code: API_CODES.SESSION_NOT_FOUND, msg: 'session.not_found', data: null }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1150)); });
    await flush();
    expect(container.querySelector('[data-home]')).not.toBeNull();
    expect(shown()).toBeNull();

    report['cold'] = {
      contentVisibleWhileGetSessionPending: false,
      flushMs: Math.round(coldMs),
      factoryCalls: 0,
      openCalls: 0,
    };
    report['warmSettingsReturn'] = {
      contentVisibleWhileGetSessionPending: true,
      flushMs: Math.round(warmMs),
      getSessionStarted: true,
      getSessionSettledBeforePaint: false,
      openCalls: 1,
      resumeCalls: 1,
      factoryCalls: 1,
      closeCalls: 0,
      liveRoster: 0,
      parked: 1,
    };
  });

  it('keeps history, draft and identity through three transient return failures and retry', async () => {
    await render('/s/sess-a');
    expect(shown()?.getAttribute('data-transcript')).toBe('alpha body');
    for (let visit = 0; visit < 3; visit++) {
      await go('/settings');
      gate = 'hold';
      await go('/s/sess-a');
      const retained = shown();
      await act(async () => { finishHeld('sess-a', new Error('temporary session index read failure')); });
      await flush();
      expect(container.querySelector('[data-path]')?.textContent).toBe('/s/sess-a');
      expect(container.querySelector('[data-home]')).toBeNull();
      expect(shown()).toBe(retained);
      expect(shown()?.getAttribute('data-transcript')).toBe('alpha body');
      expect(shown()?.getAttribute('data-draft')).toBe('draft-a');
      expect(shown()?.getAttribute('data-model')).toBe('model-a');
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('temporary session index read failure');
      gate = 'open';
      await act(async () => { container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); });
      await flush();
      expect(shown()).toBe(retained);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    }
    expect(counts.factory).toBe(1);
    expect(counts.open).toBe(1);
    expect(counts.resume).toBe(3);
    expect(counts.close).toBe(0);
  });

  it('switches A and B from the parked store without mixing scroll or drafts', async () => {
    await render('/s/sess-a');
    expect(shown()?.getAttribute('data-transcript')).toBe('alpha body');
    await go('/s/sess-b');
    expect(shown()?.getAttribute('data-transcript')).toBe('beta body');
    expect(shown()?.getAttribute('data-draft')).toBe('draft-b');
    expect(shown()?.getAttribute('data-anchor')).toBe('anchor-b');
    expect(counts.factory).toBe(2);
    expect(counts.open).toBe(2);
    expect(harness.registry?.parkedCount).toBe(1);
    expect(counts.close).toBe(0);

    const readsBefore = sessionReads.length;
    gate = 'hold';
    const started = performance.now();
    await go('/s/sess-a');
    const switchMs = performance.now() - started;
    const back = shown();
    expect(back?.getAttribute('data-surface')).toBe('sess-a');
    expect(back?.getAttribute('data-transcript')).toBe('alpha body');
    expect(back?.getAttribute('data-draft')).toBe('draft-a');
    expect(back?.getAttribute('data-anchor')).toBe('anchor-a');
    expect(back?.getAttribute('data-model')).toBe('model-a');
    expect(readDraft('sess-b')).toBe('draft-b');
    expect(getReadingSnapshot<TimelineReadingSnapshot>('visit-sess-b', timelineSnapshotKey('sess-b'))?.anchor.key).toBe('anchor-b');
    expect(held.get('sess-a')?.length).toBeGreaterThan(0);
    expect(sessionReads.length).toBe(readsBefore + 1);
    expect(counts.factory).toBe(2);
    expect(counts.open).toBe(2);
    expect(counts.resume).toBe(1);
    expect(counts.close).toBe(0);

    await act(async () => { finishHeld('sess-a'); });
    gate = 'hold';
    await go('/s/sess-b');
    expect(shown()?.getAttribute('data-transcript')).toBe('beta body');
    expect(shown()?.getAttribute('data-draft')).toBe('draft-b');
    expect(shown()?.getAttribute('data-model')).toBe('model-b');
    expect(readDraft('sess-a')).toBe('draft-a');
    expect(counts.resume).toBe(2);
    expect(counts.close).toBe(0);
    expect(harness.registry?.parkedCount).toBe(1);
    expect(VIEW_CACHE_MAX_PARKED).toBeGreaterThanOrEqual(2);
    expect(VIEW_CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(VIEW_CACHE_TTL_MS).toBe(5 * 60_000);

    report['switch'] = {
      flushMs: Math.round(switchMs),
      contentVisibleWhileGetSessionPending: true,
      shown: 'alpha body',
      draft: 'draft-a',
      otherDraft: 'draft-b',
      anchor: 'anchor-a',
      otherAnchor: 'anchor-b',
      factoryCalls: counts.factory,
      openCalls: counts.open,
      resumeCalls: 2,
      closeCalls: 0,
      parkedWhileOneIsLive: 1,
      maxParked: VIEW_CACHE_MAX_PARKED,
    };
  });

  it('does not paint another connection\'s parked transcript', async () => {
    await render('/s/sess-a');
    const firstClient = harness.client;
    await go('/settings');
    expect(harness.registry?.hasRetained('sess-a', firstClient)).toBe(true);
    harness.scopeId = 'remote:other';
    harness.client = {
      getSession: (sessionId: string) => {
        sessionReads.push(sessionId);
        return new Promise((resolve, reject) => {
          const waiting = held.get(sessionId) ?? [];
          waiting.push({ resolve, reject });
          held.set(sessionId, waiting);
        });
      },
    };
    gate = 'hold';
    await go('/s/sess-a');
    expect(shown()).toBeNull();
    expect(container.textContent).toContain('sidebar.loadingSessions');
    expect(harness.registry?.hasRetained('sess-a', harness.client)).toBe(false);
    expect(harness.registry?.hasRetained('sess-a', firstClient)).toBe(true);
    expect(counts.factory).toBe(1);
    report['otherConnectionPainted'] = false;
  });

  it('keeps a cold return blocked for the whole getSession while a parked return has already painted', async () => {
    const delayMs = 400;
    await render('/settings');
    gate = 'hold';
    const coldStart = performance.now();
    await go('/s/sess-a');
    expect(shown()).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, delayMs)); });
    const coldBlockedMs = performance.now() - coldStart;
    expect(shown()).toBeNull();
    expect(coldBlockedMs).toBeGreaterThanOrEqual(delayMs - 30);
    gate = 'open';
    await act(async () => { finishHeld('sess-a'); });
    await flush();
    expect(shown()?.getAttribute('data-transcript')).toBe('alpha body');

    await go('/settings');
    gate = 'hold';
    const warmStart = performance.now();
    await go('/s/sess-a');
    const warmPaintMs = performance.now() - warmStart;
    expect(shown()?.getAttribute('data-transcript')).toBe('alpha body');
    expect(held.get('sess-a')?.length).toBeGreaterThan(0);
    expect(warmPaintMs).toBeLessThan(delayMs);
    report['timed'] = {
      getSessionDelayMs: delayMs,
      // Old admission treated a parked session like this: no retained hit, so the
      // transcript stays unmounted for the whole getSession.
      unretainedBlockedMs: Math.round(coldBlockedMs),
      parkedReturnPaintMs: Math.round(warmPaintMs),
      parkedReturnPaintedWhileGetSessionPending: true,
    };
  });
});
