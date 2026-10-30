// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App, SESSION_FIRST_PAGE_POLL_INTERVAL_MS, isEditableTarget } from './App';
import { HostProvider, browserHost } from './host';
import { I18nProvider } from './i18n';
import { PageHeader } from './components/PageChrome';
import { canAbortActiveTurn, shouldHandleGlobalAbortOnEscape } from './components/SessionView';
import { anyOverlayOpen } from './lib/uiBusy';
import { clearNavHistory } from './lib/navHistory';
import { configureSpaceStorage } from './lib/spaceStorage';
import { retryRootReadModelDelay, retryRootReadModelQuery } from './lib/readModelRetry';
import { resolveFallbackPhase } from './components/ConversationShell';
import { ApiError } from './lib/client';
import { shouldGuardNavigation } from './components/dirtyGuard';
import { handleGlobalConnectionFrame, refreshSessionAttention } from './state/connection';

const appHarness = vi.hoisted(() => ({ connection: null as unknown }));

const updateHarness = vi.hoisted(() => ({
  options: null as { hasPendingApproval?: boolean; isDesktop?: boolean } | null,
  offer: null as unknown,
  onUpdate: vi.fn(),
}));

vi.mock('./lib/useDesktopUpdateScheduler', () => ({
  UPDATE_DIALOG_OVERLAY: 'update-available',
  useDesktopUpdateScheduler: (options: { hasPendingApproval?: boolean; isDesktop?: boolean }) => {
    updateHarness.options = options;
    return {
      offer: updateHarness.offer,
      onUpdate: updateHarness.onUpdate,
      onRemindLater: vi.fn(async () => {}),
      onSkip: vi.fn(async () => {}),
      onDismiss: vi.fn(),
      installing: false,
      installError: null,
      persistError: null,
    };
  },
}));

vi.mock('./state/connection', async (importOriginal) => ({
  ...await importOriginal<typeof import('./state/connection')>(),
  useConnection: () => appHarness.connection,
  useOptionalConnection: () => appHarness.connection,
  useOptionalControllerRegistry: () => null,
}));
vi.mock('./components/SessionView', async (importOriginal) => ({
  ...await importOriginal<typeof import('./components/SessionView')>(),
  SessionRouteView: () => null,
}));
// Keep the real page trigger, App shell and Sidebar; omit unrelated route data.
vi.mock('./components/UsagePage', () => ({
  UsagePage: ({ onToggleSidebar }: { onToggleSidebar: () => void }) =>
    <PageHeader title="Usage" onToggleSidebar={onToggleSidebar} />,
}));
vi.mock('./components/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('./lib/skins/useUserSkins', () => ({ useUserSkins: () => {} }));
vi.mock('./lib/skins/useAppearancePacks', () => ({ useAppearancePacks: () => {} }));

describe('isEditableTarget', () => {
  it('recognizes every editable focus surface', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isEditableTarget(editable)).toBe(true);
  });

  it('lets plain surfaces through so global shortcuts keep working', () => {
    const plain = document.createElement('div');
    Object.defineProperty(plain, 'isContentEditable', { value: false });
    expect(isEditableTarget(plain)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(new EventTarget())).toBe(false);
  });
});

describe('session first-page polling', () => {
  it('spaces first-page refreshes to a 15-second visible interval', () => {
    expect(SESSION_FIRST_PAGE_POLL_INTERVAL_MS).toBe(15_000);
  });
});

describe('root read-model query retry', () => {
  it('recovers a query after a long initial index build', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    let attempts = 0;
    try {
      const result = client.fetchQuery({
        queryKey: ['long-index-build'],
        queryFn: () => {
          attempts += 1;
          if (attempts <= 10) throw new ApiError({ code: 40939, msg: 'session index is building', data: null });
          return ['ready'];
        },
        retry: retryRootReadModelQuery,
        retryDelay: retryRootReadModelDelay,
      });
      await vi.advanceTimersByTimeAsync(35_000);
      expect(await result).toEqual(['ready']);
      expect(attempts).toBe(11);
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });

  it('waits while the server reports building without an arbitrary retry-count gate', () => {
    const building = new ApiError({ code: 40939, msg: 'session index is building', data: null });
    expect(retryRootReadModelQuery(0, building)).toBe(true);
    expect(retryRootReadModelQuery(5, building)).toBe(true);
    expect(retryRootReadModelQuery(1_000, building)).toBe(true);
    expect([0, 1, 2, 3, 4, 5, 1_000].map(retryRootReadModelDelay)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(
      retryRootReadModelQuery(
        0,
        new ApiError({ code: 50001, msg: 'internal error', data: null }),
      ),
    ).toBe(false);
    expect(retryRootReadModelQuery(0, new Error('network failed'))).toBe(false);
  });
});

describe('app navigation dirty guard', () => {
  const current = { pathname: '/settings/providers', search: '', hash: '' };

  it('guards application-level routes while allowing clean and no-op navigation', () => {
    expect(shouldGuardNavigation(current, '/capabilities', true)).toBe(true);
    expect(shouldGuardNavigation(current, '/s/example', true)).toBe(true);
    expect(shouldGuardNavigation(current, '/settings/providers', true)).toBe(false);
    expect(shouldGuardNavigation(current, '/capabilities', false)).toBe(false);
  });
});

describe('discovery route and dirty guard navigation', () => {
  it('guards transitions to /discover when dirty form is active', () => {
    const current = { pathname: '/settings/providers', search: '', hash: '' };
    expect(shouldGuardNavigation(current, '/discover', true)).toBe(true);
    expect(shouldGuardNavigation(current, '/discover', false)).toBe(false);
  });

  it('preserves discovery state and prevents route advance when dirty guard rejects', async () => {
    const { navigateDiscovery } = await import('@kiki/session-core/discovery');
    const state = {
      version: 1 as const,
      contentVersion: 1,
      lifecycle: 'active' as const,
      route: 'overview' as const,
      station: 'workspace' as const,
      collapsed: false,
      progress: {},
    };
    const context = {
      online: true,
      currentHref: '/new',
      anchors: ['workspace-picker' as const],
    };
    const cancelledPort = {
      navigate: vi.fn(async () => 'cancelled' as const),
    };
    const result = await navigateDiscovery(state, { type: 'next' }, context, cancelledPort);
    expect(result.outcome).toBe('cancelled');
    expect(result.state.station).toBe('workspace');
    expect(cancelledPort.navigate).toHaveBeenCalled();
  });
});

describe('conversation shell fallback phase', () => {
  it('opens /new as the hero and a session route as settling until its seat registers', () => {
    expect(resolveFallbackPhase(true)).toBe('hero');
    expect(resolveFallbackPhase(false)).toBe('settling');
  });
});

describe('connection-level activity refresh', () => {
  it('refreshes sessions, room summaries and the affected activity queries without unrelated session polling', () => {
    const queryClient = { invalidateQueries: vi.fn(async () => undefined) };
    refreshSessionAttention(queryClient, 'example-session');
    expect(queryClient.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['sessions'] }],
      [{ queryKey: ['rooms'] }],
      [{ queryKey: ['activity-prompts', 'example-session'] }],
      [{ queryKey: ['activity-tasks', 'example-session'] }],
    ]);
  });
});

describe('connection-level model catalog refresh', () => {
  it('invalidates catalog lists and editor entities without invalidating unrelated queries', () => {
    const queryClient = new QueryClient();
    const catalogKeys = [
      ['models'],
      ['providers'],
      ['model-entity', 'example-model'],
      ['provider-entity', 'example-provider'],
      ['discovered-models'],
    ];
    const unrelatedKeys = [['sessions'], ['rooms'], ['config']];
    for (const queryKey of [...catalogKeys, ...unrelatedKeys]) {
      queryClient.setQueryData(queryKey, {});
    }
    try {
      expect(handleGlobalConnectionFrame({ type: 'event.model_catalog.changed' }, queryClient)).toBe(true);
      for (const queryKey of catalogKeys) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
      }
      for (const queryKey of unrelatedKeys) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
      }
    } finally {
      queryClient.clear();
    }
  });

  it('does not handle session frames', () => {
    const queryClient = { invalidateQueries: vi.fn(async () => undefined) };

    expect(handleGlobalConnectionFrame({ type: 'turn.ended' }, queryClient)).toBe(false);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('App sidebar Escape wiring', () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let unmounted: boolean;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', (media: string) => ({
      media,
      matches: media === '(max-width: 767px)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('kiki.locale', 'en');
    configureSpaceStorage(null);
    clearNavHistory();
    window.history.replaceState(null, '');
    appHarness.connection = {
      scopeId: 'local',
      meta: { server_home_id: 'main', capabilities: {}, open_in_apps: [] },
      wsStatus: 'open',
      localClient: null,
      client: {
        getAuth: async () => ({ ready: true }),
        listModels: async () => ({ items: [] }),
        listSessions: async () => ({ items: [], has_more: false }),
        listWorkspaceCatalog: async () => ({ items: [] }),
        listEphemeralSessions: async () => ({ items: [] }),
        listPersonas: async () => [],
        pluginNavigation: async () => ({}),
        readShortcuts: async () => ({}),
        getRequestGovernance: async () => ({
          domainId: 'example', runtimeEpoch: 'example', seq: 1,
          asOf: '2026-01-01T00:00:00Z', active: 0, queued: 0,
          coverage: { native: 'managed', external: 'unmanaged' },
          dimensions: [], rules: [], waiting: [],
        }),
        klient: {
          rest: { rooms: { listItems: async () => [] } },
          events: { on: () => ({ dispose: () => {} }) },
        },
      },
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    unmounted = false;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    if (anyOverlayOpen()) throw new Error('an overlay was already open before the app mounted');
  });

  afterEach(async () => {
    if (!unmounted) await unmountApp();
    queryClient.clear();
    container.remove();
    appHarness.connection = null;
    clearNavHistory();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '');
    vi.unstubAllGlobals();
    if (anyOverlayOpen()) throw new Error('an overlay stayed open after the app unmounted');
  });

  async function mountApp() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <HostProvider host={browserHost}>
              <MemoryRouter initialEntries={['/usage']}>
                <App />
              </MemoryRouter>
            </HostProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function withHistoryPop<T>(action: () => Promise<T>): Promise<T> {
    let onPop: () => void = () => {};
    const popped = new Promise<void>((resolve) => { onPop = resolve; });
    window.addEventListener('popstate', onPop, { once: true });
    try {
      const result = await action();
      await popped;
      return result;
    } finally {
      window.removeEventListener('popstate', onPop);
    }
  }

  async function unmountApp() {
    const unmount = async () => { await act(async () => { root.unmount(); }); };
    if (container.querySelector('#app-sidebar.open') !== null) await withHistoryPop(unmount);
    else await unmount();
    unmounted = true;
  }

  function element<T extends HTMLElement>(selector: string): T {
    const found = container.querySelector<T>(selector);
    if (found === null) throw new Error(`Missing App element: ${selector}`);
    return found;
  }

  async function openDrawerAndFilter() {
    const trigger = element<HTMLButtonElement>('button[aria-controls="app-sidebar"]');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(element('#app-sidebar').hasAttribute('inert')).toBe(true);
    expect(anyOverlayOpen()).toBe(false);
    await act(async () => { trigger.click(); });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(element('#app-sidebar').classList.contains('open')).toBe(true);
    expect(element('#app-sidebar').hasAttribute('inert')).toBe(false);
    expect(anyOverlayOpen()).toBe(true);
    expect(anyOverlayOpen(['app-sidebar'])).toBe(false);
    await act(async () => { element<HTMLButtonElement>('[data-filter-menu-toggle]').click(); });
    // The menu rides the shared AnchoredPopover, which portals to <body>.
    expect(document.querySelector('[data-filter-menu]')).not.toBeNull();
    expect(anyOverlayOpen(['app-sidebar'])).toBe(true);
    return trigger;
  }

  async function escape() {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    let overlayOpen = false;
    // An open popover owns Escape on its own surface (the AnchoredPopover
    // handles the key where focus sits, portaled under <body>); with no
    // popover open the key is the window-level one the drawer listens for.
    const target = document.querySelector('[data-anchored-popover]') ?? window;
    await act(async () => {
      target.dispatchEvent(event);
      // Read before React's effect cleanup: this is what a later global
      // abort listener would see during the same native event dispatch.
      overlayOpen = anyOverlayOpen();
    });
    return { event, overlayOpen };
  }

  it('lets the real filter menu consume the first Escape and the real App drawer effect consume the second', async () => {
    await mountApp();
    const trigger = await openDrawerAndFilter();
    const running = { busy: true, abortablePromptId: 'example-prompt', abortableTurnId: undefined };
    expect(canAbortActiveTurn(running)).toBe(true);

    const first = await escape();
    expect(first.event.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-filter-menu]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(element('#app-sidebar').classList.contains('open')).toBe(true);
    expect(anyOverlayOpen()).toBe(true);
    expect(anyOverlayOpen(['app-sidebar'])).toBe(false);

    const second = await withHistoryPop(escape);
    expect(second.event.defaultPrevented).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(element('#app-sidebar').classList.contains('open')).toBe(false);
    expect(element('#app-sidebar').hasAttribute('inert')).toBe(true);
    expect(anyOverlayOpen()).toBe(false);

    // Exercise the production abort predicate, not a copied SessionView listener.
    for (const { event, overlayOpen } of [first, second]) {
      expect(shouldHandleGlobalAbortOnEscape({
        key: event.key, defaultPrevented: event.defaultPrevented, overlayOpen,
        terminalFocused: false, terminalOpen: false, inFormField: false,
      })).toBe(false);
    }
    const third = await escape();
    expect(third.event.defaultPrevented).toBe(false);
    expect(shouldHandleGlobalAbortOnEscape({
      key: third.event.key, defaultPrevented: third.event.defaultPrevented, overlayOpen: third.overlayOpen,
      terminalFocused: false, terminalOpen: false, inFormField: false,
    })).toBe(true);
  });

  it('renders the update offer the shell scheduler hands it and forwards the install click', async () => {
    const offer = {
      channel: 'stable',
      update: { currentVersion: '0.3.1', version: '0.3.2', notes: 'Session switching is faster.', install: vi.fn(async () => {}) },
    };
    updateHarness.offer = offer;
    updateHarness.options = null;
    updateHarness.onUpdate.mockClear();
    await mountApp();

    // The shell owns the schedule: one hook call, from the browser host, which
    // must not start the native checks.
    const seen = updateHarness.options as { isDesktop?: boolean } | null;
    expect(seen?.isDesktop).toBe(false);
    // The dialog paints through the shell's portal, outside the app container.
    expect(document.querySelector('[data-update-notes]')).not.toBeNull();
    const install = document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!;
    await act(async () => { install.click(); });
    expect(updateHarness.onUpdate).toHaveBeenCalledWith(offer);
    updateHarness.offer = null;
  });

  it('passes the sessions waiting on an approval to the scheduler', async () => {
    const base = appHarness.connection as { client: { listSessions: () => Promise<unknown> } };
    const sessions = [{
      id: 'session_approval', title: 'Waiting', metadata: { cwd: '/work/example' }, pending_interaction: 'approval',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', busy: false,
    }];
    const original = base.client.listSessions;
    base.client.listSessions = async () => ({ items: sessions, has_more: false });
    try {
      updateHarness.options = null;
      await mountApp();
      const seen = updateHarness.options as { hasPendingApproval?: boolean } | null;
      expect(seen?.hasPendingApproval).toBe(true);
    } finally {
      base.client.listSessions = original;
    }
  });

  it('unregisters the real App drawer and filter layers on unmount without leaving an Escape consumer', async () => {
    await mountApp();
    await openDrawerAndFilter();
    await unmountApp();
    expect(anyOverlayOpen()).toBe(false);
    expect((await escape()).event.defaultPrevented).toBe(false);
  });

  it('renders StorageMigrationView directly and does not load sessions when storage_mode is maintenance', async () => {
    const conn = appHarness.connection as {
      meta: { server_home_id: string; capabilities: Record<string, unknown>; open_in_apps: unknown[]; storage_mode?: 'maintenance' | 'normal'; storage_status_path?: string };
      client: { listSessions: () => Promise<unknown>; getStorageMigration?: () => Promise<unknown> };
    };
    const originalMeta = conn.meta;
    const originalScope = 'scopeId' in conn ? conn.scopeId : undefined;
    const originalListSessions = conn.client.listSessions;
    const originalGetStorageMigration = conn.client.getStorageMigration;

    const listSessionsSpy = vi.fn(async () => ({ items: [], has_more: false }));
    const getStorageMigrationSpy = vi.fn(async () => ({
      schemaVersion: 1 as const,
      mode: 'maintenance' as const,
      status: {
        schemaVersion: 1 as const,
        homeDir: '/test/home',
        authority: 'legacy' as const,
        phase: 'detecting' as const,
        state: 'ready' as const,
        sources: [],
        progress: { items: 0, bytes: 0 },
        canCancel: false,
        canRollback: false,
        minimumReaderVersion: '0.5.0' as const,
        legacyImportRemovedVersion: '0.6.0' as const,
      },
      actions: ['migrate' as const],
      transition: { state: 'idle' as const },
    }));

    conn.meta = { ...originalMeta, storage_mode: 'maintenance', storage_status_path: '/api/storage' };
    conn.client.listSessions = listSessionsSpy;
    conn.client.getStorageMigration = getStorageMigrationSpy;

    try {
      await mountApp();
      expect(listSessionsSpy).not.toHaveBeenCalled();
      expect(container.querySelector('h1')?.textContent).toContain('Mailbox storage upgrade');
      expect(container.querySelector('[data-action="migrate"]')).not.toBeNull();
    } finally {
      conn.meta = originalMeta;
      if ('scopeId' in conn && originalScope !== undefined) conn.scopeId = originalScope;
      conn.client.listSessions = originalListSessions;
      conn.client.getStorageMigration = originalGetStorageMigration;
    }
  });

  it('switches between maintenance and normal mode and handles connection change on same mounted tree without hook crashes', async () => {
    const conn = appHarness.connection as {
      meta: { server_home_id: string; capabilities: Record<string, unknown>; open_in_apps: unknown[]; storage_mode?: 'maintenance' | 'normal'; storage_status_path?: string };
      client: { listSessions: () => Promise<unknown>; getStorageMigration?: () => Promise<unknown> };
      scopeId: string;
    };
    const originalMeta = conn.meta;
    const originalScope = 'scopeId' in conn ? conn.scopeId : undefined;
    const originalListSessions = conn.client.listSessions;
    const originalGetStorageMigration = conn.client.getStorageMigration;

    const listSessionsSpy = vi.fn(async () => ({ items: [], has_more: false }));
    const getStorageMigrationSpy = vi.fn(async () => ({
      schemaVersion: 1 as const,
      mode: 'maintenance' as const,
      status: {
        schemaVersion: 1 as const,
        homeDir: '/test/home',
        authority: 'legacy' as const,
        phase: 'detecting' as const,
        state: 'ready' as const,
        sources: [],
        progress: { items: 0, bytes: 0 },
        canCancel: false,
        canRollback: false,
        minimumReaderVersion: '0.5.0' as const,
        legacyImportRemovedVersion: '0.6.0' as const,
      },
      actions: ['migrate' as const],
      transition: { state: 'idle' as const },
    }));

    conn.client.listSessions = listSessionsSpy;
    conn.client.getStorageMigration = getStorageMigrationSpy;

    try {
      // 1. Mount in normal mode
      await mountApp();
      expect(container.querySelector('h1')?.textContent).not.toContain('Mailbox storage upgrade');

      // 2. Flip to maintenance mode on the same mounted tree
      conn.meta = { ...originalMeta, storage_mode: 'maintenance', storage_status_path: '/api/storage' };
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <I18nProvider>
              <HostProvider host={browserHost}>
                <MemoryRouter initialEntries={['/usage']}>
                  <App />
                </MemoryRouter>
              </HostProvider>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      expect(container.querySelector('h1')?.textContent).toContain('Mailbox storage upgrade');

      // 3. Switch connection scope on same tree while in maintenance
      conn.scopeId = 'remote:srv-2';
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <I18nProvider>
              <HostProvider host={browserHost}>
                <MemoryRouter initialEntries={['/usage']}>
                  <App />
                </MemoryRouter>
              </HostProvider>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      expect(container.querySelector('h1')?.textContent).toContain('Mailbox storage upgrade');

      // 4. Flip back to normal mode on the same mounted tree
      conn.meta = { ...originalMeta, storage_mode: 'normal' };
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <I18nProvider>
              <HostProvider host={browserHost}>
                <MemoryRouter initialEntries={['/usage']}>
                  <App />
                </MemoryRouter>
              </HostProvider>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      expect(container.querySelector('h1')?.textContent).not.toContain('Mailbox storage upgrade');
    } finally {
      conn.meta = originalMeta;
      if ('scopeId' in conn && originalScope !== undefined) conn.scopeId = originalScope;
      conn.client.listSessions = originalListSessions;
      conn.client.getStorageMigration = originalGetStorageMigration;
    }
  });
});
