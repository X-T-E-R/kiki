/**
 * App shell — route-aware three-column layout.
 *
 * Routes:
 *   /                → redirect to last session or /new
 *   /new             → full-page draft conversation
 *   /s/:id           → live session view
 *   /s/:id/tasks     → session background-task browser
 *   /settings/:section? → settings panel
 *   /board, /cron    → task board / scheduled tasks (`?workspace=` scopes them)
 *   /memory          → memory console, or its turn-on guide while memory is off
 *   /usage           → usage dashboard
 *
 * Global actions: Ctrl+N / the sidebar button navigate to the /new draft page
 * from any route, Ctrl+K opens the QuickSwitcher, Ctrl+Tab jumps to the most
 * recent other session, and Ctrl+/ (or a bare `?`) opens the shortcuts panel.
 * Those are the shipped chords; the saved shortcut table (lib/shortcuts) can
 * remap each one. Ctrl+N and Ctrl+Tab register only in the desktop runtime.
 * `document.title` follows the active route; toasts mount at the root.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Workspace } from '@kiki/protocol';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
  useNavigationType,
  type NavigateOptions,
  type To,
} from 'react-router-dom';

import { ConfirmDialog } from './components/ConfirmDialog';
import { CronPage } from './components/GlobalCronPanel';
import { TaskBoardPage } from './components/GlobalTaskBoard';
import { DirtyGuardContext, useDirtyGuardState } from './components/dirtyGuard';
import { NewSessionPage } from './components/NewSessionPage';
import {
  OnboardingWizard,
  shouldOfferOnboarding,
  subscribeOnboardingOpenRequests,
} from './components/OnboardingWizard';
import { ActivityPage } from './components/ActivityPage';
import { useConversationList } from './lib/useConversationList';
import { RoomLinkRedirect } from './lib/conversationRoutes';
import { CapabilitiesPage } from './components/capabilities/CapabilitiesPage';
import { ConversationShell } from './components/ConversationShell';
import { MemoryPage } from './components/MemoryPage';
import { QuickSwitcher } from './components/QuickSwitcher';
import { RestartBanner } from './components/RestartBanner';
import { SessionRouteView } from './components/SessionView';
import { PersonasPage } from './components/persona/PersonasPage';
import { PersonaDailyRoute } from './components/persona/PersonaDailyRoute';
import { RoomPage } from './components/room/RoomPage';
import { SettingsPage } from './components/SettingsPage';
import { SpaceViewMemory, SpaceViewState } from './components/SpaceViewState';
import { readSpaceViewRoute } from './lib/spaceViewState';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { Sidebar } from './components/Sidebar';
import { isBotOrRoomSession } from './components/persona/personaSessionUtils';
import { TasksPage } from './components/TasksPage';
import { Toasts } from './components/Toasts';
import { UsagePage } from './components/UsagePage';
import { useHost, type DesktopUpdate } from './host';
import {
  arrangePinnedFirst,
  dedupeSessions,
  groupConversationItems,
  mergeSessionFirstPage,
  readSessionFirstPage,
  sortWorkspacesByPinnedThenRecency,
  type ConversationListItem,
  type SessionGroup,
  type SessionListData,
} from '@kiki/session-core/sessions';
import {
  isOnboardingCompleted,
  readDesktopPrefs,
  readLastSessionId,
  writeDesktopPrefs,
  writeLayoutPreferences,
  type AutoUpdateMode,
} from '@kiki/session-core/settings';
import { isSessionIndexBuildingError } from './lib/client';
import { useLayoutPreferences } from './lib/layoutHooks';
import { useAppearancePacks } from './lib/skins/useAppearancePacks';
import { useUserSkins } from './lib/skins/useUserSkins';
import { pushToast } from './lib/toasts';
import { isEditableTarget, matchesShortcutAction } from './lib/shortcuts';
import { useShortcutPreferencesSync } from './lib/useShortcutPreferences';
import { handleFindShortcut, QUICK_SWITCHER_EVENT, type FindRoute } from './lib/timelineFind';
import { anyOverlayOpen } from './lib/uiBusy';
import { startVisiblePoll } from './lib/visiblePoll';
import { useAwayNotifications } from './lib/useAwayNotifications';
import { resolveWindowTitle, type WindowRoute } from './lib/windowTitle';
import { useI18n } from './i18n';
import { useConnection } from './state/connection';
import { recordNavigation } from './lib/navHistory';
import { activeSpace } from './lib/spaceStorage';
import { NavHistoryBridge } from './components/NavBackButton';

export const SESSION_FIRST_PAGE_POLL_INTERVAL_MS = 15_000;
export const SESSION_INDEX_RETRY_LIMIT = 4;

/** Retry the cold-home read model only a bounded number of times. */
export function retryRootReadModelQuery(failureCount: number, error: Error): boolean {
  return failureCount < SESSION_INDEX_RETRY_LIMIT && isSessionIndexBuildingError(error);
}

/** Keep cold-index retries responsive without hammering a new home. */
export function retryRootReadModelDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2_000);
}

interface StartupUpdateHost {
  supportsDesktopUpdates(): Promise<boolean>;
  checkDesktopUpdate(): Promise<DesktopUpdate | null>;
}

export type StartupUpdateResult = 'disabled' | 'unsupported' | 'up-to-date' | 'notified' | 'installed';

export async function runStartupUpdateCheck(
  host: StartupUpdateHost,
  mode: AutoUpdateMode,
  onUpdateAvailable: (update: DesktopUpdate) => void,
  onUpdateInstalled: (update: DesktopUpdate) => void,
): Promise<StartupUpdateResult> {
  if (mode === 'off') return 'disabled';
  if (!(await host.supportsDesktopUpdates())) return 'unsupported';
  const update = await host.checkDesktopUpdate();
  if (update === null) return 'up-to-date';
  if (mode === 'notify') {
    onUpdateAvailable(update);
    return 'notified';
  }
  await update.install();
  onUpdateInstalled(update);
  return 'installed';
}

function RootRedirect() {
  const host = useHost();
  const { scopeId } = useConnection();
  const target = useMemo(() => {
    const saved = host.kind === 'tauri' ? readSpaceViewRoute(scopeId) : undefined;
    const lastSessionId = readLastSessionId();
    return saved ?? (lastSessionId !== undefined ? `/s/${lastSessionId}` : '/new');
  }, [host.kind, scopeId]);
  return <Navigate to={target} replace />;
}

export { isEditableTarget };

export function App() {
  const host = useHost();
  const { client, socket, wsStatus } = useConnection();
  const { t, locale } = useI18n();
  const rawNavigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const { scopeId, meta, connectionRef } = useConnection();
  const desktop = host.kind === 'tauri';

  // Commit the target visit before descendants' passive restoration effects.
  // A blocked transition never changes location and never advances this store.
  useLayoutEffect(() => {
    // A remote Kiki is not a local home: its scope key is its own home, the
    // same rule the scope boundary uses. Reading the local home here would
    // stamp every visit `main` beside a remote scope id, and the window that
    // boots into that visit would refuse its own entry as unreachable.
    const localHome = host.kind === 'tauri' ? (activeSpace()?.homeId ?? 'main') : 'main';
    const home = scopeId.startsWith('remote:') ? scopeId : localHome;
    const label = location.pathname.startsWith('/settings')
      ? 'Settings'
      : location.pathname === '/usage'
        ? 'Usage'
        : location.pathname === '/board'
          ? 'Task board'
          : location.pathname === '/cron'
            ? 'Scheduled tasks'
            : location.pathname === '/memory'
              ? 'Memory'
              : location.pathname === '/new'
                ? 'New session'
                : undefined;
    const entry = recordNavigation({
      location,
      scope: { homeId: home, scopeId, serverHomeId: meta.server_home_id, connectionRef },
      label,
      action: navType === 'POP' ? 'POP' : navType === 'REPLACE' ? 'REPLACE' : 'PUSH',
    });
    const browserState = window.history.state;
    if (browserState?.key === location.key || (location.key === 'default' && (browserState?.key === null || browserState?.key === undefined))) {
      const userState = browserState?.usr ?? {};
      window.history.replaceState({ ...browserState, usr: { ...userState,
        kikiNav: { ...userState.kikiNav, visitId: entry.visitId, scope: entry.scope } } }, '');
    }
  }, [location, navType, scopeId, host.kind, meta.server_home_id, connectionRef]);
  // User skin files live on the server, so the catalog loads app-wide: a skin
  // chosen from the themes folder must paint on every route, not only after a
  // visit to Settings → Appearance.
  useUserSkins();
  useAppearancePacks();
  // Remapped keys apply app-wide, so the saved table loads with the shell.
  useShortcutPreferencesSync();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const layoutPrefs = useLayoutPreferences();
  // Sidebar filters persist in layoutPrefs. The fetch mirrors the two
  // server-side narrowings (archived visibility, exactly one workspace); the
  // remaining dimensions filter the loaded list client-side.
  const listFilters = layoutPrefs.filters;
  const showArchived = listFilters.archived !== 'hide';
  const workspaceFilter = listFilters.workspaces.length === 1 ? listFilters.workspaces[0] : undefined;
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Decided exactly once per app run, the moment both probes have answered:
  // a "configured" answer latches too, so a later catalog hiccup can never
  // pop the wizard over an established session.
  const onboardingDecided = useRef(false);
  const onboardingAuthQuery = useQuery({
    queryKey: ['auth'],
    queryFn: () => client.getAuth(),
    staleTime: 10_000,
    retry: false,
  });
  const onboardingModelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    if (onboardingDecided.current) return;
    if (onboardingAuthQuery.data === undefined || onboardingModelsQuery.data === undefined) return;
    onboardingDecided.current = true;
    if (
      shouldOfferOnboarding({
        completed: isOnboardingCompleted(),
        auth: onboardingAuthQuery.data,
        models: onboardingModelsQuery.data.items,
      })
    ) {
      setOnboardingOpen(true);
    }
  }, [onboardingAuthQuery.data, onboardingModelsQuery.data]);
  useEffect(
    () => subscribeOnboardingOpenRequests(() => { setOnboardingOpen(true); }),
    [],
  );
  const performNavigation = useCallback((target: To | number, options?: NavigateOptions) => {
    if (typeof target === 'number') void rawNavigate(target);
    else void rawNavigate(target, options);
  }, [rawNavigate]);
  const { value: dirtyGuardValue, navigate, pending: pendingNavigation, confirm: confirmNavigation, cancel: cancelNavigation } =
    useDirtyGuardState(location, performNavigation);

  // Sync native desktop prefs into localStorage on boot; listen for tray
  // "New Session" events.
  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((prefs) => {
      if (prefs !== null) writeDesktopPrefs(prefs);
    });
    return host.onTrayNewSession(() => navigate('/new'));
  }, [host, navigate]);

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    const timer = window.setTimeout(() => {
      void host.readDesktopPrefs()
        .then((nativePrefs) => {
          if (nativePrefs !== null) writeDesktopPrefs(nativePrefs);
          const mode = (nativePrefs ?? readDesktopPrefs()).autoUpdate;
          return runStartupUpdateCheck(
            host,
            mode,
            (update) => {
              pushToast({ tone: 'info', text: t('st.about.updateAvailable', { version: update.version }) });
            },
            () => {
              pushToast({ tone: 'success', text: t('st.about.installedRestart') });
            },
          );
        })
        .catch(() => {});
    }, 1_500);
    return () => { window.clearTimeout(timer); };
  }, [host, t]);

  // Keep the native side (tray menu labels) on the active UI locale.
  useEffect(() => {
    void host.writeDesktopPrefs?.({ locale });
  }, [host, locale]);

  const sessionMatch = useMatch('/s/:id/*');
  const activeSessionId = sessionMatch?.params.id;
  const isNewRoute = useMatch('/new') !== null;
  const isSettingsRoute = useMatch('/settings/*') !== null;
  const isUsageRoute = useMatch('/usage') !== null;
  const isBoardRoute = useMatch('/board') !== null;
  const isCronRoute = useMatch('/cron') !== null;
  const isMemoryRoute = useMatch('/memory') !== null;
  const isActivityRoute = useMatch('/activity') !== null;

  const sessionsQuery = useInfiniteQuery({
    queryKey: ['sessions', showArchived, workspaceFilter],
    queryFn: ({ pageParam }) =>
      client.listSessions({
        page_size: 50,
        include_archive: showArchived || undefined,
        workspace_id: workspaceFilter,
        before_id: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.next_cursor ?? lastPage.items.at(-1)?.id : undefined,
    initialPageParam: undefined as string | undefined,
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
  });
  // Refresh the head, bridging to the loaded boundary only when it no longer
  // overlaps. Older loaded pages are not interval-refetched.
  const queryClient = useQueryClient();
  useEffect(() => {
    return startVisiblePoll({
      intervalMs: SESSION_FIRST_PAGE_POLL_INTERVAL_MS,
      task: async () => {
        const first = await readSessionFirstPage((before_id) => client.listSessions({
          page_size: 50,
          include_archive: showArchived || undefined,
          workspace_id: workspaceFilter,
          before_id,
        }), queryClient.getQueryData<SessionListData>(['sessions', showArchived, workspaceFilter]));
        queryClient.setQueryData(
          ['sessions', showArchived, workspaceFilter],
          (old: SessionListData | undefined) => mergeSessionFirstPage(old, first),
        );
      },
    });
  }, [client, queryClient, showArchived, workspaceFilter]);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
  });
  // Pinned workspaces lead the sidebar scope list, and — because the same
  // order seeds workspace grouping — their session buckets come first too.
  const workspaceOptions = useMemo<readonly Workspace[]>(
    () => sortWorkspacesByPinnedThenRecency(workspacesQuery.data?.items ?? []),
    [workspacesQuery.data],
  );

  // The canonical session order powers QuickSwitcher / Ctrl+Tab hopping and the
  // /new recent chips, so it stays pinned-first + newest-first regardless of
  // the sidebar's view preference. Grouping applies its own sort internally.
  const sessions = useMemo(
    () => arrangePinnedFirst(dedupeSessions(sessionsQuery.data)),
    [sessionsQuery.data],
  );
  const conversations = useConversationList(sessions, layoutPrefs.sortBy, workspaceOptions);
  const sessionGroups = useMemo<readonly SessionGroup<ConversationListItem>[]>(() => {
    // A Bot's home and a room member's own session keep their single address
    // (the Bot rows above, the room's row); everything else lists here.
    const items = conversations.items.filter((item) =>
      item.kind === 'room' || item.session.archived === true || !isBotOrRoomSession(item.session));
    return groupConversationItems(items, {
      groupBy: layoutPrefs.groupBy,
      workspaces: workspaceOptions,
      filters: listFilters,
      nowMs: Date.now(),
      order: layoutPrefs.sortBy,
      labels: {
        pinned: t('sidebar.groupPinned'),
        today: t('sidebar.groupToday'),
        yesterday: t('sidebar.groupYesterday'),
        week: t('sidebar.groupWeek'),
        month: t('sidebar.groupMonth'),
        older: t('sidebar.groupOlder'),
      },
      ungroupedLabel: t('sidebar.groupUngrouped'),
    });
  }, [conversations.items, workspaceOptions, listFilters, layoutPrefs.groupBy, layoutPrefs.sortBy, t]);

  // System notifications while the window is in the background, the taskbar
  // badge, and notification clicks back to their session.
  const listNewestSessions = useCallback(
    () => client.listSessions({ page_size: 100 }).then((page) => page.items),
    [client],
  );
  useAwayNotifications({
    host,
    sessions,
    listSessions: listNewestSessions,
    navigate: (route) => { navigate(route); },
  });

  // document.title follows the route: session title, page name, or bare Kiki.
  useEffect(() => {
    const route: WindowRoute =
      activeSessionId !== undefined
        ? { kind: 'session', sessionId: activeSessionId }
        : isNewRoute
          ? { kind: 'new' }
          : isSettingsRoute
            ? { kind: 'settings' }
            : isUsageRoute
              ? { kind: 'usage' }
              : { kind: 'other' };
    document.title = resolveWindowTitle(route, sessions, {
      untitled: t('sidebar.untitled'),
      newSession: t('new.title'),
      settings: t('st.title'),
      usage: t('usage.title'),
    });
  }, [activeSessionId, isNewRoute, isSettingsRoute, isUsageRoute, sessions, t]);

  // ⌘N / Ctrl+N navigates to the /new draft page from any route; ⌘K / Ctrl+K
  // toggles the quick switcher; ⌘, / Ctrl+, opens settings; Ctrl+/ toggles
  // the shortcuts panel. Chords come from the saved shortcut table.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcutAction(event, 'new-session')) {
        // Browsers reserve Ctrl+N (new window) — preventDefault cannot stop
        // it, so the binding stays desktop-only instead of half-firing.
        if (!desktop) return;
        event.preventDefault();
        setQuickSwitcherOpen(false);
        navigate('/new');
      } else if (matchesShortcutAction(event, 'switcher')) {
        event.preventDefault();
        setQuickSwitcherOpen((open) => !open);
      } else if (matchesShortcutAction(event, 'settings')) {
        event.preventDefault();
        // Land in the search field: Ctrl+, → type → Enter → Esc is the
        // shortest path to any setting, and shorter than the nav tree.
        navigate('/settings', { state: { focusSearch: true } });
      } else if (matchesShortcutAction(event, 'shortcuts')) {
        event.preventDefault();
        setQuickSwitcherOpen(false);
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [navigate, desktop]);

  // ⌘F / Ctrl+F: find in the conversation on screen (the composer included —
  // a selection there seeds the query); F3 / Shift+F3 step through it. On
  // settings it lands in the page's own search (the Ctrl+, path). Other
  // routes (/new included) and open dialogs keep the key untouched.
  // Capture phase, so an input that stops propagation cannot let the
  // browser's own find bar through underneath ours.
  const findRoute: FindRoute = activeSessionId !== undefined ? 'session' : isSettingsRoute ? 'settings' : 'other';
  useEffect(() => {
    if (findRoute === 'other') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      handleFindShortcut(event, findRoute, {
        overlayOpen: () => anyOverlayOpen(),
        focusSettingsSearch: () => {
          navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: { focusSearch: true } });
        },
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => { window.removeEventListener('keydown', onKeyDown, true); };
  }, [findRoute, navigate, location.pathname, location.search, location.hash]);

  // The find bar's "search all sessions" hands its query to the switcher.
  const [switcherQuery, setSwitcherQuery] = useState<string | undefined>(undefined);
  useEffect(() => {
    const onRequest = (event: Event) => {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query;
      setShortcutsOpen(false);
      setSwitcherQuery(query);
      setQuickSwitcherOpen(true);
    };
    window.addEventListener(QUICK_SWITCHER_EVENT, onRequest);
    return () => { window.removeEventListener(QUICK_SWITCHER_EVENT, onRequest); };
  }, []);

  // A bare `?` (outside editable targets and other overlays) also opens the
  // shortcuts panel — the discoverability path for keyboard-first users.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcutAction(event, 'shortcuts-help')) return;
      if (anyOverlayOpen()) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, []);

  // Esc on the settings route returns to the last non-settings page. Editable
  // targets, open dialogs, and the mobile sidebar consume their own Escape
  // first (dialogs stop propagation / the flags below short-circuit us).
  const lastNonSettingsRef = useRef('/');
  useEffect(() => {
    if (!isSettingsRoute) lastNonSettingsRef.current = `${location.pathname}${location.search}`;
  }, [isSettingsRoute, location]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isSettingsRoute || sidebarOpen || quickSwitcherOpen || shortcutsOpen) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      navigate(lastNonSettingsRef.current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [isSettingsRoute, sidebarOpen, quickSwitcherOpen, shortcutsOpen, navigate]);

  // Ctrl+Tab jumps to the most recent other session. Browser tab switching
  // owns Ctrl+Tab (preventDefault cannot intercept it), so the binding only
  // registers in the desktop runtime — the shortcuts panel marks it
  // desktop-only. While focus sits in an editable surface the keystroke stays
  // with it: hopping sessions here would silently rip focus from the draft.
  useEffect(() => {
    if (!desktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcutAction(event, 'next-session')) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      const next = sessions.find((session) => session.id !== activeSessionId);
      if (next !== undefined) {
        setQuickSwitcherOpen(false);
        navigate(`/s/${next.id}`);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [sessions, activeSessionId, navigate, desktop]);

  // Close mobile sidebar on route change.
  useEffect(() => {
    setSidebarOpen(false);
  }, [activeSessionId, isNewRoute, isSettingsRoute, isUsageRoute, isBoardRoute, isCronRoute, isMemoryRoute, isActivityRoute]);

  // Escape closes the mobile sidebar drawer (the backdrop swallows pointer
  // events, so the key must be handled globally while it is open).
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [sidebarOpen]);

  return (
    <DirtyGuardContext.Provider value={dirtyGuardValue}>
      <NavHistoryBridge>
      <div className="flex h-full overflow-hidden bg-canvas">
      <Sidebar
        className={`app-sidebar ${sidebarOpen ? 'open' : ''}`}
        activeSessionId={activeSessionId}
        sessions={sessions}
        rooms={conversations.rooms}
        sessionGroups={sessionGroups}
        sessionsQuery={sessionsQuery}
        roomsQuery={conversations.roomsQuery}
        workspaceOptions={workspaceOptions}
        filters={listFilters}
        onFiltersChange={(filters) => { writeLayoutPreferences({ filters }); }}
        groupBy={layoutPrefs.groupBy}
        onGroupBy={(groupBy) => { writeLayoutPreferences({ groupBy }); }}
        sortBy={layoutPrefs.sortBy}
        onSortBy={(sortBy) => { writeLayoutPreferences({ sortBy }); }}
        onNewSession={() => { navigate('/new'); }}
      />

      {/* Stage: the canvas-side frame; the routed page floats on it as one
          raised sheet (the conversation route splits into its own sheets). */}
      <div className="app-stage">
        {wsStatus !== 'open' && !isSettingsRoute ? (
          <div data-app-banner className="shrink-0 border-b border-amber-rule/40 bg-amber-card px-4 py-1.5 text-center text-[12px] font-medium text-amber-ink">
            <span>{wsStatus === 'connecting' ? t('app.reconnecting') : t('app.disconnected')}</span>
            {wsStatus === 'closed' ? (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => { socket.nudge(); }}
                  className="rounded-sm border border-amber-ink/40 px-1.5 py-px font-semibold transition-colors hover:bg-amber-ink/10"
                >
                  {t('app.reconnectNow')}
                </button>
                {' · '}
                <span className="font-normal">{t('app.disconnectedSendHint')}</span>
              </>
            ) : null}
          </div>
        ) : null}
        <RestartBanner />
        <div className="app-sheet">
        <SpaceViewMemory />
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          {/* The conversation shell owns the composer mount across /new and
              /s/:id/*, so sending the hero draft never remounts the textarea. */}
          <Route element={<ConversationShell />}>
            <Route
              path="/new"
              element={<NewSessionPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
            />
            {/* The persona's stable address lives in the shell too: it hands
                over to /s/:id on the same mount when a daily conversation
                already exists, and renders the daily draft when it does not. */}
            <Route
              path="/p/:personaId/daily"
              element={
                <SpaceViewState>
                  <PersonaDailyRoute onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />
                </SpaceViewState>
              }
            />
            <Route
              path="/s/:id/*"
              element={
                <SpaceViewState>
                  <SessionRouteView
                    sessionId={activeSessionId}
                    onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
                    sessions={sessions}
                  />
                </SpaceViewState>
              }
            />
          </Route>
          <Route
            path="/settings/:section?"
            element={<SettingsPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          <Route
            path="/usage"
            element={<UsagePage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          <Route
            path="/activity"
            element={
              <ActivityPage
                sessions={sessions}
                rooms={conversations.rooms}
                workspaceOptions={workspaceOptions}
                onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
              />
            }
          />
          <Route
            path="/board"
            element={
              <TaskBoardPage
                originSessionId={readLastSessionId()}
                sessions={sessions}
                workspaceOptions={workspaceOptions}
                workspacesLoading={workspacesQuery.isPending}
                onNavigate={navigate}
                onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
              />
            }
          />
          <Route
            path="/cron"
            element={
              <CronPage
                sessions={sessions}
                workspaceOptions={workspaceOptions}
                onNavigate={navigate}
                onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
              />
            }
          />
          <Route
            path="/memory"
            element={
              <MemoryPage
                workspaceOptions={workspaceOptions}
                workspacesLoading={workspacesQuery.isPending}
                onNavigate={navigate}
                onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
              />
            }
          />
          <Route
            path="/personas"
            element={<PersonasPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          <Route path="/r/:id" element={<SpaceViewState><RoomLinkRedirect /></SpaceViewState>} />
          <Route
            path="/rooms/:id"
            element={<SpaceViewState><RoomPage sessions={sessions} onToggleSidebar={() => { setSidebarOpen((value) => !value); }} /></SpaceViewState>}
          />
          <Route
            path="/capabilities"
            element={<CapabilitiesPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          {/* More specific than the `/s/:id/*` splat, so the tasks browser wins
              over SessionRouteView while the sidebar keeps the session active. */}
          <Route
            path="/s/:id/tasks"
            element={<SpaceViewState><TasksPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} /></SpaceViewState>}
          />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
        </div>
      </div>


      {sidebarOpen ? (
        <>
          <div
            role="button"
            tabIndex={-1}
            aria-label={t('app.closeSidebar')}
            className="app-overlay-backdrop md:hidden"
            onClick={() => { setSidebarOpen(false); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSidebarOpen(false);
            }}
          />
          {/* md and up: only while an open preview folded the sidebar away
              (index.css hides it otherwise), so a sidebar opened by hand
              over the preview closes on a click outside. */}
          <div
            role="button"
            tabIndex={-1}
            aria-label={t('app.closeSidebar')}
            data-sidebar-scrim="preview"
            className="app-overlay-backdrop z-[39] hidden md:block"
            onClick={() => { setSidebarOpen(false); }}
          />
        </>
      ) : null}

      {quickSwitcherOpen ? (
        <QuickSwitcher
          sessions={sessions}
          workspaces={workspaceOptions}
          initialQuery={switcherQuery}
          onClose={() => { setQuickSwitcherOpen(false); setSwitcherQuery(undefined); }}
        />
      ) : null}
        {shortcutsOpen ? <ShortcutsOverlay onClose={() => { setShortcutsOpen(false); }} /> : null}
        {onboardingOpen ? (
          <OnboardingWizard onClose={() => { setOnboardingOpen(false); }} />
        ) : null}
        <Toasts />
      </div>
      <ConfirmDialog
        stacked
        open={pendingNavigation}
        title={t('st.dirty.leaveTitle')}
        body={t('st.dirty.leaveBody')}
        confirmLabel={t('st.dirty.leaveConfirm')}
        cancelLabel={t('st.dirty.stay')}
        onConfirm={() => { void Promise.resolve().then(confirmNavigation).catch((error: unknown) => {
          if (error instanceof Error && error.name === 'AbortError') return;
          pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
        }); }}
        onCancel={cancelNavigation}
      />
      </NavHistoryBridge>
    </DirtyGuardContext.Provider>
  );
}
