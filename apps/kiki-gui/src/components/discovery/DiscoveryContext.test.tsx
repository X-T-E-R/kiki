// @vitest-environment jsdom

import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EMPTY_DISCOVERY_STATE,
  type DiscoveryState,
} from '@kiki/session-core/discovery';

import { browserHost, HostProvider } from '../../host';
import { I18nProvider } from '../../i18n';
import { ConnectionContext, type ConnectionValue } from '../../state/connection';
import { DirtyGuardContext, useDirtyGuardState, type GuardedNavigate } from '../dirtyGuard';
import { SidebarContext } from '../sidebarContext';
import { DiscoveryProvider, discoveryDestinationHref } from './DiscoveryContext';
import { DiscoveryPage } from './DiscoveryPage';

describe('discoveryDestinationHref', () => {
  it('routes the usage-filter anchor to the history panel that mounts it', () => {
    expect(discoveryDestinationHref({ href: '/usage', anchor: 'usage-filter' })).toBe('/usage?panel=history');
  });

  it('appends the panel after an existing query', () => {
    expect(discoveryDestinationHref({ href: '/usage?metric=tokens', anchor: 'usage-filter' })).toBe('/usage?metric=tokens&panel=history');
  });

  it('leaves an explicit panel parameter alone', () => {
    expect(discoveryDestinationHref({ href: '/usage?panel=quota', anchor: 'usage-filter' })).toBe('/usage?panel=quota');
  });

  it('leaves every other destination untouched', () => {
    expect(discoveryDestinationHref({ href: '/memory', anchor: 'memory-scope' })).toBe('/memory');
    expect(discoveryDestinationHref({ href: '/new', anchor: 'workspace-picker' })).toBe('/new');
    expect(discoveryDestinationHref({ href: '/usage' })).toBe('/usage');
  });
});

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

function DiscoveryHarness({ initialState }: { readonly initialState: DiscoveryState }) {
  const location = useLocation();
  const navigate = useNavigate();
  const rawNavigate = useCallback<GuardedNavigate>((target, options) => {
    if (typeof target === 'number') void navigate(target);
    else void navigate(target, options);
  }, [navigate]);
  const guard = useDirtyGuardState(location, rawNavigate);
  return (
    <DirtyGuardContext.Provider value={guard.value}>
      <DiscoveryProvider initialState={initialState}>
        <Routes>
          <Route path="/discover" element={<DiscoveryPage onToggleSidebar={() => {}} />} />
          <Route path="*" element={<div data-landed-route>{location.pathname}{location.search}</div>} />
        </Routes>
        <output data-test-location>{location.pathname}{location.search}</output>
        <button type="button" data-test-dirty onClick={() => { guard.value.reportDirty('editor', true); }}>Dirty</button>
        {guard.pending ? (
          <>
            <button type="button" data-test-cancel onClick={guard.cancel}>Stay</button>
            <button type="button" data-test-confirm onClick={() => { void guard.confirm(); }}>Leave</button>
          </>
        ) : null}
      </DiscoveryProvider>
    </DirtyGuardContext.Provider>
  );
}

async function mountDiscover(initialState: DiscoveryState): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const connectionValue = {
    scopeId: 'local',
    wsStatus: 'open',
    client: null,
    localClient: null,
  } as unknown as ConnectionValue;
  await act(async () => {
    root.render(
      <HostProvider host={browserHost}>
        <QueryClientProvider client={queryClient}>
          <ConnectionContext.Provider value={connectionValue}>
            <SidebarContext.Provider value={{ sidebarOpen: false }}>
              <I18nProvider>
                <MemoryRouter initialEntries={['/discover']}>
                  <DiscoveryHarness initialState={initialState} />
                </MemoryRouter>
              </I18nProvider>
            </SidebarContext.Provider>
          </ConnectionContext.Provider>
        </QueryClientProvider>
      </HostProvider>,
    );
  });
  return container;
}

describe('DiscoveryPage route map and guarded navigation', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem('kiki.locale', 'en');
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    for (const container of containers.splice(0)) container.remove();
  });

  it('renders on bg-paper, reflects actual overview and topic checkpoints without writing progress on view', async () => {
    const partialState: DiscoveryState = {
      ...EMPTY_DISCOVERY_STATE,
      lifecycle: 'left',
      route: 'overview',
      station: 'memory',
      progress: {
        workspace: { seen: true, tried: true, skipped: false },
        agents: { seen: false, tried: false, skipped: true },
      },
    };
    const container = await mountDiscover(partialState);
    const page = container.querySelector('[data-discovery-page]')!;
    expect(page.className).toContain('bg-paper');
    expect(page.className).not.toContain('bg-canvas');

    // Five actual registered overview stations with distinct states.
    const stations = [...container.querySelectorAll('[data-discovery-overview-rail] [data-discovery-station]')];
    expect(stations.map((el) => [el.getAttribute('data-discovery-station'), el.getAttribute('data-discovery-station-state')]))
      .toEqual([
        ['workspace', 'tried'],
        ['agents', 'skipped'],
        ['memory', 'resumable'],
        ['capabilities', 'unvisited'],
        ['cron', 'unvisited'],
      ]);

    // Resume strip names the exact checkpoint.
    expect(container.querySelector('[data-discovery-resume]')?.textContent).toContain('stop 3');

    // Topic routes stay understand / sustain / extend and distinguish skipped from seen.
    const topics = [...container.querySelectorAll('[data-start-route]')].map((el) => el.getAttribute('data-start-route'));
    expect(topics).toEqual(['understand', 'sustain', 'extend']);
    const understandStatus = container.querySelector('[data-start-route="understand"] [data-discovery-route-status]')!.textContent;
    expect(understandStatus).toContain('Skipped');
    expect(understandStatus).not.toContain('Viewed');

    // Viewing /discover never writes progress to storage.
    expect(localStorage.getItem('kiki.settings')).toBeNull();
  });

  it('respects dirtyGuard when starting or resuming a route from /discover', async () => {
    const resumableState: DiscoveryState = {
      ...EMPTY_DISCOVERY_STATE,
      lifecycle: 'left',
      route: 'sustain',
      station: 'memory',
      progress: {},
    };
    const container = await mountDiscover(resumableState);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-test-dirty]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-discovery-resume] button')!.click(); });

    // Guard intercepts navigation; cancelling stays on /discover without committing state.
    expect(container.querySelector('[data-test-cancel]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-test-cancel]')!.click(); });
    expect(container.querySelector('[data-test-location]')!.textContent).toBe('/discover');

    // Confirming allows navigation to the checkpoint destination.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-discovery-resume] button')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-test-confirm]')!.click(); });
    expect(container.querySelector('[data-test-location]')!.textContent).toBe('/memory');
  });

  it('distinguishes finished topic routes (all seen or with skips) from merely viewed or abandoned routes', async () => {
    // 1. Finished topic route where every station was seen (never collapses into "Viewed").
    const finishedAllSeen: DiscoveryState = {
      ...EMPTY_DISCOVERY_STATE,
      lifecycle: 'finished',
      route: 'understand',
      station: 'usage',
      progress: {
        agents: { seen: true, tried: false, skipped: false },
        direction: { seen: true, tried: false, skipped: false },
        usage: { seen: true, tried: true, skipped: false },
        // Sustain stops also all seen (e.g. via another route), but sustain itself was NOT finished.
        memory: { seen: true, tried: false, skipped: false },
        cron: { seen: true, tried: false, skipped: false },
        // Extend has one seen + one skipped, not finished.
        capabilities: { seen: true, tried: false, skipped: false },
        extensions: { seen: false, tried: false, skipped: true },
      },
    };
    const seenContainer = await mountDiscover(finishedAllSeen);
    const understandFinished = seenContainer.querySelector('[data-start-route="understand"] [data-discovery-route-status]')!.textContent;
    const sustainViewed = seenContainer.querySelector('[data-start-route="sustain"] [data-discovery-route-status]')!.textContent;
    const extendPartial = seenContainer.querySelector('[data-start-route="extend"] [data-discovery-route-status]')!.textContent;
    expect(understandFinished).toBe('End of this route');
    expect(sustainViewed).toBe('Viewed');
    expect(extendPartial).toContain('1/2');
    expect(extendPartial).toContain('1 skipped');

    // 2. Finished topic route with skipped stations preserves both completion and skipped count.
    const finishedWithSkips: DiscoveryState = {
      ...EMPTY_DISCOVERY_STATE,
      lifecycle: 'finished',
      route: 'understand',
      station: 'usage',
      progress: {
        agents: { seen: true, tried: false, skipped: false },
        direction: { seen: true, tried: false, skipped: false },
        usage: { seen: false, tried: false, skipped: true },
      },
    };
    const skippedContainer = await mountDiscover(finishedWithSkips);
    const understandFinishedSkipped = skippedContainer.querySelector('[data-start-route="understand"] [data-discovery-route-status]')!.textContent;
    expect(understandFinishedSkipped).toContain('End of this route');
    expect(understandFinishedSkipped).toContain('1 skipped');
  });
});
