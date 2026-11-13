/**
 * App shell — route-aware three-column layout.
 *
 * Routes:
 *   /                → redirect to last session or /new
 *   /new             → full-page draft conversation
 *   /s/:id           → live session view
 *   /s/:id/tasks     → session background-task browser
 *   /settings/:section? → settings panel
 *   /cron            → scheduled tasks (`?workspace=` scopes them)
 *   /memory          → memory console, or its turn-on guide while memory is off
 *   /usage           → usage dashboard
 *   /archived        → archived conversations: read one, or clear the archive
 *
 * Global actions: Ctrl+N / the sidebar button navigate to the /new draft page
 * from any route, Ctrl+K opens the QuickSwitcher, Ctrl+Tab / Ctrl+Shift+Tab
 * cycle running threads, and Ctrl+/ (or a bare `?`) opens the shortcuts panel.
 * Those are the shipped chords; the saved shortcut table (lib/shortcuts) can
 * remap each one. Browser-owned chords are not intercepted on the web.
 * `document.title` follows the active route; toasts mount at the root.
 */

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import type { WorkPresetItem, WorkspaceCatalogEntry } from '@kiki/protocol';
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
import { UpdateAvailableDialog } from './components/UpdateAvailableDialog';
import { DirtyGuardContext, useDirtyGuardState } from './components/dirtyGuard';
import { DiscoveryPage, DiscoveryProvider, DiscoveryTourTag } from './components/discovery';
import { NewSessionPage } from './components/NewSessionPage';
import { NotifyAskBanner } from './components/firstRun/NotifyAskBanner';
import { ActivityPage, useSessionSeen } from './components/ActivityPage';
import { AppConnectionBanner } from './components/AppConnectionBanner';
import { PINNED_SESSIONS_QUERY_KEY, useConversationList } from './lib/useConversationList';
import { RoomLinkRedirect } from './lib/conversationRoutes';
import { ConversationShell } from './components/ConversationShell';
import { lazyPage, PageLoadBoundary } from './components/LazyPage';
import { PageHeader } from './components/PageChrome';
import { QuickSwitcher } from './components/QuickSwitcher';
import { RestartBanner } from './components/RestartBanner';
import { SessionRouteView, type SidebarBadge } from './components/SessionView';
import { PersonaDailyRoute } from './components/persona/PersonaDailyRoute';
import { SpaceViewMemory, SpaceViewState } from './components/SpaceViewState';
import { readSpaceViewRoute } from './lib/spaceViewState';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { Sidebar } from './components/Sidebar';
import { isBotOrRoomSession } from './components/persona/personaSessionUtils';
import { StorageMigrationViewComponent } from './components/storage/StorageMigrationView';
import { Toasts } from './components/Toasts';
import { WorkPage } from './components/WorkPage';
import { WorkSetupSheet } from './components/WorkSetupSheet';
import { useWorkModes, workPresetsEnabled } from './lib/workModeCatalog';
import { readWindowModeId, writeWindowModeId } from './lib/workModes';
import { landingRouteFor } from './lib/workModeStartup';
import { useHost } from './host';
import {
  adjacentRunningSession,
  arrangePinnedFirst,
  buildConversationInbox,
  groupConversationItems,
  mergeSessionFirstPage,
  readAllSessionPages,
  readSessionFirstPage,
  sortWorkspacesByPinnedThenRecency,
  withPinnedSessions,
  type ConversationListItem,
  type SessionGroup,
  type SessionListData,
} from '@kiki/session-core/sessions';
import {
  readLastSessionId,
  writeDesktopPrefs,
  writeLayoutPreferences,
} from '@kiki/session-core/settings';
import { useLayoutPreferences, useMediaQuery, usePhoneMode, useVisualViewportHeightVar } from './lib/layoutHooks';
import { useLayerHistory } from './lib/layerHistory';
import { setBackdropDrawerClosed } from './lib/skins/backdrop';
import { useAppearancePacks } from './lib/skins/useAppearancePacks';
import { useUserSkins } from './lib/skins/useUserSkins';
import { pushToast } from './lib/toasts';
import { browserOwnsShortcut, isEditableTarget, isImeKeyEvent, matchesShortcutAction, shortcutRecordingActive } from './lib/shortcuts';
import { applyUiZoomAction, desktopZoomShortcut } from './lib/uiZoom';
import { useNavigationComposerFocus } from './lib/navigationComposerFocus';
import { useShortcutPreferencesSync } from './lib/useShortcutPreferences';
import { handleFindShortcut, QUICK_SWITCHER_EVENT, type FindRoute } from './lib/timelineFind';
import { anyOverlayOpen, registerOverlay } from './lib/uiBusy';
import { startVisiblePoll } from './lib/visiblePoll';
import { useAwayNotifications } from './lib/useAwayNotifications';
import { resolveWindowTitle, type WindowRoute } from './lib/windowTitle';
import { useI18n } from './i18n';
import { useConnection } from './state/connection';
import { recordNavigation } from './lib/navHistory';
import {
  desktopPluginFocusHandoff,
  pluginFocusPublication,
  pluginFocusSameIdentity,
  pluginFocusStep,
  type PluginFocusCursor,
  type PluginFocusIdentity,
  type PluginFocusStep,
} from './lib/pluginFocus';
import { requestScopeNavigation } from './lib/navScope';
import { activeSpace, parseActiveSpacePayload } from './lib/spaceStorage';
import { NavHistoryBridge } from './components/NavBackButton';
import { useDesktopUpdateScheduler } from './lib/useDesktopUpdateScheduler';
import { SidebarContext } from './components/sidebarContext';
import { retryRootReadModelDelay, retryRootReadModelQuery } from './lib/readModelRetry';

// Pages a conversation never shows are downloaded on first visit, so a phone
// opening a chat does not fetch and parse them before its first frame
// (components/LazyPage). The conversation path — sidebar, /new, /s/:id, the
// persona daily route, Work — stays in the first-paint graph. Activity and
// Discover stay as well: the sidebar and this shell import other exports of
// those modules, so a lazy import could not move them.
const SettingsPage = lazyPage(() => import('./components/SettingsPage').then((m) => m.SettingsPage));
const UsagePage = lazyPage(() => import('./components/UsagePage').then((m) => m.UsagePage));
const MemoryPage = lazyPage(() => import('./components/MemoryPage').then((m) => m.MemoryPage));
const CapabilitiesPage = lazyPage(() => import('./components/capabilities/CapabilitiesPage').then((m) => m.CapabilitiesPage));
const PersonasPage = lazyPage(() => import('./components/persona/PersonasPage').then((m) => m.PersonasPage));
const CronPage = lazyPage(() => import('./components/GlobalCronPanel').then((m) => m.CronPage));
const ArchivedSessionsPage = lazyPage(() => import('./components/ArchivedSessionsPage').then((m) => m.ArchivedSessionsPage));
const RoomPage = lazyPage(() => import('./components/room/RoomPage').then((m) => m.RoomPage));
const TasksPage = lazyPage(() => import('./components/TasksPage').then((m) => m.TasksPage));

// The sidebar's entries for those pages, by their nav hook attribute.
const NAV_ENTRY_PAGES: readonly (readonly [string, { preload(): void }])[] = [
  ['[data-nav-settings]', SettingsPage],
  ['[data-nav-usage]', UsagePage],
  ['[data-nav-memory]', MemoryPage],
  ['[data-nav-capabilities]', CapabilitiesPage],
  ['[data-nav-personas]', PersonasPage],
  ['[data-nav-cron]', CronPage],
];

export const SESSION_FIRST_PAGE_POLL_INTERVAL_MS = 15_000;

/** The complete pinned-session read, under ['sessions'] so list refreshes reach it. */
export function pinnedSessionsQueryKey(showArchived: boolean, workspaceFilter: string | undefined) {
  return [...PINNED_SESSIONS_QUERY_KEY, showArchived, workspaceFilter] as const;
}

async function showDesktopWindow(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_main_window');
}

async function publishConsumedPluginFocus(homeId: string, requestId: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('remember_plugin_focus', { homeId, requestId });
  await invoke('ack_plugin_focus', { homeId, requestId });
}

/** Show through the permitted native command before changing route. A rejection leaves the cursor unchanged. */
async function applyConnectionPluginFocus(input: {
  request: { readonly id: number; readonly sessionId: string } | undefined;
  cursor: PluginFocusCursor;
  sameConnection: boolean;
  owner: { readonly homeId: string; readonly scopeId: string };
  closed: () => boolean;
  hostKind: string;
  navigate: (route: string) => void;
}): Promise<{ cursor: PluginFocusCursor; consumed: PluginFocusIdentity | undefined }> {
  const step: PluginFocusStep = pluginFocusStep({
    request: input.request === undefined ? undefined : { id: input.request.id, sessionId: input.request.sessionId },
    cursor: input.cursor,
    sameConnection: input.sameConnection,
    owner: input.owner,
  });
  if (step.kind === 'remember') return { cursor: step.cursor, consumed: undefined };
  if (step.kind !== 'focus-current') throw new Error('Current plugin focus lost its connection');
  if (input.hostKind === 'tauri') await showDesktopWindow();
  if (input.closed()) return { cursor: input.cursor, consumed: undefined };
  input.navigate(step.route);
  return { cursor: step.cursor, consumed: pluginFocusPublication(step, input.owner) };
}

function RootRedirect() {
  const host = useHost();
  const { scopeId } = useConnection();
  const { pathname } = useLocation();
  const target = useMemo(() => {
    const saved = host.kind === 'tauri' ? readSpaceViewRoute(scopeId) : undefined;
    if (saved !== undefined) return saved;
    // A window launched into a mode opens on that mode's landing page, so its
    // first frame is the surface the user asked for. The current path is
    // excluded: a route that landed here only because its mode is unavailable
    // has to move on rather than redirect to itself.
    const landing = landingRouteFor(readWindowModeId());
    if (landing !== pathname) return landing;
    const lastSessionId = readLastSessionId();
    return lastSessionId !== undefined ? `/s/${lastSessionId}` : '/new';
  }, [host.kind, pathname, scopeId]);
  return <Navigate to={target} replace />;
}

export { isEditableTarget };

export function App() {
  const { meta } = useConnection();
  if (meta.storage_mode === 'maintenance') {
    return <StorageMigrationViewComponent onComplete={() => { window.location.reload(); }} />;
  }
  return <NormalApp />;
}

function NormalApp() {
  const host = useHost();
  const { client, socket, wsStatus, wsBannerSuppressed, recovery, nudge } = useConnection();
  const { t, locale } = useI18n();
  const rawNavigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const { scopeId, meta, connectionRef, localClient, connectionSource } = useConnection();
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
      : location.pathname === '/discover'
        ? 'Discover'
        : location.pathname === '/usage'
        ? 'Usage'
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
  const closeSidebar = useCallback(() => { setSidebarOpen(false); }, []);
  // Phone keyboard: mirror the visual viewport into the app height chain
  // (index.css consumes --kiki-visual-height on coarse pointers).
  useVisualViewportHeightVar();
  // While the drawer is open on a phone it owns one history entry, so the
  // device back closes it before route navigation (lib/layerHistory).
  const drawerStage = useMediaQuery('(max-width: 767px)');
  const drawerClosed = drawerStage && !sidebarOpen;
  useEffect(() => {
    setBackdropDrawerClosed(drawerClosed);
    return () => { setBackdropDrawerClosed(false); };
  }, [drawerClosed]);
  useLayerHistory('app-sidebar', sidebarOpen && drawerStage, closeSidebar);
  const layoutPrefs = useLayoutPreferences();
  // Sidebar filters persist in layoutPrefs. The fetch mirrors the two
  // server-side narrowings (archived visibility, exactly one workspace); the
  // remaining dimensions filter the loaded list client-side.
  const listFilters = layoutPrefs.filters;
  const showArchived = listFilters.archived !== 'hide';
  const workspaceFilter = listFilters.workspaces.length === 1 ? listFilters.workspaces[0] : undefined;
  const newSessionPath = workspaceFilter === undefined ? '/new' : `/new?workspace=${encodeURIComponent(workspaceFilter)}`;
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Work setup is one sheet, reached from the mode menu on any page and from
  // the Work surface itself, so a user who is mid-conversation can add the
  // missing piece without losing where they were.
  const [workSetup, setWorkSetup] = useState<WorkPresetItem | null>(null);
  const openWorkSetup = useCallback((mode: WorkPresetItem) => { setWorkSetup(mode); }, []);
  // One catalog read per client, shared by the Work surface and the setup
  // sheet so a completed setup refreshes both without a second fetch.
  const workModeCatalog = useWorkModes(client, workPresetsEnabled(meta));
  const performNavigation = useCallback((target: To | number, options?: NavigateOptions) => {
    if (typeof target === 'number') return rawNavigate(target);
    return rawNavigate(target, options);
  }, [rawNavigate]);
  const { value: dirtyGuardValue, navigate, pending: pendingNavigation, confirm: confirmNavigation, cancel: cancelNavigation } =
    useDirtyGuardState(location, performNavigation);
  // The watch survives a new navigate callback. A new client starts again, so a
  // request that already existed is recorded instead of replayed.
  const focusWatch = useRef({
    client: null as object | null,
    current: { initialized: false, seenId: 0 } as PluginFocusCursor,
    local: null as object | null,
    localCursor: { initialized: false, seenId: 0 } as PluginFocusCursor,
    armedNative: null as PluginFocusIdentity | null,
    armedLocal: null as PluginFocusIdentity | null,
    pendingPublish: [] as PluginFocusIdentity[],
  });
  const pendingNavigationRef = useRef(pendingNavigation);
  pendingNavigationRef.current = pendingNavigation;
  // A plugin's "bring up this session" hands focus between desktop windows.
  // On a phone it would only change the page with nobody touching it, so
  // neither watch below runs in phone mode. Nothing waits on this client: the
  // server keeps just the latest request, for ten seconds, and reading it
  // acknowledges nothing (only the desktop shell acks, natively).
  const phoneMode = usePhoneMode();

  useEffect(() => {
    if (phoneMode) {
      // Leaving phone mode starts from a fresh cursor, so a request made while
      // the watch was off is recorded on the first read, never replayed.
      focusWatch.current.client = null;
      focusWatch.current.local = null;
      return;
    }
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const noteConsumed = (identity: PluginFocusIdentity) => {
      const pending = focusWatch.current.pendingPublish;
      if (!pending.some((item) => pluginFocusSameIdentity(item, identity))) pending.push(identity);
    };
    const flushConsumed = async () => {
      const pending = focusWatch.current.pendingPublish;
      while (pending.length > 0) {
        const identity = pending[0];
        if (identity === undefined) return;
        await publishConsumedPluginFocus(identity.homeId, identity.requestId);
        if (focusWatch.current.pendingPublish[0] === identity) focusWatch.current.pendingPublish.shift();
      }
    };
    const read = async () => {
      try {
        if (focusWatch.current.client !== client) {
          focusWatch.current.client = client;
          focusWatch.current.current = { initialized: false, seenId: 0 };
        }
        if (focusWatch.current.local !== localClient) {
          focusWatch.current.local = localClient;
          focusWatch.current.localCursor = { initialized: false, seenId: 0 };
          focusWatch.current.armedLocal = null;
        }
        if (host.kind === 'tauri') await flushConsumed();
        if (closed) return;
        // An open confirmation owns the seat. A later poll retries after it closes.
        if (!pendingNavigationRef.current) {
          let nativeHandoff: ReturnType<typeof desktopPluginFocusHandoff> = undefined;
          if (host.kind === 'tauri') {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              nativeHandoff = desktopPluginFocusHandoff(await invoke('read_plugin_focus'));
            } catch {
              nativeHandoff = undefined;
            }
          }
          let localRestore: Extract<PluginFocusStep, { kind: 'restore-owner' }> | undefined;
          if (nativeHandoff === undefined && host.kind === 'tauri' && localClient !== null && (connectionSource === 'remote' || connectionSource === 'ssh')) {
            const home = parseActiveSpacePayload(await host.activeSpace());
            if (home === null) throw new Error('Active desktop space is unavailable');
            const localRequest = (await localClient.pluginNavigation()).request;
            if (!closed) {
              const localStep = pluginFocusStep({
                request: localRequest === undefined ? undefined : { id: localRequest.id, sessionId: localRequest.sessionId },
                cursor: focusWatch.current.localCursor,
                sameConnection: false,
                owner: { homeId: home.homeId, scopeId: 'local' },
              });
              if (localStep.kind === 'remember') focusWatch.current.localCursor = localStep.cursor;
              else if (localStep.kind === 'restore-owner') {
                if (!pluginFocusSameIdentity(focusWatch.current.armedLocal, { homeId: localStep.homeId, requestId: localStep.cursor.seenId })) {
                  localRestore = localStep;
                }
              } else {
                throw new Error('Local plugin focus lost its owning space');
              }
            }
          }
          if (closed) return;
          if (nativeHandoff !== undefined && !pluginFocusSameIdentity(focusWatch.current.armedNative, nativeHandoff)) {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('show_main_window');
            if (closed) return;
            await requestScopeNavigation({ homeId: nativeHandoff.homeId, scopeId: nativeHandoff.scopeId, route: nativeHandoff.route });
            const handed = { homeId: nativeHandoff.homeId, requestId: nativeHandoff.requestId };
            focusWatch.current.armedNative = handed;
            noteConsumed(handed);
            await flushConsumed();
          } else if (localRestore !== undefined) {
            await showDesktopWindow();
            if (closed) return;
            await requestScopeNavigation({ homeId: localRestore.homeId, scopeId: localRestore.scopeId, route: localRestore.route });
            const handed = { homeId: localRestore.homeId, requestId: localRestore.cursor.seenId };
            focusWatch.current.armedLocal = handed;
            focusWatch.current.localCursor = localRestore.cursor;
            noteConsumed(handed);
            await flushConsumed();
          } else {
            const applied = await applyConnectionPluginFocus({
              request: (await client.pluginNavigation()).request,
              cursor: focusWatch.current.current,
              sameConnection: true,
              owner: { homeId: activeSpace()?.homeId ?? 'main', scopeId: 'local' },
              closed: () => closed,
              hostKind: host.kind,
              navigate: (target) => { void navigate(target); },
            });
            if (closed) return;
            focusWatch.current.current = applied.cursor;
            if (applied.consumed !== undefined && host.kind === 'tauri') {
              noteConsumed(applied.consumed);
              await flushConsumed();
            }
          }
        }
      } catch {
        // A rejected show or a thrown scope transaction leaves that request unconsumed.
        // Returning from the existing confirmation consumes it, so a later poll does not open the dialog again.
      }
      if (!closed) timer = setTimeout(() => { void read(); }, 1500);
    };
    void read();
    return () => { closed = true; clearTimeout(timer); };
  }, [client, localClient, connectionSource, host, navigate, phoneMode]);

  useEffect(() => {
    if (phoneMode) return;
    let closed = false;
    let initialized = false;
    let seen = 0;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const { request } = await client.pluginNavigation();
        if (closed) return;
        if (initialized && request !== undefined && request.id > seen) {
          void navigate(`/s/${encodeURIComponent(request.sessionId)}`);
          if (host.kind === 'tauri') {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const window = getCurrentWindow();
            await window.show(); await window.unminimize(); await window.setFocus();
          }
        }
        initialized = true;
        if (request !== undefined) seen = Math.max(seen, request.id);
      } catch {}
      if (!closed) timer = setTimeout(() => { void read(); }, 1500);
    };
    void read();
    return () => { closed = true; clearTimeout(timer); };
  }, [client, host, navigate, phoneMode]);

  // Sync native desktop prefs into localStorage on boot; listen for tray
  // "New Session" events.
  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((prefs) => {
      if (prefs !== null) writeDesktopPrefs(prefs);
    });
    return host.onTrayNewSession(() => { void navigate(newSessionPath); });
  }, [host, navigate, newSessionPath]);

  // Keep the native side (tray menu labels) on the active UI locale. The tray
  // is a native surface, so a failed write leaves it labelled in the old
  // language while the window is in the new one; that is worth one quiet toast
  // rather than a rejected promise nobody handles.
  useEffect(() => {
    const write = host.writeDesktopPrefs?.({ locale });
    if (write === undefined) return;
    void write.catch(() => {
      pushToast({ tone: 'error', text: t('app.trayLocaleSaveFailed') });
    });
  }, [host, locale, t]);

  const sessionMatch = useMatch('/s/:id/*');
  const activeSessionId = sessionMatch?.params.id;
  const composerAgentMatch = useMatch('/s/:id/agent/:agentId');
  useNavigationComposerFocus(scopeId, activeSessionId, composerAgentMatch?.params.agentId);
  const isNewRoute = useMatch('/new') !== null;
  const isSettingsRoute = useMatch('/settings/*') !== null;
  const isUsageRoute = useMatch('/usage') !== null;

  const sessionsQuery = useInfiniteQuery({
    queryKey: ['sessions', showArchived, workspaceFilter],
    queryFn: ({ pageParam, signal }) =>
      client.listSessions({
        page_size: 50,
        include_archive: showArchived || undefined,
        workspace_id: workspaceFilter,
        before_id: pageParam,
      }, { signal }),
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
    const controller = new AbortController();
    const stop = startVisiblePoll({
      intervalMs: SESSION_FIRST_PAGE_POLL_INTERVAL_MS,
      task: async () => {
        const first = await readSessionFirstPage((before_id) => client.listSessions({
          page_size: 50,
          include_archive: showArchived || undefined,
          workspace_id: workspaceFilter,
          before_id,
        }, { signal: controller.signal }), queryClient.getQueryData<SessionListData>(['sessions', showArchived, workspaceFilter]), controller.signal);
        if (controller.signal.aborted) return;
        queryClient.setQueryData(
          ['sessions', showArchived, workspaceFilter],
          (old: SessionListData | undefined) => mergeSessionFirstPage(old, first),
        );
      },
    });
    return () => {
      stop();
      controller.abort();
    };
  }, [client, queryClient, showArchived, workspaceFilter]);
  // Pinned sessions are read as their own complete set: the recency pages
  // above only reach as far as the reader has scrolled, and an old pinned
  // session must not wait for them. The key sits under ['sessions'], so every
  // list refresh and pin toggle refreshes it too.
  const pinnedSessionsQuery = useQuery({
    queryKey: pinnedSessionsQueryKey(showArchived, workspaceFilter),
    queryFn: ({ signal }) => readAllSessionPages((before_id) => client.listSessions({
      page_size: 100,
      pinned: true,
      include_archive: showArchived || undefined,
      workspace_id: workspaceFilter,
      before_id,
    }, { signal }), signal),
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
  });

  const workspacesQuery = useQuery({
    queryKey: ['workspaces', 'catalog'],
    queryFn: () => client.listWorkspaceCatalog(),
    staleTime: 30_000,
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
  });
  // Pinned workspaces lead the sidebar scope list, and — because the same
  // order seeds workspace grouping — their session buckets come first too.
  const workspaceOptions = useMemo<readonly WorkspaceCatalogEntry[]>(
    () => sortWorkspacesByPinnedThenRecency(workspacesQuery.data?.items ?? []),
    [workspacesQuery.data],
  );

  // The canonical session order powers QuickSwitcher and the /new recent
  // chips, so it stays pinned-first + newest-first regardless of
  // the sidebar's view preference. Grouping applies its own sort internally.
  const sessions = useMemo(
    () => arrangePinnedFirst(withPinnedSessions(sessionsQuery.data, pinnedSessionsQuery.data)),
    [sessionsQuery.data, pinnedSessionsQuery.data],
  );
  const conversations = useConversationList(sessions, layoutPrefs.sortBy, workspaceOptions);
  // The one update schedule for the whole app: a check after the first screen,
  // a daily tick for a window left open, and a catch-up when it comes back. A
  // session waiting on an approval is a modal moment in its own right, so the
  // offer waits rather than landing on top of it.
  const hasPendingApproval = useMemo(
    () => sessions.some((session) => session.pending_interaction === 'approval'),
    [sessions],
  );
  const desktopUpdate = useDesktopUpdateScheduler({ host, isDesktop: desktop, hasPendingApproval });
  // The phone header's ☰ carries the same count as the sidebar bell: a
  // session waiting on the user stays visible from the conversation the
  // drawer hides.
  const seen = useSessionSeen();
  const sidebarBadge = useMemo<SidebarBadge | undefined>(() => {
    const inbox = buildConversationInbox(sessions, conversations.rooms, seen, workspaceOptions);
    return inbox.total === 0 ? undefined : { total: inbox.total, needsYou: inbox.needsYou.length > 0 };
  }, [sessions, conversations.rooms, seen, workspaceOptions]);
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
        void navigate(newSessionPath);
      } else if (matchesShortcutAction(event, 'switcher')) {
        event.preventDefault();
        setQuickSwitcherOpen((open) => !open);
      } else if (matchesShortcutAction(event, 'settings')) {
        event.preventDefault();
        // Land in the search field: Ctrl+, → type → Enter → Esc is the
        // shortest path to any setting, and shorter than the nav tree.
        void navigate('/settings', { state: { focusSearch: true } });
      } else if (matchesShortcutAction(event, 'shortcuts')) {
        event.preventDefault();
        setQuickSwitcherOpen(false);
        setShortcutsOpen((open) => !open);
      } else if (desktop && !event.defaultPrevented && !shortcutRecordingActive()) {
        const zoomAction = desktopZoomShortcut(event);
        if (zoomAction !== null) {
          event.preventDefault();
          applyUiZoomAction(zoomAction);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [navigate, desktop, newSessionPath]);

  // Desktop WebView2 disables Chromium's built-in accelerator zoom, so Ctrl/⌘ +
  // wheel steps the app's interface scale cleanly (leaving browser mode's native
  // pinch/wheel zoom untouched).
  useEffect(() => {
    if (!desktop) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || shortcutRecordingActive()) return;
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.deltaY === 0) return;
      if (event.target instanceof Element && event.target.closest('[data-image-viewport], [data-media-lightbox]')) return;
      event.preventDefault();
      applyUiZoomAction(event.deltaY < 0 ? 'in' : 'out');
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => { window.removeEventListener('wheel', onWheel); };
  }, [desktop]);

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
          void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: { focusSearch: true } });
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

  // Pointing a mouse or pen at, or focusing, the sidebar entry of a page that
  // is downloaded on first visit starts that download, so the click that
  // follows usually finds the page ready. Touch is left out: a finger landing
  // on an entry may still turn into a scroll, and a phone should not spend
  // data on that; the tap itself starts the download.
  useEffect(() => {
    const onIntent = (event: Event) => {
      if ('pointerType' in event && event.pointerType === 'touch') return;
      if (!(event.target instanceof Element)) return;
      for (const [selector, page] of NAV_ENTRY_PAGES) {
        if (event.target.closest(selector) !== null) page.preload();
      }
    };
    document.addEventListener('pointerover', onIntent, true);
    document.addEventListener('focusin', onIntent, true);
    return () => {
      document.removeEventListener('pointerover', onIntent, true);
      document.removeEventListener('focusin', onIntent, true);
    };
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

  // Modified navigation chords remain usable from the composer. Browser-owned
  // Ctrl+Tab is left alone; a web user can bind either action to another chord.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || anyOverlayOpen() || quickSwitcherOpen || shortcutsOpen) return;
      if (!desktop && browserOwnsShortcut(event)) return;
      if (event.target instanceof Element && event.target.closest('.xterm')) return;
      if (isEditableTarget(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      const direction = matchesShortcutAction(event, 'next-session') ? 1
        : matchesShortcutAction(event, 'previous-session') ? -1 : undefined;
      if (direction === undefined) return;
      event.preventDefault();
      const next = adjacentRunningSession(sessions, activeSessionId, direction);
      if (next !== undefined && next !== activeSessionId) void navigate(`/s/${next}`);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [sessions, activeSessionId, navigate, desktop, quickSwitcherOpen, shortcutsOpen]);

  // Close mobile sidebar on route change.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, location.search]);

  // Escape closes the mobile sidebar drawer (the backdrop swallows pointer
  // events, so the key must be handled globally while it is open).
  // Registers with uiBusy so SessionView global abort yields, and prevents
  // default so 1 Escape closes the drawer without aborting a running turn.
  // When another layer inside the drawer is open (such as view/filter menu),
  // anyOverlayOpen(['app-sidebar']) yields so that inner layer consumes Escape first.
  useEffect(() => {
    if (!sidebarOpen) return;
    const unregister = registerOverlay('app-sidebar');
    const onKeyDown = (event: KeyboardEvent) => {
      // An Escape that cancels an IME candidate in the drawer's search field
      // belongs to the IME, not to the drawer.
      if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyEvent(event)) return;
      if (anyOverlayOpen(['app-sidebar'])) return;
      event.preventDefault();
      setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sidebarOpen]);

  // A file released over chrome that takes no files (the sidebar, a settings
  // page) is the browser's to handle, and its handling is to open the file in
  // place of the app. Refuse the drag here unless something inside accepted it
  // first; a native file field keeps its own drop.
  useEffect(() => {
    const refuseStrayFileDrop = (event: DragEvent) => {
      if (event.defaultPrevented || event.dataTransfer === null || !event.dataTransfer.types.includes('Files')) return;
      if (event.target instanceof HTMLInputElement && event.target.type === 'file') return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuseStrayFileDrop);
    window.addEventListener('drop', refuseStrayFileDrop);
    return () => {
      window.removeEventListener('dragover', refuseStrayFileDrop);
      window.removeEventListener('drop', refuseStrayFileDrop);
    };
  }, []);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const isSessionReachable = Boolean(
    activeSessionId
    && !sessionsQuery.isLoading
    && sessionsQuery.data
    && activeSession
    && !activeSession.archived
    && !(activeSession as { deleted?: boolean }).deleted,
  );

  return (
    <SidebarContext.Provider value={{ sidebarOpen, toggleSidebar: () => { setSidebarOpen((v) => !v); }, closeSidebar }}>
    <DirtyGuardContext.Provider value={dirtyGuardValue}>
      <NavHistoryBridge>
      <DiscoveryProvider
        activeSessionId={activeSessionId}
        isSessionBusy={activeSession?.busy}
        sessionReachable={isSessionReachable}
      >
      <div className="flex h-full overflow-hidden bg-canvas">
      <Sidebar
        id="app-sidebar"
        inert={drawerClosed}
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
        onNewSession={() => { void navigate(newSessionPath); }}
        onClose={closeSidebar}
      />

      {/* Stage: the canvas-side frame; the routed page floats on it as one
          raised sheet (the conversation route splits into its own sheets). */}
      <div className="app-stage">
        {wsStatus !== 'open' && !isSettingsRoute ? (
          <AppConnectionBanner wsStatus={wsStatus} suppressInitialConnecting={wsBannerSuppressed} recovery={recovery} onReconnect={() => { if (nudge !== undefined) nudge(); else socket.nudge(); }} onOpenConnectionSettings={() => { void navigate(recovery?.failure?.kind === 'identity' ? '/settings/spaces' : '/settings/connection'); }} />
        ) : null}
        <RestartBanner />
        <NotifyAskBanner />
        <div className="app-sheet">
        <SpaceViewMemory />
        <PageLoadBoundary
          resetKey={location.pathname}
          header={<PageHeader title={t('app.pageLoadFailed')} onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          reloadLabel={t('app.reload')}
        >
        {/* Router navigations are transitions, so opening a lazy page keeps
            the current page on screen until its chunk arrives. This blank
            sheet shows only when the window starts at such a page. */}
        <Suspense fallback={<div className="min-h-0 flex-1" aria-busy="true" />}>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route
            path="/discover"
            element={<DiscoveryPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          {/* The conversation shell owns the composer mount across /new and
              /s/:id/*, so sending the hero draft never remounts the textarea. */}
          <Route element={<ConversationShell />}>
            <Route
              path="/new"
              element={<NewSessionPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
            />
            <Route
              path="/work"
              element={workPresetsEnabled(meta)
                ? <SpaceViewState><WorkPage onSetupMode={openWorkSetup} enabled /></SpaceViewState>
                : <RootRedirect />}
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
                    sidebarBadge={sidebarBadge}
                  />
                </SpaceViewState>
              }
            />
          </Route>
          <Route
            path="/settings/*"
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
            path="/cron"
            element={
              <CronPage
                sessions={sessions}
                workspaceOptions={workspaceOptions}
                onNavigate={(target) => { void navigate(target); }}
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
                onNavigate={(target) => { void navigate(target); }}
                onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
              />
            }
          />
          <Route
            path="/archived"
            element={<ArchivedSessionsPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
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
        </Suspense>
        </PageLoadBoundary>
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
        {workSetup !== null && client !== null ? (
          <WorkSetupSheet
            mode={workSetup}
            client={client}
            onClose={() => { setWorkSetup(null); }}
            onEnabled={(preset) => { writeWindowModeId(preset.id); workModeCatalog.reload(); }}
            onPickFile={() => { setWorkSetup(null); }}
          />
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
      <UpdateAvailableDialog
        offer={desktopUpdate.offer}
        onUpdate={desktopUpdate.onUpdate}
        onRemindLater={desktopUpdate.onRemindLater}
        onSkip={desktopUpdate.onSkip}
        onDismiss={desktopUpdate.onDismiss}
        installing={desktopUpdate.installing}
        installError={desktopUpdate.installError}
        persistError={desktopUpdate.persistError}
      />
      <DiscoveryTourTag />
      </DiscoveryProvider>
      </NavHistoryBridge>
    </DirtyGuardContext.Provider>
    </SidebarContext.Provider>
  );
}
