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

import { startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RemoteConnection, WorkPresetItem, WorkspaceCatalogEntry } from '@kiki/protocol';
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
  useNavigationType,
  useParams,
  type NavigateOptions,
  type To,
} from 'react-router-dom';

import { ConfirmDialog } from './components/ConfirmDialog';
import { DirtyGuardContext, useDirtyGuardState } from './components/dirtyGuard';
import { DiscoveryProvider, useDiscovery } from './components/discovery/DiscoveryContext';
import { NotifyAskBanner } from './components/firstRun/NotifyAskBanner';
import { useSessionSeen } from './lib/sessionSeen';
import { AppConnectionBanner } from './components/AppConnectionBanner';
import { PINNED_SESSIONS_QUERY_KEY, useConversationList } from './lib/useConversationList';
import { RoomLinkRedirect } from './lib/conversationRoutes';
import { ConversationShell } from './components/ConversationShell';
import { lazyPage, PageLoadBoundary } from './components/LazyPage';
import { PageHeader } from './components/PageChrome';
import { RestartBanner } from './components/RestartBanner';
import { SessionRouteView, type SidebarBadge } from './components/SessionView';
import { SpaceViewMemory, SpaceViewState } from './components/SpaceViewState';
import { readSpaceViewRoute } from './lib/spaceViewState';
import { shouldHideFromSessionGroups } from './components/persona/personaSessionUtils';
import { usePersonaDirectory } from './components/persona/usePersonaDirectory';
import { portableSpaceKeys } from './lib/portableSpaces';
import { useSpaces } from './lib/spaces';
import { useSubscribeIntentQueue } from './lib/subscribeIntent';
import { Toasts } from './components/Toasts';
import { useWorkModes, workPresetsEnabled } from './lib/workModeCatalog';
import { readWindowModeId, writeWindowModeId } from './lib/workModes';
import { landingRouteFor } from './lib/workModeStartup';
import { useHost } from './host';
import { writeDraft } from '@kiki/session-core/composer';
import {
  adjacentRunningSession,
  arrangePinnedFirst,
  dedupeSessions,
  flattenSidebarUnitsToSessions,
  groupConversationItems,
  hasFlatSidebarSessionsCapability,
  mergeMultiSpaceConversationItems,
  mergeSessionFirstPage,
  projectSidebarUnitGroups,
  readAllSessionPages,
  readSessionFirstPage,
  sidebarUnitQuerySort,
  sortWorkspacesByPinnedThenRecency,
  withPinnedSessions,
  type ConversationListItem,
  type NamedConversationWorkspace,
  type SessionGroup,
  type SessionListData,
  type SidebarDisplayBucket,
} from '@kiki/session-core/sessions';
import { useSidebarUnitsQuery } from './components/sidebar/useSidebarUnitsQuery';
import {
  encodeConversationRef,
  readLastSessionId,
  writeDesktopPrefs,
  writeLayoutPreferences,
  type SessionPrivateFilter,
} from '@kiki/session-core/settings';
import { useLayoutPreferences, useMediaQuery, usePhoneMode, useVisualViewportHeightVar } from './lib/layoutHooks';
import { useLayerHistory } from './lib/layerHistory';
import { setBackdropDrawerClosed } from './lib/skins/backdrop';
import { useAppearancePacks } from './lib/skins/useAppearancePacks';
import { afterPaint } from './lib/afterPaint';
import { useUserSkins } from './lib/skins/useUserSkins';
import { pushToast } from './lib/toasts';
import { browserOwnsShortcut, isEditableTarget, isImeKeyEvent, matchesShortcutAction, shortcutRecordingActive } from './lib/shortcuts';
import { applyUiZoomAction, desktopZoomShortcut } from './lib/uiZoom';
import { useNavigationComposerFocus } from './lib/navigationComposerFocus';
import { useShortcutPreferencesSync } from './lib/useShortcutPreferences';
import { handleFindShortcut, QUICK_SWITCHER_EVENT, type FindRoute } from './lib/timelineFind';
import { anyOverlayOpen, registerOverlay } from './lib/uiBusy';
import { startVisiblePoll } from './lib/visiblePoll';
import { useConversationSeen } from './lib/conversationOpen';
import { placeNewPath } from './lib/placeRoutes';
import { useAwayNotifications } from './lib/useAwayNotifications';
import { useInboxTriageState } from './lib/useInboxTriageState';
import {
  ALL_SPACE_SCOPE,
  matchesSpaceScope,
  spaceScopeToKey,
  useMultiSpaceSessions,
} from './lib/useMultiSpaceSessions';
import { resolveWindowTitle, type WindowRoute } from './lib/windowTitle';
import { useI18n } from './i18n';
import { useConnection } from './state/connection';
import { PlaceClientProvider, PlaceClientsProvider } from './state/placeClients';
import { useScopeRestore } from './components/NavScopeBoundary';
import { isCrossScopeNavigation, recordNavigation, type NavScopeIdentity } from './lib/navHistory';
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
import { androidBridge, subscribeAndroidHostEvents } from './lib/androidBridge';
import { MOBILE_ASSISTANT_PATH, mobileChatPath, normalizeDeepLinkRoute, readDesktopOverride, writeDesktopOverride } from './mobile/mobileShellRoute';
import { SidebarContext } from './components/sidebarContext';
import { useDeferSecondaryBootQueries } from './lib/bootHydrationGate';
import { retryRootReadModelDelay, retryRootReadModelQuery } from './lib/readModelRetry';

// Pages and shellchrome a cold `/s/:id` session view never renders initially
// are downloaded lazily, keeping mobile cold-open transfer and parse small.
const Sidebar = lazyPage(() => import('./components/Sidebar').then((m) => m.Sidebar));
const DesktopResizableShell = lazyPage(() =>
  import('./components/DesktopResizableShell').then((m) => m.DesktopResizableShell),
);
const NewSessionPage = lazyPage(() => import('./components/NewSessionPage').then((m) => m.NewSessionPage));
const ActivityPage = lazyPage(() => import('./components/ActivityPage').then((m) => m.ActivityPage));
const DiscoveryPage = lazyPage(() => import('./components/discovery/DiscoveryPage').then((m) => m.DiscoveryPage));
const DiscoveryTourTag = lazyPage(() =>
  import('./components/discovery/DiscoveryTourTag').then((m) => m.DiscoveryTourTag),
);
const PersonaDailyRoute = lazyPage(() =>
  import('./components/persona/PersonaDailyRoute').then((m) => m.PersonaDailyRoute),
);
const StorageMigrationViewComponent = lazyPage(() =>
  import('./components/storage/StorageMigrationView').then((m) => m.StorageMigrationViewComponent),
);
const UpdateAvailableDialog = lazyPage(() =>
  import('./components/UpdateAvailableDialog').then((m) => m.UpdateAvailableDialog),
);
const SettingsPage = lazyPage(() => import('./components/SettingsPage').then((m) => m.SettingsPage));
const UsagePage = lazyPage(() => import('./components/UsagePage').then((m) => m.UsagePage));
const MemoryPage = lazyPage(() => import('./components/MemoryPage').then((m) => m.MemoryPage));
const CapabilitiesPage = lazyPage(() => import('./components/capabilities/CapabilitiesPage').then((m) => m.CapabilitiesPage));
const PersonasPage = lazyPage(() => import('./components/persona/PersonasPage').then((m) => m.PersonasPage));
const CronPage = lazyPage(() => import('./components/GlobalCronPanel').then((m) => m.CronPage));
const ArchivedSessionsPage = lazyPage(() => import('./components/ArchivedSessionsPage').then((m) => m.ArchivedSessionsPage));
const RoomPage = lazyPage(() => import('./components/room/RoomPage').then((m) => m.RoomPage));
const TasksPage = lazyPage(() => import('./components/TasksPage').then((m) => m.TasksPage));
const WorkPage = lazyPage(() => import('./components/WorkPage').then((m) => m.WorkPage));
const QuickSwitcher = lazyPage(() => import('./components/QuickSwitcher').then((m) => m.QuickSwitcher));
const ShortcutsOverlay = lazyPage(() => import('./components/ShortcutsOverlay').then((m) => m.ShortcutsOverlay));
const SubscribeModal = lazyPage(() => import('./components/settings/spaces/SubscribeModal').then((m) => m.SubscribeModal));
const WorkSetupSheet = lazyPage(() => import('./components/WorkSetupSheet').then((m) => m.WorkSetupSheet));
const preloadGeneralSettingsSection = () => {
  void import('./components/settings/GeneralSection').catch(() => {});
};

// The sidebar's entries for those pages, by their nav hook attribute.
const NAV_ENTRY_PAGES: readonly (readonly [string, { preload(): void }])[] = [
  ['[data-nav-settings]', { preload: () => { SettingsPage.preload(); preloadGeneralSettingsSection(); } }],
  ['[data-nav-usage]', UsagePage],
  ['[data-nav-memory]', MemoryPage],
  ['[data-nav-capabilities]', CapabilitiesPage],
  ['[data-nav-personas]', PersonasPage],
  ['[data-nav-cron]', CronPage],
];

export const SESSION_FIRST_PAGE_POLL_INTERVAL_MS = 15_000;

/** The complete pinned-session read, under ['sessions'] so list refreshes reach it. */
export function pinnedSessionsQueryKey(
  showArchived: boolean,
  workspaceFilter: string | undefined,
  privateFilter?: SessionPrivateFilter,
) {
  return privateFilter === undefined || privateFilter === 'hide'
    ? ([...PINNED_SESSIONS_QUERY_KEY, showArchived, workspaceFilter] as const)
    : ([...PINNED_SESSIONS_QUERY_KEY, showArchived, workspaceFilter, privateFilter] as const);
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

function PlaceOutlet({
  remoteConnections,
  remoteLoaded,
}: {
  readonly remoteConnections: readonly RemoteConnection[];
  readonly remoteLoaded: boolean;
}) {
  const { connectionId } = useParams<{ connectionId: string }>();
  return (
    <PlaceClientProvider
      connectionId={connectionId}
      remoteConnections={remoteConnections}
      remoteLoaded={remoteLoaded}
    >
      <Outlet />
    </PlaceClientProvider>
  );
}

function ActiveDiscoveryTourTag() {
  const { state } = useDiscovery();
  if (state.lifecycle !== 'active' && state.lifecycle !== 'left') return null;
  return (
    <Suspense fallback={null}>
      <DiscoveryTourTag />
    </Suspense>
  );
}

export function App() {
  const { meta, scopeId } = useConnection();
  if (meta.storage_mode === 'maintenance') {
    return (
      <Suspense fallback={<div className="min-h-0 flex-1" aria-busy="true" />}>
        <StorageMigrationViewComponent onComplete={() => { window.location.reload(); }} />
      </Suspense>
    );
  }
  return (
    <PlaceClientsProvider key={scopeId}>
      <NormalApp key={scopeId} />
    </PlaceClientsProvider>
  );
}

function ShellCatalogSync() {
  useUserSkins();
  useAppearancePacks();
  useShortcutPreferencesSync();
  return null;
}

function NormalApp() {
  const host = useHost();
  const { client, socket, wsStatus, wsBannerSuppressed, recovery, nudge } = useConnection();
  const { t, locale } = useI18n();
  const rawNavigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const { scopeId, spaceKey, meta, connectionRef, localClient, connectionSource, needsScopeReload } = useConnection();
  const scopeRestore = useScopeRestore();
  const desktop = host.kind === 'tauri';

  // Commit the target visit before descendants' passive restoration effects.
  // A blocked transition never changes location and never advances this store.
  useLayoutEffect(() => {
    // During an in-place scope handoff or pending scope reload, the connection
    // has already moved to the target scope while Router is still on the old
    // location. Recording the old pathname under the new scope would overwrite
    // the browser history state and trip NavScopeBoundary's `assertCurrent()`.
    if (scopeRestore?.transitioningInPlace === true || needsScopeReload) return;
    // A remote Kiki is not a local home: its scope key is its own home, the
    // same rule the scope boundary uses. Reading the local home here would
    // stamp every visit `main` beside a remote scope id, and the window that
    // boots into that visit would refuse its own entry as unreachable.
    const localHome = host.kind === 'tauri' ? (activeSpace()?.homeId ?? 'main') : 'main';
    const home = scopeId.startsWith('remote:')
      ? scopeId
      : (typeof spaceKey === 'string' && spaceKey !== '' ? spaceKey : localHome);
    const activeScope: NavScopeIdentity = {
      homeId: home,
      scopeId,
      serverHomeId: meta.server_home_id,
      connectionRef,
    };
    const explicitScope = (location.state as { kikiNav?: { scope?: NavScopeIdentity } } | null)?.kikiNav?.scope;
    if (
      explicitScope !== undefined
      && (isCrossScopeNavigation(activeScope, explicitScope)
        || (explicitScope.serverHomeId !== undefined && explicitScope.serverHomeId !== activeScope.serverHomeId))
    ) {
      return;
    }
    const label = location.pathname.startsWith('/settings')
      ? 'Settings'
      : location.pathname === '/discover'
        ? 'Discover'
        : location.pathname === '/usage'
          ? 'Activity'
        : location.pathname === '/cron'
            ? 'Scheduled tasks'
            : location.pathname === '/memory'
              ? 'Memory'
              : location.pathname === '/new'
                ? 'New session'
                : undefined;
    const entry = recordNavigation({
      location,
      scope: activeScope,
      label,
      action: navType === 'POP' ? 'POP' : navType === 'REPLACE' ? 'REPLACE' : 'PUSH',
    });
    const browserState = window.history.state;
    if (browserState?.key === location.key || (location.key === 'default' && (browserState?.key === null || browserState?.key === undefined))) {
      const userState = browserState?.usr ?? {};
      window.history.replaceState({ ...browserState, usr: { ...userState,
        kikiNav: { ...userState.kikiNav, visitId: entry.visitId, scope: entry.scope } } }, '');
    }
  }, [location, navType, scopeId, spaceKey, host.kind, meta.server_home_id, connectionRef, scopeRestore?.transitioningInPlace, needsScopeReload]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => { setSidebarOpen(false); }, []);
  // Phone keyboard: mirror the visual viewport into the app height chain
  // (index.css consumes --kiki-visual-height on coarse pointers).
  useVisualViewportHeightVar();
  // While the drawer is open on a phone it owns one history entry, so the
  // device back closes it before route navigation (lib/layerHistory).
  const drawerStage = useMediaQuery('(max-width: 767px)');
  const wideNoSidebarOverlay = useMediaQuery('(min-width: 1360px)');
  const drawerClosed = drawerStage && !sidebarOpen;
  const deferSecondaryBoot = useDeferSecondaryBootQueries() && drawerClosed;
  const [backgroundReady, setBackgroundReady] = useState(false);
  useEffect(() => {
    if (deferSecondaryBoot) return;
    return afterPaint(() => { setBackgroundReady(true); });
  }, [deferSecondaryBoot]);
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
  const privateFilter = listFilters.private ?? 'hide';
  const includePrivate = privateFilter === 'include';
  const privateOnly = privateFilter === 'only';
  const workspaceFilter = listFilters.workspaces.length === 1 ? listFilters.workspaces[0] : undefined;
  const sessionsKey = useMemo(
    () => (privateFilter === 'hide'
      ? (['sessions', showArchived, workspaceFilter] as const)
      : (['sessions', showArchived, workspaceFilter, privateFilter] as const)),
    [privateFilter, showArchived, workspaceFilter],
  );
  const focusedScopeKey = spaceScopeToKey(layoutPrefs.spaceScope);
  const focusedRemoteConnId = focusedScopeKey?.startsWith('remote:')
    ? focusedScopeKey.slice('remote:'.length)
    : undefined;
  const newSessionPath = focusedRemoteConnId !== undefined
    ? placeNewPath(focusedRemoteConnId)
    : (workspaceFilter === undefined ? '/new' : `/new?workspace=${encodeURIComponent(workspaceFilter)}`);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Work setup is one sheet, reached from the mode menu on any page and from
  // the Work surface itself, so a user who is mid-conversation can add the
  // missing piece without losing where they were.
  const [workSetup, setWorkSetup] = useState<WorkPresetItem | null>(null);
  const openWorkSetup = useCallback((mode: WorkPresetItem) => { setWorkSetup(mode); }, []);
  // One catalog read per client, shared by the Work surface and the setup
  // sheet so a completed setup refreshes both without a second fetch.
  const workModeCatalog = useWorkModes(client, workPresetsEnabled(meta) && (!deferSecondaryBoot || backgroundReady));
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
  // this watch does not run in phone mode. Nothing waits on this client: the
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const webIdlePollMs = 6000;
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
    const scheduleNext = (hasActiveRequest: boolean) => {
      if (closed) return;
      if (host.kind !== 'tauri' && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      const delayMs = host.kind === 'tauri' || hasActiveRequest ? 1500 : webIdlePollMs;
      timer = setTimeout(() => { void read(); }, delayMs);
    };
    const read = async () => {
      let hasActiveRequest = false;
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
            hasActiveRequest = true;
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('show_main_window');
            if (closed) return;
            await requestScopeNavigation({ homeId: nativeHandoff.homeId, scopeId: nativeHandoff.scopeId, route: nativeHandoff.route });
            const handed = { homeId: nativeHandoff.homeId, requestId: nativeHandoff.requestId };
            focusWatch.current.armedNative = handed;
            noteConsumed(handed);
            await flushConsumed();
          } else if (localRestore !== undefined) {
            hasActiveRequest = true;
            await showDesktopWindow();
            if (closed) return;
            await requestScopeNavigation({ homeId: localRestore.homeId, scopeId: localRestore.scopeId, route: localRestore.route });
            const handed = { homeId: localRestore.homeId, requestId: localRestore.cursor.seenId };
            focusWatch.current.armedLocal = handed;
            focusWatch.current.localCursor = localRestore.cursor;
            noteConsumed(handed);
            await flushConsumed();
          } else {
            const request = (await client.pluginNavigation()).request;
            hasActiveRequest = request !== undefined;
            const applied = await applyConnectionPluginFocus({
              request,
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
      scheduleNext(hasActiveRequest);
    };
    const onVisibilityChange = () => {
      if (closed || host.kind === 'tauri') return;
      if (document.visibilityState === 'hidden') {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        return;
      }
      if (timer === undefined) void read();
    };
    if (host.kind !== 'tauri' && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    void read();
    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (host.kind !== 'tauri' && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [client, localClient, connectionSource, host, navigate, phoneMode]);

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

  const localSessionMatch = useMatch('/s/:id/*');
  const placeSessionMatch = useMatch('/p/:connectionId/s/:id/*');
  const placeNewMatch = useMatch('/p/:connectionId/new');
  const placeRoomMatch = useMatch('/p/:connectionId/rooms/:id');
  const placeRoomLinkMatch = useMatch('/p/:connectionId/r/:id');
  const activePlaceConnectionId =
    placeSessionMatch?.params.connectionId
    ?? placeNewMatch?.params.connectionId
    ?? placeRoomMatch?.params.connectionId
    ?? placeRoomLinkMatch?.params.connectionId;
  const activeSessionId = placeSessionMatch?.params.id ?? localSessionMatch?.params.id;
  const localComposerAgentMatch = useMatch('/s/:id/agent/:agentId');
  const placeComposerAgentMatch = useMatch('/p/:connectionId/s/:id/agent/:agentId');
  const composerAgentMatch = placeComposerAgentMatch ?? localComposerAgentMatch;
  const activeComposerScopeId = activePlaceConnectionId !== undefined ? `remote:${activePlaceConnectionId}` : scopeId;
  useNavigationComposerFocus(activeComposerScopeId, activeSessionId, composerAgentMatch?.params.agentId);
  const isNewRoute = useMatch('/new') !== null || placeNewMatch !== null;
  const isSettingsRoute = useMatch('/settings/*') !== null;
  const isUsageRoute = useMatch('/usage') !== null;

  const sidebarGroupsCapable = hasFlatSidebarSessionsCapability(meta) && client.klient?.rest?.sidebar !== undefined;
  const sidebarSort = sidebarUnitQuerySort(layoutPrefs.sortBy);
  const sidebarUnits = useSidebarUnitsQuery({
    enabled: sidebarGroupsCapable && (!drawerClosed || backgroundReady),
    client,
    wsStatus,
    showArchived,
    workspaceFilter,
    privateFilter,
    sort: sidebarSort,
    pinnedEnabled: backgroundReady || sidebarOpen,
  });

  const sessionsQuery = useInfiniteQuery({
    queryKey: sessionsKey,
    enabled: !sidebarGroupsCapable && (!drawerClosed || backgroundReady),
    queryFn: ({ pageParam, signal }) =>
      client.listSessions({
        page_size: 50,
        include_archive: showArchived || undefined,
        include_private: includePrivate || undefined,
        private_only: privateOnly || undefined,
        workspace_id: workspaceFilter,
        before_id: pageParam,
      }, { signal }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.next_cursor ?? lastPage.items.at(-1)?.id : undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 15_000,
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
  });
  // Refresh the head, bridging to the loaded boundary only when it no longer
  // overlaps. Older loaded pages are not interval-refetched. Global session and
  // persona events trigger an immediate coalesced head refresh so newly created
  // threads appear in the sidebar without waiting for the 15-second poll.
  const queryClient = useQueryClient();
  const personaHeadKey = useMemo(
    () => ['sessions', 'persona-head', showArchived, privateFilter] as const,
    [showArchived, privateFilter],
  );
  useEffect(() => {
    if (sidebarGroupsCapable) return undefined;
    const controller = new AbortController();
    let inFlight = false;
    let queued = false;
    let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
    const probedForeignIds = new Set<string>();

    const hasSessionInCache = (data: SessionListData | undefined, sessionId: string): boolean =>
      Array.isArray(data?.pages) && data.pages.some((page) => Array.isArray(page?.items) && page.items.some((item) => item.id === sessionId));

    const runHeadRefresh = async () => {
      if (controller.signal.aborted) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      queued = false;
      try {
        const current = queryClient.getQueryData<SessionListData>(sessionsKey);
        if (current === undefined) {
          await queryClient.invalidateQueries({ queryKey: sessionsKey });
        } else {
          const first = await readSessionFirstPage((before_id) => client.listSessions({
            page_size: 50,
            include_archive: showArchived || undefined,
            include_private: includePrivate || undefined,
            private_only: privateOnly || undefined,
            workspace_id: workspaceFilter,
            before_id,
          }, { signal: controller.signal }), current, controller.signal);
          if (controller.signal.aborted) return;
          startTransition(() => {
            queryClient.setQueryData(
              sessionsKey,
              (old: SessionListData | undefined) => mergeSessionFirstPage(old, first),
            );
          });
        }
        if (workspaceFilter !== undefined && !controller.signal.aborted) {
          void queryClient.invalidateQueries({ queryKey: personaHeadKey });
        }
      } catch {
        // Transient read errors leave the current list intact until the next event or poll.
      } finally {
        inFlight = false;
        if (!controller.signal.aborted && queued) {
          queued = false;
          void runHeadRefresh();
        }
      }
    };

    const scheduleImmediateRefresh = () => {
      if (controller.signal.aborted || coalesceTimer !== undefined) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = undefined;
        void runHeadRefresh();
      }, 60);
    };

    const noteMaybeNewSession = (sessionId: string, force = false) => {
      if (sessionId === '') return;
      const loaded = queryClient.getQueryData<SessionListData>(sessionsKey);
      if (hasSessionInCache(loaded, sessionId)) return;
      if (!force && workspaceFilter !== undefined) {
        const personaLoaded = queryClient.getQueryData<SessionListData>(personaHeadKey);
        if (hasSessionInCache(personaLoaded, sessionId) || probedForeignIds.has(sessionId)) return;
        if (probedForeignIds.size >= 256) probedForeignIds.clear();
        probedForeignIds.add(sessionId);
      }
      scheduleImmediateRefresh();
    };

    const events = client.klient?.events;
    const subscriptions = events === undefined
      ? []
      : [
          events.on('session.created', (event) => {
            noteMaybeNewSession(event.sessionId, true);
            void queryClient.invalidateQueries({ queryKey: ['sessions', 'ephemeral'] });
          }),
          events.on('session.metaUpdated', (event) => { noteMaybeNewSession(event.sessionId); }),
          events.on('session.workChanged', (event) => { noteMaybeNewSession(event.sessionId); }),
          events.on('personas.changed', () => { scheduleImmediateRefresh(); }),
        ];

    const stop = startVisiblePoll({
      // While the event socket is open, live session events drive head refreshes;
      // keep only a slow safety reconciliation poll so an idle browser stays quiet.
      intervalMs: wsStatus === 'open' ? SESSION_FIRST_PAGE_POLL_INTERVAL_MS * 8 : SESSION_FIRST_PAGE_POLL_INTERVAL_MS,
      task: runHeadRefresh,
    });
    return () => {
      stop();
      if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
      for (const sub of subscriptions) sub.dispose();
      controller.abort();
    };
  }, [client, includePrivate, personaHeadKey, privateOnly, queryClient, sessionsKey, showArchived, sidebarGroupsCapable, workspaceFilter, wsStatus]);
  // Pinned sessions are read as their own complete set: the recency pages
  // above only reach as far as the reader has scrolled, and an old pinned
  // session must not wait for them. The key sits under ['sessions'], so every
  // list refresh and pin toggle refreshes it too.
  const pinnedSessionsQuery = useQuery({
    queryKey: pinnedSessionsQueryKey(showArchived, workspaceFilter, privateFilter),
    enabled: !sidebarGroupsCapable && (backgroundReady || sidebarOpen),
    staleTime: 15_000,
    queryFn: ({ signal }) => readAllSessionPages((before_id) => client.listSessions({
      page_size: 100,
      pinned: true,
      include_archive: showArchived || undefined,
      include_private: includePrivate || undefined,
      private_only: privateOnly || undefined,
      workspace_id: workspaceFilter,
      before_id,
    }, { signal }), signal),
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
  });

  const workspacesQuery = useQuery({
    queryKey: ['workspaces', 'catalog'],
    enabled: !drawerClosed || backgroundReady || isNewRoute,
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

  const personaHeadQuery = useQuery({
    queryKey: personaHeadKey,
    enabled: workspaceFilter !== undefined && (backgroundReady || sidebarOpen),
    queryFn: async ({ signal }): Promise<SessionListData> => ({
      pages: [await client.listSessions({
        page_size: 100,
        include_archive: showArchived || undefined,
        include_private: includePrivate || undefined,
        private_only: privateOnly || undefined,
      }, { signal })],
      pageParams: [undefined],
    }),
    staleTime: 15_000,
    retry: retryRootReadModelQuery,
    retryDelay: retryRootReadModelDelay,
  });

  // The canonical session order powers QuickSwitcher and the /new recent
  // chips, so it stays pinned-first + newest-first regardless of
  // the sidebar's view preference. Grouping applies its own sort internally.
  const sessions = useMemo(() => {
    const all = sidebarGroupsCapable
      ? arrangePinnedFirst(flattenSidebarUnitsToSessions(sidebarUnits.units))
      : arrangePinnedFirst(withPinnedSessions(sessionsQuery.data, pinnedSessionsQuery.data));
    if (privateFilter === 'only') return all.filter((session) => session.private === true);
    if (privateFilter === 'include') return all;
    return all.filter((session) => session.private !== true);
  }, [privateFilter, sidebarGroupsCapable, sidebarUnits.units, sessionsQuery.data, pinnedSessionsQuery.data]);
  const globalSessions = useMemo(() => {
    if (workspaceFilter === undefined) return sessions;
    const rawCrossWorkspace = dedupeSessions(personaHeadQuery.data);
    const crossWorkspace = privateFilter === 'only'
      ? rawCrossWorkspace.filter((session) => session.private === true)
      : privateFilter === 'include'
        ? rawCrossWorkspace
        : rawCrossWorkspace.filter((session) => session.private !== true);
    if (crossWorkspace.length === 0) return sessions;
    return dedupeSessions({
      pages: [{ items: [...sessions, ...crossWorkspace], has_more: false }],
      pageParams: [undefined],
    });
  }, [workspaceFilter, sessions, personaHeadQuery.data, privateFilter]);
  const conversations = useConversationList(sessions, layoutPrefs.sortBy, workspaceOptions, {
    skipLegacyMetaRefresh: sidebarGroupsCapable,
    enabled: !deferSecondaryBoot || backgroundReady,
  });
  // The one update schedule for the whole app: a check after the first screen,
  // a daily tick for a window left open, and a catch-up when it comes back. A
  // session waiting on an approval is a modal moment in its own right, so the
  // offer waits rather than landing on top of it.
  const hasPendingApproval = useMemo(
    () => globalSessions.some((session) => session.pending_interaction === 'approval'),
    [globalSessions],
  );
  const desktopUpdate = useDesktopUpdateScheduler({ host, isDesktop: desktop, hasPendingApproval });
  // The phone header's ☰ carries the same count as the sidebar bell: a
  // session waiting on the user stays visible from the conversation the
  // drawer hides.
  const seen = useSessionSeen();
  const seenV2 = useConversationSeen();
  const personaDirectoryState = usePersonaDirectory({
    sessions: globalSessions,
    seen,
    enabled: !deferSecondaryBoot || backgroundReady,
  });
  const rawPersonaDirectory = personaDirectoryState.data === undefined ? undefined : personaDirectoryState.directory;
  const activeSpaceScope = layoutPrefs.spaceScope ?? ALL_SPACE_SCOPE;
  const multiSpaceSidebarFilter = useMemo(
    () => ({ showArchived, includePrivate, privateOnly, sort: sidebarSort }),
    [showArchived, includePrivate, privateOnly, sidebarSort],
  );
  const multiSpace = useMultiSpaceSessions({
    activeSessions: globalSessions,
    activeSidebarUnits: sidebarGroupsCapable ? sidebarUnits.units : undefined,
    activeRooms: conversations.rooms,
    activeWorkspaces: workspaceOptions,
    sidebarFilter: multiSpaceSidebarFilter,
    spaceScope: activeSpaceScope,
    enabled: !drawerClosed,
  });
  const localRoomMatch = useMatch('/rooms/:id');
  const activeRoomId = placeRoomMatch?.params.id ?? localRoomMatch?.params.id;
  const activePlaceSpaceKey = activePlaceConnectionId !== undefined
    ? `remote:${activePlaceConnectionId}`
    : spaceKey;
  const activeConversationKey = activeSessionId !== undefined
    ? encodeConversationRef({ spaceKey: activePlaceSpaceKey, kind: 'session', id: activeSessionId })
    : activeRoomId !== undefined
      ? encodeConversationRef({ spaceKey: activePlaceSpaceKey, kind: 'room', id: activeRoomId })
      : undefined;
  const inboxTriage = useInboxTriageState({
    sources: multiSpace.sources,
    currentSpaceKey: spaceKey,
    spaceScope: activeSpaceScope,
    activeConversationKey,
  });
  const sidebarBadge = useMemo<SidebarBadge | undefined>(() => {
    const current = inboxTriage.inbox;
    return current.total === 0
      ? undefined
      : { total: current.total, needsYou: current.needsYouCount > 0, needsYouCount: current.needsYouCount };
  }, [inboxTriage.inbox]);
  const activePlaceSessions = useMemo(() => {
    if (activePlaceConnectionId === undefined) return sessions;
    const src = multiSpace.sources.find((entry) => entry.spaceKey === `remote:${activePlaceConnectionId}`);
    return src?.sessions ?? [];
  }, [activePlaceConnectionId, multiSpace.sources, sessions]);
  const sessionGroups = useMemo<readonly SessionGroup<ConversationListItem>[]>(() => {
    if (sidebarGroupsCapable) return [];
    const scopedSources = multiSpace.sources.filter((src) => matchesSpaceScope(activeSpaceScope, src.spaceKey));
    const hasRemoteSources = scopedSources.some((src) => src.isRemote);
    const localOnlyMatching = !hasRemoteSources && scopedSources.length === 1 && scopedSources[0]?.spaceKey === spaceKey;
    const rawItems = localOnlyMatching
      ? conversations.items
      : mergeMultiSpaceConversationItems(
          scopedSources.map((src) => (
            src.spaceKey === spaceKey && !src.isRemote
              ? { ...src, sessions, rooms: conversations.rooms, workspaces: workspaceOptions }
              : src
          )),
          seenV2,
          layoutPrefs.sortBy,
          spaceKey,
          seen,
        );
    // A Bot's active home and a room member's own session keep their single
    // address (the Persona rows above, the room's row); everything else lists here.
    const items = rawItems.filter((item) =>
      item.kind === 'room' || item.isRemote === true || !shouldHideFromSessionGroups(item.session, rawPersonaDirectory));
    const mergedWorkspaces: NamedConversationWorkspace[] = [...workspaceOptions];
    if (!localOnlyMatching) {
      const seenWs = new Set(workspaceOptions.map((ws) => ws.id));
      for (const src of scopedSources) {
        for (const ws of src.workspaces ?? []) {
          if (!seenWs.has(ws.id)) {
            seenWs.add(ws.id);
            mergedWorkspaces.push(ws);
          }
        }
      }
    }
    return groupConversationItems(items, {
      groupBy: layoutPrefs.groupBy,
      workspaces: mergedWorkspaces,
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
  }, [
    multiSpace.sources,
    activeSpaceScope,
    spaceKey,
    conversations.items,
    conversations.rooms,
    sessions,
    workspaceOptions,
    seenV2,
    seen,
    rawPersonaDirectory,
    listFilters,
    layoutPrefs.groupBy,
    layoutPrefs.sortBy,
    t,
    sidebarGroupsCapable,
  ]);

  const sidebarUnitBuckets = useMemo<readonly SidebarDisplayBucket[] | undefined>(() => {
    if (!sidebarGroupsCapable) return undefined;
    const scopedSources = multiSpace.unitSources.filter((src) => matchesSpaceScope(activeSpaceScope, src.spaceKey));
    const mergedWorkspaces: NamedConversationWorkspace[] = [...workspaceOptions];
    const seenWs = new Set(workspaceOptions.map((ws) => ws.id));
    for (const src of scopedSources) {
      for (const ws of src.workspaces ?? []) {
        if (!seenWs.has(ws.id)) {
          seenWs.add(ws.id);
          mergedWorkspaces.push(ws);
        }
      }
    }
    return projectSidebarUnitGroups(scopedSources, {
      groupBy: layoutPrefs.groupBy,
      workspaces: mergedWorkspaces,
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
      seenV2,
      fallbackLocalSpaceKey: spaceKey,
      fallbackLocalSeen: seen,
      shouldHideRow: (_row, session, _rowSpaceKey, isRemote) =>
        !isRemote && shouldHideFromSessionGroups(session, rawPersonaDirectory),
    });
  }, [
    sidebarGroupsCapable,
    multiSpace.unitSources,
    activeSpaceScope,
    workspaceOptions,
    layoutPrefs.groupBy,
    layoutPrefs.sortBy,
    listFilters,
    t,
    seenV2,
    spaceKey,
    seen,
    rawPersonaDirectory,
  ]);

  const activeSessionsQuery = useMemo(() => (
    sidebarGroupsCapable
      ? {
          isLoading: sidebarUnits.isLoading,
          isError: sidebarUnits.isError,
          error: sidebarUnits.error,
          data: sidebarUnits.listData,
          hasNextPage: sidebarUnits.hasNextPage,
          isFetchingNextPage: sidebarUnits.isFetchingNextPage,
          fetchNextPage: sidebarUnits.fetchNextPage,
        }
      : sessionsQuery
  ), [
    sidebarGroupsCapable,
    sidebarUnits.isLoading,
    sidebarUnits.isError,
    sidebarUnits.error,
    sidebarUnits.listData,
    sidebarUnits.hasNextPage,
    sidebarUnits.isFetchingNextPage,
    sidebarUnits.fetchNextPage,
    sessionsQuery,
  ]);

  const handleLoadMoreGroupMembers = useCallback(
    async (groupId: string, targetSpaceKey: string, cursor: string) => {
      if (targetSpaceKey === spaceKey) {
        await sidebarUnits.loadMoreGroupMembers(groupId, cursor);
      } else {
        await multiSpace.loadMoreSpaceGroupMembers(targetSpaceKey, groupId, cursor);
      }
    },
    [spaceKey, sidebarUnits.loadMoreGroupMembers, multiSpace.loadMoreSpaceGroupMembers],
  );

  const sidebarNextCursor = sidebarGroupsCapable
    ? sidebarUnits.nextCursor
    : (sessionsQuery.data?.pages.at(-1)?.has_more
        ? (sessionsQuery.data.pages.at(-1)?.next_cursor ?? sessionsQuery.data.pages.at(-1)?.items.at(-1)?.id)
        : undefined);
  const sidebarQueryGeneration = sidebarGroupsCapable
    ? sidebarUnits.queryGenerationKey
    : JSON.stringify(sessionsKey);

  // System notifications while the window is in the background, the taskbar
  // badge, and notification clicks back to their session.
  const listNewestSessions = useCallback(
    () => client.listSessions({ page_size: 100 }).then((page) => page.items),
    [client],
  );
  useAwayNotifications({
    host,
    sessions: globalSessions,
    listSessions: listNewestSessions,
    unifiedInbox: inboxTriage.allSpacesInbox,
    enabled: backgroundReady,
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

  // Consume Android host deep-link `navigate` and `share-intake` events cleanly without DOM scraping.
  useEffect(() => subscribeAndroidHostEvents((detail) => {
    if (detail.type === 'navigate') {
      void navigate(normalizeDeepLinkRoute(detail.route, false));
      return;
    }
    if (detail.type === 'share-intake') {
      const applyDraft = (text: string) => {
        const trimmed = text.trim();
        if (trimmed === '') return;
        const draftTarget = activeSessionId ?? 'new';
        writeDraft(draftTarget, trimmed);
        if (activeSessionId === undefined) {
          void navigate('/new');
        }
      };
      if (detail.draft !== undefined && detail.draft.trim() !== '') {
        applyDraft(detail.draft);
      } else {
        void androidBridge.takeShareIntake(detail.id).then((items) => {
          const text = items
            .map((entry) => entry.text?.trim() || entry.path?.trim() || '')
            .filter((part) => part !== '')
            .join('\n');
          applyDraft(text);
        });
      }
    }
  }), [activeSessionId, navigate]);

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

  // Consume desktop `kiki://subscribe?...` intents via the authoritative FIFO
  // pump and scrub legacy `?subscribe=` query parameters immediately without
  // navigating away from unsaved drafts.
  const subscribeQueue = useSubscribeIntentQueue(host, location, navigate);
  const inRemoteScopeForSubscribe = connectionSource === 'remote' || connectionSource === 'ssh';
  const subscribeControlClient = host.kind === 'tauri'
    ? localClient
    : (localClient ?? (inRemoteScopeForSubscribe ? null : client));
  const subscribeSpaces = useSpaces(subscribeQueue.activeIntent !== null ? subscribeControlClient : null);

  // Escape closes the mobile sidebar drawer (the backdrop swallows pointer
  // events, so the key must be handled globally while it is open).
  // Registers with uiBusy so SessionView global abort yields, and prevents
  // default so 1 Escape closes the drawer without aborting a running turn.
  // When another layer inside the drawer is open (such as view/filter menu),
  // anyOverlayOpen(['app-sidebar']) yields so that inner layer consumes Escape first.
  useEffect(() => {
    if (wideNoSidebarOverlay && sidebarOpen) setSidebarOpen(false);
  }, [wideNoSidebarOverlay, sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen) return;
    if (!drawerStage && typeof document !== 'undefined') {
      const previewFoldingSidebar = document.querySelector('.conversation-row .preview-workspace:not([hidden]):not([data-preview-fullscreen])') !== null;
      if (!previewFoldingSidebar) {
        setSidebarOpen(false);
        return;
      }
    }
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
  }, [sidebarOpen, drawerStage]);

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
    && !activeSessionsQuery.isLoading
    && activeSessionsQuery.data
    && activeSession
    && !activeSession.archived
    && !(activeSession as { deleted?: boolean }).deleted,
  );

  const wideDockedDesktop = useMediaQuery('(min-width: 1360px)');
  const dockedSidebarSplit = wideDockedDesktop && layoutPrefs.sidebarCollapsed !== true;
  const [sidebarMounted, setSidebarMounted] = useState(!deferSecondaryBoot);
  useEffect(() => {
    if (!deferSecondaryBoot) setSidebarMounted(true);
  }, [deferSecondaryBoot]);

  const sidebarNode = sidebarMounted || !drawerClosed ? (
    <Suspense
      fallback={
        <aside
          id="app-sidebar"
          inert={drawerClosed}
          className={dockedSidebarSplit ? 'app-sidebar !w-full' : `app-sidebar ${sidebarOpen ? 'open' : ''}`}
        />
      }
    >
      <Sidebar
        id="app-sidebar"
        inert={drawerClosed}
        dockedInPanelGroup={dockedSidebarSplit}
        temporaryOpen={sidebarOpen && !wideDockedDesktop}
        className={dockedSidebarSplit ? 'app-sidebar !w-full' : `app-sidebar ${sidebarOpen ? 'open' : ''}`}
        activeSessionId={activeSessionId}
        sessions={sessions}
        personaSessions={globalSessions}
        rooms={conversations.rooms}
        sessionGroups={sessionGroups}
        sidebarUnitBuckets={sidebarUnitBuckets}
        sidebarGroupsEnabled={sidebarGroupsCapable}
        sidebarNextCursor={sidebarNextCursor}
        sidebarQueryGeneration={sidebarQueryGeneration}
        onLoadMoreGroupMembers={sidebarGroupsCapable ? handleLoadMoreGroupMembers : undefined}
        loadingGroupIds={sidebarUnits.loadingGroupIds}
        groupMemberErrors={sidebarUnits.groupMemberErrors}
        onDetachGroupMember={sidebarGroupsCapable ? sidebarUnits.detachGroupMember : undefined}
        sessionsQuery={activeSessionsQuery}
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
        multiSpaceSources={multiSpace.sources}
        healthBySpace={multiSpace.healthBySpace}
        hasMoreBySpace={multiSpace.hasMoreBySpace}
        nextCursorBySpace={multiSpace.nextCursorBySpace}
        loadingMoreSpaces={multiSpace.loadingMoreSpaces}
        onLoadMoreSpaceSessions={multiSpace.loadMoreSpaceSessions}
        hasMultipleSpaces={multiSpace.hasMultipleSpaces}
        localSpaceKey={multiSpace.localSpaceKey}
        onRefreshRemoteSpace={multiSpace.refreshRemoteSpace}
        inboxTriage={inboxTriage}
      />
    </Suspense>
  ) : (
    <aside id="app-sidebar" inert className="app-sidebar" />
  );

  const stageNode = (
    <div className="app-stage">
      {backgroundReady ? <ShellCatalogSync /> : null}
      {wsStatus !== 'open' && !isSettingsRoute ? (
        <AppConnectionBanner wsStatus={wsStatus} suppressInitialConnecting={wsBannerSuppressed} recovery={recovery} onReconnect={() => { if (nudge !== undefined) nudge(); else socket.nudge(); }} onOpenConnectionSettings={() => { void navigate(recovery?.failure?.kind === 'identity' ? '/settings/spaces' : '/settings/connection'); }} />
      ) : null}
      <RestartBanner />
      <NotifyAskBanner />
      <div className="app-sheet">
      <SpaceViewMemory />
      {scopeRestore?.transitioningInPlace === true ? (
        <div className="min-h-0 flex-1" aria-busy="true" />
      ) : (
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
                sessions={globalSessions}
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
          {/* In-place paired remote computer routes (`/p/:connectionId/...`):
              mounts the center conversation / new-session / room canvas + Right
              Inspector Rail inside PlaceClientProvider while keeping Left
              Sidebar and Settings permanently bound to the local home. */}
          <Route
            path="/p/:connectionId"
            element={
              <PlaceOutlet
                remoteConnections={multiSpace.remoteConnections}
                remoteLoaded={!multiSpace.remoteLoading}
              />
            }
          >
            <Route element={<ConversationShell />}>
              <Route
                path="new"
                element={<NewSessionPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
              />
              <Route
                path="s/:id/*"
                element={
                  <SpaceViewState>
                    <SessionRouteView
                      sessionId={activeSessionId}
                      onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
                      sessions={activePlaceSessions}
                      sidebarBadge={sidebarBadge}
                    />
                  </SpaceViewState>
                }
              />
            </Route>
            <Route
              path="s/:id/tasks"
              element={<SpaceViewState><TasksPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} /></SpaceViewState>}
            />
            <Route path="r/:id" element={<SpaceViewState><RoomLinkRedirect /></SpaceViewState>} />
            <Route
              path="rooms/:id"
              element={<SpaceViewState><RoomPage sessions={activePlaceSessions} onToggleSidebar={() => { setSidebarOpen((value) => !value); }} /></SpaceViewState>}
            />
          </Route>
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
      )}
        </div>
      </div>
  );

  const toggleSidebar = useCallback(() => { setSidebarOpen((v) => !v); }, []);
  const sidebarContextValue = useMemo(
    () => ({ sidebarOpen, toggleSidebar, closeSidebar }),
    [sidebarOpen, toggleSidebar, closeSidebar],
  );

  return (
    <SidebarContext.Provider value={sidebarContextValue}>
    <DirtyGuardContext.Provider value={dirtyGuardValue}>
      <NavHistoryBridge>
      <DiscoveryProvider
        activeSessionId={activeSessionId}
        isSessionBusy={activeSession?.busy}
        sessionReachable={isSessionReachable}
      >
      <div className="flex h-full overflow-hidden bg-canvas">
      {dockedSidebarSplit ? (
        <Suspense
          fallback={(
            <>
              {sidebarNode}
              {stageNode}
            </>
          )}
        >
          <DesktopResizableShell
            defaultSidebarWidth={layoutPrefs.sidebarWidth}
            resizeAriaLabel={t('sidebar.resizeAria')}
            sidebar={sidebarNode}
            stage={stageNode}
          />
        </Suspense>
      ) : (
        <>
          {sidebarNode}
          {stageNode}
        </>
      )}


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

      <Suspense fallback={null}>
      {quickSwitcherOpen ? (
        <QuickSwitcher
          sessions={sessions}
          workspaces={workspaceOptions}
          initialQuery={switcherQuery}
          onClose={() => { setQuickSwitcherOpen(false); setSwitcherQuery(undefined); }}
        />
      ) : null}
        {shortcutsOpen ? <ShortcutsOverlay onClose={() => { setShortcutsOpen(false); }} /> : null}
        {subscribeQueue.activeIntent !== null && subscribeControlClient !== null ? (
          <SubscribeModal
            key={subscribeQueue.activeIntent.id}
            client={subscribeControlClient}
            spaces={subscribeSpaces.data ?? []}
            mode={{ kind: 'new', initialIntent: subscribeQueue.activeIntent }}
            queuedCount={subscribeQueue.queuedCount}
            onClose={() => { void subscribeQueue.settleActiveIntent(); }}
            onDone={(result) => {
              void queryClient.invalidateQueries({ queryKey: portableSpaceKeys.all });
              if (result.kind === 'commit') {
                const count = result.commit.appliedIds.length + result.commit.deletedIds.length;
                const text = result.commit.kind === 'once'
                  ? t('st.portable.center.importOnceDone', { count })
                  : t('st.portable.subscribeDone', { name: result.commit.source.label, count });
                pushToast({
                  tone: 'success',
                  text,
                  ...(location.pathname.startsWith('/settings/subscriptions')
                    ? {}
                    : {
                      action: {
                        label: t('st.section.subscriptions'),
                        run: () => { void navigate('/settings/subscriptions'); },
                      },
                    }),
                });
              }
              void subscribeQueue.settleActiveIntent();
            }}
          />
        ) : null}
        {workSetup !== null && client !== null ? (
          <WorkSetupSheet
            mode={workSetup}
            client={client}
            onClose={() => { setWorkSetup(null); }}
            onEnabled={(preset) => { writeWindowModeId(preset.id); workModeCatalog.reload(); }}
            onPickFile={() => { setWorkSetup(null); }}
          />
        ) : null}
      </Suspense>
        <Toasts />
        {readDesktopOverride() ? (
          <button
            type="button"
            data-return-mobile-chip
            onClick={() => {
              writeDesktopOverride(false);
              void navigate(activeSessionId !== undefined ? mobileChatPath('local', activeSessionId) : MOBILE_ASSISTANT_PATH);
            }}
            className="kiki-mobile-glass-pill fixed right-4 bottom-[calc(16px+var(--kiki-safe-bottom-inset))] z-40 inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-normal text-ink transition-colors hover:bg-panel"
          >
            <span>{t('mobile.desktop.returnMobile')}</span>
          </button>
        ) : null}
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
      {desktopUpdate.offer !== null ? (
        <Suspense fallback={null}>
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
        </Suspense>
      ) : null}
      <ActiveDiscoveryTourTag />
      </DiscoveryProvider>
      </NavHistoryBridge>
    </DirtyGuardContext.Provider>
    </SidebarContext.Provider>
  );
}
