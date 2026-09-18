/**
 * App shell — route-aware three-column layout.
 *
 * Routes:
 *   /                → redirect to last session or /new
 *   /new             → full-page draft conversation
 *   /s/:id           → live session view
 *   /s/:id/tasks     → session background-task browser
 *   /settings/:section? → settings panel
 *
 * Global actions: Ctrl+N / the sidebar button navigate to the /new draft page
 * from any route, Ctrl+K opens the QuickSwitcher, Ctrl+Tab jumps to the most
 * recent other session, and Ctrl+/ (or a bare `?`) opens the shortcuts panel.
 * Ctrl+N and Ctrl+Tab are browser-reserved and register only in the desktop
 * runtime.
 * `document.title` follows the active route; toasts mount at the root.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Workspace } from '@kiki/protocol';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
  type NavigateOptions,
  type To,
} from 'react-router-dom';

import { ConfirmDialog } from './components/ConfirmDialog';
import { GlobalTaskBoard } from './components/GlobalTaskBoard';
import { DirtyGuardContext, shouldGuardNavigation } from './components/dirtyGuard';
import { NewSessionPage } from './components/NewSessionPage';
import {
  OnboardingWizard,
  shouldOfferOnboarding,
  subscribeOnboardingOpenRequests,
} from './components/OnboardingWizard';
import { CapabilitiesShim } from './components/CapabilitiesShim';
import { ConversationShell } from './components/ConversationShell';
import { QuickSwitcher } from './components/QuickSwitcher';
import { RestartBanner } from './components/RestartBanner';
import { SessionRouteView } from './components/SessionView';
import { SettingsPage } from './components/SettingsPage';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { Sidebar } from './components/Sidebar';
import { TasksPage } from './components/TasksPage';
import { Toasts } from './components/Toasts';
import { UsagePage } from './components/UsagePage';
import { useHost } from './host';
import {
  arrangePinnedFirst,
  dedupeSessions,
  groupSessionsByTime,
  groupSessionsByWorkspace,
  mergeSessionFirstPage,
  sortSessionItems,
  sortWorkspacesByPinnedThenRecency,
  type SessionGroup,
  type SessionListData,
} from '@kiki/session-core/sessions';
import {
  isOnboardingCompleted,
  readLastSessionId,
  writeDesktopPrefs,
  writeLayoutPreferences,
} from '@kiki/session-core/settings';
import { isSessionIndexBuildingError } from './lib/client';
import { useLayoutPreferences } from './lib/layoutHooks';
import { pushToast } from './lib/toasts';
import { anyOverlayOpen } from './lib/uiBusy';
import { startVisiblePoll } from './lib/visiblePoll';
import { resolveWindowTitle, type WindowRoute } from './lib/windowTitle';
import { useI18n } from './i18n';
import { useConnection } from './state/connection';

export function retryRootReadModelQuery(_failureCount: number, error: Error): boolean {
  return isSessionIndexBuildingError(error);
}

function RootRedirect() {
  const lastSessionId = useMemo(() => readLastSessionId(), []);
  return <Navigate to={lastSessionId !== undefined ? `/s/${lastSessionId}` : '/new'} replace />;
}

/**
 * True while focus sits in a text input surface. Global navigation shortcuts
 * that would yank focus away (Ctrl+Tab session hopping) must yield to it;
 * deliberate app shortcuts (Ctrl+K, Ctrl+, …) stay active by design.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLInputElement === 'undefined') return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function App() {
  const host = useHost();
  const { client, socket, wsStatus } = useConnection();
  const { t, locale } = useI18n();
  const rawNavigate = useNavigate();
  const location = useLocation();
  const desktop = host.kind === 'tauri';
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState<string | undefined>(undefined);
  const layoutPrefs = useLayoutPreferences();
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
  const [dirtyIds, setDirtyIds] = useState<readonly string[]>([]);
  const [pendingNavigation, setPendingNavigation] = useState<{
    readonly target: To;
    readonly options?: NavigateOptions;
  } | null>(null);

  const reportDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((current) => {
      const has = current.includes(id);
      if (has === dirty) return current;
      return dirty ? [...current, id] : current.filter((entry) => entry !== id);
    });
  }, []);
  const navigate = useCallback((target: To, options?: NavigateOptions) => {
    if (shouldGuardNavigation(location, target, dirtyIds.length > 0)) {
      setPendingNavigation({ target, options });
      return;
    }
    void rawNavigate(target, options);
  }, [dirtyIds.length, location, rawNavigate]);
  const dirtyGuardValue = useMemo(
    () => ({ dirty: dirtyIds.length > 0, reportDirty, navigate }),
    [dirtyIds.length, navigate, reportDirty],
  );
  const confirmNavigation = () => {
    const pending = pendingNavigation;
    setPendingNavigation(null);
    setDirtyIds([]);
    if (pending !== null) void rawNavigate(pending.target, pending.options);
  };

  // Sync native desktop prefs into localStorage on boot; listen for tray
  // "New Session" events.
  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((prefs) => {
      if (prefs !== null) writeDesktopPrefs(prefs);
    });
    return host.onTrayNewSession(() => void navigate('/new'));
  }, [host, navigate]);

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    const timer = window.setTimeout(() => {
      void host.checkDesktopUpdate()
        .then((update) => {
          if (update !== null) {
            pushToast({ tone: 'info', text: t('st.about.updateAvailable', { version: update.version }) });
          }
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

  const sessionsQuery = useInfiniteQuery({
    queryKey: ['sessions', showArchived, workspaceFilter],
    queryFn: ({ pageParam }) =>
      client.listSessions({
        page_size: 100,
        include_archive: showArchived || undefined,
        workspace_id: workspaceFilter,
        before_id: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.items.at(-1)?.id : undefined,
    initialPageParam: undefined as string | undefined,
    retry: retryRootReadModelQuery,
  });
  // Poll only the first page (where every change lands). Interval-refetching
  // an infinite query refetches ALL loaded pages on every tick; older pages
  // instead refresh on demand (load-more) or on invalidation.
  const queryClient = useQueryClient();
  useEffect(() => {
    return startVisiblePoll({
      intervalMs: 5000,
      task: async () => {
        const first = await client.listSessions({
          page_size: 100,
          include_archive: showArchived || undefined,
          workspace_id: workspaceFilter,
        });
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
  const sessionGroups = useMemo<readonly SessionGroup[]>(() => {
    const sorted = sortSessionItems(sessions, layoutPrefs.sortBy);
    const nowMs = Date.now();
    if (layoutPrefs.groupBy === 'workspace') {
      // Pinned rows keep a global leading bucket here too: a per-workspace
      // bucket would bury the sessions the user asked to keep on top.
      return groupSessionsByWorkspace(
        sorted,
        workspaceOptions,
        (workspace) => workspace.name,
        t('sidebar.groupUngrouped'),
        t('sidebar.groupPinned'),
      );
    }
    return groupSessionsByTime(
      sorted,
      nowMs,
      {
        pinned: t('sidebar.groupPinned'),
        today: t('sidebar.groupToday'),
        yesterday: t('sidebar.groupYesterday'),
        week: t('sidebar.groupWeek'),
        month: t('sidebar.groupMonth'),
        older: t('sidebar.groupOlder'),
      },
    );
  }, [sessions, workspaceOptions, layoutPrefs.groupBy, layoutPrefs.sortBy, t]);

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
  // toggles the quick switcher; Ctrl+Tab jumps to the most recent other
  // session (the list arrives sorted by updated_at, newest first).
  // ⌘, / Ctrl+, opens settings.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'n' && !event.shiftKey && !event.altKey) {
        // Browsers reserve Ctrl+N (new window) — preventDefault cannot stop
        // it, so the binding stays desktop-only instead of half-firing.
        if (!desktop) return;
        event.preventDefault();
        setQuickSwitcherOpen(false);
        void navigate('/new');
      } else if (key === 'k' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setQuickSwitcherOpen((open) => !open);
      } else if (key === ',' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        // Land in the search field: Ctrl+, → type → Enter → Esc is the
        // shortest path to any setting, and shorter than the nav tree.
        void navigate('/settings', { state: { focusSearch: true } });
      } else if (key === '/' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setQuickSwitcherOpen(false);
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [navigate, desktop]);

  // A bare `?` (outside editable targets and other overlays) also opens the
  // shortcuts panel — the discoverability path for keyboard-first users.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
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
      void navigate(lastNonSettingsRef.current);
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
      if (!event.ctrlKey || event.key !== 'Tab') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      const next = sessions.find((session) => session.id !== activeSessionId);
      if (next !== undefined) {
        setQuickSwitcherOpen(false);
        void navigate(`/s/${next.id}`);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [sessions, activeSessionId, navigate, desktop]);

  // Close mobile sidebar on route change.
  useEffect(() => {
    setSidebarOpen(false);
  }, [activeSessionId, isNewRoute, isSettingsRoute, isUsageRoute]);

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
      <div className="flex h-full overflow-hidden bg-paper">
      <Sidebar
        className={`app-sidebar ${sidebarOpen ? 'open' : ''}`}
        activeSessionId={activeSessionId}
        sessions={sessions}
        sessionGroups={sessionGroups}
        sessionsQuery={sessionsQuery}
        workspaceOptions={workspaceOptions}
        workspaceFilter={workspaceFilter}
        onWorkspaceFilter={setWorkspaceFilter}
        showArchived={showArchived}
        onToggleArchived={() => { setShowArchived((value) => !value); }}
        groupBy={layoutPrefs.groupBy}
        onGroupBy={(groupBy) => { writeLayoutPreferences({ groupBy }); }}
        sortBy={layoutPrefs.sortBy}
        onSortBy={(sortBy) => { writeLayoutPreferences({ sortBy }); }}
        onNewSession={() => { void navigate('/new'); }}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {wsStatus !== 'open' && !isSettingsRoute ? (
          <div className="shrink-0 border-b border-amber-rule/40 bg-amber-card px-4 py-1.5 text-center text-[12px] font-medium text-amber-ink">
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
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          {/* The conversation shell owns the composer mount across /new and
              /s/:id/*, so sending the hero draft never remounts the textarea. */}
          <Route element={<ConversationShell />}>
            <Route
              path="/new"
              element={<NewSessionPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
            />
            <Route
              path="/s/:id/*"
              element={
                <SessionRouteView
                  sessionId={activeSessionId}
                  onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
                  sessions={sessions}
                />
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
            path="/capabilities"
            element={<CapabilitiesShim />}
          />
          {/* More specific than the `/s/:id/*` splat, so the tasks browser wins
              over SessionRouteView while the sidebar keeps the session active. */}
          <Route
            path="/s/:id/tasks"
            element={<TasksPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </div>

      <GlobalTaskBoard
        activeSessionId={activeSessionId}
        sessions={sessions}
        workspaceOptions={workspaceOptions}
        workspacesLoading={workspacesQuery.isPending}
        onNavigate={navigate}
      />

      {sidebarOpen ? (
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
      ) : null}

      {quickSwitcherOpen ? (
        <QuickSwitcher sessions={sessions} onClose={() => { setQuickSwitcherOpen(false); }} />
      ) : null}
        {shortcutsOpen ? <ShortcutsOverlay onClose={() => { setShortcutsOpen(false); }} /> : null}
        {onboardingOpen ? (
          <OnboardingWizard onClose={() => { setOnboardingOpen(false); }} />
        ) : null}
        <Toasts />
      </div>
      <ConfirmDialog
        open={pendingNavigation !== null}
        title={t('st.dirty.leaveTitle')}
        body={t('st.dirty.leaveBody')}
        confirmLabel={t('st.dirty.leaveConfirm')}
        cancelLabel={t('st.dirty.stay')}
        onConfirm={confirmNavigation}
        onCancel={() => { setPendingNavigation(null); }}
      />
    </DirtyGuardContext.Provider>
  );
}
