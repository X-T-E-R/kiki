import { Drawer } from '@base-ui/react/drawer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

import type { Session } from '@kiki/protocol';
import {
  buildUnifiedInbox,
  hasSemanticAttentionCursor,
  isConversationUnread,
  mergeSessionFirstPage,
  pendingKindOf,
  sessionAttentionCursor,
  type SessionListData,
  type SpaceConversationSource,
  type UnifiedInboxEntry,
  type UnifiedInboxItem,
} from '@kiki/session-core/sessions';
import {
  encodeConversationRef,
  markConversationSeen,
  writeLayoutPreferences,
} from '@kiki/session-core/settings';

import { Icon } from '../components/icons';
import { ToastAnchor, Toasts } from '../components/Toasts';
import { Wordmark } from '../components/Wordmark';
import { useI18n } from '../i18n';
import { androidBridge, subscribeAndroidHostEvents } from '../lib/androidBridge';
import { isEmbeddedAndroidHost } from '../lib/appShell';
import { beginExplicitConversationOpen, useConversationSeen } from '../lib/conversationOpen';
import { useHostBackBridge, useLayerHistory } from '../lib/layerHistory';
import { anyOverlayOpen } from '../lib/uiBusy';
import { useLayoutPreferences, useVisualViewportHeightVar } from '../lib/layoutHooks';
import { requestScopeNavigation } from '../lib/navScope';
import { remoteSpaceKey, remoteSpaceScope } from '../lib/remoteConnections';
import { clearErrorToasts, pushToast } from '../lib/toasts';
import {
  ALL_SPACE_SCOPE,
  matchesSpaceScope,
  spaceScopeToKey,
  useMultiSpaceSessions,
} from '../lib/useMultiSpaceSessions';
import { useAppearancePacks } from '../lib/skins/useAppearancePacks';
import { useUserSkins } from '../lib/skins/useUserSkins';
import { useSpacePreferencesFrame } from '../lib/spacePreferences';
import { spaceSettingsTargetOf } from '../lib/spaceSettings';
import { useConnection } from '../state/connection';

import { lazyComponent } from '../lib/lazyComponent';
import { MobileChatScreen } from './chat/MobileChatScreen';
import type { AssistantComputer } from './components/AssistantSetupView';
import { useMobileClientResolver } from './mobileClientPool';
import {
  desktopWorkbenchPath,
  isMobileChatPath,
  MOBILE_ASSISTANT_PATH,
  MOBILE_CHATS_PATH,
  MOBILE_ONBOARDING_PATH,
  MOBILE_SPACES_PATH,
  MOBILE_TODAY_PATH,
  mobileChatPath,
  normalizeDeepLinkRoute,
  writeDesktopOverride,
} from './mobileShellRoute';
import { AssistantTab } from './tabs/AssistantTab';
import { useSoftKeyboardOpen } from './useSoftKeyboardOpen';

const ChatsTab = lazyComponent(() => import('./tabs/ChatsTab').then((m) => m.ChatsTab));
const SpacesTab = lazyComponent(() => import('./tabs/SpacesTab').then((m) => m.SpacesTab));
const MobileSpaceSheet = lazyComponent(() => import('./MobileSpaceSheet').then((m) => m.MobileSpaceSheet));
const QuickCaptureSheet = lazyComponent(() => import('./components/QuickCaptureSheet').then((m) => m.QuickCaptureSheet));
const MobileVoiceOverlay = lazyComponent(() => import('./chat/MobileVoiceOverlay').then((m) => m.MobileVoiceOverlay));

if (import.meta.env.MODE === 'test') {
  await Promise.all([
    ChatsTab.preload(),
    SpacesTab.preload(),
    MobileSpaceSheet.preload(),
    QuickCaptureSheet.preload(),
    MobileVoiceOverlay.preload(),
  ]);
}

function ChatRouteBridge({
  resolveClient,
  resolveSpaceName,
  onBack,
  onOpenWorkbench,
  onOpenProviderSettings,
  onOpenVoiceForChat,
}: {
  readonly resolveClient: ReturnType<typeof useMobileClientResolver>;
  readonly resolveSpaceName: (spaceKey: string) => string;
  readonly onBack: () => void;
  readonly onOpenWorkbench: (spaceKey: string, sessionId: string) => void;
  readonly onOpenProviderSettings: (spaceKey: string) => void;
  readonly onOpenVoiceForChat: (onResult: (text: string) => void) => void;
}) {
  const params = useParams<{ readonly spaceKey: string; readonly sessionId: string }>();
  const spaceKey = decodeURIComponent(params.spaceKey ?? 'local');
  const sessionId = decodeURIComponent(params.sessionId ?? '');
  const targetClient = resolveClient(spaceKey);

  if (sessionId === '') {
    return <Navigate to={MOBILE_CHATS_PATH} replace />;
  }

  return (
    <MobileChatScreen
      spaceKey={spaceKey}
      spaceName={resolveSpaceName(spaceKey)}
      sessionId={sessionId}
      client={targetClient}
      onBack={onBack}
      onOpenWorkbench={() => { onOpenWorkbench(spaceKey, sessionId); }}
      onOpenProviderSettings={() => { onOpenProviderSettings(spaceKey); }}
      onOpenVoiceForChat={onOpenVoiceForChat}
    />
  );
}

function projectChatItemsFromEntries(
  entries: readonly UnifiedInboxEntry[],
  seenMap: ReturnType<typeof useConversationSeen>,
  fallbackTitle: string,
): readonly UnifiedInboxItem[] {
  const items: UnifiedInboxItem[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'session') continue;
    const { session } = entry;
    if (session.archived === true || session.private === true) continue;
    const ref = { spaceKey: entry.spaceKey, kind: 'session' as const, id: session.id };
    const encodedKey = encodeConversationRef(ref);
    const cursor = sessionAttentionCursor(session);
    const pending = pendingKindOf(session);
    const needsYou = pending !== 'none';
    const unread = !session.busy && isConversationUnread(cursor, seenMap[encodedKey], hasSemanticAttentionCursor(session));
    items.push({
      ref,
      encodedKey,
      spaceKey: entry.spaceKey,
      spaceName: entry.spaceName,
      isRemote: entry.isRemote,
      workspaceId: session.workspace_id,
      workspaceName: entry.workspaceName,
      sessionId: session.id,
      title: session.title?.trim() || fallbackTitle,
      reason: pending !== 'none' ? pending : session.busy ? 'running' : 'completed',
      at: session.updated_at,
      busy: session.busy === true,
      attentionCursor: cursor,
      lastSeq: session.last_seq,
      triageClass: needsYou || unread ? 'active' : session.busy ? 'working' : 'settled',
      unread,
      needsYou,
      preview: session.last_prompt?.trim() || undefined,
      personaId: session.agent_config?.persona?.id,
      personaName: session.agent_config?.persona?.name,
      model: session.agent_config?.model,
    });
  }
  return items.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function entriesFromSources(sources: readonly SpaceConversationSource[]): readonly UnifiedInboxEntry[] {
  const entries: UnifiedInboxEntry[] = [];
  for (const source of sources) {
    const wsNameById = new Map((source.workspaces ?? []).map((ws) => [ws.id, ws.name]));
    for (const session of source.sessions) {
      entries.push({
        kind: 'session',
        spaceKey: source.spaceKey,
        spaceName: source.spaceName,
        isRemote: source.isRemote,
        workspaceName: wsNameById.get(session.workspace_id),
        session,
      });
    }
  }
  return entries;
}

function DesktopSessionRouteRedirect() {
  const params = useParams<{ readonly connectionId?: string; readonly sessionId?: string }>();
  const sessionId = decodeURIComponent(params.sessionId ?? '');
  if (sessionId === '') {
    return <Navigate to={MOBILE_CHATS_PATH} replace />;
  }
  const spaceKey = params.connectionId ? remoteSpaceKey(decodeURIComponent(params.connectionId)) : 'local';
  return <Navigate to={mobileChatPath(spaceKey, sessionId)} replace />;
}

export function MobileAppShell() {
  useVisualViewportHeightVar();
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { client, meta } = useConnection();
  useSpacePreferencesFrame(spaceSettingsTargetOf(client, meta));
  useUserSkins();
  useAppearancePacks();
  const layoutPrefs = useLayoutPreferences();
  const seenMap = useConversationSeen();
  const resolveClient = useMobileClientResolver();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const keyboardOpen = useSoftKeyboardOpen(shellRef);

  const [spaceSheetOpen, setSpaceSheetOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickInitialText, setQuickInitialText] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voiceCallbackRef = useRef<((text: string) => void) | null>(null);

  const activeScope = layoutPrefs.spaceScope ?? ALL_SPACE_SCOPE;

  // Clear stale sticky error toasts on route transitions so offline banners never linger over controls.
  useEffect(() => {
    clearErrorToasts();
  }, [location.pathname]);

  // Paginated local session list (initial head stays paginated; older pages load on demand).
  const mobileSessionsQueryKey = useMemo(
    () => ['mobile-sessions', 'local', client.baseUrl] as const,
    [client.baseUrl],
  );
  const sessionsQuery = useInfiniteQuery({
    // The shell's own connection is always the local space; remote spaces come from useMultiSpaceSessions.
    queryKey: mobileSessionsQueryKey,
    staleTime: 8_000,
    refetchOnWindowFocus: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      client.listSessions({ before_id: pageParam }, { signal }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? (lastPage.next_cursor ?? lastPage.items.at(-1)?.id) : undefined,
  });

  // Poll only page 0 every 15s and merge into the cached infinite pages so deep pagination
  // never causes N sequential page refetches on every interval.
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let abort: AbortController | null = null;
    const pollHead = async () => {
      if (!active || inFlight) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      inFlight = true;
      abort = new AbortController();
      try {
        const freshFirstPage = await client.listSessions({}, { signal: abort.signal });
        if (!active) return;
        queryClient.setQueryData<SessionListData>(mobileSessionsQueryKey, (current) =>
          mergeSessionFirstPage(current, freshFirstPage),
        );
      } catch {
        // Keep cached pages on transient poll failure.
      } finally {
        inFlight = false;
        abort = null;
      }
    };
    const timer = setInterval(() => { void pollHead(); }, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
      abort?.abort();
    };
  }, [client, mobileSessionsQueryKey, queryClient]);

  const workspacesQuery = useQuery({
    queryKey: ['mobile-workspaces', 'local', client.baseUrl],
    staleTime: 60_000,
    queryFn: async () => (await client.listWorkspaceCatalog()).items,
  });

  const activeSessions = useMemo<readonly Session[]>(() => {
    const pages = sessionsQuery.data?.pages;
    if (pages === undefined) return [];
    const seenIds = new Set<string>();
    const out: Session[] = [];
    for (const page of pages) {
      for (const item of page.items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          out.push(item);
        }
      }
    }
    return out;
  }, [sessionsQuery.data]);
  const multiSpace = useMultiSpaceSessions({
    activeSessions,
    activeRooms: [],
    activeWorkspaces: workspacesQuery.data ?? [],
    enabled: !isMobileChatPath(location.pathname),
  });

  // Subscribe to Android native deep-links (notification tap) and share-intake bridge events,
  // plus foreground `kiki:pair-deeplink` events from Capacitor iOS/Android.
  useEffect(() => {
    const unsubscribeAndroid = subscribeAndroidHostEvents((detail) => {
      if (detail.type === 'navigate') {
        const target = normalizeDeepLinkRoute(detail.route, true);
        void navigate(target);
      } else if (detail.type === 'share-intake') {
        const openWithDraft = (text: string) => {
          if (text.trim() === '') return;
          setQuickInitialText(text);
          setQuickOpen(true);
        };
        if (detail.draft !== undefined && detail.draft.trim() !== '') {
          openWithDraft(detail.draft);
        } else {
          void androidBridge.takeShareIntake(detail.id).then((items) => {
            const parts = items
              .map((entry) => entry.text?.trim() || entry.path?.trim() || '')
              .filter((part) => part !== '');
            openWithDraft(parts.join('\n'));
          });
        }
      }
    });

    const onPairDeeplink = () => {
      void navigate(MOBILE_SPACES_PATH);
    };
    window.addEventListener('kiki:pair-deeplink', onPairDeeplink);
    return () => {
      unsubscribeAndroid();
      window.removeEventListener('kiki:pair-deeplink', onPairDeeplink);
    };
  }, [navigate]);

  const allEntries = useMemo<readonly UnifiedInboxEntry[]>(
    () => entriesFromSources(multiSpace.sources),
    [multiSpace.sources],
  );

  const scopedEntries = useMemo(
    () => allEntries.filter((entry) => matchesSpaceScope(activeScope, entry.spaceKey)),
    [activeScope, allEntries],
  );

  const globalInbox = useMemo(
    () => buildUnifiedInbox(allEntries, seenMap, {}),
    [allEntries, seenMap],
  );
  const scopedInbox = useMemo(
    () => buildUnifiedInbox(scopedEntries, seenMap, {}),
    [scopedEntries, seenMap],
  );

  // Full conversation list for ChatsTab (including read conversations, newest first).
  const allChatItems = useMemo<readonly UnifiedInboxItem[]>(
    () => projectChatItemsFromEntries(scopedEntries, seenMap, t('mobile.chats.title')),
    [scopedEntries, seenMap, t],
  );

  const hasMoreChats = useMemo(() => {
    if (matchesSpaceScope(activeScope, multiSpace.localSpaceKey) && sessionsQuery.hasNextPage) {
      return true;
    }
    for (const [key, more] of multiSpace.hasMoreBySpace.entries()) {
      if (more && matchesSpaceScope(activeScope, key)) return true;
    }
    return false;
  }, [activeScope, multiSpace.hasMoreBySpace, multiSpace.localSpaceKey, sessionsQuery.hasNextPage]);

  const loadingMoreChats = sessionsQuery.isFetchingNextPage || multiSpace.loadingMoreSpaces.size > 0;

  const loadMoreChats = useCallback(() => {
    const reportError = (error: unknown) => {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    };
    if (
      matchesSpaceScope(activeScope, multiSpace.localSpaceKey) &&
      sessionsQuery.hasNextPage &&
      !sessionsQuery.isFetchingNextPage
    ) {
      void sessionsQuery.fetchNextPage().catch(reportError);
    }
    for (const [key, more] of multiSpace.hasMoreBySpace.entries()) {
      if (more && matchesSpaceScope(activeScope, key)) {
        void multiSpace.loadMoreSpaceSessions(key).catch(reportError);
      }
    }
  }, [activeScope, multiSpace, sessionsQuery]);

  const seenMapRef = useRef(seenMap);
  seenMapRef.current = seenMap;

  const searchChatItems = useCallback(
    async (query: string, signal: AbortSignal): Promise<readonly UnifiedInboxItem[]> => {
      const matchedSources = await multiSpace.searchAcrossSpaces(query, activeScope, signal);
      return projectChatItemsFromEntries(
        entriesFromSources(matchedSources),
        seenMapRef.current,
        t('mobile.chats.title'),
      );
    },
    [activeScope, multiSpace, t],
  );

  const needsYouItems = useMemo(
    () => scopedInbox.active.filter((item) => item.needsYou),
    [scopedInbox.active],
  );

  const onlineSpacesCount = useMemo(() => {
    let count = 0;
    for (const health of multiSpace.healthBySpace.values()) {
      if (health.state === 'online') count += 1;
    }
    return Math.max(1, count);
  }, [multiSpace.healthBySpace]);

  const localCounts = useMemo(() => {
    let waiting = 0;
    let running = 0;
    for (const item of globalInbox.active) {
      if (item.spaceKey === multiSpace.localSpaceKey && item.needsYou) waiting += 1;
    }
    for (const item of globalInbox.working) {
      if (item.spaceKey === multiSpace.localSpaceKey) running += 1;
    }
    return { waiting, running };
  }, [globalInbox.active, globalInbox.working, multiSpace.localSpaceKey]);

  const resolveSpaceName = useCallback(
    (spaceKey: string): string => {
      if (spaceKey === 'local' || spaceKey === multiSpace.localSpaceKey) {
        return isEmbeddedAndroidHost() ? t('mobile.space.localPhone') : multiSpace.localSpaceName;
      }
      return multiSpace.healthBySpace.get(spaceKey)?.spaceName ?? spaceKey;
    },
    [multiSpace.healthBySpace, multiSpace.localSpaceKey, multiSpace.localSpaceName, t],
  );

  const activeScopeKey = spaceScopeToKey(activeScope);
  const currentSpaceLabel =
    activeScopeKey === undefined ? t('mobile.space.all') : resolveSpaceName(activeScopeKey);
  const currentSpaceTone: 'online' | 'attention' | 'offline' =
    needsYouItems.length > 0
      ? 'attention'
      : activeScopeKey !== undefined && multiSpace.healthBySpace.get(activeScopeKey)?.state === 'offline'
        ? 'offline'
        : 'online';

  const targetCaptureSpaceKey = activeScopeKey ?? multiSpace.localSpaceKey;
  const targetCaptureSpaceName = resolveSpaceName(targetCaptureSpaceKey);

  const openItem = useCallback(
    (item: UnifiedInboxItem) => {
      beginExplicitConversationOpen(item.ref, item.attentionCursor, {
        syncLegacy: !item.isRemote,
      });
      void navigate(mobileChatPath(item.spaceKey, item.sessionId));
    },
    [navigate],
  );

  // Carries the thread being read into the workbench; a remote space is activated first.
  const openDesktopWorkbench = useCallback(
    (spaceKey?: string, sessionId?: string) => {
      writeDesktopOverride(true);
      const route = desktopWorkbenchPath(sessionId);
      if (spaceKey !== undefined && spaceKey.startsWith('remote:')) {
        void requestScopeNavigation({
          ...remoteSpaceScope(spaceKey.slice('remote:'.length)),
          route,
          inPlace: true,
        }).catch(() => { void navigate(route); });
        return;
      }
      void navigate(route);
    },
    [navigate],
  );

  const openProviderSettings = useCallback(
    (spaceKey?: string) => {
      writeDesktopOverride(true);
      const route = '/settings/providers';
      if (spaceKey !== undefined && spaceKey.startsWith('remote:')) {
        void requestScopeNavigation({
          ...remoteSpaceScope(spaceKey.slice('remote:'.length)),
          route,
          inPlace: true,
        }).catch(() => { void navigate(route); });
        return;
      }
      void navigate(route);
    },
    [navigate],
  );

  const assistantComputers = useMemo<readonly AssistantComputer[]>(() => {
    const computers: AssistantComputer[] = [{ spaceKey: multiSpace.localSpaceKey, name: resolveSpaceName(multiSpace.localSpaceKey) }];
    for (const record of multiSpace.remoteConnections) {
      if (!record.enabled) continue;
      const key = remoteSpaceKey(record.id);
      const online = multiSpace.healthBySpace.get(key)?.state === 'online' || record.state === 'online';
      if (online) computers.push({ spaceKey: key, name: record.label });
    }
    return computers;
  }, [multiSpace.healthBySpace, multiSpace.localSpaceKey, multiSpace.remoteConnections, resolveSpaceName]);

  const archiveItem = useCallback(
    async (item: UnifiedInboxItem) => {
      try {
        const targetClient = resolveClient(item.spaceKey);
        await targetClient.archiveSession(item.sessionId);
        void queryClient.invalidateQueries({ queryKey: ['mobile-sessions'] });
        void multiSpace.refetchRemotes();
        pushToast({ tone: 'success', text: t('mobile.chats.archived') });
      } catch (error) {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [multiSpace, queryClient, resolveClient, t],
  );

  const inChat = isMobileChatPath(location.pathname);
  const inOnboarding = location.pathname === MOBILE_ONBOARDING_PATH;
  const activeTab: 'assistant' | 'chats' | 'spaces' = location.pathname.startsWith(MOBILE_CHATS_PATH)
    ? 'chats'
    : location.pathname.startsWith(MOBILE_SPACES_PATH)
      ? 'spaces'
      : 'assistant';

  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  useHostBackBridge();
  useLayerHistory('mobile-nav-drawer', navDrawerOpen, () => {
    setNavDrawerOpen(false);
  });

  useEffect(() => {
    setNavDrawerOpen(false);
  }, [location.pathname]);

  const navBadgeTotal = globalInbox.needsYouCount + globalInbox.unreadCount;

  return (
    <Drawer.Provider>
      <div
        ref={shellRef}
        data-mobile-shell
        data-keyboard-open={keyboardOpen ? '' : undefined}
        className="kiki-mobile-shell"
      >
        <ToastAnchor className="kiki-mobile-toast-anchor" />

        <Drawer.Root
          open={navDrawerOpen}
          modal="trap-focus"
          onOpenChange={(nextOpen, eventDetails) => {
            if (!nextOpen && (eventDetails.reason === 'outside-press' || eventDetails.reason === 'escape-key') && anyOverlayOpen()) {
              eventDetails.cancel();
              return;
            }
            setNavDrawerOpen(nextOpen);
          }}
          swipeDirection="left"
        >
          {!inChat && !inOnboarding && !spaceSheetOpen && !quickOpen && !voiceOpen ? (
            <Drawer.SwipeArea
              swipeDirection="right"
              data-mobile-swipe-area=""
              className="fixed inset-y-0 left-0 z-30 w-5"
            />
          ) : null}

          <Drawer.Indent className="kiki-drawer-indent flex min-h-0 flex-1 flex-col">
            <Routes>
              <Route
                path="/m/assistant"
                element={
                  <AssistantTab
                    scopeSpaceKey={activeScopeKey}
                    computers={assistantComputers}
                    resolveClient={resolveClient}
                    resolveSpaceName={resolveSpaceName}
                    needsYouItems={globalInbox.active.filter((item) => item.needsYou)}
                    onOpenItem={openItem}
                    onRefresh={() => {
                      void queryClient.invalidateQueries({ queryKey: ['mobile-sessions'] });
                      void multiSpace.refetchRemotes();
                    }}
                    onPairComputer={() => { void navigate(MOBILE_SPACES_PATH); }}
                    onOpenWorkbench={openDesktopWorkbench}
                    onOpenProviderSettings={openProviderSettings}
                    onOpenVoiceForChat={(onResult) => {
                      voiceCallbackRef.current = onResult;
                      setVoiceOpen(true);
                    }}
                    onScopeChange={(scope) => { writeLayoutPreferences({ spaceScope: scope }); }}
                    onOpenNavDrawer={() => { setNavDrawerOpen(true); }}
                    navUnreadBadge={navBadgeTotal}
                  />
                }
              />
              <Route path={MOBILE_TODAY_PATH} element={<Navigate to={MOBILE_ASSISTANT_PATH} replace />} />
              <Route
                path="/m/chats"
                element={
                  <ChatsTab
                    spaceLabel={currentSpaceLabel}
                    spaceStatusTone={currentSpaceTone}
                    items={allChatItems}
                    showSpaceTag={activeScope === ALL_SPACE_SCOPE && multiSpace.hasMultipleSpaces}
                    hasMore={hasMoreChats}
                    loadingMore={loadingMoreChats}
                    onLoadMore={loadMoreChats}
                    onSearch={searchChatItems}
                    onOpenSpaceSheet={() => { setSpaceSheetOpen(true); }}
                    onOpenItem={openItem}
                    onMarkRead={(item) => { markConversationSeen(item.ref, item.attentionCursor); }}
                    onArchive={(item) => { void archiveItem(item); }}
                    onOpenNavDrawer={() => { setNavDrawerOpen(true); }}
                  />
                }
              />
              <Route
                path="/m/spaces"
                element={
                  <SpacesTab
                    localSpaceKey={multiSpace.localSpaceKey}
                    localSpaceName={multiSpace.localSpaceName}
                    localRunningCount={localCounts.running}
                    remoteConnections={multiSpace.remoteConnections}
                    healthBySpace={multiSpace.healthBySpace}
                    activeScope={activeScope}
                    onSelectScope={(scope) => {
                      writeLayoutPreferences({ spaceScope: scope });
                      void navigate(MOBILE_ASSISTANT_PATH);
                    }}
                    onRefreshRemotes={multiSpace.refetchRemotes}
                    onOpenWorkbench={() => { openDesktopWorkbench(); }}
                    onOpenNavDrawer={() => { setNavDrawerOpen(true); }}
                  />
                }
              />
              <Route
                path="/m/c/:spaceKey/:sessionId"
                element={
                  <ChatRouteBridge
                    resolveClient={resolveClient}
                    resolveSpaceName={resolveSpaceName}
                    onBack={() => {
                      if (window.history.length > 1) void navigate(-1);
                      else void navigate(MOBILE_CHATS_PATH);
                    }}
                    onOpenWorkbench={openDesktopWorkbench}
                    onOpenProviderSettings={openProviderSettings}
                    onOpenVoiceForChat={(onResult) => {
                      voiceCallbackRef.current = onResult;
                      setVoiceOpen(true);
                    }}
                  />
                }
              />
              <Route
                path="/m/onboarding"
                element={
                  <SpacesTab
                    localSpaceKey={multiSpace.localSpaceKey}
                    localSpaceName={multiSpace.localSpaceName}
                    localRunningCount={localCounts.running}
                    remoteConnections={multiSpace.remoteConnections}
                    healthBySpace={multiSpace.healthBySpace}
                    activeScope={activeScope}
                    onSelectScope={(scope) => {
                      writeLayoutPreferences({ spaceScope: scope });
                      void navigate(MOBILE_ASSISTANT_PATH);
                    }}
                    onRefreshRemotes={multiSpace.refetchRemotes}
                    onOpenWorkbench={() => { openDesktopWorkbench(); }}
                  />
                }
              />
              <Route path="/s/:sessionId/*" element={<DesktopSessionRouteRedirect />} />
              <Route path="/sessions/:sessionId/*" element={<DesktopSessionRouteRedirect />} />
              <Route path="/p/:connectionId/s/:sessionId/*" element={<DesktopSessionRouteRedirect />} />
              <Route path="*" element={<Navigate to={MOBILE_ASSISTANT_PATH} replace />} />
            </Routes>
          </Drawer.Indent>

          <Drawer.Portal>
            <Drawer.Backdrop className="kiki-drawer-backdrop" />
            <Drawer.Viewport className="kiki-drawer-viewport-left">
              <Drawer.Popup
                data-mobile-nav-drawer=""
                aria-label={t('mobile.tab.nav')}
                className="kiki-drawer-left pt-[var(--kiki-safe-top-inset)] pb-[var(--kiki-safe-bottom-inset)]"
              >
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-hairline/70 pl-[18px] pr-2.5">
                  <Wordmark size="md" />
                  <button
                    type="button"
                    aria-label={t('common.close')}
                    onClick={() => { setNavDrawerOpen(false); }}
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>

                <div className="px-2.5 pt-3 pb-2">
                  <button
                    type="button"
                    data-mobile-quick-trigger=""
                    onClick={() => {
                      setNavDrawerOpen(false);
                      setQuickInitialText('');
                      setQuickOpen(true);
                    }}
                    className="flex min-h-11 w-full items-center gap-2.5 rounded-xl bg-ink/[0.05] px-3 text-left text-[14px] font-normal text-ink transition-colors hover:bg-ink/[0.08]"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/14 text-accent-ink">
                      <Icon name="plus" size={12} />
                    </span>
                    <span className="flex-1 truncate">{t('mobile.tab.quick')}</span>
                  </button>
                </div>

                <nav aria-label="Mobile navigation" className="flex-1 space-y-1 overflow-y-auto px-2.5 py-1">
                  <button
                    type="button"
                    data-mobile-tab="assistant"
                    aria-current={activeTab === 'assistant' ? 'page' : undefined}
                    onClick={() => {
                      setNavDrawerOpen(false);
                      void navigate(MOBILE_ASSISTANT_PATH);
                    }}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] transition-colors ${
                      activeTab === 'assistant'
                        ? 'bg-selected font-normal text-ink'
                        : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
                    }`}
                  >
                    <Icon name="persona" size={16} />
                    <span className="flex-1 truncate">{t('mobile.tab.assistant')}</span>
                  </button>

                  <button
                    type="button"
                    data-mobile-tab="chats"
                    aria-current={activeTab === 'chats' ? 'page' : undefined}
                    onClick={() => {
                      setNavDrawerOpen(false);
                      void navigate(MOBILE_CHATS_PATH);
                    }}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] transition-colors ${
                      activeTab === 'chats'
                        ? 'bg-selected font-normal text-ink'
                        : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
                    }`}
                  >
                    <Icon name="thread" size={16} />
                    <span className="flex-1 truncate">{t('mobile.tab.chats')}</span>
                    {globalInbox.needsYouCount > 0 ? (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-on-accent tabular-nums">
                        {globalInbox.needsYouCount}
                      </span>
                    ) : globalInbox.unreadCount > 0 ? (
                      <span className="h-2 w-2 rounded-full bg-selected-ink" aria-hidden="true" />
                    ) : null}
                  </button>

                  <button
                    type="button"
                    data-mobile-tab="spaces"
                    aria-current={activeTab === 'spaces' ? 'page' : undefined}
                    onClick={() => {
                      setNavDrawerOpen(false);
                      void navigate(MOBILE_SPACES_PATH);
                    }}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] transition-colors ${
                      activeTab === 'spaces'
                        ? 'bg-selected font-normal text-ink'
                        : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
                    }`}
                  >
                    <Icon name="web" size={16} />
                    <span className="flex-1 truncate">{t('mobile.tab.spaces')}</span>
                  </button>
                </nav>

                <div className="border-t border-hairline/70 px-2.5 py-2">
                  <button
                    type="button"
                    data-mobile-open-workbench=""
                    onClick={() => {
                      setNavDrawerOpen(false);
                      openDesktopWorkbench();
                    }}
                    className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[13.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
                  >
                    <Icon name="expand" size={16} />
                    <span className="flex-1 truncate">{t('mobile.chat.openWorkbench')}</span>
                  </button>
                </div>
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.Portal>
        </Drawer.Root>

        {spaceSheetOpen ? (
          <MobileSpaceSheet
            open={spaceSheetOpen}
            onClose={() => { setSpaceSheetOpen(false); }}
            activeScope={activeScope}
            onSelectScope={(scope) => { writeLayoutPreferences({ spaceScope: scope }); }}
            localSpaceKey={multiSpace.localSpaceKey}
            localSpaceName={multiSpace.localSpaceName}
            localWaitingCount={localCounts.waiting}
            localRunningCount={localCounts.running}
            healthBySpace={multiSpace.healthBySpace}
            remoteConnections={multiSpace.remoteConnections}
            totalOnlineCount={onlineSpacesCount}
            totalWaitingCount={globalInbox.needsYouCount}
            onPairNew={() => { void navigate(MOBILE_SPACES_PATH); }}
            onRetryRemotes={multiSpace.refetchRemotes}
            onOpenWorkbench={() => { openDesktopWorkbench(); }}
          />
        ) : null}

        {quickOpen ? (
          <QuickCaptureSheet
            open={quickOpen}
            initialText={quickInitialText}
            targetSpaceKey={targetCaptureSpaceKey}
            targetSpaceName={targetCaptureSpaceName}
            client={resolveClient(targetCaptureSpaceKey)}
            onClose={() => { setQuickOpen(false); }}
            onOpenSpacePicker={() => {
              setQuickOpen(false);
              setSpaceSheetOpen(true);
            }}
            onOpenVoice={() => {
              voiceCallbackRef.current = (spoken) => {
                setQuickInitialText(spoken);
                setQuickOpen(true);
              };
              setVoiceOpen(true);
            }}
            onCreatedSession={(spaceKey, sessionId) => {
              void queryClient.invalidateQueries({ queryKey: ['mobile-sessions'] });
              void navigate(mobileChatPath(spaceKey, sessionId));
            }}
          />
        ) : null}

        {voiceOpen ? (
          <MobileVoiceOverlay
            open={voiceOpen}
            onClose={() => { setVoiceOpen(false); }}
            onSubmitText={(spoken) => {
              const cb = voiceCallbackRef.current;
              voiceCallbackRef.current = null;
              cb?.(spoken);
            }}
          />
        ) : null}

        <Toasts />
      </div>
    </Drawer.Provider>
  );
}
