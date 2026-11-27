/**
 * Session sidebar — session-first and quiet.
 *
 * Top to bottom: the wordmark, New session (the surface's one primary) and
 * search, a short primary nav (task board, scheduled tasks, usage,
 * capabilities), the filter chip row, then the session list. The footer keeps
 * settings and the collapse toggle on one line, plus the connection in words
 * while it is down (connected says nothing).
 *
 * Organize: one View menu (group by time / workspace / none, sort by updated
 * / created / title) and one Filter menu (status, workspaces, archived); both
 * persist in layoutPrefs. Active filters stay visible as removable chips and
 * keep scoping the list while a search is running.
 *
 * Search is two-layer (useSessionSearch): an instant local match over loaded
 * titles, workspace names/roots and cwd, plus the debounced server content
 * search. ↑↓ moves across every result group, Enter opens, Esc clears; `/`
 * focuses the box from anywhere outside an editable surface.
 *
 * The session row menu opens from the hover ⋯ button or a right-click
 * anywhere on the row; the undo confirmation rides the shared ConfirmDialog
 * and the header menus the shared AnchoredPopover. In phone mode the row,
 * filter and view menus are bottom sheets (ActionSheet) instead.
 */

import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useLocation } from 'react-router-dom';

import type { RoomListItem, Session, SessionSeedMode, WorkspaceCatalogEntry } from '@kiki/protocol';

import {
  compactReceiptOutcome,
  compactSessionContext,
  exportSessionArchive,
  forkSession,
  sessionActionErrorText,
  undoLastTurn,
  type SessionActionContext,
} from '@kiki/session-core/commands';
import { errorText } from '@kiki/session-core/i18n';
import {
  formatElapsedClock,
  hasActiveSessionFilters,
  highlightTerms,
  isPinnedSession,
  isSearchable,
  patchSidebarUnitRow,
  pinMetadataPatch,
  projectAttachedConversationGroups,
  roomRefLink,
  sessionRowState,
  sidebarUnitRows,
  type ConversationListItem,
  type SessionRowState,
  SESSION_SORT_ORDERS,
  sessionAttentionCursor,
  sessionStatusOf,
  type SidebarDisplayBucket,
  type SidebarDisplayItem,
  type SidebarSessionGroupEntry,
  type SidebarUnitPagesData,
  type SpaceConversationSource,
  type UnifiedInboxItem,
  WORKSPACE_UNGROUPED_KEY,
  shortCwd,
  splitByRanges,
  togglePinned,
  type ActivityEntry,
  type MatchRange,
  type SessionGroup,
  type SessionListData,
  type SessionSortOrder,
} from '@kiki/session-core/sessions';
import {
  ALL_SIDEBAR_NAV_KEYS,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  encodeConversationRef,
  readDesktopPrefs,
  readLastSessionId,
  roomSeenKey,
  shownPinnedNavItems,
  writeLayoutPreferences,
  type ConversationRef,
  type SessionArchivedFilter,
  type SessionPrivateFilter,
  type SessionSeenMap,
  type SessionListFilters,
  type SessionStatusFilter,
  type SidebarMode,
  type SidebarNavKey,
} from '@kiki/session-core/settings';
import { useHost } from '../host';
import { isDesktopHost } from '../host/host';
import { useI18n } from '../i18n';
import { ROOMS_QUERY_KEY, roomQueryKey, useBotRoomApi } from '../lib/botRooms';
import { copyTextToClipboard } from '../lib/clipboard';
import { beginExplicitConversationOpen, useConversationSeen } from '../lib/conversationOpen';
import { useLayoutPreferences, useMediaQuery, usePaneResize, usePhoneMode } from '../lib/layoutHooks';
import { requestScopeNavigation } from '../lib/navScope';
import { enterSpace, launchWindowMode } from '../lib/spaces';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { parsePlaceConnectionId, placeHrefForSpaceKey, stripPlacePrefix } from '../lib/placeRoutes';
import { unzoomedPoint, unzoomedRect, unzoomedViewport } from '../lib/uiZoom';
import { readExternalClientMark } from '../lib/externalClients';
import { ROOM_ITEMS_QUERY_KEY } from '../lib/useConversationList';
import { useInboxTriageState, type InboxTriageController } from '../lib/useInboxTriageState';
import { ALL_SPACE_SCOPE, matchesSpaceScope, type MultiSpaceHealth } from '../lib/useMultiSpaceSessions';
import { useSessionSearch, type SessionSearchState } from '../lib/sessionSearch';
import { SESSION_SEARCH_EVENT } from '../lib/sidebarSearch';
import { lifeOf, type LifeState } from '../lib/motion';
import { nestConversationItems, sessionRelationOf, type ConversationTreeNode, type SessionRelation } from '../lib/sessionThreads';
import { readTopLevelThreads, writeTopLevelThreads } from '../lib/threadDisplayMemory';
import { pushToast, runToastAction } from '../lib/toasts';
import { sanitizeDisplayTitle, useThreadTitleResolver } from '../lib/threadTitles';
import { readWorkspaceGroupMemory, writeWorkspaceGroupMemory } from '../lib/sidebarGroupMemory';
import { anyOverlayOpen, registerOverlay } from '../lib/uiBusy';
import { isEditableTarget, isImeKeyEvent } from '../lib/shortcuts';
import { useConnection } from '../state/connection';
import { useOptionalPlaceClientPool } from '../state/placeClients';
import { RelativeTime, useElapsedSince } from './RelativeTime';
import { useSessionSeen } from '../lib/sessionSeen';
import { useSessionActivity } from './ActivityPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { useGuardedNavigate } from './dirtyGuard';
import {
  isMobileAppShellUserAgent,
  MOBILE_ASSISTANT_PATH,
  mobileChatPath,
  readDesktopOverride,
  writeDesktopOverride,
} from '../mobile/mobileShellRoute';
import { ActionSheet } from './overlays/ActionSheet';
import { AnchoredPopover } from './overlays/AnchoredPopover';
import { LifeMark } from './LifeMark';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { DisclosureChevron, Icon, resolvePluginSlotIconName, Spinner } from './icons';
import { SpaceScopeControl } from './sidebar/SpaceScopeControl';
import { SidebarModeSwitch } from './sidebar/SidebarModeSwitch';
import { SidebarInboxView } from './sidebar/SidebarInboxView';
import { SidebarRowDot, sidebarDotKindFromLife, type SidebarRowDotKind } from './sidebar/SidebarRowSignal';
import { partitionColdFold, partitionUnitColdFold } from './sidebar/coldFold';
import { SessionGroupHeaderRow, SessionGroupMoreRow, SidebarLoadMoreRow } from './sidebar/SidebarGroupRows';
import { useSidebarInfiniteDemand, type SidebarDemandTarget } from './sidebar/useSidebarInfiniteDemand';
import { SessionContextMenu } from './sessionContextMenu';
import { SidebarPersonaSection } from './persona/SidebarPersonaSection';
import { usePersonaDirectory, type PersonaDirectoryEntry } from './persona/usePersonaDirectory';
import { invalidatePersonaSessionLists } from '../lib/personaFreshness';
import { PersonaAvatar, personaAvatarOf } from './persona/PersonaAvatar';
import { JoinRoomDialog, NewThreadRoomDialog } from './room/ThreadRoomDialogs';
import { isSubagentSession, ROOM_MAX_MEMBERS, useThreadCommsEnabled } from './room/threadRooms';
import { WorktreeArchiveDialog } from './WorktreeArchiveDialog';
import { WorktreeMark } from './WorktreeMark';
import { ThreadTitle } from './ThreadTitle';
import { RequestGovernanceBadge } from './RequestGovernanceView';
import { resolvePluginLocalizedText, selectSidebarPanelSlots } from '@kiki/session-core';
import { buildPluginPanelHref, usePluginGuiSlots } from './plugins/PluginComposerSlots';
import {
  queueSessionPluginPanelOpen,
  requestSessionPluginPanelOpen,
  useSessionPluginPanelSnapshot,
} from '../lib/pluginPanelPreview';

// Re-exported for callers and tests that paged the old in-component search.
export { mergeSearchPages, searchNextPageParam } from '../lib/sessionSearch';

/** How many sessions a workspace group shows before "Show N more". */
export const WORKSPACE_GROUP_PREVIEW = 8;
/** Flatten & virtualize the sidebar session list / search results beyond this row count. */
export const SIDEBAR_VIRTUALIZE_THRESHOLD = 60;
const EMPTY_SESSIONS: readonly Session[] = [];

// Nav icons all come from the shared family (components/icons.tsx).
const ICON = 'h-4 w-4 shrink-0';
/** Quiet square control for the wordmark row (search, activity). */
const HEADER_ICON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors pointer-coarse:h-11 pointer-coarse:w-11 hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink aria-[current=page]:bg-ink/[0.06] aria-[current=page]:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';
/** The collapsed rail's one button: the header's quiet square a step larger,
 * so the 56px column stays a comfortable target. Flat — never a pill. */
const RAIL_ICON =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink aria-[current=page]:bg-ink/[0.06] aria-[current=page]:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

const ClockIcon = () => <Icon name="clock" size={16} />;
const UsageIcon = () => <Icon name="usage" size={16} />;
/** Memory is a kept leaf of notes (a place), not the timeline's spark. */
const MemoryIcon = () => <Icon name="notes" size={16} />;
const PersonaIcon = () => <Icon name="persona" size={16} />;
const CapabilitiesIcon = () => <Icon name="star" size={16} />;
const CompassIcon = () => <Icon name="compass" size={16} />;

function PinIcon({ className = '' }: { className?: string }) {
  return <Icon name="pin" size={12} className={className} />;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null);
}

function sessionLabel(
  session: Session,
  untitled: string,
  nestedForkParentTitle?: string,
): string {
  const title = sanitizeDisplayTitle(session.title) ?? '';
  const prompt = sanitizeDisplayTitle(session.last_prompt) ?? '';
  if (nestedForkParentTitle !== undefined && title.startsWith('Fork: ')) {
    const rest = sanitizeDisplayTitle(title.slice(6)) ?? '';
    if (rest !== '' && rest !== nestedForkParentTitle) return rest;
    if (prompt !== '' && prompt !== nestedForkParentTitle) return prompt;
    if (rest !== '') return rest;
  }
  if (title !== '') return title;
  if (prompt !== '') return prompt;
  return untitled;
}

/** Only a fresh, active list can still carry the failure on the clicked row.
 * Inactive caches may retain an archived root; other session queries may have no pages. */
function isSessionStillListed(queryClient: QueryClient, sessionId: string): boolean {
  return queryClient.getQueryCache().findAll({ queryKey: ['sessions'], type: 'active' })
    .some(({ state }) => {
      if (state.isInvalidated) return false;
      const pages = (state.data as { pages?: readonly { items?: readonly Session[]; units?: readonly import('@kiki/protocol').SidebarUnit[] }[] } | undefined)?.pages;
      if (!Array.isArray(pages)) return false;
      return pages.some((page) => {
        if (Array.isArray(page?.items)) {
          return page.items.some((item: Session) => item.id === sessionId && item.archived !== true);
        }
        if (Array.isArray(page?.units)) {
          return page.units.some((unit: import('@kiki/protocol').SidebarUnit) =>
            sidebarUnitRows(unit).some((row) => row.id === sessionId && row.archived !== true),
          );
        }
        return false;
      });
    });
}

function bucketHeaderDomId(groupKey: string): string {
  return `sidebar-bucket-${groupKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function collapsedSessionGroupLife(
  group: SidebarSessionGroupEntry,
  seen: SessionSeenMap,
  seenV2: Readonly<Record<string, { readonly seq: number }>>,
): LifeState {
  let hasWorking = false;
  let hasFailed = false;
  let hasDone = false;
  for (const member of group.members) {
    const memberSeen = member.isRemote === true && member.spaceKey !== undefined
      ? { [member.session.id]: seenV2[encodeConversationRef({ spaceKey: member.spaceKey, kind: 'session', id: member.session.id })]?.seq ?? 0 }
      : seen;
    const state = sessionRowState(member.session, memberSeen);
    const life = rowLife(member.session, state);
    if (life === 'waiting') return 'waiting';
    if (life === 'working') hasWorking = true;
    else if (life === 'failed') hasFailed = true;
    else if (life === 'done') hasDone = true;
  }
  if (hasWorking) return 'working';
  if (hasFailed) return 'failed';
  if (hasDone) return 'done';
  return 'idle';
}

function foldedUnitBucketLife(
  items: readonly SidebarDisplayItem[],
  seen: SessionSeenMap,
  seenV2: Readonly<Record<string, { readonly seq: number }>>,
): LifeState {
  let hasRunning = false;
  for (const item of items) {
    if (item.kind === 'session-group') {
      const life = collapsedSessionGroupLife(item, seen, seenV2);
      if (life === 'waiting') return 'waiting';
      if (life === 'working') hasRunning = true;
      continue;
    }
    const state = conversationRowState(item, seen);
    if (state === 'needs-me' || state === 'cleanup-pending') return 'waiting';
    if (state === 'running') hasRunning = true;
  }
  return hasRunning ? 'working' : 'idle';
}

/** Text with highlighted ranges (search matches). */
function Highlighted({ text, ranges }: { text: string; ranges: readonly MatchRange[] }) {
  if (ranges.length === 0) return <>{text}</>;
  return (
    <>
      {splitByRanges(text, ranges).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-[2px] bg-accent-soft px-px text-ink">{part.text}</mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Row status slot: a fixed 7px column every row shares, holding the shared
 * life mark (`lifeOf`). "A dot means something is going on", and each state
 * has its own shape: waiting is the accent dot with its ring, working a still
 * solid ink dot (rows never breathe — the header count carries the pulse), a
 * finished-unseen row a hollow ring that settles once when it lands, a failed
 * unseen run a neutral square that also says so in plain text on the second
 * line. A
 * caught-up row leaves the slot empty.
 */
function rowLife(session: Session, state: SessionRowState): LifeState {
  if (state === 'needs-me' || state === 'cleanup-pending') return 'waiting';
  if (state === 'running') return 'working';
  if (state === 'read') return 'idle';
  // Unread: the run's outcome decides the tone; an old finish still reads as
  // "done", because unseen is the fact, not recency.
  const life = lifeOf(session);
  return life === 'failed' ? 'failed' : 'done';
}

/** A room's row state, from the summary's own flags (its seen mark rides the
 * precomputed `unread_count`, keyed `room:<id>` rather than the bare id). */
function roomRowState(item: Extract<ConversationListItem, { kind: 'room' }>): SessionRowState {
  if (item.needs_you || item.pending_interaction === 'approval' || item.pending_interaction === 'question') return 'needs-me';
  if (item.busy) return 'running';
  return item.unread_count > 0 ? 'unread' : 'read';
}

/** One state per row, thread or room. */
function conversationRowState(item: ConversationListItem, seen: SessionSeenMap): SessionRowState {
  return item.kind === 'room' ? roomRowState(item) : sessionRowState(item.session, seen);
}

/** A room's mark tone follows the run's outcome, like a thread row's. */
function roomRowLife(item: Extract<ConversationListItem, { kind: 'room' }>, state: SessionRowState): LifeState {
  if (state === 'needs-me') return 'waiting';
  if (state === 'running') return 'working';
  if (state === 'read') return 'idle';
  return item.failed ? 'failed' : 'done';
}

/**
 * What a folded group is hiding that you would want to know: a session that
 * needs you, else one still running. Finished and failed rows stay behind the
 * fold (the bell counts them).
 */
function foldedGroupLife(nodes: readonly ConversationTreeNode[], seen: SessionSeenMap): LifeState {
  let hasRunning = false;
  const stack: ConversationTreeNode[] = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const state = conversationRowState(node.item, seen);
    if (state === 'needs-me' || state === 'cleanup-pending') return 'waiting';
    if (state === 'running') hasRunning = true;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }
  return hasRunning ? 'working' : 'idle';
}

/** The word for an unseen run that did not complete: failed, or stopped. */
function failedLabel(session: Session, t: ReturnType<typeof useI18n>['t']): string {
  return session.last_turn_reason === 'cancelled' ? t('sidebar.rowState.stopped') : t('sidebar.rowState.failed');
}

function StatusMark({ session, state }: { session: Session; state: SessionRowState }) {
  const { t } = useI18n();
  const life = rowLife(session, state);
  const signal = state === 'running' || state === 'needs-me' || state === 'unread';
  const title =
    state === 'needs-me'
      ? (session.pending_interaction === 'question' ? t('sidebar.status.question') : t('sidebar.status.approval'))
      : state === 'cleanup-pending'
        ? t('sidebar.rowState.cleanupPending')
      : state === 'running'
        ? t('sidebar.status.working')
        : life === 'failed'
          ? failedLabel(session, t)
          : state === 'unread'
            ? t('sidebar.rowState.unread')
            : undefined;
  const dotKind: SidebarRowDotKind = state === 'needs-me'
    ? 'needs_you'
    : state === 'running'
      ? 'working'
      : 'unread';
  return (
    <SidebarRowDot
      signal={signal}
      kind={dotKind}
      label={title}
      dataAttr={{ 'data-session-status': state === 'read' ? 'idle' : state }}
    />
  );
}

type NavKey = SidebarNavKey;

const NAV_ITEMS: readonly { key: NavKey; route: string; hook: Record<string, string>; icon: () => React.ReactNode }[] = [
  { key: 'cron', route: '/cron', hook: { 'data-nav-cron': '' }, icon: ClockIcon },
  // Always present, on or off: switched off it opens the turn-on guide, so
  // "what does Kiki remember" has one stable address either way.
  { key: 'memory', route: '/memory', hook: { 'data-nav-memory': '' }, icon: MemoryIcon },
  // Who talks to you sits beside what it remembers: a persona owns a memory
  // namespace, and carries no tools or permissions (those are Capabilities).
  { key: 'personas', route: '/personas', hook: { 'data-nav-personas': '' }, icon: PersonaIcon },
  { key: 'usage', route: '/usage', hook: { 'data-nav-usage': '' }, icon: UsageIcon },
  { key: 'capabilities', route: '/capabilities', hook: { 'data-nav-capabilities': '' }, icon: CapabilitiesIcon },
  { key: 'discover', route: '/discover', hook: { 'data-nav-discover': '' }, icon: CompassIcon },
];

const WORKSPACE_SCOPED_ROUTES: readonly string[] = ['/cron', '/memory'];

/** Workspace-scoped pages open pre-filtered to the active session's
 * workspace; the page's own switcher widens to all workspaces. */
function scopedRoute(route: string, workspaceId: string | undefined): string {
  if (workspaceId === undefined || !WORKSPACE_SCOPED_ROUTES.includes(route)) return route;
  return `${route}?workspace=${encodeURIComponent(workspaceId)}`;
}

function openSidebarPluginPanel(options: {
  readonly pluginId: string;
  readonly panelId: string;
  readonly title: string;
  readonly activeSessionId?: string;
  readonly reachableSessionId?: string;
  readonly activeWorkspaceId?: string;
  readonly currentPathname: string;
  readonly navigate: (to: string) => unknown;
  readonly onCloseSidebar?: () => void;
}): void {
  const {
    pluginId,
    panelId,
    title,
    activeSessionId,
    reachableSessionId,
    activeWorkspaceId,
    currentPathname,
    navigate,
    onCloseSidebar,
  } = options;
  onCloseSidebar?.();
  if (requestSessionPluginPanelOpen({ pluginId, panelId, title }, activeSessionId)) {
    return;
  }
  const targetSessionId = activeSessionId ?? reachableSessionId;
  if (targetSessionId !== undefined && targetSessionId !== '') {
    const targetRoute = `/s/${encodeURIComponent(targetSessionId)}`;
    const alreadyAtTargetSession =
      currentPathname === targetRoute || currentPathname.startsWith(`${targetRoute}/`);
    if (!alreadyAtTargetSession) {
      queueSessionPluginPanelOpen({ pluginId, panelId, title }, targetSessionId);
      void navigate(targetRoute);
      return;
    }
  }
  void navigate(
    buildPluginPanelHref({
      pluginId,
      panelId,
      sessionId: activeSessionId ?? reachableSessionId,
      workspaceId: activeWorkspaceId,
    }),
  );
}

function PrimaryNav({
  activeSessionId,
  reachableSessionId,
  activeWorkspaceId,
  badges,
  offscreen = false,
  onCloseSidebar,
}: {
  activeSessionId?: string;
  reachableSessionId?: string;
  activeWorkspaceId: string | undefined;
  badges?: Partial<Record<NavKey, { count: number; label: string }>>;
  /** The drawer is closed: nothing here is on screen. */
  offscreen?: boolean;
  onCloseSidebar?: () => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const location = useLocation();
  const layoutPrefs = useLayoutPreferences();
  const pinnedNavItems = shownPinnedNavItems(layoutPrefs, usePhoneMode());
  const sessionPluginPanel = useSessionPluginPanelSnapshot();
  const { slots: pluginGuiSlots } = usePluginGuiSlots({
    sessionId: activeSessionId,
    workspaceId: activeWorkspaceId,
    enabled: !offscreen,
  });
  const pluginSidebarPanels = useMemo(
    () => selectSidebarPanelSlots(pluginGuiSlots),
    [pluginGuiSlots],
  );
  const activePanelParam = useMemo(
    () => (location.pathname.startsWith('/capabilities') ? new URLSearchParams(location.search).get('panel') : null),
    [location.pathname, location.search],
  );
  const activeInSessionPanelKey =
    sessionPluginPanel.activePluginPanelKey !== undefined &&
    (activeSessionId === undefined || sessionPluginPanel.sessionId === activeSessionId)
      ? sessionPluginPanel.activePluginPanelKey
      : undefined;

  const pinnedSet = useMemo(() => new Set<SidebarNavKey>(pinnedNavItems), [pinnedNavItems]);
  const primaryItems = useMemo(() => NAV_ITEMS.filter((item) => pinnedSet.has(item.key)), [pinnedSet]);
  const secondaryItems = useMemo(() => NAV_ITEMS.filter((item) => !pinnedSet.has(item.key)), [pinnedSet]);

  const isItemActive = useCallback(
    (item: (typeof NAV_ITEMS)[number]) =>
      location.pathname === item.route || (item.key === 'capabilities' && location.pathname.startsWith('/capabilities')),
    [location.pathname],
  );

  const sectionCollapsed = layoutPrefs.sidebarNavSectionCollapsed ?? true;
  const foldedItems = useMemo(
    () => (sectionCollapsed ? secondaryItems.filter((item) => !isItemActive(item)) : []),
    [sectionCollapsed, secondaryItems, isItemActive],
  );
  const foldedBadgeCount = useMemo(
    () => foldedItems.reduce((total, item) => {
      const badge = badges?.[item.key];
      return total + (badge !== undefined && badge.count > 0 ? badge.count : 0);
    }, 0),
    [foldedItems, badges],
  );

  const renderNavItem = (item: (typeof NAV_ITEMS)[number]) => {
    const current = isItemActive(item);
    const badge = badges?.[item.key];
    const Icon = item.icon;
    return (
      <li key={item.key}>
        <button
          type="button"
          {...item.hook}
          aria-current={current ? 'page' : undefined}
          onClick={() => { void navigate(scopedRoute(item.route, activeWorkspaceId)); }}
          className={`row-interactive flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] leading-5 font-normal pointer-coarse:h-11 ${
            current ? 'text-ink' : 'text-ink-soft hover:text-ink'
          }`}
        >
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${current ? 'text-ink' : 'text-ink-faint'}`}><Icon /></span>
          <span className="min-w-0 flex-1 truncate">{item.key === 'personas' ? t('persona.nav') : item.key === 'discover' ? t('discovery.title') : t(`nav.${item.key}`)}</span>
          {/* The badge polls once a second; behind a closed drawer it would
              poll for nobody. It reads again the moment the drawer opens. */}
          {item.key === 'usage' && !offscreen ? <RequestGovernanceBadge /> : null}
          {badge !== undefined && badge.count > 0 ? (
            <span
              data-nav-badge={item.key}
              title={badge.label}
              aria-label={badge.label}
              className="shrink-0 px-0.5 text-[12px] leading-4 font-normal text-accent-ink tabular-nums"
            >
              {badge.count}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <nav aria-label={t('nav.aria')} data-primary-nav className="px-2.5 pb-2">
      <ul className="space-y-px">
        {primaryItems.map(renderNavItem)}
        {pluginSidebarPanels.map((panel) => {
          const panelKey = `${panel.pluginId}:${panel.panelId}`;
          const current = activeInSessionPanelKey === panelKey || activePanelParam === panelKey;
          const title = resolvePluginLocalizedText(panel.title, locale);
          const iconName = resolvePluginSlotIconName({
            icon: (panel as { readonly icon?: string }).icon,
            pluginId: panel.pluginId,
            panelId: panel.panelId,
            fallback: 'star',
          });
          return (
            <li key={panelKey} data-plugin-sidebar-panels="">
              <button
                type="button"
                data-plugin-sidebar-panel={panelKey}
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  openSidebarPluginPanel({
                    pluginId: panel.pluginId,
                    panelId: panel.panelId,
                    title,
                    activeSessionId,
                    reachableSessionId,
                    activeWorkspaceId,
                    currentPathname: location.pathname,
                    navigate,
                    onCloseSidebar,
                  });
                }}
                className={`row-interactive flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] leading-5 font-normal pointer-coarse:h-11 ${
                  current ? 'text-ink' : 'text-ink-soft hover:text-ink'
                }`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${current ? 'text-ink' : 'text-ink-faint'}`}>
                  <Icon name={iconName} size={16} className={ICON} />
                </span>
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {secondaryItems.length > 0 ? (
        <div data-sidebar-secondary-nav className="space-y-px pt-1">
          {sectionCollapsed ? (
            <>
              {/* The page you are on stays visible even while folded, so the
                * nav never hides where the reader is. */}
              {secondaryItems.some(isItemActive) ? (
                <ul className="space-y-px">{secondaryItems.filter(isItemActive).map(renderNavItem)}</ul>
              ) : null}
              <button
                type="button"
                data-sidebar-secondary-toggle="expand"
                aria-expanded={false}
                aria-label={t('sidebar.expandMoreTools')}
                onClick={() => { writeLayoutPreferences({ sidebarNavSectionCollapsed: false }); }}
                className="row-interactive flex h-8 w-full items-center gap-2 px-2 text-left text-[12px] leading-4 font-normal text-ink-faint hover:text-ink transition-colors duration-[var(--kiki-motion-quick)] pointer-coarse:h-11"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-faint">
                  <DisclosureChevron open={false} size={12} className="shrink-0" />
                </span>
                <span className="min-w-0 flex-1 truncate">{t('sidebar.moreTools')}</span>
                {foldedBadgeCount > 0 ? (
                  <span
                    data-secondary-badges-count
                    className="shrink-0 px-0.5 text-[12px] leading-4 font-normal text-accent-ink tabular-nums"
                  >
                    {foldedBadgeCount}
                  </span>
                ) : null}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-sidebar-secondary-toggle="collapse"
                aria-expanded={true}
                aria-label={t('sidebar.collapseMoreTools')}
                onClick={() => { writeLayoutPreferences({ sidebarNavSectionCollapsed: true }); }}
                className="row-interactive flex h-8 w-full items-center gap-2 px-2 text-left text-[12px] leading-4 font-normal text-ink-faint hover:text-ink transition-colors duration-[var(--kiki-motion-quick)] pointer-coarse:h-11"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-faint">
                  <DisclosureChevron open={true} size={12} className="shrink-0" />
                </span>
                <span className="min-w-0 flex-1 truncate">{t('sidebar.moreTools')}</span>
              </button>
              <ul className="space-y-px">{secondaryItems.map(renderNavItem)}</ul>
            </>
          )}
        </div>
      ) : null}
    </nav>
  );
}

/** The narrow-desktop rail: the whole sidebar reduced to its destinations —
 * new session, the primary pages, settings — one quiet icon per stop, labels
 * carried by tooltips. The expand toggle at its foot is the twin of the
 * expanded footer's collapse toggle; both write the same persisted override. */
function CollapsedSidebarRail({
  activeSessionId,
  reachableSessionId,
  activeWorkspaceId,
  onNewSession,
  offscreen = false,
}: {
  activeSessionId?: string;
  reachableSessionId?: string;
  activeWorkspaceId: string | undefined;
  onNewSession: () => void;
  offscreen?: boolean;
}) {
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const location = useLocation();
  const layoutPrefs = useLayoutPreferences();
  const pinnedSet = useMemo(() => new Set<SidebarNavKey>(layoutPrefs.pinnedNavItems), [layoutPrefs.pinnedNavItems]);
  const primaryRailItems = useMemo(() => NAV_ITEMS.filter((item) => pinnedSet.has(item.key)), [pinnedSet]);
  const secondaryRailItems = useMemo(() => NAV_ITEMS.filter((item) => !pinnedSet.has(item.key)), [pinnedSet]);
  const sessionPluginPanel = useSessionPluginPanelSnapshot();
  const { slots: pluginGuiSlots } = usePluginGuiSlots({
    sessionId: activeSessionId,
    workspaceId: activeWorkspaceId,
    enabled: !offscreen,
  });
  const pluginSidebarPanels = useMemo(
    () => selectSidebarPanelSlots(pluginGuiSlots),
    [pluginGuiSlots],
  );
  const activePanelParam = useMemo(
    () => (location.pathname.startsWith('/capabilities') ? new URLSearchParams(location.search).get('panel') : null),
    [location.pathname, location.search],
  );
  const activeInSessionPanelKey =
    sessionPluginPanel.activePluginPanelKey !== undefined &&
    (activeSessionId === undefined || sessionPluginPanel.sessionId === activeSessionId)
      ? sessionPluginPanel.activePluginPanelKey
      : undefined;
  const [moreMenuAnchor, setMoreMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const isRailItemActive = useCallback(
    (item: (typeof NAV_ITEMS)[number]) =>
      location.pathname === item.route
      || (item.key === 'capabilities' && location.pathname.startsWith('/capabilities')),
    [location.pathname],
  );
  const railLabelOf = useCallback(
    (item: (typeof NAV_ITEMS)[number]) =>
      item.key === 'personas' ? t('persona.nav') : item.key === 'discover' ? t('discovery.title') : t(`nav.${item.key}`),
    [t],
  );
  const activeSecondaryRailItems = useMemo(
    () => secondaryRailItems.filter(isRailItemActive),
    [secondaryRailItems, isRailItemActive],
  );
  const moreMenuEntries = useMemo<readonly MiniMenuEntry[]>(
    () => secondaryRailItems.map((item) => ({
      key: item.key,
      label: railLabelOf(item),
      run: () => { void navigate(scopedRoute(item.route, activeWorkspaceId)); },
    })),
    [secondaryRailItems, railLabelOf, navigate, activeWorkspaceId],
  );
  const renderRailNavItem = (item: (typeof NAV_ITEMS)[number]) => {
    const current = isRailItemActive(item);
    const label = railLabelOf(item);
    const ItemIcon = item.icon;
    return (
      <button
        key={item.key}
        type="button"
        {...item.hook}
        aria-current={current ? 'page' : undefined}
        aria-label={label}
        title={label}
        onClick={() => { void navigate(scopedRoute(item.route, activeWorkspaceId)); }}
        className={RAIL_ICON}
      >
        <span className="relative"><ItemIcon />{item.key === 'usage' ? <RequestGovernanceBadge compact /> : null}</span>
      </button>
    );
  };
  return (
    <>
      <nav aria-label={t('nav.aria')} data-sidebar-rail className="flex flex-col items-center gap-1 px-2 pt-3">
        <button
          type="button"
          data-new-session
          aria-label={t('sidebar.newSession')}
          title={t('sidebar.newSession')}
          onClick={onNewSession}
          className={RAIL_ICON}
        >
          <span className="text-accent"><Icon name="plus" size={16} /></span>
        </button>
        {primaryRailItems.map(renderRailNavItem)}
        {pluginSidebarPanels.map((panel) => {
          const panelKey = `${panel.pluginId}:${panel.panelId}`;
          const current = activeInSessionPanelKey === panelKey || activePanelParam === panelKey;
          const title = resolvePluginLocalizedText(panel.title, locale);
          const iconName = resolvePluginSlotIconName({
            icon: (panel as { readonly icon?: string }).icon,
            pluginId: panel.pluginId,
            panelId: panel.panelId,
            fallback: 'star',
          });
          return (
            <button
              key={panelKey}
              type="button"
              data-plugin-sidebar-panel={panelKey}
              aria-current={current ? 'page' : undefined}
              aria-label={title}
              title={title}
              onClick={() => {
                openSidebarPluginPanel({
                  pluginId: panel.pluginId,
                  panelId: panel.panelId,
                  title,
                  activeSessionId,
                  reachableSessionId,
                  activeWorkspaceId,
                  currentPathname: location.pathname,
                  navigate,
                });
              }}
              className={RAIL_ICON}
            >
              <Icon name={iconName} size={16} />
            </button>
          );
        })}
        {activeSecondaryRailItems.map(renderRailNavItem)}
        {secondaryRailItems.length > 0 ? (
          <button
            type="button"
            data-sidebar-rail-more
            aria-haspopup="menu"
            aria-expanded={moreMenuAnchor !== null}
            aria-label={t('sidebar.moreTools')}
            title={t('sidebar.moreTools')}
            onClick={(event) => {
              if (moreMenuAnchor !== null) {
                setMoreMenuAnchor(null);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMoreMenuAnchor({ x: rect.right + 6, y: rect.top });
            }}
            className={RAIL_ICON}
          >
            <Icon name="more" size={16} />
          </button>
        ) : null}
      </nav>
      {moreMenuAnchor !== null ? (
        <MiniContextMenu
          x={moreMenuAnchor.x}
          y={moreMenuAnchor.y}
          entries={moreMenuEntries}
          onClose={() => { setMoreMenuAnchor(null); }}
          ariaLabel={t('sidebar.moreTools')}
          overlayId="sidebar-rail-more-menu"
          dataAttribute="data-sidebar-rail-more-menu"
        />
      ) : null}
      <div className="mt-auto flex flex-col items-center gap-1 px-2 pb-3">
        <button
          type="button"
          data-nav-settings
          aria-current={location.pathname.startsWith('/settings') ? 'page' : undefined}
          aria-label={t('sidebar.settings')}
          title={t('sidebar.settings')}
          onClick={() => { void navigate('/settings'); }}
          className={RAIL_ICON}
        >
          <Icon name="settings" size={16} />
        </button>
        <button
          type="button"
          data-sidebar-toggle="expand"
          aria-label={t('sidebar.expandSidebar')}
          title={t('sidebar.expandSidebar')}
          onClick={() => { writeLayoutPreferences({ sidebarCollapsed: false }); }}
          className={RAIL_ICON}
        >
          <Icon name="expand" size={16} />
        </button>
      </div>
    </>
  );
}

export function Sidebar({
  activeSessionId,
  sessions: rawSessions,
  personaSessions,
  rooms: rawRooms = [],
  sessionGroups: rawSessionGroups,
  sessionsQuery,
  roomsQuery,
  workspaceOptions,
  filters,
  onFiltersChange,
  onNewSession,
  groupBy,
  onGroupBy,
  sortBy,
  onSortBy,
  navBadges,
  className,
  id,
  inert,
  dockedInPanelGroup = false,
  temporaryOpen = false,
  onClose,
  nowMs,
  multiSpaceSources,
  healthBySpace,
  hasMoreBySpace,
  nextCursorBySpace,
  loadingMoreSpaces,
  onLoadMoreSpaceSessions,
  hasMultipleSpaces = false,
  localSpaceKey: localSpaceKeyProp,
  onRefreshRemoteSpace,
  inboxTriage: externalInboxTriage,
  sidebarMode: sidebarModeOverride,
  sidebarUnitBuckets: rawSidebarUnitBuckets,
  sidebarGroupsEnabled = false,
  sidebarNextCursor,
  sidebarQueryGeneration,
  onLoadMoreGroupMembers,
  loadingGroupIds,
  groupMemberErrors,
  onDetachGroupMember,
}: {
  activeSessionId: string | undefined;
  /** Every loaded session (unfiltered); the pending badge and search read it. */
  sessions: readonly Session[];
  /** Cross-workspace session snapshot for persona activity when `sessions` is workspace-filtered. */
  personaSessions?: readonly Session[];
  rooms?: readonly RoomListItem[];
  /** Filtered, sorted, grouped conversations (threads and rooms interleaved). */
  sessionGroups: readonly SessionGroup<ConversationListItem>[];
  /** Server-paginated automatic session group buckets (active when host supports `sidebar_groups`). */
  sidebarUnitBuckets?: readonly SidebarDisplayBucket[];
  /** True when the connected host advertises `meta.capabilities.sidebar_groups`. */
  sidebarGroupsEnabled?: boolean;
  /** Server traversal cursor for the next local page (never synthesized from a member ID). */
  sidebarNextCursor?: string;
  /** Monotonic identity key for the active sidebar query generation. */
  sidebarQueryGeneration?: string;
  /** Load additional members for an expanded >50-member group. */
  onLoadMoreGroupMembers?: (groupId: string, spaceKey: string, cursor: string) => Promise<void>;
  loadingGroupIds?: ReadonlySet<string>;
  groupMemberErrors?: ReadonlyMap<string, string>;
  /** Durable per-session detach (`POST /api/sessions/:id:detach-group`). */
  onDetachGroupMember?: (sessionId: string) => Promise<{ readonly previousGroupId?: string }>;
  sessionsQuery: {
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    /** Absent (undefined) while the first page has not landed. */
    data?: unknown;
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    fetchNextPage?: () => Promise<unknown>;
  };
  /** The room summaries fetch; a failure is shown, never read as "no rooms". */
  roomsQuery?: { readonly isError: boolean; readonly data?: unknown };
  workspaceOptions: readonly WorkspaceCatalogEntry[];
  filters: SessionListFilters;
  onFiltersChange: (filters: SessionListFilters) => void;
  groupBy: 'time' | 'workspace' | 'none';
  onGroupBy: (groupBy: 'time' | 'workspace' | 'none') => void;
  sortBy: SessionSortOrder;
  onSortBy: (sortBy: SessionSortOrder) => void;
  /** Attention counts for the primary nav (e.g. stale scheduled tasks). */
  navBadges?: Partial<Record<NavKey, { count: number; label: string }>>;
  /** Opens the new-session draft (the /new page stays the no-session landing). */
  onNewSession: () => void;
  className?: string;
  id?: string;
  inert?: boolean;
  /** True when `App` hosts this sidebar inside a `react-resizable-panels` `<Panel>`. */
  dockedInPanelGroup?: boolean;
  /** True when summoned temporarily as an overlay (e.g. 768-1359px preview); forces full list without persisting. */
  temporaryOpen?: boolean;
  /** Phone-drawer exit (a ✕ in the wordmark row); absent where the sidebar is docked. */
  onClose?: () => void;
  /** Current time reference for time grouping and the recency projection;
   *  defaults to `Date.now()`. */
  nowMs?: number;
  /** Multi-space sources from `useMultiSpaceSessions` (falls back to current space when omitted). */
  multiSpaceSources?: readonly SpaceConversationSource[];
  /** Per-space health state for quiet offline/stale indicator in `SpaceScopeControl`. */
  healthBySpace?: ReadonlyMap<string, MultiSpaceHealth>;
  /** Per-space pagination availability for non-active/remote spaces. */
  hasMoreBySpace?: ReadonlyMap<string, boolean>;
  /** Per-space next-page cursor tokens for non-active/remote spaces. */
  nextCursorBySpace?: ReadonlyMap<string, string>;
  /** Non-active spaces currently fetching their next page. */
  loadingMoreSpaces?: ReadonlySet<string>;
  /** Load the next page of a non-active/remote space. */
  onLoadMoreSpaceSessions?: (spaceKey: string) => Promise<void>;
  /** True when >1 local or paired remote space exists. */
  hasMultipleSpaces?: boolean;
  /** Local control home key for returning from a remote space in `全部空间` mode. */
  localSpaceKey?: string;
  /** Immediate refresh hook for a remote computer after sidebar mutations. */
  onRefreshRemoteSpace?: (connectionId: string) => Promise<void>;
  /** Shared inbox triage controller from App (falls back to local instance when omitted). */
  inboxTriage?: InboxTriageController;
  /** Optional explicit mode override (primarily for focused unit tests). */
  sidebarMode?: SidebarMode;
}) {
  const host = useHost();
  const isPhone = usePhoneMode();
  const navigate = useGuardedNavigate();
  const { client, scopeId, wsStatus, spaceKey: connSpaceKey, localSpaceKey: connLocalSpaceKey, localScopeId: connLocalScopeId } = useConnection();
  const placePool = useOptionalPlaceClientPool();
  const currentSpaceKey = connSpaceKey || 'main';
  const effectiveLocalSpaceKey = localSpaceKeyProp ?? connLocalSpaceKey ?? 'main';
  const effectiveLocalScopeId = connLocalScopeId ?? 'local';
  const { t, tp, locale } = useI18n();
  const untitled = t('sidebar.untitled');
  const queryClient = useQueryClient();
  const roomApi = useBotRoomApi();
  // Router location (not the window global): the room row's active mark and
  // the room menu need the live path.
  const location = useLocation();
  const [menu, setMenu] = useState<{ item: ConversationListItem; x: number; y: number } | null>(null);
  // Ctrl/⌘-click multi-select, for pulling several threads into one room.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [roomDraft, setRoomDraft] = useState<readonly Session[] | null>(null);
  const [joiningRoom, setJoiningRoom] = useState<readonly Session[] | null>(null);
  const threadCommsEnabled = useThreadCommsEnabled(client);
  const toggleSelected = (session: Session) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(session.id)) next.delete(session.id);
      else if (next.size < ROOM_MAX_MEMBERS) next.add(session.id);
      return next;
    });
  };
  useEffect(() => {
    if (selected.size === 0) return undefined;
    // Dropping the selection is this Escape's whole job, so it claims the key:
    // capture phase plus preventDefault, or the session view's own listener
    // would also read it as "stop the running turn". An open menu or dialog,
    // and a text field with its own use for Escape, keep theirs.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || anyOverlayOpen() || isEditableTarget(event.target)) return;
      event.preventDefault();
      setSelected(new Set());
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => { window.removeEventListener('keydown', onKeyDown, true); };
  }, [selected.size]);
  const [renaming, setRenaming] = useState<ConversationListItem | null>(null);
  const [renamedTitles, setRenamedTitles] = useState<ReadonlyMap<string, { readonly from: string; readonly to: string }>>(() => new Map());
  const renameSequences = useRef(new Map<string, number>());
  useEffect(() => {
    setRenamedTitles((current) => {
      if (current.size === 0) return current;
      const titles = new Map(rawSessionGroups.flatMap((group) => group.items.map((item) =>
        [item.key, item.kind === 'session' ? item.session.title : item.title] as const)));
      if (rawSidebarUnitBuckets !== undefined) {
        for (const bucket of rawSidebarUnitBuckets) {
          for (const item of bucket.items) {
            if (item.kind === 'session-group') {
              for (const member of item.members) titles.set(member.key, member.session.title);
            } else {
              titles.set(item.key, item.kind === 'session' ? item.session.title : item.title);
            }
          }
        }
      }
      for (const session of rawSessions) titles.set(`session:${session.id}`, session.title);
      for (const room of rawRooms) titles.set(`room:${room.id}`, room.title);
      const next = new Map(current);
      for (const [key, override] of current) {
        const title = titles.get(key);
        if (title !== undefined && title !== override.from) next.delete(key);
      }
      return next.size === current.size ? current : next;
    });
  }, [rawSessions, rawRooms, rawSessionGroups, rawSidebarUnitBuckets]);
  const [justRenamed, setJustRenamed] = useState<{ readonly key: string; readonly seq: number } | null>(null);
  const pendingPrivacyRef = useRef(new Set<string>());
  const [pendingPrivacy, setPendingPrivacy] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (justRenamed === null) return undefined;
    const timer = window.setTimeout(() => {
      setJustRenamed((current) => (current?.seq === justRenamed.seq ? null : current));
    }, 400);
    return () => { window.clearTimeout(timer); };
  }, [justRenamed]);
  const sessions = useMemo(() => {
    if (renamedTitles.size === 0) return rawSessions;
    return rawSessions.map((entry) => {
      const override = renamedTitles.get(`session:${entry.id}`);
      return override !== undefined && entry.title === override.from ? { ...entry, title: override.to } : entry;
    });
  }, [rawSessions, renamedTitles]);
  const rooms = useMemo(() => {
    if (renamedTitles.size === 0) return rawRooms;
    return rawRooms.map((entry) => {
      const override = renamedTitles.get(`room:${entry.id}`);
      return override !== undefined && entry.title === override.from ? { ...entry, title: override.to } : entry;
    });
  }, [rawRooms, renamedTitles]);
  const sessionGroups = useMemo(() => {
    if (renamedTitles.size === 0) return rawSessionGroups;
    return rawSessionGroups.map((group) => ({
      ...group,
      items: group.items.map((item) => {
        const override = renamedTitles.get(item.key);
        if (override === undefined) return item;
        if (item.kind === 'room') {
          return item.title === override.from
            ? { ...item, title: override.to, room: { ...item.room, title: override.to } }
            : item;
        }
        return item.session.title === override.from
          ? { ...item, title: override.to, session: { ...item.session, title: override.to } }
          : item;
      }),
    }));
  }, [rawSessionGroups, renamedTitles]);
  const sidebarUnitBuckets = useMemo(() => {
    if (rawSidebarUnitBuckets === undefined || renamedTitles.size === 0) return rawSidebarUnitBuckets;
    const applyRename = <T extends ConversationListItem>(item: T): T => {
      const override = renamedTitles.get(item.key);
      if (override === undefined) return item;
      if (item.kind === 'room') {
        return item.title === override.from
          ? { ...item, title: override.to, room: { ...item.room, title: override.to } }
          : item;
      }
      return item.session.title === override.from
        ? { ...item, title: override.to, session: { ...item.session, title: override.to } }
        : item;
    };
    return rawSidebarUnitBuckets.map((bucket) => ({
      ...bucket,
      items: bucket.items.map((item) => {
        if (item.kind !== 'session-group') return applyRename(item);
        const nextMembers = item.members.map((member) => applyRename(member));
        const opener = item.openerId !== undefined
          ? nextMembers.find((member) => member.id === item.openerId)
          : nextMembers[0];
        const nextTitle = opener !== undefined && opener.title.trim() !== '' ? opener.title : item.title;
        return { ...item, title: nextTitle, members: nextMembers };
      }),
    }));
  }, [rawSidebarUnitBuckets, renamedTitles]);
  const useUnitMode = sidebarGroupsEnabled && sidebarUnitBuckets !== undefined;
  const groupedSessionKeyToGroupId = useMemo(() => {
    const map = new Map<string, string>();
    if (sidebarUnitBuckets === undefined) return map;
    for (const bucket of sidebarUnitBuckets) {
      for (const item of bucket.items) {
        if (item.kind === 'session-group') {
          for (const member of item.members) map.set(member.key, item.groupId);
        }
      }
    }
    return map;
  }, [sidebarUnitBuckets]);
  const closeRenameEditor = useCallback(() => { setRenaming(null); }, []);
  const [confirmUndo, setConfirmUndo] = useState<Session | null>(null);
  const [confirmArchiveWorktree, setConfirmArchiveWorktree] = useState<Session | null>(null);
  const [deletingRoom, setDeletingRoom] = useState<Extract<ConversationListItem, { kind: 'room' }> | null>(null);
  const [roomActionBusy, setRoomActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [workspacePinBusy, setWorkspacePinBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<'view' | 'filter' | null>(null);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);
  const filterMenuButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchInput, setSearchInput] = useState('');
  const [includeToolOutput] = useState(false);
  // Search is a header icon (Codex-style): the field only takes vertical space
  // while it is in use, and `/` opens it from anywhere. Closing clears the
  // query so the list is never left silently filtered behind a collapsed box.
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  // Folded and fully shown workspace groups, plus the list's scroll position,
  // survive a reload; they are per space and per connection (sidebarGroupMemory).
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set(readWorkspaceGroupMemory(scopeId).collapsed));
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set(readWorkspaceGroupMemory(scopeId).expanded));
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<ReadonlySet<string>>(
    () => new Set(readWorkspaceGroupMemory(scopeId).expandedSessionGroups),
  );
  const [topLevelThreads, setTopLevelThreads] = useState(() => readTopLevelThreads(scopeId));
  const memoryScope = useRef(scopeId);
  useEffect(() => {
    if (memoryScope.current === scopeId) return;
    memoryScope.current = scopeId;
    const memory = readWorkspaceGroupMemory(scopeId);
    setCollapsedGroups(new Set(memory.collapsed));
    setExpandedGroups(new Set(memory.expanded));
    setExpandedSessionGroups(new Set(memory.expandedSessionGroups));
    setTopLevelThreads(readTopLevelThreads(scopeId));
  }, [scopeId]);

  // One archive in flight per conversation, keyed by the row's own
  // `ConversationListItem.key` (`session:<id>` / `room:<id>`), so a thread and a
  // room say the same thing while they archive and neither can be asked twice.
  // The map is what the row reads, what the menu disables against, and what
  // clears on its own: an entry lives exactly as long as its request does.
  const [pendingArchives, setPendingArchives] = useState<ReadonlySet<string>>(() => new Set());
  // Why an archive failed, per conversation: the row keeps its place in the
  // list and says so in place, so a refusal is never a row that vanished and
  // came back.
  const [archiveErrors, setArchiveErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const beginArchive = (key: string) => {
    setPendingArchives((current) => new Set(current).add(key));
    setArchiveErrors((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  };
  const endArchive = (key: string, error?: string) => {
    setPendingArchives((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setArchiveErrors((current) => {
      const had = current.has(key);
      if (!had && error === undefined) return current;
      const next = new Map(current);
      if (error === undefined) next.delete(key);
      else next.set(key, error);
      return next;
    });
  };
  // A space switch must not carry one space's in-flight row into the next.
  useEffect(() => {
    setPendingArchives(new Set());
    setArchiveErrors(new Map());
  }, [scopeId]);

  const toggleThreadDisplay = (id: string) => {
    const next = new Set(topLevelThreads);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeTopLevelThreads(scopeId, next);
    setTopLevelThreads(next);
    setMenu(null);
  };

  // Bot homes and room member sessions never arrive here: the caller filters
  // them out (they keep their own addresses — a Bot row, the room's row),
  // except archived ones from a deleted room, which stay findable. Its
  // per-session polls feed these rows only (the ☰ count is App's own), so a
  // closed drawer pauses them.
  const activity = useSessionActivity(sessions, inert !== true);
  // Read-state marks drive both the activity badge and the row states below.
  const legacySeen = useSessionSeen();
  const seenV2 = useConversationSeen();
  // Merge v2 global marks (including optimistic open overlays) over v1 for the
  // active space so clicking any row clears its unread dot synchronously.
  const seen = useMemo<SessionSeenMap>(() => {
    const merged: Record<string, number> = { ...legacySeen };
    let changed = false;
    for (const session of sessions) {
      const key = encodeConversationRef({ spaceKey: currentSpaceKey, kind: 'session', id: session.id });
      const rec = seenV2[key];
      if (rec !== undefined && merged[session.id] !== rec.seq) {
        merged[session.id] = rec.seq;
        changed = true;
      }
    }
    for (const room of rooms) {
      const key = encodeConversationRef({ spaceKey: currentSpaceKey, kind: 'room', id: room.id });
      const rec = seenV2[key];
      const rk = roomSeenKey(room.id);
      if (rec !== undefined && merged[rk] !== rec.seq) {
        merged[rk] = rec.seq;
        changed = true;
      }
    }
    return changed ? merged : legacySeen;
  }, [legacySeen, seenV2, sessions, rooms, currentSpaceKey]);

  const layoutPrefs = useLayoutPreferences();
  const spaceScope = layoutPrefs.spaceScope ?? ALL_SPACE_SCOPE;
  const activeRouteConnectionId = parsePlaceConnectionId(location.pathname);
  const activeRouteSpaceKey = activeRouteConnectionId !== undefined
    ? `remote:${activeRouteConnectionId}`
    : currentSpaceKey;
  const normalizedPathname = stripPlacePrefix(location.pathname);
  const activeSessionMatch = /^\/s\/([^/?#]+)/.exec(normalizedPathname);
  const activeRouteSessionId = activeSessionMatch?.[1] !== undefined
    ? decodeURIComponent(activeSessionMatch[1])
    : activeSessionId;
  const activeRoomMatch = /^\/rooms\/([^/?#]+)/.exec(normalizedPathname);
  const activeRoomId = activeRoomMatch?.[1] !== undefined ? decodeURIComponent(activeRoomMatch[1]) : undefined;
  const activeConversationKey = activeRouteSessionId !== undefined
    ? encodeConversationRef({ spaceKey: activeRouteSpaceKey, kind: 'session', id: activeRouteSessionId })
    : activeRoomId !== undefined
      ? encodeConversationRef({ spaceKey: activeRouteSpaceKey, kind: 'room', id: activeRoomId })
      : undefined;

  const fallbackSources = useMemo<readonly SpaceConversationSource[]>(() => (
    multiSpaceSources ?? [{
      spaceKey: currentSpaceKey,
      spaceName: '',
      isRemote: currentSpaceKey.startsWith('remote:'),
      sessions,
      rooms,
      workspaces: workspaceOptions,
    }]
  ), [multiSpaceSources, currentSpaceKey, sessions, rooms, workspaceOptions]);

  const localInboxTriage = useInboxTriageState({
    sources: externalInboxTriage === undefined ? fallbackSources : [],
    currentSpaceKey,
    spaceScope,
    activeConversationKey,
    nowMs,
  });
  const inboxTriage = externalInboxTriage ?? localInboxTriage;
  const unifiedInbox = inboxTriage.inbox;
  const activeSidebarMode: SidebarMode =
    sidebarModeOverride
    ?? layoutPrefs.sidebarMode
    ?? (unifiedInbox.needsYouCount > 0 ? 'inbox' : 'sessions');
  const badgeTotal = unifiedInbox.total;
  const badgeNeedsYou = unifiedInbox.needsYouCount;
  const badgeUnread = unifiedInbox.unreadCount;
  // Blocked-only keeps the "needs you" wording; once finished runs are in the
  // count too, the label says "new items" instead of overstating urgency.
  const activityLabel = badgeTotal === 0
    ? t('sidebar.activityAria')
    : badgeNeedsYou === badgeTotal
      ? tp('sidebar.activityCount', badgeTotal)
      : tp('activity.badgeCount', badgeTotal);

  const openConversation = useCallback((
    ref: ConversationRef,
    cursor: { readonly epoch?: string; readonly seq: number },
    href: string,
    options?: { readonly pinItem?: UnifiedInboxItem },
  ) => {
    const sameSpace = ref.spaceKey === currentSpaceKey || ref.spaceKey === effectiveLocalSpaceKey;
    const isRemoteTarget = ref.spaceKey.startsWith('remote:');
    const targetHomeId = ref.spaceKey !== '' ? ref.spaceKey : effectiveLocalSpaceKey;
    const isOtherLocalSubspace = !sameSpace && !isRemoteTarget && targetHomeId !== effectiveLocalSpaceKey;
    const opensSeparateWindow =
      isDesktopHost(host)
      && isOtherLocalSubspace
      && host.openSpace !== undefined
      && launchWindowMode(readDesktopPrefs().windowMode) === 'windows';
    const handle = beginExplicitConversationOpen(ref, cursor, { syncLegacy: sameSpace && !isRemoteTarget });
    if (options?.pinItem !== undefined && !opensSeparateWindow) {
      inboxTriage.pinViewingItem(options.pinItem);
    } else {
      inboxTriage.clearViewingPin();
    }
    const rollback = () => {
      handle.cancel();
      if (options?.pinItem !== undefined && !opensSeparateWindow) {
        inboxTriage.clearViewingPin();
      }
    };
    if (sameSpace || isRemoteTarget) {
      // Two-Tier in-place routing: both local conversations (`/s/:id`) and
      // paired remote computer conversations (`/p/:connectionId/s/:id`) open in
      // 0ms via React Router without mutating the window's root connection.
      const targetHref = isRemoteTarget ? placeHrefForSpaceKey(ref.spaceKey, href) : href;
      if (location.pathname === targetHref) {
        handle.commit();
      }
      void navigate(targetHref, undefined, rollback);
      return;
    }
    if (opensSeparateWindow) {
      void enterSpace(host, targetHomeId, 'windows').catch(rollback);
      return;
    }
    void requestScopeNavigation({
      homeId: targetHomeId,
      scopeId: isOtherLocalSubspace ? 'local' : effectiveLocalScopeId,
      route: href,
      inPlace: true,
    }).catch(rollback);
  }, [currentSpaceKey, effectiveLocalSpaceKey, effectiveLocalScopeId, host, inboxTriage, location.pathname, navigate]);

  const openSessionRow = useCallback((session: Session, targetSpaceKey = currentSpaceKey) => {
    openConversation(
      { spaceKey: targetSpaceKey, kind: 'session', id: session.id },
      sessionAttentionCursor(session),
      `/s/${encodeURIComponent(session.id)}`,
    );
  }, [currentSpaceKey, openConversation]);

  const openRoomRow = useCallback((room: RoomListItem, href: string, targetSpaceKey = currentSpaceKey) => {
    openConversation(
      { spaceKey: targetSpaceKey, kind: 'room', id: room.id },
      { seq: Math.max(0, Math.trunc(room.lastSeq)) },
      href,
    );
  }, [currentSpaceKey, openConversation]);

  const openInboxItem = useCallback((item: UnifiedInboxItem) => {
    const href = item.ref.kind === 'room'
      ? roomRefLink(item.ref.id)
      : `/s/${encodeURIComponent(item.ref.id)}`;
    openConversation(item.ref, item.attentionCursor, href, { pinItem: item });
  }, [openConversation]);
  const [coldFoldExpanded, setColdFoldExpanded] = useState(false);
  const activeWorkspaceId = sessions.find((session) => session.id === activeSessionId)?.workspace_id;
  const reachableSessionId = useMemo(() => {
    if (activeSessionId !== undefined && activeSessionId !== '') return activeSessionId;
    const lastId = readLastSessionId();
    if (
      lastId !== undefined &&
      lastId !== '' &&
      sessions.some((session) => session.id === lastId && session.archived !== true)
    ) {
      return lastId;
    }
    return sessions.find((session) => session.archived !== true)?.id;
  }, [activeSessionId, sessions]);

  // Local panel-layout prefs: the sidebar owns its own width. Local live
  // width drives the inline CSS var during a drag; the persisted pref is
  // only written on pointer-up.
  const [sidebarWidthValue, setSidebarWidthValue] = useState(layoutPrefs.sidebarWidth);
  useEffect(() => {
    setSidebarWidthValue(layoutPrefs.sidebarWidth);
  }, [layoutPrefs.sidebarWidth]);
  const { startResize, reset } = usePaneResize({
    value: sidebarWidthValue,
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    onChange: (value, final) => {
      setSidebarWidthValue(value);
      if (final) writeLayoutPreferences({ sidebarWidth: value });
    },
    onReset: () => {
      setSidebarWidthValue(SIDEBAR_DEFAULT_WIDTH);
      writeLayoutPreferences({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
    },
  });

  // Desktop collapse: below md the sidebar stays App's drawer (sidebarOpen);
  // from md up it follows the window width until the user picks a side — the
  // persisted override wins over the breakpoint.
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const isNarrowDesktop = useMediaQuery('(max-width: 1279px)');
  const isCollapsed = isDesktop && !temporaryOpen && (layoutPrefs.sidebarCollapsed ?? isNarrowDesktop);

  const refreshSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    invalidatePersonaSessionLists(queryClient);
  }, [queryClient]);
  const actionContext: SessionActionContext = useMemo(
    () => ({ client, host, refreshSessions, navigate }),
    [client, host, refreshSessions, navigate],
  );

  // Search scopes to the active filters: the workspace chips narrow both
  // layers; status/archived narrow content hits to the visible sessions.
  // Rooms are not searchable content; only their thread rows take part.
  const visibleSessions = useMemo(() => {
    if (useUnitMode && sidebarUnitBuckets !== undefined) {
      const out: Session[] = [];
      for (const bucket of sidebarUnitBuckets) {
        for (const item of bucket.items) {
          if (item.kind === 'session-group') {
            for (const member of item.members) out.push(member.session);
          } else if (item.kind === 'session') {
            out.push(item.session);
          }
        }
      }
      return out;
    }
    return sessionGroups.flatMap((group) => group.items).flatMap((item) => (item.kind === 'session' ? [item.session] : []));
  }, [useUnitMode, sidebarUnitBuckets, sessionGroups]);
  const privateFilter = filters.private ?? 'hide';
  const narrowsBeyondWorkspace = filters.status.length > 0 || filters.archived !== 'hide' || privateFilter !== 'hide';
  // When more pages exist on the server (`hasNextPage === true`), never intersect
  // server search hits with only the currently loaded page-1 `visibleSessions`
  // (which would silently discard hits from sessions #51+). Exclude only loaded
  // sessions known to fail the active filter instead.
  const hasMoreUnloadedSessions = sessionsQuery.hasNextPage === true;
  const visibleSessionIdSet = useMemo(
    () => new Set(visibleSessions.map((session) => session.id)),
    [visibleSessions],
  );
  const allowedSessionIds = useMemo(
    () => (narrowsBeyondWorkspace && !hasMoreUnloadedSessions ? visibleSessionIdSet : undefined),
    [narrowsBeyondWorkspace, hasMoreUnloadedSessions, visibleSessionIdSet],
  );
  const excludedSessionIds = useMemo(() => {
    if (!narrowsBeyondWorkspace || !hasMoreUnloadedSessions) return undefined;
    const excluded = new Set<string>();
    for (const session of sessions) {
      if (!visibleSessionIdSet.has(session.id)) excluded.add(session.id);
    }
    return excluded;
  }, [narrowsBeyondWorkspace, hasMoreUnloadedSessions, sessions, visibleSessionIdSet]);
  const workspaceById = useMemo(
    () => new Map(workspaceOptions.map((workspace) => [workspace.id, workspace])),
    [workspaceOptions],
  );
  const workspaceNameById = useMemo(
    () => new Map(workspaceOptions.map((workspace) => [workspace.id, workspace.name])),
    [workspaceOptions],
  );
  const deferredSearchInput = useDeferredValue(searchInput);
  const searchMounted = searchOpen || searchInput.trim() !== '' || deferredSearchInput.trim() !== '';
  const remoteSearchSpaceBySessionId = useMemo(() => {
    const map = new Map<string, string>();
    if (multiSpaceSources === undefined) return map;
    for (const src of multiSpaceSources) {
      if (!src.isRemote || !matchesSpaceScope(spaceScope, src.spaceKey)) continue;
      for (const s of src.sessions) {
        if (!map.has(s.id)) map.set(s.id, src.spaceKey);
      }
    }
    return map;
  }, [multiSpaceSources, spaceScope]);
  const searchableSessions = useMemo(() => {
    if (!searchMounted) return EMPTY_SESSIONS;
    const base = narrowsBeyondWorkspace ? visibleSessions : sessions.filter((session) => session.archived !== true && session.private !== true);
    const includeLocal = matchesSpaceScope(spaceScope, currentSpaceKey);
    const merged: Session[] = includeLocal ? [...base] : [];
    if (multiSpaceSources !== undefined) {
      const seenIds = new Set(merged.map((s) => s.id));
      for (const src of multiSpaceSources) {
        if (!src.isRemote || !matchesSpaceScope(spaceScope, src.spaceKey)) continue;
        for (const remoteSession of src.sessions) {
          if (remoteSession.archived === true || remoteSession.private === true) continue;
          if (!seenIds.has(remoteSession.id)) {
            seenIds.add(remoteSession.id);
            merged.push(remoteSession);
          }
        }
      }
    }
    return merged;
  }, [searchMounted, narrowsBeyondWorkspace, visibleSessions, sessions, spaceScope, currentSpaceKey, multiSpaceSources]);
  const search = useSessionSearch({
    text: deferredSearchInput,
    sessions: searchableSessions,
    workspaces: workspaceOptions,
    untitled,
    workspaceScope: filters.workspaces,
    allowedSessionIds,
    excludedSessionIds,
    includeToolOutput,
  });

  // `/` focuses search from anywhere that is not typing somewhere else; other
  // surfaces ask for the same thing through `requestSessionSearch()`.
  useEffect(() => {
    const openSearch = () => {
      setSearchOpen(true);
      // The input mounts with this state change; focus after that commit.
      window.setTimeout(() => { searchRef.current?.focus(); }, 0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(SESSION_SEARCH_EVENT, openSearch);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(SESSION_SEARCH_EVENT, openSearch);
    };
  }, []);

  const setFilters = (patch: Partial<SessionListFilters>) => {
    const merged = { ...filters, ...patch };
    const { private: nextPrivate, ...rest } = merged;
    onFiltersChange(nextPrivate !== undefined && nextPrivate !== 'hide' ? { ...rest, private: nextPrivate } : rest);
  };
  const toggleStatus = (status: SessionStatusFilter) => {
    setFilters({
      status: filters.status.includes(status)
        ? filters.status.filter((entry) => entry !== status)
        : [...filters.status, status],
    });
  };
  const toggleWorkspace = (workspaceId: string) => {
    setFilters({
      workspaces: filters.workspaces.includes(workspaceId)
        ? filters.workspaces.filter((entry) => entry !== workspaceId)
        : [...filters.workspaces, workspaceId],
    });
  };

  // Workspace pin: one toggle per row inside the filter menu. It writes the
  // server-side `pinned` field, so the order it produces is shared by every client.
  const toggleWorkspacePin = (workspace: WorkspaceCatalogEntry) => {
    setWorkspacePinBusy(true);
    setActionError(null);
    void client
      .setWorkspacePinnedCatalog(workspace.id, !workspace.pinned)
      .then(() => queryClient.invalidateQueries({ queryKey: ['workspaces'] }))
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { setWorkspacePinBusy(false); });
  };

  const remoteConnIdOf = (itemSpaceKey?: string): string | undefined =>
    itemSpaceKey !== undefined && itemSpaceKey.startsWith('remote:')
      ? itemSpaceKey.slice('remote:'.length)
      : undefined;

  const clientForSpace = (itemSpaceKey?: string) => {
    const connId = remoteConnIdOf(itemSpaceKey);
    return connId !== undefined ? (placePool?.getOrCreateClient(connId) ?? client) : client;
  };

  const togglePin = (session: Session, itemSpaceKey?: string) => {
    setMenu(null);
    setActionError(null);
    const remoteConnId = remoteConnIdOf(itemSpaceKey);
    const targetClient = clientForSpace(itemSpaceKey);
    const next = togglePinned(isPinnedSession(session));
    const metadata = pinMetadataPatch(session, next);
    if (remoteConnId !== undefined) {
      void targetClient
        .updateSessionProfile(session.id, { metadata })
        .then(() => { void onRefreshRemoteSpace?.(remoteConnId); })
        .catch((error: unknown) => {
          setActionError(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    const applyPatch = (entry: Session, serverUpdated?: Session): Session => {
      const base =
        serverUpdated !== undefined && serverUpdated !== null && typeof serverUpdated === 'object' && 'id' in serverUpdated
          ? serverUpdated
          : entry;
      return {
        ...base,
        metadata: {
          ...base.metadata,
          ...metadata,
          cwd: base.metadata.cwd,
        },
      };
    };
    const patchSessionLists = (transform: (entry: Session) => Session, pinnedValue: boolean) => {
      queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
        old === undefined || !Array.isArray(old.pages)
          ? old
          : {
              ...old,
              pages: old.pages.map((page) => (!Array.isArray(page?.items) ? page : {
                ...page,
                items: page.items.map((entry) => (entry.id === session.id ? transform(entry) : entry)),
              })),
            },
      );
      queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units'] }, (old) =>
        patchSidebarUnitRow(old, session.id, (row) => ({ ...row, pinned: pinnedValue })),
      );
      queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units-pinned'] }, (old) =>
        patchSidebarUnitRow(old, session.id, (row) => ({ ...row, pinned: pinnedValue })),
      );
      if (queryClient.getQueryData(['session', session.id]) !== undefined) {
        queryClient.setQueryData<Session>(['session', session.id], (old) =>
          old === undefined ? old : transform(old),
        );
      }
    };
    const previousMetadata = session.metadata;
    const previousPinned = isPinnedSession(session);
    patchSessionLists((entry) => applyPatch(entry), next);
    void client
      .updateSessionProfile(session.id, { metadata })
      .then((updated) => {
        patchSessionLists((entry) => applyPatch(entry, updated), next);
        void queryClient.invalidateQueries({
          queryKey: ['sessions'],
          predicate: (query) =>
            !Array.isArray((query.state.data as SessionListData | undefined)?.pages) ||
            JSON.stringify(query.queryKey).includes('"pinned"') ||
            JSON.stringify(query.queryKey).includes('sidebar-units-pinned'),
        });
      })
      .catch((error: unknown) => {
        patchSessionLists((entry) => ({ ...entry, metadata: previousMetadata }), previousPinned);
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };

  const togglePrivate = (session: Session, targetSpaceKey?: string) => {
    setMenu(null);
    if (pendingPrivacyRef.current.has(session.id)) return;
    pendingPrivacyRef.current.add(session.id);
    setPendingPrivacy((current) => new Set(current).add(session.id));
    setActionError(null);
    const nextPrivate = session.private !== true;
    const remoteConnId = remoteConnIdOf(targetSpaceKey);
    const targetClient = clientForSpace(targetSpaceKey);
    void targetClient
      .updateSession(session.id, { private: nextPrivate })
      .then((updated) => {
        if (remoteConnId !== undefined) {
          void onRefreshRemoteSpace?.(remoteConnId);
        } else {
          queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
            old === undefined || !Array.isArray(old.pages)
              ? old
              : {
                  ...old,
                  pages: old.pages.map((page) => (!Array.isArray(page?.items) ? page : {
                    ...page,
                    items: page.items.map((item) => (item.id === session.id ? { ...item, ...updated, private: nextPrivate } : item)),
                  })),
                },
          );
          queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units'] }, (old) =>
            patchSidebarUnitRow(old, session.id, (row) => ({ ...row, private: nextPrivate })),
          );
          queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units-pinned'] }, (old) =>
            patchSidebarUnitRow(old, session.id, (row) => ({ ...row, private: nextPrivate })),
          );
          if (queryClient.getQueryData(['session', session.id]) !== undefined) {
            queryClient.setQueryData<Session>(['session', session.id], (old) =>
              old === undefined ? old : { ...old, ...updated, private: nextPrivate },
            );
          }
          refreshSessions();
          void queryClient.invalidateQueries({ queryKey: ['global-search'] });
        }
        pushToast({ tone: 'success', text: t(nextPrivate ? 'private.madeToast' : 'private.exitedToast') });
      })
      .catch((error: unknown) => {
        setActionError(t('private.updateFailed', { detail: errorText(locale, error) }));
      })
      .finally(() => {
        pendingPrivacyRef.current.delete(session.id);
        setPendingPrivacy((current) => {
          if (!current.has(session.id)) return current;
          const next = new Set(current);
          next.delete(session.id);
          return next;
        });
      });
  };

  // Room lifecycle rides the room API; ['rooms'] invalidation covers both the
  // summaries ('rooms','items') and a cached room document ('rooms',id).
  const refreshRooms = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY }),
    [queryClient],
  );
  const patchRoom = (roomId: string, patch: { name?: string; pinned?: boolean; archived?: boolean }) => {
    setMenu(null);
    setActionError(null);
    void roomApi
      .updateRoom(roomId, patch)
      .then(() => { refreshRooms(); })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };
  const toggleRoomPin = (item: Extract<ConversationListItem, { kind: 'room' }>) => {
    patchRoom(item.id, { pinned: !item.pinned });
  };
  const toggleRoomPause = (item: Extract<ConversationListItem, { kind: 'room' }>, paused: boolean) => {
    setMenu(null);
    setActionError(null);
    const request = paused ? roomApi.continueRoom(item.id) : roomApi.pauseRoom(item.id);
    void request
      .then((room) => {
        queryClient.setQueryData(roomQueryKey(item.id), room);
        refreshRooms();
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };
  const deleteRoom = (item: Extract<ConversationListItem, { kind: 'room' }>) => {
    setRoomActionBusy(true);
    setActionError(null);
    void roomApi
      .deleteRoom(item.id)
      .then(() => {
        setDeletingRoom(null);
        queryClient.removeQueries({ queryKey: roomQueryKey(item.id) });
        refreshRooms();
        refreshSessions();
        if (location.pathname === item.href) void navigate('/');
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { setRoomActionBusy(false); });
  };

  useEffect(() => {
    if (actionNotice === null) return;
    const timer = setTimeout(() => { setActionNotice(null); }, 3000);
    return () => { clearTimeout(timer); };
  }, [actionNotice]);

  const runForkSession = (session: Session, seed: SessionSeedMode = 'verbatim') => {
    setMenu(null);
    setActionError(null);
    setActionNotice(null);
    void forkSession(actionContext, session, { seed }).catch((error: unknown) => {
      setActionError(t('action.forkFailed', { detail: sessionActionErrorText(locale, error) }));
    });
  };

  const runCreateBranch = (session: Session, seed: SessionSeedMode = 'fresh') => {
    setMenu(null);
    setActionError(null);
    setActionNotice(null);
    void client
      .createBranch(session.id, { seed, tools_locked: false })
      .then((created) => {
        refreshSessions();
        void navigate(`/s/${session.id}/agent/${encodeURIComponent(created.agent_id)}`);
      })
      .catch((error: unknown) => {
        setActionError(t('branch.failed', { detail: sessionActionErrorText(locale, error) }));
      });
  };

  const runAction = (session: Session, action: 'undo' | 'compact' | 'export') => {
    setMenu(null);
    if (action === 'undo') {
      setConfirmUndo(session);
      return;
    }
    setActionError(null);
    setActionNotice(null);
    if (action === 'export') {
      void exportSessionArchive(actionContext, session)
        .then((saved) => {
          if (saved) setActionNotice(t('action.exportDone', { title: resolveTitle(sessionLabel(session, untitled)) }));
        })
        .catch((error: unknown) => {
          setActionError(t('action.exportFailed', { detail: sessionActionErrorText(locale, error) }));
        });
    } else {
      void compactSessionContext(actionContext, session)
        .then((receipt) => {
          if (compactReceiptOutcome(receipt) === 'duplicate') { pushToast({ tone: 'info', text: t('context.compaction.manual.duplicate') }); return; }
          setActionNotice(t('action.compactRequested', { title: resolveTitle(sessionLabel(session, untitled)) }));
        })
        .catch((error: unknown) => {
          setActionError(t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }));
        });
    }
  };

  const navigateAwayFromArchived = (archivedIds: ReadonlySet<string>) => {
    if (activeSessionId === undefined || !archivedIds.has(activeSessionId)) return;
    if (location.pathname.startsWith('/archived')) return;
    const currentIndex = visibleSessions.findIndex((candidate) => candidate.id === activeSessionId);
    const remaining = visibleSessions.filter((candidate) => !archivedIds.has(candidate.id) && candidate.archived !== true);
    const next = currentIndex >= 0
      ? (visibleSessions.slice(currentIndex + 1).find((candidate) => !archivedIds.has(candidate.id) && candidate.archived !== true)
        ?? visibleSessions.slice(0, currentIndex).findLast((candidate) => !archivedIds.has(candidate.id) && candidate.archived !== true)
        ?? remaining[0])
      : remaining[0];
    void navigate(next !== undefined ? `/s/${encodeURIComponent(next.id)}` : '/new');
  };

  // The authoritative answer, not an optimistic guess: the archived fact goes
  // into the loaded pages so the ordinary list (archived: hide) drops the row
  // and the archived view keeps it, with no second wait on the network. The
  // invalidation after it only reconciles anything the server also archived.
  const markSessionsArchived = (ids: ReadonlySet<string>) => {
    if (ids.size === 0) return;
    // Non-paginated session views keep their own shape and refetch below.
    queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) => old === undefined || !Array.isArray(old.pages) ? old : {
      ...old,
      pages: old.pages.map((page) => (!Array.isArray(page?.items) ? page : {
        ...page,
        items: page.items.map((session) => ids.has(session.id) ? { ...session, archived: true } : session),
      })),
    });
    for (const id of ids) {
      queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units'] }, (old) =>
        patchSidebarUnitRow(old, id, (row) => ({ ...row, archived: true })),
      );
      queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units-pinned'] }, (old) =>
        patchSidebarUnitRow(old, id, (row) => ({ ...row, archived: true })),
      );
    }
    void queryClient.invalidateQueries({ queryKey: ['archived-sessions'] }).catch(() => undefined);
    refreshSessions();
    navigateAwayFromArchived(ids);
  };
  const markRoomsArchived = (ids: ReadonlySet<string>) => {
    if (ids.size === 0) return;
    queryClient.setQueryData<RoomListItem[]>(ROOM_ITEMS_QUERY_KEY, (old) => old === undefined ? old : old.map((room) => (
      ids.has(room.id) ? { ...room, archived: true } : room
    )));
    refreshRooms();
  };

  const archive = (session: Session, key: string, itemSpaceKey?: string) => {
    setMenu(null);
    setActionError(null);
    const remoteConnId = remoteConnIdOf(itemSpaceKey);
    const targetClient = clientForSpace(itemSpaceKey);
    // A worktree session asks once whether its checkout goes too.
    if (remoteConnId === undefined && session.worktree !== undefined) {
      setConfirmArchiveWorktree(session);
      return;
    }
    if (pendingArchives.has(key)) return;
    beginArchive(key);
    if (remoteConnId !== undefined) {
      void targetClient
        .archiveSession(session.id, { include_attached: !sidebarGroupsEnabled })
        .then(() => {
          void onRefreshRemoteSpace?.(remoteConnId);
          endArchive(key);
        })
        .catch((error: unknown) => {
          endArchive(key, error instanceof Error ? error.message : String(error));
        });
      return;
    }
    if (sidebarGroupsEnabled) {
      void client
        .archiveSession(session.id, { include_attached: false })
        .then((result) => {
          const confirmed = new Set(
            (result.outcomes ?? []).filter((outcome) => outcome.ok).map((outcome) => outcome.id),
          );
          if (confirmed.size === 0 && result.archived) confirmed.add(session.id);
          if (confirmed.size === 0) refreshSessions();
          else markSessionsArchived(confirmed);
          endArchive(key);
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          invalidatePersonaSessionLists(queryClient);
          void queryClient
            .invalidateQueries({ queryKey: ['sessions'] })
            .catch(() => undefined)
            .then(() => {
              if (!isSessionStillListed(queryClient, session.id)) setActionError(reason);
            });
          endArchive(key, reason);
        });
      return;
    }
    // Legacy host fallback: archiving a parent takes its attached conversations
    // with it, holding back only locally promoted top-level rows.
    const exclude = [...topLevelThreads].filter((id) => id !== session.id);
    void client
      .archiveSession(session.id, { include_attached: true, exclude_session_ids: exclude })
      .then((result) => {
        // Only what the server confirmed leaves the list. A response without
        // outcomes is not a family success and is never read as one: the list
        // is re-read instead, which is also what repairs the case where the
        // archived set includes conversations this view never loaded.
        const confirmed = new Set(
          (result.outcomes ?? []).filter((outcome) => outcome.ok).map((outcome) => outcome.id),
        );
        if (confirmed.size === 0) refreshSessions();
        else markSessionsArchived(confirmed);
        endArchive(key);
      })
      .catch((error: unknown) => {
        // Partial success is retained by the server. Refresh without restoring
        // anything; if the clicked root is gone, keep the failed ids and reason
        // in the existing sidebar alert so surviving children can be retried.
        const reason = error instanceof Error ? error.message : String(error);
        invalidatePersonaSessionLists(queryClient);
        void queryClient
          .invalidateQueries({ queryKey: ['sessions'] })
          .catch(() => undefined)
          .then(() => {
            if (!isSessionStillListed(queryClient, session.id)) setActionError(reason);
          });
        endArchive(key, reason);
      });
  };

  const archiveRoom = (room: Extract<ConversationListItem, { kind: 'room' }>, key: string) => {
    setMenu(null);
    setActionError(null);
    if (pendingArchives.has(key)) return;
    beginArchive(key);
    void roomApi
      .updateRoom(room.id, { archived: true })
      .then((document) => {
        queryClient.setQueryData(roomQueryKey(room.id), document);
        markRoomsArchived(new Set([room.id]));
        endArchive(key);
      })
      .catch((error: unknown) => {
        // The room's own archive changed nothing else: its members keep their
        // own archived state, so only this row waits on the server.
        refreshRooms();
        endArchive(key, error instanceof Error ? error.message : String(error));
      });
  };

  const [recoveringInterrupted, setRecoveringInterrupted] = useState(false);

  const handleRecoverAllInterrupted = useCallback(async (items: readonly UnifiedInboxItem[]) => {
    if (recoveringInterrupted || items.length === 0) return;
    setRecoveringInterrupted(true);
    setActionError(null);
    const touchedRemoteIds = new Set<string>();
    let touchedLocal = false;
    try {
      const results = await Promise.allSettled(
        items.map(async (item) => {
          if (item.ref.kind !== 'session') return;
          const remoteConnId = remoteConnIdOf(item.spaceKey);
          const targetClient = clientForSpace(item.spaceKey);
          await targetClient.recoverSession(item.sessionId);
          if (remoteConnId !== undefined) touchedRemoteIds.add(remoteConnId);
          else touchedLocal = true;
        }),
      );
      if (touchedLocal) refreshSessions();
      for (const remoteConnId of touchedRemoteIds) {
        void onRefreshRemoteSpace?.(remoteConnId);
      }
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected.length > 0) {
        const detail = rejected[0]!.reason instanceof Error ? rejected[0]!.reason.message : String(rejected[0]!.reason);
        setActionError(rejected.length === 1 ? detail : `${detail} (+${rejected.length - 1})`);
      }
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecoveringInterrupted(false);
    }
  }, [clientForSpace, onRefreshRemoteSpace, recoveringInterrupted, refreshSessions]);

  const detachGroupMember = useCallback(async (session: Session, itemSpaceKey?: string) => {
    setActionError(null);
    const remoteConnId = remoteConnIdOf(itemSpaceKey);
    try {
      if (remoteConnId !== undefined) {
        const remoteClient = clientForSpace(itemSpaceKey);
        const rest = remoteClient.klient?.rest;
        if (rest === undefined) throw new Error('Detach unavailable on remote transport');
        await rest.sessions.detachGroup(session.id);
        void onRefreshRemoteSpace?.(remoteConnId);
      } else if (onDetachGroupMember !== undefined) {
        await onDetachGroupMember(session.id);
      } else {
        const rest = client.klient?.rest;
        if (rest === undefined) throw new Error('Detach unavailable on this transport');
        await rest.sessions.detachGroup(session.id);
        refreshSessions();
      }
      pushToast({ tone: 'success', text: t('sidebar.group.detachedToast') });
    } catch (error: unknown) {
      setActionError(t('sidebar.group.detachFailed', { detail: errorText(locale, error) }));
    }
  }, [client, locale, onDetachGroupMember, onRefreshRemoteSpace, refreshSessions, t]);

  const restore = (session: Session, itemSpaceKey?: string) => {
    setMenu(null);
    setActionError(null);
    const remoteConnId = remoteConnIdOf(itemSpaceKey);
    const targetClient = clientForSpace(itemSpaceKey);
    void targetClient
      .restoreSession(session.id)
      .then(() => {
        if (remoteConnId !== undefined) void onRefreshRemoteSpace?.(remoteConnId);
        else refreshSessions();
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };

  // One flat list across the result groups so ↑↓ never has to know where a
  // group boundary is; each entry knows how to open itself.
  // Opening a session or message hit keeps the query and the active row: when
  // hit 1 was the wrong one, hit 2 is one ↓/Enter (or click) away instead of a
  // retype. Only Escape and the × clear it. A workspace pick is different: it
  // turns the query into a list filter, and the list it filters is only shown
  // once the query is gone.
  const { directory: personaDirectory } = usePersonaDirectory({ sessions: personaSessions ?? sessions, seen });
  const matchingPersonas = useMemo(() => {
    if (!search.active) return [];
    const term = search.parsed.text.trim().toLowerCase();
    if (term === '') return [];
    return personaDirectory.filter((item) =>
      !item.hidden
      && (item.name.toLowerCase().includes(term)
        || item.id.toLowerCase().includes(term)
        || (item.title?.toLowerCase().includes(term) ?? false)),
    );
  }, [personaDirectory, search.active, search.parsed.text]);

  const results = useMemo(() => {
    const items: { key: string; open: () => void }[] = [];
    for (const persona of matchingPersonas) {
      items.push({
        key: `p:${persona.id}`,
        open: () => { void navigate(`/p/${encodeURIComponent(persona.id)}/daily`); },
      });
    }
    for (const match of search.local.workspaces) {
      items.push({
        key: `ws:${match.workspace.id}`,
        open: () => {
          if (!filters.workspaces.includes(match.workspace.id)) {
            setFilters({ workspaces: [...filters.workspaces, match.workspace.id] });
          }
          setSearchInput('');
        },
      });
    }
    for (const match of search.local.sessions) {
      const targetSpaceKey = remoteSearchSpaceBySessionId.get(match.session.id) ?? currentSpaceKey;
      items.push({ key: `s:${match.session.id}`, open: () => { openSessionRow(match.session.source, targetSpaceKey); } });
    }
    search.hits.forEach((hit, index) => {
      items.push({
        key: `h:${index}`,
        open: () => {
          const hitSession = sessions.find((s) => s.id === hit.session_id);
          const handle = hitSession !== undefined
            ? beginExplicitConversationOpen(
                { spaceKey: currentSpaceKey, kind: 'session', id: hit.session_id },
                sessionAttentionCursor(hitSession),
                { syncLegacy: true },
              )
            : undefined;
          const route = hit.agent_id && hit.agent_id !== 'main'
            ? `/s/${encodeURIComponent(hit.session_id)}/agent/${encodeURIComponent(hit.agent_id)}`
            : `/s/${encodeURIComponent(hit.session_id)}`;
          const params = new URLSearchParams();
          if (hit.turn !== undefined) params.set('turn', String(hit.turn));
          if (hit.step_id !== undefined && hit.step_id !== '') params.set('step', hit.step_id);
          if (search.parsed.text.trim() !== '') params.set('q', search.parsed.text.trim());
          const qs = params.toString();
          void navigate(qs === '' ? route : `${route}?${qs}`, undefined, () => { handle?.cancel(); });
        },
      });
    });
    return items;
    // setFilters closes over the latest filters; recompute with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchingPersonas, search.local, search.hits, filters, navigate, openSessionRow, sessions, currentSpaceKey]);
  const resultsByKey = useMemo(() => {
    const map = new Map<string, { readonly index: number; readonly open: () => void }>();
    for (let index = 0; index < results.length; index += 1) {
      const entry = results[index]!;
      map.set(entry.key, { index, open: entry.open });
    }
    return map;
  }, [results]);
  useEffect(() => { setActiveResult(0); }, [searchInput]);
  const activeKey = search.active ? results[Math.min(activeResult, results.length - 1)]?.key : undefined;
  useEffect(() => {
    if (activeKey === undefined) return;
    const node = document.getElementById(`sidebar-result-${activeKey}`);
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (searchInput === '') event.currentTarget.blur();
      setSearchInput('');
      return;
    }
    if (!search.active || results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveResult((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveResult((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      results[Math.min(activeResult, results.length - 1)]?.open();
    }
  };

  const filterChips: { key: string; label: string; clear: () => void }[] = [
    ...filters.status.map((status) => ({
      key: `status:${status}`,
      label: t(status === 'running' ? 'sidebar.statusRunning' : status === 'needs-me' ? 'sidebar.statusNeedsMe' : status === 'cleanup-pending' ? 'sidebar.rowState.cleanupPending' : 'sidebar.statusIdle'),
      clear: () => { toggleStatus(status); },
    })),
    ...filters.workspaces.map((id) => ({
      key: `ws:${id}`,
      label: workspaceById.get(id)?.name ?? id,
      clear: () => { toggleWorkspace(id); },
    })),
    ...(filters.archived === 'hide'
      ? []
      : [{
          key: 'archived',
          label: filters.archived === 'only' ? t('sidebar.filterArchivedOnly') : t('sidebar.filterArchived'),
          clear: () => { setFilters({ archived: 'hide' }); },
        }]),
    ...(privateFilter === 'hide'
      ? []
      : [{
          key: 'private',
          label: privateFilter === 'only' ? t('sidebar.filterPrivateOnly') : t('sidebar.filterPrivate'),
          clear: () => { setFilters({ private: 'hide' }); },
        }]),
  ];
  const filtersActive = hasActiveSessionFilters(filters);
  const visibleRunningCount = useMemo(() => {
    if (multiSpaceSources === undefined || multiSpaceSources.length === 0) {
      return activity.model.running.length;
    }
    let total = 0;
    for (const source of multiSpaceSources) {
      if (!matchesSpaceScope(spaceScope, source.spaceKey)) continue;
      if (!source.isRemote && source.spaceKey === currentSpaceKey) {
        total += activity.model.running.length;
      } else {
        total += source.sessions.filter((s) => s.archived !== true && s.private !== true && sessionStatusOf(s) === 'running').length;
      }
    }
    return total;
  }, [multiSpaceSources, spaceScope, currentSpaceKey, activity.model.running.length]);
  const counts = { running: visibleRunningCount };
  // The status filter offers only the states some session is in right now,
  // among the archived ones the list shows: an entry with nothing behind it
  // ("process cleanup unconfirmed" on a quiet day) is a choice nobody can use.
  const presentStatuses = useMemo(() => {
    const candidateSessions = multiSpaceSources !== undefined && multiSpaceSources.length > 0
      ? multiSpaceSources.flatMap((source) => (matchesSpaceScope(spaceScope, source.spaceKey) ? source.sessions : []))
      : sessions;
    return new Set<SessionStatusFilter>(candidateSessions
      .filter((session) => (filters.archived === 'only' ? session.archived === true
        : filters.archived === 'hide' ? session.archived !== true : true))
      .filter((session) => (privateFilter === 'only' ? session.private === true
        : privateFilter === 'hide' ? session.private !== true : true))
      .map((session) => sessionStatusOf(session)));
  }, [multiSpaceSources, spaceScope, sessions, filters.archived, privateFilter]);

  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeWorkspaceGroupMemory(scopeId, { collapsed: [...next] });
      return next;
    });
  }, [scopeId]);
  const toggleGroupExpanded = useCallback((key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeWorkspaceGroupMemory(scopeId, { expanded: [...next] });
      return next;
    });
  }, [scopeId]);
  const toggleSessionGroupExpanded = useCallback((groupId: string) => {
    setExpandedSessionGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      writeWorkspaceGroupMemory(scopeId, { expandedSessionGroups: [...next] });
      return next;
    });
  }, [scopeId]);
  const setAllGroupsCollapsed = (keys: readonly string[], collapse: boolean) => {
    const next = new Set(collapse ? keys : []);
    setCollapsedGroups(next);
    writeWorkspaceGroupMemory(scopeId, { collapsed: [...next] });
  };

  // The list's scroll position is remembered with the folds: written after
  // scrolling settles, restored once each time the list mounts with rows.
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRestored = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [listScrolled, setListScrolled] = useState(false);
  const scrollTopRef = useRef(0);
  const demandNotifyScrollRef = useRef<((top: number) => void) | null>(null);
  const visibleAnchorRef = useRef<{ readonly key: string; readonly offsetInRow: number } | null>(null);
  const onListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const top = event.currentTarget.scrollTop;
    scrollTopRef.current = top;
    demandNotifyScrollRef.current?.(top);
    setListScrolled((prev) => (prev === (top > 2) ? prev : top > 2));
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { writeWorkspaceGroupMemory(scopeId, { scrollTop: top }); }, 150);
  };
  useEffect(() => () => { clearTimeout(scrollTimer.current); }, []);
  useEffect(() => {
    scrollRestored.current = false;
    setListScrolled(false);
    scrollTopRef.current = 0;
    visibleAnchorRef.current = null;
  }, [search.active, scopeId]);

  // Legacy host fallback tree (unused when server supports `sidebar_groups`).
  const sessionTree = useMemo(() => {
    if (useUnitMode) return [];
    const projected = projectAttachedConversationGroups(sessionGroups, {
      groupBy,
      order: sortBy,
      topLevelIds: topLevelThreads,
      sessions,
      nowMs: nowMs ?? Date.now(),
      labels: {
        pinned: t('sidebar.groupPinned'),
        today: t('sidebar.groupToday'),
        yesterday: t('sidebar.groupYesterday'),
        week: t('sidebar.groupWeek'),
        month: t('sidebar.groupMonth'),
        older: t('sidebar.groupOlder'),
      },
    });
    return nestConversationItems(projected, { crossGroups: groupBy !== 'workspace', topLevelIds: topLevelThreads });
  }, [useUnitMode, sessionGroups, groupBy, topLevelThreads, sortBy, sessions, t, nowMs]);
  const hasDisplayBuckets = useUnitMode
    ? (sidebarUnitBuckets !== undefined && sidebarUnitBuckets.length > 0)
    : sessionGroups.length > 0;
  useLayoutEffect(() => {
    const node = listRef.current;
    if (node === null || scrollRestored.current || !hasDisplayBuckets) return;
    scrollRestored.current = true;
    const top = readWorkspaceGroupMemory(scopeId).scrollTop;
    if (top > 0) {
      node.scrollTop = top;
      scrollTopRef.current = top;
      setListScrolled(top > 2);
    }
  }, [scopeId, search.active, hasDisplayBuckets]);
  // Temporary conversations stay out of the paged list (and its search and
  // grouping); they get their own block at the top while any exist. The key
  // sits under ['sessions'], so every list refresh refreshes it too.
  // A closed drawer shows none of it, so it does not poll then (the session
  // view keeps its own read of the same key for its record); opening the
  // drawer shows the cached block and refetches it at once.
  const ephemeralQuery = useInfiniteQuery({
    queryKey: ['sessions', 'ephemeral'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => client.listEphemeralSessions({ before_id: pageParam, page_size: 50 }),
    getNextPageParam: (page) => page.has_more ? page.next_cursor : undefined,
    refetchInterval: (query) =>
      wsStatus === 'open'
        ? ((Array.isArray(query.state.data?.pages) && Array.isArray(query.state.data.pages[0]?.items) ? query.state.data.pages[0].items.length : 0) > 0 ? 60_000 : false)
        : 15_000,
    enabled: inert !== true,
  });
  const ephemeralSessions = useMemo(
    () => (Array.isArray(ephemeralQuery.data?.pages)
      ? ephemeralQuery.data.pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : []))
      : EMPTY_SESSIONS),
    [ephemeralQuery.data],
  );
  // While a filter narrows the list, a workspace group shows what matched
  // even if it is folded (the fold is kept for later), and its header counts
  // the matches against everything loaded in that workspace.
  const foldsSuspended = filtersActive;
  const workspaceTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const session of sessions) {
      if (session.archived === true) continue;
      if (privateFilter === 'hide' && session.private === true) continue;
      if (privateFilter === 'only' && session.private !== true) continue;
      totals.set(session.workspace_id, (totals.get(session.workspace_id) ?? 0) + 1);
    }
    return totals;
  }, [privateFilter, sessions]);
  const pinnedTotal = useMemo(
    () => sessions.filter((session) =>
      session.archived !== true
      && (privateFilter === 'hide' ? session.private !== true : privateFilter === 'only' ? session.private === true : true)
      && isPinnedSession(session)).length,
    [privateFilter, sessions],
  );
  const workspaceGroupKeys = groupBy === 'workspace'
    ? (useUnitMode && sidebarUnitBuckets !== undefined
        ? sidebarUnitBuckets.map((bucket) => bucket.key)
        : sessionTree.map((group) => group.key))
    : [];
  const allFolded = workspaceGroupKeys.length > 0 && workspaceGroupKeys.every((key) => collapsedGroups.has(key));
  const titleSessions = useMemo(() => {
    const byId = new Map<string, Session>();
    for (const session of sessions) byId.set(session.id, session);
    for (const session of ephemeralSessions) byId.set(session.id, session);
    for (const group of sessionGroups) {
      for (const item of group.items) {
        if (item.kind === 'session' && !byId.has(item.session.id)) {
          byId.set(item.session.id, item.session);
        }
      }
    }
    if (sidebarUnitBuckets !== undefined) {
      for (const bucket of sidebarUnitBuckets) {
        for (const item of bucket.items) {
          if (item.kind === 'session-group') {
            for (const member of item.members) {
              if (!byId.has(member.session.id)) byId.set(member.session.id, member.session);
            }
          } else if (item.kind === 'session' && !byId.has(item.session.id)) {
            byId.set(item.session.id, item.session);
          }
        }
      }
    }
    return [...byId.values()];
  }, [sessions, ephemeralSessions, sessionGroups, sidebarUnitBuckets]);
  const titleRefCandidates = useMemo(() => {
    const out: string[] = [];
    for (const session of titleSessions) {
      const text = sessionLabel(session, untitled);
      if (text.includes('[[') || text.includes('/s/')) out.push(text);
    }
    return out;
  }, [titleSessions, untitled]);
  const resolveTitle = useThreadTitleResolver(titleRefCandidates, titleSessions);
  const titleOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of titleSessions) {
      const label = sessionLabel(session, untitled);
      map.set(session.id, label.includes('[[') || label.includes('/s/') ? resolveTitle(label) : label);
    }
    return map;
  }, [titleSessions, untitled, resolveTitle]);

  interface BucketHeaderMeta {
    readonly key: string;
    readonly label: string;
    readonly total: number;
  }

  type SidebarFlatEntry =
    | {
        readonly kind: 'ws-header';
        readonly key: string;
        readonly group: BucketHeaderMeta;
        readonly collapsed: boolean;
        readonly foldedLife: LifeState;
        readonly workspace: WorkspaceCatalogEntry | undefined;
        readonly workspaceTarget: WorkspaceCatalogEntry | undefined;
        readonly isFirst: boolean;
      }
    | {
        readonly kind: 'time-header';
        readonly key: string;
        readonly group: BucketHeaderMeta;
        readonly isFirst: boolean;
      }
    | {
        readonly kind: 'session-group-header';
        readonly key: string;
        readonly groupKey: string;
        readonly unitGroup: SidebarSessionGroupEntry;
        readonly expanded: boolean;
        readonly collapsedLife: LifeState;
        readonly hasActiveMember: boolean;
      }
    | {
        readonly kind: 'session-group-more';
        readonly key: string;
        readonly groupKey: string;
        readonly groupId: string;
        readonly spaceKey: string;
        readonly cursor: string;
        readonly remaining: number;
      }
    | {
        readonly kind: 'row';
        readonly key: string;
        readonly groupKey: string;
        readonly item: ConversationListItem;
        readonly relation?: SessionRelation;
        readonly nested: boolean;
        readonly legacyParentId?: string;
        readonly unitGroupId?: string;
        readonly groupNamesWorkspace: boolean;
      }
    | {
        readonly kind: 'group-more';
        readonly key: string;
        readonly groupKey: string;
        readonly hidden: number;
        readonly expanded: boolean;
      }
    | {
        readonly kind: 'cold-fold';
        readonly key: string;
        readonly count: number;
        readonly expanded: boolean;
      };

  const coldFoldEnabled = !search.active && !filtersActive && groupBy === 'time';
  const legacyColdFoldPartition = useMemo(() => {
    if (useUnitMode) return { visibleGroups: [] as typeof sessionTree, coldNodes: [] as ConversationTreeNode[] };
    return partitionColdFold(sessionTree, {
      enabled: coldFoldEnabled,
      activeSessionId,
      activeRoomHref: location.pathname.startsWith('/rooms/') ? location.pathname : undefined,
      rowStateOf: (node) => conversationRowState(node.item, seen),
    });
  }, [useUnitMode, sessionTree, coldFoldEnabled, activeSessionId, location.pathname, seen]);
  const unitColdFoldPartition = useMemo(() => {
    if (!useUnitMode || sidebarUnitBuckets === undefined) {
      return { visibleBuckets: [] as readonly SidebarDisplayBucket[], coldItems: [] as readonly SidebarDisplayItem[], coldCount: 0 };
    }
    return partitionUnitColdFold(sidebarUnitBuckets, {
      enabled: coldFoldEnabled,
      activeSessionId,
      activeRouteSpaceKey,
      activeRoomHref: location.pathname.startsWith('/rooms/') ? location.pathname : undefined,
      currentSpaceKey,
      rowStateOf: (item) => {
        if (item.kind === 'room') return roomRowState(item);
        const itemSeen = item.isRemote === true && item.spaceKey !== undefined
          ? { [item.session.id]: seenV2[encodeConversationRef({ spaceKey: item.spaceKey, kind: 'session', id: item.session.id })]?.seq ?? 0 }
          : seen;
        return sessionRowState(item.session, itemSeen);
      },
    });
  }, [useUnitMode, sidebarUnitBuckets, coldFoldEnabled, activeSessionId, activeRouteSpaceKey, location.pathname, currentSpaceKey, seen, seenV2]);

  const displayedSessionTree = coldFoldExpanded ? sessionTree : legacyColdFoldPartition.visibleGroups;
  const displayedUnitBuckets = useUnitMode && sidebarUnitBuckets !== undefined
    ? (coldFoldExpanded ? sidebarUnitBuckets : unitColdFoldPartition.visibleBuckets)
    : [];
  const coldFoldCount = useUnitMode ? unitColdFoldPartition.coldCount : legacyColdFoldPartition.coldNodes.length;

  // Determine the single demand target for infinite scroll (active local space or scoped remote space).
  const demandTarget = useMemo<SidebarDemandTarget | undefined>(() => {
    const localInScope = matchesSpaceScope(spaceScope, currentSpaceKey);
    if (localInScope && sessionsQuery.hasNextPage === true && sessionsQuery.fetchNextPage !== undefined) {
      return {
        sourceKey: currentSpaceKey,
        // Synthetic fallback tokens are local demand-lock identity keys only; never sent as wire cursors.
        cursor: sidebarNextCursor ?? `__local_page_${sessions.length}`,
        fetch: () => sessionsQuery.fetchNextPage!(),
      };
    }
    if (hasMoreBySpace !== undefined && onLoadMoreSpaceSessions !== undefined) {
      for (const [targetSpaceKey, hasMore] of hasMoreBySpace) {
        if (!hasMore || !matchesSpaceScope(spaceScope, targetSpaceKey)) continue;
        return {
          sourceKey: targetSpaceKey,
          // Local demand-lock identity key only; the space loader reads its own server cursor.
          cursor: nextCursorBySpace?.get(targetSpaceKey) ?? `__remote_${targetSpaceKey}`,
          fetch: () => onLoadMoreSpaceSessions(targetSpaceKey),
        };
      }
    }
    return undefined;
  }, [
    spaceScope,
    currentSpaceKey,
    sessionsQuery.hasNextPage,
    sessionsQuery.fetchNextPage,
    sidebarNextCursor,
    sessions.length,
    hasMoreBySpace,
    nextCursorBySpace,
    onLoadMoreSpaceSessions,
  ]);
  const hasAnyMoreSessions = demandTarget !== undefined;

  const flatSessionEntries = useMemo<readonly SidebarFlatEntry[]>(() => {
    const entries: SidebarFlatEntry[] = [];
    const collapsible = groupBy === 'workspace';

    if (useUnitMode) {
      for (let bucketIndex = 0; bucketIndex < displayedUnitBuckets.length; bucketIndex += 1) {
        const bucket = displayedUnitBuckets[bucketIndex]!;
        const collapsed = collapsible && !foldsSuspended && collapsedGroups.has(bucket.key);
        const expanded = expandedGroups.has(bucket.key);
        const limit = collapsible && !expanded && bucket.key !== 'pinned' ? WORKSPACE_GROUP_PREVIEW : Infinity;
        const shown = collapsed ? [] : bucket.items.slice(0, limit);
        const hidden = collapsed ? 0 : bucket.items.length - shown.length;
        const groupNamesWorkspace = collapsible && bucket.key !== 'pinned' && bucket.key !== WORKSPACE_UNGROUPED_KEY;
        const isFirst = bucketIndex === 0;
        const headerMeta: BucketHeaderMeta = { key: bucket.key, label: bucket.label, total: bucket.total };

        if (collapsible) {
          const workspace = workspaceById.get(bucket.key);
          const workspaceTarget = workspace !== undefined && groupNamesWorkspace ? workspace : undefined;
          const foldedLife = collapsed ? foldedUnitBucketLife(bucket.items, seen, seenV2) : 'idle';
          entries.push({
            kind: 'ws-header',
            key: `hdr:${bucket.key}`,
            group: headerMeta,
            collapsed,
            foldedLife,
            workspace,
            workspaceTarget,
            isFirst,
          });
        } else if (!(groupBy === 'none' && bucket.key === 'all')) {
          entries.push({
            kind: 'time-header',
            key: `hdr:${bucket.key}`,
            group: headerMeta,
            isFirst,
          });
        }

        for (const item of shown) {
          if (item.kind === 'session-group') {
            // Automatic session groups flatten transparently into independent
            // top-level rows so no conversation is hidden behind a closed folder.
            for (const member of item.members) {
              entries.push({
                kind: 'row',
                key: `${bucket.key}:${item.key}:${member.key}`,
                groupKey: bucket.key,
                item: member,
                relation: sessionRelationOf(member.session),
                nested: false,
                groupNamesWorkspace,
              });
            }
            if (item.membersNextCursor !== undefined) {
              entries.push({
                kind: 'session-group-more',
                key: `${bucket.key}:${item.key}:more`,
                groupKey: bucket.key,
                groupId: item.groupId,
                spaceKey: item.spaceKey,
                cursor: item.membersNextCursor,
                remaining: Math.max(0, item.memberCount - item.members.length),
              });
            }
          } else {
            entries.push({
              kind: 'row',
              key: `${bucket.key}:${item.key}`,
              groupKey: bucket.key,
              item,
              relation: item.kind === 'session' ? sessionRelationOf(item.session) : undefined,
              nested: false,
              groupNamesWorkspace,
            });
          }
        }

        if (collapsible && (hidden > 0 || (expanded && !collapsed && bucket.items.length > WORKSPACE_GROUP_PREVIEW))) {
          entries.push({
            kind: 'group-more',
            key: `more:${bucket.key}`,
            groupKey: bucket.key,
            hidden,
            expanded,
          });
        }
      }
    } else {
      for (let groupIndex = 0; groupIndex < displayedSessionTree.length; groupIndex += 1) {
        const group = displayedSessionTree[groupIndex]!;
        const collapsed = collapsible && !foldsSuspended && collapsedGroups.has(group.key);
        const expanded = expandedGroups.has(group.key);
        const limit = collapsible && !expanded && group.key !== 'pinned' ? WORKSPACE_GROUP_PREVIEW : Infinity;
        const shown = collapsed ? [] : group.nodes.slice(0, limit);
        const hidden = collapsed ? 0 : group.nodes.length - shown.length;
        const groupNamesWorkspace = collapsible && group.key !== 'pinned' && group.key !== WORKSPACE_UNGROUPED_KEY;
        const isFirst = groupIndex === 0;
        const headerMeta: BucketHeaderMeta = { key: group.key, label: group.label, total: group.total };

        if (collapsible) {
          const workspace = workspaceById.get(group.key);
          const workspaceTarget = workspace !== undefined && groupNamesWorkspace ? workspace : undefined;
          const foldedLife = collapsed ? foldedGroupLife(group.nodes, seen) : 'idle';
          entries.push({
            kind: 'ws-header',
            key: `hdr:${group.key}`,
            group: headerMeta,
            collapsed,
            foldedLife,
            workspace,
            workspaceTarget,
            isFirst,
          });
        } else if (!(groupBy === 'none' && group.key === 'all')) {
          entries.push({
            kind: 'time-header',
            key: `hdr:${group.key}`,
            group: headerMeta,
            isFirst,
          });
        }

        const pushNode = (node: ConversationTreeNode, nested: boolean, legacyParentId?: string) => {
          entries.push({
            kind: 'row',
            key: `${group.key}:${node.item.key}`,
            groupKey: group.key,
            item: node.item,
            relation: node.relation,
            nested,
            legacyParentId,
            groupNamesWorkspace,
          });
          const nextParentId = node.item.kind === 'session' ? node.item.session.id : undefined;
          for (const child of node.children) {
            pushNode(child, true, nextParentId);
          }
        };
        for (const node of shown) pushNode(node, false);

        if (collapsible && (hidden > 0 || (expanded && !collapsed && group.nodes.length > WORKSPACE_GROUP_PREVIEW))) {
          entries.push({
            kind: 'group-more',
            key: `more:${group.key}`,
            groupKey: group.key,
            hidden,
            expanded,
          });
        }
      }
    }

    if (coldFoldCount > 0) {
      entries.push({
        kind: 'cold-fold',
        key: '__sidebar_cold_fold__',
        count: coldFoldCount,
        expanded: coldFoldExpanded,
      });
    }

    return entries;
  }, [
    useUnitMode,
    displayedUnitBuckets,
    displayedSessionTree,
    groupBy,
    foldsSuspended,
    collapsedGroups,
    expandedGroups,
    expandedSessionGroups,
    workspaceById,
    seen,
    seenV2,
    activeSessionId,
    currentSpaceKey,
    activeRouteSpaceKey,
    coldFoldCount,
    coldFoldExpanded,
  ]);

  // Always one virtualized Sessions tree — eliminates the 60-row unmount/remount cliff.
  const listWindowed = !isCollapsed && !search.active && activeSidebarMode === 'sessions';
  const virtualAnchorRef = useRef<HTMLDivElement | null>(null);
  const [listScrollMargin, setListScrollMargin] = useState(0);
  const [measuredViewportHeight, setMeasuredViewportHeight] = useState(0);
  useLayoutEffect(() => {
    if (!listWindowed) return;
    const anchor = virtualAnchorRef.current;
    const scroller = listRef.current;
    if (anchor === null || scroller === null) return;
    const measure = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (anchorRect.height === 0 && scrollerRect.height === 0) return;
      const next = Math.max(0, Math.round(anchorRect.top - scrollerRect.top + scroller.scrollTop));
      setListScrollMargin((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    const observePrecedingSiblings = () => {
      observer.disconnect();
      observer.observe(scroller);
      const parent = anchor.parentElement;
      if (parent !== null && parent !== scroller) observer.observe(parent);
      // Dynamic content above the virtualized list (such as the expandable
      // Persona section, filters, or ephemeral group) shifts `anchor.top`
      // without changing `scroller.clientHeight`, so observe every preceding
      // sibling inside the scroll container.
      let child: Element | null = (parent ?? scroller).firstElementChild;
      while (child !== null && child !== anchor) {
        observer.observe(child);
        child = child.nextElementSibling;
      }
    };
    observePrecedingSiblings();
    const mutation = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => {
        observePrecedingSiblings();
        measure();
      });
    mutation?.observe(anchor.parentElement ?? scroller, { childList: true });
    return () => {
      mutation?.disconnect();
      observer.disconnect();
    };
  }, [listWindowed, ephemeralSessions.length, filterChips.length]);

  const stickyHeaderIndices = useMemo(() => {
    if (groupBy !== 'workspace') return [];
    const indices: number[] = [];
    for (let i = 0; i < flatSessionEntries.length; i += 1) {
      if (flatSessionEntries[i]?.kind === 'ws-header') indices.push(i);
    }
    return indices;
  }, [flatSessionEntries, groupBy]);

  const activeStickyIndexRef = useRef<number | null>(null);
  const extractVirtualRange = useCallback((range: Range) => {
    if (stickyHeaderIndices.length === 0) {
      activeStickyIndexRef.current = null;
      return defaultRangeExtractor(range);
    }
    let active: number | null = null;
    for (let i = stickyHeaderIndices.length - 1; i >= 0; i -= 1) {
      const idx = stickyHeaderIndices[i]!;
      if (idx <= range.startIndex) {
        active = idx;
        break;
      }
    }
    activeStickyIndexRef.current = active;
    const base = defaultRangeExtractor(range);
    if (active === null || base.includes(active)) return base;
    return [active, ...base];
  }, [stickyHeaderIndices]);

  const [demandErrorPresent, setDemandErrorPresent] = useState(false);
  const hasLoaderRow = hasAnyMoreSessions || demandErrorPresent;
  const virtualCount = listWindowed ? flatSessionEntries.length + (hasLoaderRow ? 1 : 0) : 0;

  const listVirtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => listRef.current,
    rangeExtractor: extractVirtualRange,
    estimateSize: (index) => {
      const entry = flatSessionEntries[index];
      if (entry === undefined) return 36;
      if (entry.kind === 'ws-header') return entry.isFirst ? 28 : (entry.collapsed ? 30 : 40);
      if (entry.kind === 'time-header') return entry.isFirst ? 28 : 40;
      if (entry.kind === 'session-group-header') return 34;
      if (entry.kind === 'session-group-more') return 30;
      if (entry.kind === 'group-more' || entry.kind === 'cold-fold') return 32;
      return entry.nested ? 34 : 46;
    },
    getItemKey: (index) => flatSessionEntries[index]?.key ?? '__sidebar_load_more__',
    overscan: 8,
    scrollMargin: listScrollMargin,
    initialRect: { width: 260, height: 640 },
    measureElement: (element, _entry, instance) => {
      const height = Math.round(element.getBoundingClientRect().height);
      return height > 0 ? height : instance.options.estimateSize(Number(element.getAttribute('data-index') ?? 0));
    },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) {
          setMeasuredViewportHeight((prev) => (prev === height ? prev : height));
          cb({ width, height });
        }
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    useFlushSync: false,
  });

  const virtualItems = listWindowed ? listVirtualizer.getVirtualItems() : [];
  const lastVirtualIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1]!.index : -1;
  const totalVirtualSize = listWindowed ? listVirtualizer.getTotalSize() : 0;
  const visibleContentHeight = hasLoaderRow ? Math.max(0, totalVirtualSize - 40) : totalVirtualSize;
  const isFetchingAnyNext =
    sessionsQuery.isFetchingNextPage === true
    || (loadingMoreSpaces !== undefined && loadingMoreSpaces.size > 0);

  const infiniteDemand = useSidebarInfiniteDemand({
    active: listWindowed && inert !== true,
    queryGeneration: `${sidebarQueryGeneration ?? scopeId}|${spaceScope}|${groupBy}|${sortBy}`,
    measuredViewportHeight,
    visibleContentHeight,
    overscanPx: 8 * 46,
    scrollTop: scrollTopRef.current,
    lastVirtualIndex,
    contentRowCount: flatSessionEntries.length,
    target: demandTarget,
    isFetchingNext: isFetchingAnyNext,
  });
  demandNotifyScrollRef.current = infiniteDemand.notifyScroll;
  useEffect(() => {
    const present = infiniteDemand.error !== null;
    setDemandErrorPresent((prev) => (prev === present ? prev : present));
  }, [infiniteDemand.error]);

  // Preserve the first surviving visible row's reading position when a live
  // promotion or reorder shifts rows above the current viewport.
  const prevEntryKeysRef = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    const scroller = listRef.current;
    const prevKeys = prevEntryKeysRef.current;
    const nextKeys = flatSessionEntries.map((entry) => entry.key);
    prevEntryKeysRef.current = nextKeys;
    if (!listWindowed || scroller === null || scroller.scrollTop <= 0) {
      visibleAnchorRef.current = null;
      return;
    }
    const anchor = visibleAnchorRef.current;
    if (anchor !== null && prevKeys.length > 0) {
      const oldIdx = prevKeys.indexOf(anchor.key);
      const newIdx = nextKeys.indexOf(anchor.key);
      if (oldIdx >= 0 && newIdx >= 0 && newIdx !== oldIdx) {
        const newMetric = listVirtualizer.measurementsCache[newIdx];
        if (newMetric !== undefined) {
          const targetTop = Math.max(0, Math.round(newMetric.start + anchor.offsetInRow));
          if (Math.abs(targetTop - scroller.scrollTop) > 1) {
            scroller.scrollTop = targetTop;
            scrollTopRef.current = targetTop;
          }
        }
      }
    }
    // Capture the first visible row after settling so the next reorder anchors cleanly.
    const currentTop = scroller.scrollTop;
    for (const vItem of listVirtualizer.getVirtualItems()) {
      const entry = flatSessionEntries[vItem.index];
      if (entry === undefined) continue;
      if (vItem.end > currentTop) {
        visibleAnchorRef.current = { key: entry.key, offsetInRow: currentTop - vItem.start };
        break;
      }
    }
  }, [flatSessionEntries, listWindowed, listVirtualizer]);

  const handleLoadMoreGroupMembers = useCallback((groupId: string, targetSpaceKey: string, cursor: string) => {
    void onLoadMoreGroupMembers?.(groupId, targetSpaceKey, cursor);
  }, [onLoadMoreGroupMembers]);

  // Bound once per render so the kind narrowing survives into the menu's
  // callbacks (property-access narrowing does not reach into closures).
  const menuItem = menu?.item ?? null;

  if (isCollapsed) {
    // The rail owns no session list: picking a thread stays one click away
    // (expand the sidebar, or open any session from a scoped page), so the
    // column keeps only the destinations. The resizer goes too — 56px is not
    // draggable.
    return (
      <aside
        id={id}
        inert={inert}
        className={className ?? 'app-sidebar'}
        style={{ '--kiki-sidebar-width': '56px' } as React.CSSProperties}
        data-session-sidebar
        data-sidebar-collapsed="true"
        aria-label={t('sidebar.navAria')}
      >
        <CollapsedSidebarRail
          activeSessionId={activeSessionId}
          reachableSessionId={reachableSessionId}
          activeWorkspaceId={activeWorkspaceId}
          onNewSession={onNewSession}
          offscreen={inert === true}
        />
      </aside>
    );
  }

  return (
    <aside
      id={id}
      inert={inert}
      className={className ?? 'app-sidebar'}
      style={dockedInPanelGroup ? undefined : ({ '--kiki-sidebar-width': `${sidebarWidthValue}px` } as React.CSSProperties)}
      data-session-sidebar
      aria-label={t('sidebar.navAria')}
    >
      {dockedInPanelGroup ? null : (
        <div
          data-sidebar-resizer
          className="app-sidebar__resizer hidden md:block"
          aria-hidden
          title={t('sidebar.resizeAria')}
          onPointerDown={startResize}
          onDoubleClick={reset}
        />
      )}
      {/* Wordmark row doubles as the utility row: search and activity are two
          quiet icons, so the vertical space a permanent search field used to
          take belongs to the session list. The wordmark itself is the space
          menu (§6.4) and carries the current space's color and name. */}
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2.5 pl-[18px]">
        <div className="min-w-0 flex-1"><SpaceScopeControl healthBySpace={healthBySpace} /></div>
        <button
          type="button"
          data-search-toggle
          aria-expanded={searchOpen}
          aria-label={t('sidebar.searchAria')}
          title={t('sidebar.searchHint')}
          onClick={() => {
            const next = !searchOpen;
            setSearchOpen(next);
            if (next) window.setTimeout(() => { searchRef.current?.focus(); }, 0);
            else setSearchInput('');
          }}
          className={HEADER_ICON}
        >
          <Icon name="search" size={16} />
        </button>
        <button
          type="button"
          data-nav-activity
          aria-label={activityLabel}
          aria-current={location.pathname === '/activity' ? 'page' : undefined}
          title={activityLabel}
          onClick={() => { void navigate('/activity'); }}
          className={`relative ${HEADER_ICON}`}
        >
          <Icon name="bell" size={16} />
        </button>
        {onClose !== undefined ? (
          // The phone drawer's exit sits in the thumb's top-left arc, beside
          // the utilities; the browser back closes the layer too (App wires
          // the history entry).
          <button
            type="button"
            aria-label={t('app.closeSidebar')}
            onClick={onClose}
            className={`${HEADER_ICON} md:hidden`}
          >
            <Icon name="close" size={16} />
          </button>
        ) : null}
      </div>

      <div className="space-y-1 px-2.5 pb-2">
        <button
          type="button"
          data-new-session
          onClick={onNewSession}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-normal text-ink transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.045] pointer-coarse:h-11"
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent-ink"><Icon name="plus" size={12} /></span>
          <span className="min-w-0 flex-1 truncate">{t('sidebar.newSession')}</span>
        </button>
        {searchOpen ? (
        <div>
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint">
            <Icon name="search" size={14} />
          </span>
          <input
            ref={searchRef}
            type="text"
            value={searchInput}
            data-search-box
            role="combobox"
            aria-expanded={search.active}
            aria-controls="sidebar-search-results"
            aria-activedescendant={activeKey === undefined ? undefined : `sidebar-result-${activeKey}`}
            onChange={(event) => { setSearchInput(event.target.value); }}
            onKeyDown={(event) => {
              // Enter, Escape and the arrows belong to an open IME candidate
              // window: picking a candidate must not open a result.
              if (isImeKeyEvent(event)) return;
              // Escape collapses the field again, back to the icon.
              if (event.key === 'Escape' && searchInput === '') {
                setSearchOpen(false);
                return;
              }
              onSearchKeyDown(event);
            }}
            placeholder={t('sidebar.searchPlaceholder')}
            title={t('sidebar.searchHint')}
            aria-label={t('sidebar.searchAria')}
            className="h-8 w-full rounded-lg border border-transparent bg-transparent pr-7 pl-7 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-ink/[0.04] focus:border-hairline-strong focus:bg-paper focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:pr-10 pointer-coarse:text-[16px]"
          />
          {searchInput === '' ? (
            <kbd aria-hidden className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-hairline px-1 font-sans text-[11px] leading-4 text-ink-faint pointer-coarse:hidden">/</kbd>
          ) : (
            <button
              type="button"
              aria-label={t('sidebar.clearSearch')}
              onClick={() => { setSearchInput(''); searchRef.current?.focus(); }}
              className="absolute top-1/2 right-0.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-faint transition-colors hover:bg-hairline hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11"
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
        </div>
        ) : null}
      </div>

      <PrimaryNav
        activeSessionId={activeSessionId}
        reachableSessionId={reachableSessionId}
        activeWorkspaceId={activeWorkspaceId}
        badges={navBadges}
        offscreen={inert === true}
        onCloseSidebar={onClose}
      />

      {!search.active ? (
        <SidebarModeSwitch
          mode={activeSidebarMode}
          onChange={(nextMode) => {
            if (nextMode !== 'sessions') setOpenMenu(null);
            writeLayoutPreferences({ sidebarMode: nextMode });
          }}
          needsYouCount={badgeNeedsYou}
          unreadCount={badgeUnread}
          total={badgeTotal}
          actions={activeSidebarMode === 'sessions' ? (
            <>
              {counts.running > 0 ? (
                <button
                  type="button"
                  data-status-shortcut="running"
                  data-activity-summary
                  aria-pressed={filters.status.includes('running')}
                  aria-label={tp('sidebar.runningCount', counts.running)}
                  title={tp('sidebar.runningCount', counts.running)}
                  onClick={() => { toggleStatus('running'); }}
                  className="hidden h-6 shrink-0 items-center gap-1 rounded-md px-1 text-[11.5px] text-ink-soft tabular-nums transition-colors hover:bg-ink/[0.05] hover:text-ink aria-pressed:bg-ink/[0.06] aria-pressed:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:px-2 @[215px]:flex"
                >
                  <LifeMark markId="sidebar:running" life="working" className="h-1.5 w-1.5" />
                  <span>{counts.running}</span>
                </button>
              ) : null}
              {workspaceGroupKeys.length > 1 && !foldsSuspended ? (
                <button
                  type="button"
                  data-session-groups-fold-all={allFolded ? 'expand' : 'collapse'}
                  aria-label={allFolded ? t('sidebar.expandAllGroups') : t('sidebar.collapseAllGroups')}
                  title={allFolded ? t('sidebar.expandAllGroups') : t('sidebar.collapseAllGroups')}
                  onClick={() => { setAllGroupsCollapsed(workspaceGroupKeys, !allFolded); }}
                  className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-11 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink @[215px]:flex"
                >
                  <Icon name={allFolded ? 'expand' : 'collapse'} size={14} />
                </button>
              ) : null}
              <button
                type="button"
                ref={filterMenuButtonRef}
                data-filter-menu-toggle
                aria-haspopup="menu"
                aria-expanded={openMenu === 'filter'}
                aria-label={t('sidebar.filterMenu')}
                title={t('sidebar.filterMenu')}
                onClick={() => { setOpenMenu((open) => (open === 'filter' ? null : 'filter')); }}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-11 transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink ${filtersActive ? 'text-selected-ink' : 'text-ink-faint'}`}
              >
                <Icon name="filter" size={14} />
              </button>
              <button
                type="button"
                ref={viewMenuButtonRef}
                data-view-menu-toggle
                aria-haspopup="menu"
                aria-expanded={openMenu === 'view'}
                aria-label={t('sidebar.viewMenu')}
                title={t('sidebar.viewMenu')}
                onClick={() => { setOpenMenu((open) => (open === 'view' ? null : 'view')); }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-11 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink"
              >
                <Icon name="sliders" size={14} />
              </button>
            </>
          ) : undefined}
        />
      ) : null}

      {search.active ? (
        <>
          {filterChips.length > 0 ? (
            <div data-sidebar-filters aria-label={t('sidebar.filtersAria')} className="flex flex-wrap items-center gap-1 px-3 pt-1 pb-1.5">
              {filterChips.map((chip) => (
                <FilterChip
                  key={chip.key}
                  kind={chip.key.split(':')[0] ?? chip.key}
                  label={chip.label}
                  clearLabel={t('sidebar.clearFilter', { label: chip.label })}
                  openLabel={t('sidebar.filterMenu')}
                  onOpen={() => { setOpenMenu('filter'); }}
                  onClear={chip.clear}
                />
              ))}
              {filterChips.length > 1 ? (
                <button
                  type="button"
                  data-sidebar-filters-clear-all
                  onClick={() => { onFiltersChange({ status: [], workspaces: [], archived: 'hide' }); }}
                  className="h-6 rounded px-1 text-[11.5px] text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline"
                >
                  {t('sidebar.clearAllFilters')}
                </button>
              ) : null}
            </div>
          ) : null}
          <SearchResults
            search={search}
            personas={matchingPersonas}
            filtersActive={filtersActive}
            activeKey={activeKey}
            onHover={(key) => {
              const entry = resultsByKey.get(key);
              if (entry !== undefined) setActiveResult(entry.index);
            }}
            onOpen={(key) => { resultsByKey.get(key)?.open(); }}
            onContextMenuSession={(session, x, y) => {
              const targetSpaceKey = remoteSearchSpaceBySessionId.get(session.id) ?? currentSpaceKey;
              const isRemote = targetSpaceKey.startsWith('remote:');
              const baseHref = `/s/${encodeURIComponent(session.id)}`;
              setMenu({
                item: {
                  kind: 'session',
                  key: `session:${session.id}`,
                  id: session.id,
                  title: session.title,
                  href: isRemote ? placeHrefForSpaceKey(targetSpaceKey, baseHref) : baseHref,
                  session,
                  spaceKey: targetSpaceKey,
                  isRemote,
                } as ConversationListItem,
                x,
                y,
              });
            }}
            workspaceNames={workspaceNameById}
          />
        </>
      ) : activeSidebarMode === 'inbox' ? (
      <div
        ref={listRef}
        onScroll={onListScroll}
        data-session-list-scrolled={listScrolled ? 'true' : undefined}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pt-1 pb-2"
        data-session-list
        role="region"
        aria-label={t('sidebar.inbox.aria')}
      >
        <SidebarInboxView
          inbox={unifiedInbox}
          activeConversationKey={activeConversationKey}
          showSpaceLabel={spaceScope === ALL_SPACE_SCOPE && hasMultipleSpaces}
          healthBySpace={healthBySpace}
          untitled={untitled}
          resolveTitle={resolveTitle}
          activeShortcutsEnabled={inert !== true && !isCollapsed && !search.active}
          onOpenItem={openInboxItem}
          onContextMenuItem={(inboxItem, x, y) => {
            if (inboxItem.ref.kind === 'room') {
              const foundRoom = sessionGroups
                .flatMap((g) => g.items)
                .find((candidate): candidate is Extract<ConversationListItem, { kind: 'room' }> =>
                  candidate.kind === 'room' && candidate.id === inboxItem.ref.id)
                ?? sidebarUnitBuckets
                  ?.flatMap((b) => b.items)
                  .find((candidate): candidate is Extract<ConversationListItem, { kind: 'room' }> =>
                    candidate.kind === 'room' && candidate.id === inboxItem.ref.id);
              if (foundRoom !== undefined) {
                setMenu({ item: foundRoom, x, y });
              }
              return;
            }
            const foundSession =
              sessions.find((s) => s.id === inboxItem.ref.id) ??
              personaSessions?.find((s) => s.id === inboxItem.ref.id) ??
              multiSpaceSources?.flatMap((source) => source.sessions).find((s) => s.id === inboxItem.ref.id);
            if (foundSession === undefined) return;
            const isRemote = inboxItem.isRemote;
            const baseHref = `/s/${encodeURIComponent(foundSession.id)}`;
            setMenu({
              item: {
                kind: 'session',
                key: `session:${foundSession.id}`,
                id: foundSession.id,
                title: foundSession.title,
                href: isRemote ? placeHrefForSpaceKey(inboxItem.spaceKey, baseHref) : baseHref,
                session: foundSession,
                spaceKey: inboxItem.spaceKey,
                isRemote,
              } as ConversationListItem,
              x,
              y,
            });
          }}
          onSettleItem={inboxTriage.settleItem}
          onSnoozeItem={inboxTriage.snoozeItem}
          onArchiveItem={inboxTriage.archiveItem}
          onRestoreItem={inboxTriage.restoreItem}
          onUndo={inboxTriage.undoLast}
          onRecoverAllInterrupted={handleRecoverAllInterrupted}
          recoveringInterrupted={recoveringInterrupted}
        />
      </div>
      ) : (
      <div
        ref={listRef}
        onScroll={onListScroll}
        data-session-list-scrolled={listScrolled ? 'true' : undefined}
        className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-1.5 pb-2"
        data-session-list
        role="region"
        aria-label={t('sidebar.listAria')}
      >
        <SidebarPersonaSection sessions={personaSessions ?? sessions} activeSessionId={activeSessionId} seen={seen} workspaceOptions={workspaceOptions} rooms={rooms} />

        {filterChips.length > 0 ? (
          <div data-sidebar-filters aria-label={t('sidebar.filtersAria')} className="flex flex-wrap items-center gap-1 px-1 pb-1.5">
            {filterChips.map((chip) => (
              <FilterChip
                key={chip.key}
                kind={chip.key.split(':')[0] ?? chip.key}
                label={chip.label}
                clearLabel={t('sidebar.clearFilter', { label: chip.label })}
                openLabel={t('sidebar.filterMenu')}
                onOpen={() => { setOpenMenu('filter'); }}
                onClear={chip.clear}
              />
            ))}
            {filterChips.length > 1 ? (
              <button
                type="button"
                data-sidebar-filters-clear-all
                onClick={() => { onFiltersChange({ status: [], workspaces: [], archived: 'hide' }); }}
                className="h-6 rounded px-1 text-[11.5px] text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                {t('sidebar.clearAllFilters')}
              </button>
            ) : null}
          </div>
        ) : null}
        {sessionsQuery.isLoading && sessions.length === 0 ? (
          <div className="flex items-center gap-2 px-2 pt-4 text-[12.5px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-faint" />
            {t('sidebar.loadingSessions')}
          </div>
        ) : null}
        {sessionsQuery.isError ? (
          <p className="mx-2 mt-2 text-[12px] leading-5 text-ink-soft" data-sessions-error>
            {`${t('sidebar.loadFailed')} · `}
            {errorText(locale, sessionsQuery.error)}
            {' · '}
            <button
              type="button"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['sessions'] })}
              className="font-normal text-ink underline underline-offset-2"
            >
              {t('common.retry')}
            </button>
          </p>
        ) : null}
        {roomsQuery?.isError === true ? (
          <p className="mx-2 mt-2 text-[12px] leading-5 text-ink-soft" data-rooms-error>
            {t('sidebar.roomsLoadFailed')}
            {' · '}
            <button
              type="button"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY })}
              className="font-normal text-ink underline underline-offset-2"
            >
              {t('common.retry')}
            </button>
          </p>
        ) : null}
        {!hasDisplayBuckets && !sessionsQuery.isLoading && !sessionsQuery.isError ? (
          <div className="px-2 pt-4" data-sidebar-empty>
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              {filtersActive ? t('sidebar.noFilterMatches') : t('sidebar.noSessions')}
            </p>
            {filtersActive ? (
              <button
                type="button"
                onClick={() => { onFiltersChange({ status: [], workspaces: [], archived: 'hide' }); }}
                className="mt-1 text-[12px] font-normal text-ink underline underline-offset-2"
              >
                {t('sidebar.clearAllFilters')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { setFilters({ archived: 'include' }); }}
                className="mt-1 text-[12px] font-normal text-ink underline underline-offset-2"
              >
                {t('sidebar.emptyShowArchived')}
              </button>
            )}
          </div>
        ) : null}
        {actionError !== null ? (
          <p role="alert" className="mx-1 mb-1 border-l-2 border-danger py-0.5 pl-2 text-[12px] text-danger">
            {actionError}
          </p>
        ) : null}
        {actionNotice !== null ? (
          <p role="status" className="mx-1 mb-1 border-l-2 border-success py-0.5 pl-2 text-[12px] text-ink-soft">
            {actionNotice}
          </p>
        ) : null}
        {selected.size > 0 ? (
          <div data-session-selection role="status"
            className="sticky top-0 z-[2] mb-1 flex min-h-9 items-center gap-1.5 rounded-lg bg-panel px-2 text-[12.5px] text-ink shadow-[var(--kiki-sheet-shadow)]">
            <span className="min-w-0 flex-1 truncate font-normal tabular-nums">{t('room.selectionCount', { count: selected.size })}</span>
            <button type="button" data-session-selection-room
              disabled={threadCommsEnabled === false || selected.size < 2}
              title={threadCommsEnabled === false ? t('room.commsOff') : selected.size < 2 ? t('room.threadsNeeded') : undefined}
              onClick={() => { setRoomDraft(sessions.filter((item) => selected.has(item.id))); }}
              className="h-7 shrink-0 rounded-md px-2 font-normal transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-55">
              {t('room.fromThreads')}
            </button>
            <button type="button" data-session-selection-clear aria-label={t('room.clearSelection')} title={t('room.clearSelection')}
              onClick={() => { setSelected(new Set()); }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-11 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
              <Icon name="close" size={12} />
            </button>
          </div>
        ) : null}
        {ephemeralSessions.length > 0 ? (
          <div
            data-session-group-block="ephemeral"
            className="mb-3 flex flex-col gap-0.5"
            role="group"
            aria-label={t('ephemeral.group')}
          >
            <p data-session-group="ephemeral" className="flex min-h-7 w-full shrink-0 items-center gap-2 px-2 py-1.5 text-left text-[12px] leading-4 font-normal text-section-ink">
              <span className="min-w-0 truncate">{t('ephemeral.group')}</span>
            </p>
            {ephemeralSessions.map((session) => (
              <div key={session.id} data-session-node="root" data-session-ephemeral>
                <SessionRow
                  session={session}
                  active={session.id === activeSessionId}
                  menuOpen={false}
                  untitled={untitled}
                  resolveTitle={resolveTitle}
                  activity={activity.byId.get(session.id)}
                  anchorFor={activity.anchorFor}
                  showLocation
                  temporary
                  onOpen={() => { openSessionRow(session); }}
                  onMenu={() => undefined}
                  onTogglePin={() => undefined}
                  seenSeq={seen[session.id] ?? 0}
                />
              </div>
            ))}
            {/* The window carried the newest temporary sessions; the rest are one
                page away, read on request into the same list and order. */}
            {ephemeralQuery.hasNextPage ? (
              <button
                type="button"
                data-session-ephemeral-load-more
                disabled={ephemeralQuery.isFetchingNextPage}
                onClick={() => void ephemeralQuery.fetchNextPage?.()}
                className="mt-1 h-8 w-full rounded-lg px-2 text-center text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink-soft disabled:opacity-60"
              >
                {ephemeralQuery.isFetchingNextPage ? t('sidebar.loadingMore') : t('sidebar.loadMore')}
              </button>
            ) : null}
            {ephemeralQuery.isError ? (
              <p role="alert" data-session-ephemeral-load-error className="px-2 py-1 text-[12px] text-danger">
                {ephemeralQuery.error?.message ?? t('common.unknownError')}
              </p>
            ) : null}
          </div>
        ) : null}
        {listWindowed ? (
          <div
            ref={virtualAnchorRef}
            data-session-list-virtualized="true"
            className="relative"
            style={{ height: totalVirtualSize }}
          >
            {virtualItems.map((virtualRow) => {
              const isLoaderRow = virtualRow.index >= flatSessionEntries.length;
              if (isLoaderRow) {
                return (
                  <div
                    key="__sidebar_load_more__"
                    data-index={virtualRow.index}
                    ref={listVirtualizer.measureElement}
                    className="absolute inset-x-0 top-0"
                    style={{ transform: `translateY(${virtualRow.start - listScrollMargin}px)` }}
                  >
                    <SidebarLoadMoreRow
                      hasMore={hasAnyMoreSessions}
                      isFetching={infiniteDemand.isFetching}
                      error={infiniteDemand.error}
                      onLoadMore={() => { infiniteDemand.requestNextPage('manual'); }}
                      onRetry={() => { infiniteDemand.requestNextPage('retry'); }}
                    />
                  </div>
                );
              }
              const entry = flatSessionEntries[virtualRow.index];
              if (entry === undefined) return null;
              const scrollOffset = listVirtualizer.scrollOffset ?? 0;
              const isActiveSticky = entry.kind === 'ws-header'
                && virtualRow.index === activeStickyIndexRef.current
                && scrollOffset > virtualRow.start;
              let stickyPushY = 0;
              if (isActiveSticky) {
                const pos = stickyHeaderIndices.indexOf(virtualRow.index);
                const nextHeaderIdx = pos >= 0 ? stickyHeaderIndices[pos + 1] : undefined;
                if (nextHeaderIdx !== undefined) {
                  const nextMetric = listVirtualizer.measurementsCache[nextHeaderIdx];
                  if (nextMetric !== undefined) {
                    const overlap = nextMetric.start - scrollOffset - virtualRow.size;
                    if (overlap < 0) stickyPushY = overlap;
                  }
                }
              }
              let content: React.ReactNode;
              if (entry.kind === 'ws-header') {
                content = (
                  <div
                    id={bucketHeaderDomId(entry.group.key)}
                    role="group"
                    aria-label={entry.group.label}
                    data-session-group-block={entry.group.key}
                    data-session-group-folded={entry.collapsed ? '' : undefined}
                    className={isActiveSticky || entry.isFirst ? '' : entry.collapsed ? 'pt-0.5' : 'pt-3'}
                  >
                    <WorkspaceGroupHeader
                      groupKey={entry.group.key}
                      label={entry.group.label}
                      count={entry.group.total}
                      totalCount={filtersActive ? (entry.group.key === 'pinned' ? pinnedTotal : workspaceTotals.get(entry.group.key)) : undefined}
                      collapsed={entry.collapsed}
                      foldable={!foldsSuspended}
                      current={entry.group.key === activeWorkspaceId}
                      foldedLife={entry.foldedLife}
                      workspace={entry.workspace}
                      pinBusy={workspacePinBusy}
                      onToggle={() => { toggleGroupCollapsed(entry.group.key); }}
                      onTogglePin={entry.workspace === undefined ? undefined : () => { toggleWorkspacePin(entry.workspace!); }}
                      onNewInWorkspace={entry.workspaceTarget === undefined ? undefined : () => {
                        void navigate(`/new?workspace=${encodeURIComponent(entry.workspaceTarget!.id)}`);
                      }}
                    />
                  </div>
                );
              } else if (entry.kind === 'time-header') {
                content = (
                  <div
                    id={bucketHeaderDomId(entry.group.key)}
                    role="group"
                    aria-label={entry.group.label}
                    data-session-group-block={entry.group.key}
                    className={entry.isFirst ? '' : 'pt-3'}
                  >
                    <p data-session-group={entry.group.key} className="flex min-h-7 w-full shrink-0 items-center gap-2 px-2 py-1.5 text-left text-[12px] leading-4 font-normal text-section-ink">
                      <span className="min-w-0 truncate">{entry.group.label}</span>
                    </p>
                  </div>
                );
              } else if (entry.kind === 'session-group-header') {
                const rawTitle = entry.unitGroup.title.trim() !== '' ? entry.unitGroup.title : untitled;
                const displayTitle = rawTitle.includes('[[') || rawTitle.includes('/s/') ? resolveTitle(rawTitle) : rawTitle;
                content = (
                  <div
                    data-session-group-key={entry.groupKey}
                    aria-labelledby={groupBy === 'none' && entry.groupKey === 'all' ? undefined : bucketHeaderDomId(entry.groupKey)}
                  >
                    <SessionGroupHeaderRow
                      group={entry.unitGroup}
                      title={displayTitle}
                      expanded={entry.expanded}
                      hasActiveMember={entry.hasActiveMember}
                      collapsedLife={entry.collapsedLife}
                      showPin={groupBy === 'none'}
                      onToggle={toggleSessionGroupExpanded}
                    />
                  </div>
                );
              } else if (entry.kind === 'session-group-more') {
                content = (
                  <div
                    data-session-group-key={entry.groupKey}
                    aria-labelledby={groupBy === 'none' && entry.groupKey === 'all' ? undefined : bucketHeaderDomId(entry.groupKey)}
                  >
                    <SessionGroupMoreRow
                      groupId={entry.groupId}
                      spaceKey={entry.spaceKey}
                      cursor={entry.cursor}
                      remaining={entry.remaining}
                      loading={loadingGroupIds?.has(entry.groupId) === true}
                      error={groupMemberErrors?.get(entry.groupId)}
                      onLoadMore={handleLoadMoreGroupMembers}
                    />
                  </div>
                );
              } else if (entry.kind === 'group-more') {
                content = (
                  <div className="pt-0.5" data-session-group-key={entry.groupKey}>
                    <button
                      type="button"
                      data-session-group-more={entry.groupKey}
                      onClick={() => { toggleGroupExpanded(entry.groupKey); }}
                      className="row-interactive h-7 self-start pr-2 pl-6 text-[12px] text-ink-faint hover:text-ink"
                    >
                      {entry.hidden > 0 ? t('sidebar.showMoreInGroup', { count: entry.hidden }) : t('sidebar.showLessInGroup')}
                    </button>
                  </div>
                );
              } else if (entry.kind === 'cold-fold') {
                content = (
                  <div className="pt-1" data-sidebar-cold-fold-wrap>
                    <button
                      type="button"
                      data-sidebar-cold-fold={entry.expanded ? 'expanded' : 'collapsed'}
                      aria-expanded={entry.expanded}
                      onClick={() => { setColdFoldExpanded((v) => !v); }}
                      className="row-interactive flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] font-normal text-ink-faint hover:text-ink"
                    >
                      <DisclosureChevron open={entry.expanded} size={12} className="shrink-0" />
                      <span className="truncate">
                        {entry.expanded
                          ? t('sidebar.coldFold.collapse')
                          : t('sidebar.coldFold.label', { count: entry.count })}
                      </span>
                    </button>
                  </div>
                );
              } else {
                const { item, relation, nested, legacyParentId, unitGroupId, groupNamesWorkspace, groupKey } = entry;
                const bucketLabelId = groupBy === 'none' && groupKey === 'all' ? undefined : bucketHeaderDomId(groupKey);
                if (item.kind === 'room') {
                  const rowSpaceKey = item.spaceKey ?? currentSpaceKey;
                  const roomLocation = workspaceNameById.get(item.workspace_id)
                    ?? (item.room.workspace === '' ? undefined : shortCwd(item.room.workspace));
                  const remoteSpaceName = item.isRemote === true && spaceScope === ALL_SPACE_SCOPE ? item.spaceName : undefined;
                  const remoteOffline = item.isRemote === true && healthBySpace?.get(rowSpaceKey)?.state === 'offline';
                  content = (
                    <div
                      data-session-node="root"
                      data-session-group-key={groupKey}
                      aria-labelledby={bucketLabelId}
                      className="py-px"
                    >
                      <RoomConversationRow
                        item={item}
                        active={location.pathname === item.href}
                        menuOpen={menu?.item.key === item.key}
                        showLocation={!groupNamesWorkspace}
                        showPin={groupBy === 'none'}
                        location={roomLocation}
                        remoteSpaceName={remoteSpaceName}
                        remoteOffline={remoteOffline}
                        onOpen={() => { openRoomRow(item.room, item.href, rowSpaceKey); }}
                        onMenu={(x, y, toggle) => {
                          setMenu((current) =>
                            toggle && current?.item.key === item.key ? null : { item, x, y });
                        }}
                        onTogglePin={() => { toggleRoomPin(item); }}
                        justRenamed={justRenamed?.key === item.key}
                        archiving={pendingArchives.has(item.key)}
                        archiveError={archiveErrors.get(item.key)}
                      />
                    </div>
                  );
                } else {
                  const session = item.session;
                  const rowSpaceKey = item.spaceKey ?? currentSpaceKey;
                  const isRemoteRow = item.isRemote === true;
                  const rowSeenSeq = isRemoteRow
                    ? (seenV2[encodeConversationRef({ spaceKey: rowSpaceKey, kind: 'session', id: session.id })]?.seq ?? 0)
                    : (seen[session.id] ?? 0);
                  const remoteSpaceName = isRemoteRow && spaceScope === ALL_SPACE_SCOPE ? item.spaceName : undefined;
                  const remoteOffline = isRemoteRow && healthBySpace?.get(rowSpaceKey)?.state === 'offline';
                  const memberShowPin = groupBy === 'none' || unitGroupId !== undefined;
                  content = (
                    <div
                      data-session-node={nested ? 'thread' : 'root'}
                      data-session-group-key={groupKey}
                      data-session-threads={legacyParentId}
                      data-sidebar-unit-group-member={unitGroupId}
                      aria-labelledby={bucketLabelId}
                      className="relative py-px"
                    >
                      {unitGroupId !== undefined ? (
                        <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 left-[13px] w-px bg-hairline" />
                      ) : null}
                      <SessionRow
                        session={session}
                        active={session.id === activeSessionId && rowSpaceKey === activeRouteSpaceKey}
                        menuOpen={menu?.item.key === item.key}
                        untitled={untitled}
                        resolveTitle={resolveTitle}
                        activity={isRemoteRow ? undefined : activity.byId.get(session.id)}
                        anchorFor={activity.anchorFor}
                        relation={relation}
                        nested={nested}
                        showLocation={!groupNamesWorkspace}
                        showPin={memberShowPin}
                        remoteSpaceName={remoteSpaceName}
                        remoteOffline={remoteOffline}
                        parentTitle={relation === undefined
                          ? undefined
                          : titleOf.get(relation.parentId) ?? t('sidebar.thread.unknownParent')}
                        onOpen={() => { openSessionRow(session, rowSpaceKey); }}
                        selected={!isRemoteRow && selected.has(session.id)}
                        onToggleSelect={isRemoteRow || session.archived === true || isSubagentSession(session) ? undefined : () => { toggleSelected(session); }}
                        onMenu={(x, y, toggle) => {
                          setMenu((current) =>
                            toggle && current?.item.key === item.key ? null : { item, x, y });
                        }}
                        onTogglePin={() => { togglePin(session, rowSpaceKey); }}
                        seenSeq={rowSeenSeq}
                        justRenamed={justRenamed?.key === item.key}
                        archiving={pendingArchives.has(item.key)}
                        archiveError={archiveErrors.get(item.key)}
                      />
                    </div>
                  );
                }
              }
              return (
                <div
                  key={entry.key}
                  data-index={virtualRow.index}
                  ref={isActiveSticky ? undefined : listVirtualizer.measureElement}
                  data-sticky-active={isActiveSticky ? '' : undefined}
                  className={isActiveSticky ? 'sticky top-0 z-[2] bg-canvas' : 'absolute inset-x-0 top-0'}
                  style={isActiveSticky
                    ? (stickyPushY < 0 ? { transform: `translateY(${stickyPushY}px)` } : undefined)
                    : { transform: `translateY(${virtualRow.start - listScrollMargin}px)` }}
                >
                  {content}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      )}

      {/* Footer: one row — Settings, then the connection while it is down,
        * then the collapse toggle (it keeps its place at the end whether or
        * not the connection words are there). The row never overlaps the
        * list above it: it is a flex sibling, not an overlay, and the list
        * keeps bottom padding for its last row. */}
      <div className="relative flex min-h-12 shrink-0 items-center gap-1 px-2.5 pointer-coarse:border-t pointer-coarse:border-hairline/70 pointer-coarse:py-1.5" data-sidebar-footer>
        <button
          type="button"
          data-nav-settings
          aria-current={location.pathname.startsWith('/settings') ? 'page' : undefined}
          onClick={() => { void navigate('/settings'); }}
          className={`row-interactive flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-left text-[13px] pointer-coarse:h-11 ${
            location.pathname.startsWith('/settings') ? 'text-ink' : 'text-ink-soft hover:text-ink'
          }`}
        >
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${location.pathname.startsWith('/settings') ? 'text-ink' : 'text-ink-faint'}`}><Icon name="settings" size={16} className={ICON} /></span>
          <span className="min-w-0 flex-1 truncate">{t('sidebar.settings')}</span>
        </button>
        {readDesktopOverride() || isPhone || isMobileAppShellUserAgent() ? (
          <button
            type="button"
            data-return-mobile-action
            onClick={() => {
              writeDesktopOverride(false);
              onClose?.();
              void navigate(activeSessionId !== undefined ? mobileChatPath('local', activeSessionId) : MOBILE_ASSISTANT_PATH);
            }}
            className="row-interactive flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-[12.5px] text-ink-soft hover:text-ink pointer-coarse:h-11"
          >
            <span>{t('mobile.desktop.returnMobile')}</span>
          </button>
        ) : null}
        <button
          type="button"
          data-sidebar-toggle="collapse"
          aria-label={t('sidebar.collapseSidebar')}
          title={t('sidebar.collapseSidebar')}
          onClick={() => { writeLayoutPreferences({ sidebarCollapsed: true }); }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink max-md:hidden"
        >
          <Icon name="collapse" size={16} />
        </button>
      </div>

      {openMenu === 'view' ? (
        <SidebarViewMenu
          anchor={viewMenuButtonRef}
          onClose={() => { setOpenMenu(null); }}
          groupBy={groupBy}
          onGroupBy={onGroupBy}
          sortBy={sortBy}
          onSortBy={onSortBy}
        />
      ) : null}
      {openMenu === 'filter' ? (
        <SidebarFilterMenu
          anchor={filterMenuButtonRef}
          onClose={() => { setOpenMenu(null); }}
          filters={filters}
          presentStatuses={presentStatuses}
          onToggleStatus={toggleStatus}
          onToggleWorkspace={toggleWorkspace}
          onArchived={(archived) => { setFilters({ archived }); }}
          onPrivate={(nextPrivate) => { setFilters({ private: nextPrivate }); }}
          workspaceOptions={workspaceOptions}
          workspacePinBusy={workspacePinBusy}
          onToggleWorkspacePin={toggleWorkspacePin}
          onManageWorkspaces={() => {
            setOpenMenu(null);
            void navigate('/settings/workspaces');
          }}
        />
      ) : null}
      {menuItem !== null && menuItem.kind === 'session' ? (
        <SessionContextMenu
          session={menuItem.session}
          copyLinkHref={menuItem.href}
          isRemote={menuItem.isRemote === true}
          title={resolveTitle(sessionLabel(menuItem.session, untitled))}
          topLevel={sidebarGroupsEnabled ? undefined : topLevelThreads.has(menuItem.id)}
          onToggleThreadDisplay={sidebarGroupsEnabled ? undefined : () => { toggleThreadDisplay(menuItem.id); }}
          extraTopEntries={sidebarGroupsEnabled && groupedSessionKeyToGroupId.has(menuItem.key) && menuItem.session.archived !== true
            ? [{
                key: 'detach-group',
                label: t('sidebar.group.detachMember'),
                run: () => detachGroupMember(menuItem.session, menuItem.spaceKey),
              }]
            : undefined}
          scopeId={scopeId}
          activeSessionId={activeSessionId}
          x={menu!.x}
          y={menu!.y}
          onClose={() => { setMenu(null); }}
          onRename={() => {
            setRenaming(menuItem);
            setMenu(null);
          }}
          onTogglePin={() => { togglePin(menuItem.session, menuItem.spaceKey); }}
          onTogglePrivate={() => { togglePrivate(menuItem.session, menuItem.spaceKey); }}
          onCreateBranch={(seed) => { runCreateBranch(menuItem.session, seed); }}
          onForkSession={(seed) => { runForkSession(menuItem.session, seed); }}
          onAction={(action) => { runAction(menuItem.session, action); }}
          onArchive={() => { archive(menuItem.session, menuItem.key, menuItem.spaceKey); }}
          onRestore={() => { restore(menuItem.session, menuItem.spaceKey); }}
          archiving={pendingArchives.has(menuItem.key)}
          privateBusy={pendingPrivacy.has(menuItem.id)}
          threadCommsEnabled={menuItem.isRemote === true ? false : threadCommsEnabled}
          onJoinRoom={() => {
            const ids = selected.has(menuItem.id) && selected.size >= 2 ? selected : new Set([menuItem.id]);
            setJoiningRoom(sessions.filter((item) => ids.has(item.id)));
            setMenu(null);
          }}
        />
      ) : null}
      {menuItem !== null && menuItem.kind === 'room' ? (
        <RoomListMenu
          item={menuItem}
          x={menu!.x}
          y={menu!.y}
          onClose={() => { setMenu(null); }}
          onTogglePin={(room) => { toggleRoomPin(room); }}
          onTogglePause={(room, paused) => { toggleRoomPause(room, paused); }}
          onRename={() => {
            setRenaming(menuItem);
            setMenu(null);
          }}
          onArchive={(room) => { archiveRoom(room, menuItem.key); }}
          onRestore={(room) => { patchRoom(room.id, { archived: false }); }}
          archiving={pendingArchives.has(menuItem.key)}
          onDelete={(room) => {
            setDeletingRoom(room);
            setMenu(null);
          }}
        />
      ) : null}
      {roomDraft !== null ? (
        <NewThreadRoomDialog threads={roomDraft} onClose={() => { setRoomDraft(null); setSelected(new Set()); }} />
      ) : null}
      {joiningRoom !== null && joiningRoom[0] !== undefined ? (
        <JoinRoomDialog session={joiningRoom[0]} threads={joiningRoom}
          onClose={() => { setJoiningRoom(null); }}
          onNewRoom={() => { setRoomDraft(joiningRoom); setJoiningRoom(null); }} />
      ) : null}
      {renaming !== null ? (
        <SidebarRenameEditor
          key={renaming.id}
          item={renaming}
          heading={renaming.kind === 'room' ? t('room.renameTitle') : t('rename.title')}
          untitled={untitled}
          resolveTitle={resolveTitle}
          onSubmit={async (title) => {
            const target = renaming;
            const sequence = (renameSequences.current.get(target.key) ?? 0) + 1;
            renameSequences.current.set(target.key, sequence);
            const previousTitle = target.kind === 'room' ? target.title : target.session.title;
            setRenamedTitles((prev) => new Map(prev).set(target.key, { from: prev.get(target.key)?.from ?? previousTitle, to: title }));
            if (target.kind === 'room') {
              queryClient.setQueryData<RoomListItem[]>(ROOM_ITEMS_QUERY_KEY, (old) =>
                old === undefined ? old : old.map((room) => (room.id === target.id ? { ...room, title } : room)),
              );
              try {
                const updated = await roomApi.updateRoom(target.id, { name: title });
                if (renameSequences.current.get(target.key) !== sequence) return;
                if (updated !== undefined && updated !== null && typeof updated === 'object' && 'id' in updated) {
                  queryClient.setQueryData(roomQueryKey(target.id), { ...updated, name: title });
                } else if (queryClient.getQueryData(roomQueryKey(target.id)) !== undefined) {
                  queryClient.setQueryData(roomQueryKey(target.id), (old: unknown) =>
                    old !== null && typeof old === 'object' ? { ...old, name: title } : old,
                  );
                }
                setJustRenamed((prev) => ({ key: target.key, seq: (prev?.seq ?? 0) + 1 }));
                setRenaming((current) => current === target ? null : current);
                refreshRooms();
              } catch (cause: unknown) {
                if (renameSequences.current.get(target.key) === sequence) {
                  setRenamedTitles((prev) => { const next = new Map(prev); next.delete(target.key); return next; });
                  refreshRooms();
                }
                throw cause;
              }
              return;
            }
            const patchSessionTitle = (nextTitle: string, serverUpdated?: unknown) => {
              const serverSession = serverUpdated !== undefined && serverUpdated !== null && typeof serverUpdated === 'object' && 'id' in serverUpdated && typeof (serverUpdated as { id?: unknown }).id === 'string'
                ? serverUpdated as Partial<Session>
                : undefined;
              const mergeUpdated = (existing: Session): Session => ({
                ...existing,
                ...serverSession,
                title: nextTitle,
              });
              queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
                old === undefined || !Array.isArray(old.pages)
                  ? old
                  : {
                      ...old,
                      pages: old.pages.map((page) => (!Array.isArray(page?.items) ? page : {
                        ...page,
                        items: page.items.map((entry) => (entry.id === target.id ? mergeUpdated(entry) : entry)),
                      })),
                    },
              );
              queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units'] }, (old) =>
                patchSidebarUnitRow(old, target.id, (row) => ({ ...row, title: nextTitle })),
              );
              queryClient.setQueriesData<SidebarUnitPagesData>({ queryKey: ['sessions', 'sidebar-units-pinned'] }, (old) =>
                patchSidebarUnitRow(old, target.id, (row) => ({ ...row, title: nextTitle })),
              );
              if (queryClient.getQueryData(['session', target.id]) !== undefined) {
                queryClient.setQueryData<Session>(['session', target.id], (old) =>
                  old === undefined ? old : mergeUpdated(old),
                );
              }
            };
            patchSessionTitle(title);
            // A bare title patch omits `metadata`, so the server leaves the
            // stored custom document (and with it any client-local pin) untouched.
            const remoteConnId = remoteConnIdOf(target.spaceKey);
            const targetClient = clientForSpace(target.spaceKey);
            try {
              const updated = await targetClient.updateSessionProfile(target.id, { title });
              if (renameSequences.current.get(target.key) !== sequence) return;
              if (remoteConnId !== undefined) {
                void onRefreshRemoteSpace?.(remoteConnId);
              } else {
                patchSessionTitle(title, updated);
              }
              setJustRenamed((prev) => ({ key: target.key, seq: (prev?.seq ?? 0) + 1 }));
              setRenaming((current) => current === target ? null : current);
              if (remoteConnId === undefined) {
                void queryClient.invalidateQueries({
                  queryKey: ['sessions'],
                  predicate: (query) => !Array.isArray((query.state.data as SessionListData | undefined)?.pages),
                });
                if (target.session.agent_config?.persona !== undefined) {
                  invalidatePersonaSessionLists(queryClient);
                }
              }
            } catch (cause: unknown) {
              if (renameSequences.current.get(target.key) === sequence) {
                setRenamedTitles((prev) => { const next = new Map(prev); next.delete(target.key); return next; });
                patchSessionTitle(previousTitle);
              }
              throw cause;
            }
          }}
          onClose={closeRenameEditor}
        />
      ) : null}
      {deletingRoom !== null ? (
        <ConfirmDialog
          open
          title={t('room.deleteTitle', { name: deletingRoom.title })}
          body={t('room.deleteBody')}
          confirmLabel={t('room.deleteRoom')}
          busy={roomActionBusy}
          overlayId="sidebar-room-delete-confirm"
          onConfirm={() => { deleteRoom(deletingRoom); }}
          onCancel={() => { setDeletingRoom(null); }}
        />
      ) : null}
      {confirmUndo !== null ? (
        <ConfirmDialog
          open
          title={t('undo.title')}
          body={t('undo.bodyNamed', { title: resolveTitle(sessionLabel(confirmUndo, untitled)) })}
          confirmLabel={t('undo.confirm')}
          overlayId="sidebar-confirm-undo"
          onConfirm={() => {
            const session = confirmUndo;
            setConfirmUndo(null);
            setActionError(null);
            void undoLastTurn(actionContext, session)
              .then(() => {
                setActionNotice(t('action.undoDone', { title: resolveTitle(sessionLabel(session, untitled)) }));
              })
              .catch((error: unknown) => {
                setActionError(t('action.undoFailed', { detail: sessionActionErrorText(locale, error) }));
              });
          }}
          onCancel={() => { setConfirmUndo(null); }}
        />
      ) : null}
      {confirmArchiveWorktree?.worktree !== undefined ? (
        <WorktreeArchiveDialog
          session={{ ...confirmArchiveWorktree, worktree: confirmArchiveWorktree.worktree }}
          excludeSessionIds={[...topLevelThreads].filter((id) => id !== confirmArchiveWorktree.id)}
          includeAttached={!sidebarGroupsEnabled}
          onClose={() => { setConfirmArchiveWorktree(null); }}
          onArchiveFailed={() => { refreshSessions(); }}
          onArchived={(result) => {
            const archivedRootId = confirmArchiveWorktree.id;
            setConfirmArchiveWorktree(null);
            void queryClient.invalidateQueries({ queryKey: ['archived-sessions'] }).catch(() => undefined);
            refreshSessions();
            const archivedSet = new Set<string>([archivedRootId]);
            if (!sidebarGroupsEnabled) {
              for (const candidate of sessions) {
                if (sessionRelationOf(candidate)?.parentId === archivedRootId && !topLevelThreads.has(candidate.id)) {
                  archivedSet.add(candidate.id);
                }
              }
            }
            navigateAwayFromArchived(archivedSet);
            if (result?.tone === 'error') setActionError(result.text);
            else if (result !== null) setActionNotice(result.text);
          }}
        />
      ) : null}
    </aside>
  );
}

/**
 * One session row = status slot + title + trailing time, then one quiet
 * second line, "folder · state", where the state is a word (awaiting answer,
 * failed, running for 12:03) — root rows only. On touch the time moves to the
 * end of that second line and the ⋯ keeps the first line's end. Nested rows
 * are a single indented line. Weight is reserved for state (unread / needs
 * you / active), never for hierarchy.
 */
const SessionRow = memo(function SessionRow({
  session,
  active,
  menuOpen,
  untitled,
  resolveTitle,
  activity,
  anchorFor,
  relation,
  nested = false,
  showLocation = true,
  showPin = false,
  remoteSpaceName,
  remoteOffline = false,
  parentTitle,
  onOpen,
  onMenu,
  onTogglePin,
  seenSeq = 0,
  temporary = false,
  selected = false,
  onToggleSelect,
  justRenamed = false,
  archiving = false,
  archiveError,
}: {
  session: Session;
  active: boolean;
  menuOpen: boolean;
  untitled: string;
  resolveTitle: (text: string) => string;
  activity: ActivityEntry | undefined;
  anchorFor: (entry: ActivityEntry) => number | undefined;
  /** Where this session came from, when its metadata records a creator. */
  relation?: SessionRelation;
  /** True while the row sits indented under the session it came from or inside a group. */
  nested?: boolean;
  /** False when the grouping already says where the session lives. */
  showLocation?: boolean;
  /** True when no Pinned group exists or to mark a pinned member inside a group. */
  showPin?: boolean;
  /** Subtle remote computer label shown only in `All computers` scope for remote rows. */
  remoteSpaceName?: string;
  /** True when the remote computer is offline (renders quiet hollow dot + hover title). */
  remoteOffline?: boolean;
  parentTitle?: string;
  onOpen: () => void;
  onMenu: (x: number, y: number, toggle: boolean) => void;
  onTogglePin: () => void;
  /** Primitive read-state watermark for this session; preserves memoization across unrelated rows. */
  seenSeq?: number;
  /** A temporary conversation: no pin, no menu (end or keep it from its header). */
  temporary?: boolean;
  /** Part of the Ctrl/⌘-click selection (pull into a room). */
  selected?: boolean;
  /** Ctrl/⌘-click toggles selection; absent for rows that cannot join a room. */
  onToggleSelect?: () => void;
  /** Brief confirmation tick shown right after an inline rename lands. */
  justRenamed?: boolean;
  /** Its archive is in flight: the row keeps its place and says so. */
  archiving?: boolean;
  /** The last archive refusal, said in place until the next attempt. */
  archiveError?: string;
}) {
  const { t, tp, time } = useI18n();
  const archived = session.archived === true;
  const pinned = isPinnedSession(session);
  const status = sessionStatusOf(session);
  // Row states: blocked, cleanup pending, running, finished-unseen, caught up.
  // Weight and marker carry the difference; the active row still wins on lift.
  const rowState = sessionRowState(session, { [session.id]: seenSeq });
  const label = resolveTitle(
    sessionLabel(session, untitled, nested && relation?.kind === 'fork' ? parentTitle : undefined),
  );
  const elapsed = useElapsedSince(activity === undefined ? undefined : anchorFor(activity));
  // A running row says how long: m:ss in the first hour, a compact duration
  // through the first day, then whole days. The workspace stays on the same
  // second line so a running row never becomes anonymous.
  const duration = elapsed === undefined
    ? undefined
    : elapsed < 3_600_000
      ? formatElapsedClock(elapsed)
      : elapsed >= 86_400_000
        ? t('time.durationDaysOnly', { d: Math.floor(elapsed / 86_400_000) })
        : time.formatDuration(elapsed);
  const runningText = duration === undefined
    ? t('sidebar.status.working')
    : t('sidebar.row.runningFor', { duration });
  // Queued prompts and background tasks are the session's own business and
  // left the row; a desktop hover over the running word still lists them.
  const runningDetail = activity === undefined || status !== 'running'
    ? []
    : [
        ...(activity.queuedCount > 0 ? [tp('activity.queueChip', activity.queuedCount)] : []),
        ...(activity.runningTasks.length > 0
          ? [tp('sidebar.backgroundTasks', activity.runningTasks.length),
              ...activity.runningTasks.map((task) => `· ${task.description.trim() || task.command || task.id}`)]
          : []),
      ];
  // A worktree session lives in its source repository; the checkout path is Kiki's own.
  const locationPath = session.worktree?.source_root ?? session.metadata.cwd;
  const location = !nested && showLocation && locationPath !== '' ? shortCwd(locationPath) : undefined;
  // An unseen run that did not complete says so in words, so failure never
  // rests on the mark's colour alone.
  const failedUnseen = rowState === 'unread' && lifeOf(session) === 'failed';
  // Archiving outranks the row's standing facts: it is what the row is doing
  // right now, and it lasts only as long as the request. A refusal sits in the
  // same slot, so the row that explains itself is the row that never left.
  // Nested rows also need this fact; keep their title and time unobstructed.
  const archiveStatus = archiving
    ? { kind: 'archiving' as const, text: t('sidebar.archiving') }
    : archiveError !== undefined
      ? { kind: 'archive-error' as const, text: archiveError }
      : undefined;
  const fact: { kind: 'needs-you' | 'cleanup-pending' | 'failed' | 'live' | 'archiving' | 'archive-error'; text: string; detail?: string } | undefined = archiveStatus !== undefined
    ? archiveStatus
    : rowState === 'cleanup-pending'
      ? { kind: 'cleanup-pending', text: t('sidebar.rowState.cleanupPending') }
    : nested
      ? undefined
    : status === 'needs-me'
      ? { kind: 'needs-you', text: session.pending_interaction === 'question' ? t('sidebar.statusTag.question') : t('sidebar.statusTag.approval') }
      : failedUnseen
        ? { kind: 'failed', text: failedLabel(session, t) }
      : status === 'running'
        ? { kind: 'live', text: runningText, detail: runningDetail.length > 0 ? runningDetail.join('\n') : undefined }
        : undefined;
  // Which client drives an externally driven session. Origin, workspace and
  // current state stay beside one another with independent truncation.
  const externalSource = readExternalClientMark(session.metadata)?.clientName;
  // Nested rows carry the relation in their accessible name and tooltip,
  // since on screen it is only the indent (plus the branch glyph).
  const nestedName = nested && relation !== undefined
    ? t(
        relation.kind === 'branch'
          ? 'sidebar.branch.rowAria'
          : relation.kind === 'fork'
            ? 'sidebar.fork.rowAria'
            : 'sidebar.thread.rowAria',
        {
          title: label,
          parent: parentTitle ?? t('sidebar.thread.unknownParent'),
        },
      )
    : undefined;
  const hasSignal = rowState === 'running' || rowState === 'needs-me' || rowState === 'unread';
  const archiveState = archiveError !== undefined ? 'failed' : archiving ? 'archiving' : undefined;
  const hasFacts = location !== undefined || fact !== undefined || archived || session.worktree !== undefined || externalSource !== undefined || remoteSpaceName !== undefined;
  // Root rows with a ⋯ only: a temporary row keeps its time on the first line
  // (it has no actions), and a nested row stays one line.
  const touchTime = !nested && !temporary;
  return (
    <div
      className="group relative"
      data-session-row={session.id}
      data-session-row-state={rowState}
      data-session-selected={selected || undefined}
      data-session-archive={archiveState}
      aria-busy={archiving || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY, false);
      }}
    >
      <button
        type="button"
        onClick={(event) => {
          if ((event.metaKey || event.ctrlKey) && onToggleSelect !== undefined) {
            event.preventDefault();
            onToggleSelect();
            return;
          }
          onOpen();
        }}
        aria-current={active ? 'page' : undefined}
        aria-pressed={onToggleSelect !== undefined && selected ? true : undefined}
        aria-label={nestedName}
        title={nestedName}
        className={`row-interactive flex min-h-8 w-full gap-2 py-1.5 pr-2 text-left pointer-coarse:min-h-11 ${selected ? 'bg-ink/[0.05] shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]' : ''} ${
          nested ? 'items-center pl-6' : 'items-start pl-2'
        }`}
      >
        <StatusMark session={session} state={rowState} />
        <span className="min-w-0 flex-1">
          <span
            data-session-title
            className={`flex items-center gap-1 text-[13px] leading-5 font-normal ${
              hasSignal
                ? 'text-ink'
                : archived
                  ? 'text-ink-faint'
                  : 'text-ink-soft'
            }`}
          >
            {/* Pinned is said by the Pinned group; only a list with no groups
              * needs the glyph. */}
            {pinned && showPin ? <PinIcon className="text-ink-faint" /> : null}
            {session.private === true ? (
              <span data-session-private aria-label={t('private.badge')} title={t('private.badge')} className="shrink-0 text-ink-faint">
                <Icon name="lock" size={12} />
              </span>
            ) : null}
            {/* Show 16px persona avatar if session belongs to a persona */}
            {session.agent_config?.persona ? (
              <span className="shrink-0 -my-0.5">
                <PersonaAvatar persona={personaAvatarOf(session.agent_config.persona)} size={16} decorative />
              </span>
            ) : null}
            {/* The one kind glyph: a fork or branch. Sessions a parent started carry none. */}
            {nested && (relation?.kind === 'branch' || relation?.kind === 'fork') ? (
              <span data-session-relation={relation.kind} aria-hidden className="shrink-0 text-ink-faint">
                <Icon name="branch" size={12} />
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {nested && relation?.kind === 'fork' && session.forked_from?.turn_index !== undefined ? (
              <span data-session-fork-turn className="shrink-0 text-[11px] font-normal text-ink-faint tabular-nums">
                #{session.forked_from.turn_index + 1}
              </span>
            ) : null}
            {justRenamed ? (
              <span
                role="status"
                data-rename-saved
                aria-label={t('st.savedTick')}
                title={t('st.savedTick')}
                className="anim-enter inline-flex shrink-0 items-center text-success"
              >
                <Icon name="check" size={12} />
              </span>
            ) : null}
            {/* Trailing slot: the time, replaced by the row actions on hover /
              * focus. Wide enough for the two 28px actions so the title never
              * slides under them. */}
            <span
              data-session-time
              className={`min-w-13 shrink-0 text-right text-[12px] leading-4 font-normal text-ink-faint tabular-nums ${
                temporary ? '' : menuOpen ? 'invisible' : 'group-focus-within:invisible group-hover:invisible [@media(hover:none)]:invisible'
              }`}
            >
              {/* The row's own activity — not the family aggregate that ordered it. */}
              <RelativeTime at={session.own_updated_at ?? session.updated_at} />
            </span>
          </span>
          {hasFacts || touchTime ? (
            <span className={`mt-px min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint ${hasFacts ? 'flex' : 'hidden [@media(hover:none)]:flex'}`}>
              {/* The source tag leads this line: which client drove the work is
                  a fact about the row, while everything after it is about right
                  now and can change under the reader. */}
              {externalSource !== undefined ? (
                <span data-session-external-source={externalSource}
                  title={t('st.xs.sourceTitle', { client: externalSource })}
                  className="inline-flex shrink-0 items-center gap-1 text-ink-faint">
                  <Icon name="external" size={12} className="shrink-0" />
                  <span className="max-w-[9rem] truncate">{t('st.xs.source')} · {externalSource}</span>
                </span>
              ) : null}
              {(location === undefined && fact === undefined) || externalSource === undefined ? null : <span aria-hidden>·</span>}
              {location === undefined ? null : (
                <span
                  data-session-location
                  className="min-w-0 shrink truncate"
                  title={locationPath}
                >
                  {location}
                </span>
              )}
              {location === undefined || fact === undefined ? null : <span aria-hidden className="shrink-0">·</span>}
              {fact === undefined ? null : fact.kind === 'needs-you' ? (
                <span data-session-needs-you className="shrink-0 whitespace-nowrap font-normal text-attention">{fact.text}</span>
              ) : fact.kind === 'cleanup-pending' ? (
                <span data-session-cleanup-pending className="shrink-0 whitespace-nowrap text-ink-soft">{fact.text}</span>
              ) : fact.kind === 'failed' ? (
                <span
                  data-session-failed
                  className="shrink-0 whitespace-nowrap text-ink-soft"
                >
                  {fact.text}
                </span>
              ) : fact.kind === 'live' ? (
                <span data-session-live title={fact.detail} className="shrink-0 whitespace-nowrap text-ink-soft tabular-nums">{fact.text}</span>
              ) : fact.kind === 'archiving' ? (
                // The one place a row says what it is waiting for, in the same
                // quiet second line as every other row fact.
                <span data-session-archiving role="status" className="flex min-w-0 items-center gap-1 truncate text-ink-soft">
                  <Spinner label={t('sidebar.archivingAria', { title: label })} size={12} />
                  <span className="truncate">{fact.text}</span>
                </span>
              ) : fact.kind === 'archive-error' ? (
                // Said in place, next to the row it belongs to. Not red: the
                // row is intact and usable, this one attempt did not land.
                <span data-session-archive-error className="min-w-0 truncate" title={fact.text}>{fact.text}</span>
              ) : null}
              <WorktreeMark worktree={session.worktree} className={fact === undefined && location === undefined ? 'max-w-full' : 'max-w-[40%] shrink-0'} />
              {remoteSpaceName !== undefined ? (
                <>
                  {fact === undefined && location === undefined && externalSource === undefined ? null : <span aria-hidden className="shrink-0">·</span>}
                  <span
                    data-session-space-label
                    title={remoteOffline ? t('sidebar.space.remoteOfflineTitle', { name: remoteSpaceName }) : remoteSpaceName}
                    className="inline-flex min-w-0 shrink items-center gap-1 truncate text-ink-faint/90"
                  >
                    {remoteOffline ? (
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full border border-ink-faint/75" />
                    ) : null}
                    <span className="truncate">{remoteSpaceName}</span>
                  </span>
                </>
              ) : null}
              {archived ? <span className="shrink-0">{fact === undefined && location === undefined && remoteSpaceName === undefined ? '' : '· '}{t('sidebar.archived')}</span> : null}
              {touchTime ? (
                // Without hover the ⋯ covers the first line's time slot for
                // good (it is the only way into the row menu on iOS), so on
                // touch the time ends this line instead.
                <span data-session-time-touch className="ml-auto hidden shrink-0 pl-1 tabular-nums [@media(hover:none)]:inline">
                  <RelativeTime at={session.own_updated_at ?? session.updated_at} />
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>

      {/* Hover/focus affordances: quick pin toggle, then the full action
        * menu. They take over the trailing time slot; both stay reachable
        * from the keyboard via focus-within. */}
      {temporary ? null : (
      <div
        className={`absolute top-0.5 right-1 flex items-center transition-opacity duration-[var(--kiki-motion-quick)] ${
          menuOpen ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'
        }`}
      >
        {archived ? null : (
          <button
            type="button"
            data-session-pin-toggle
            disabled={archiving}
            aria-label={pinned ? t('sidebar.unpinSessionFor', { title: label }) : t('sidebar.pinSessionFor', { title: label })}
            title={pinned ? t('menu.unpin') : t('menu.pin')}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
            className={`flex h-7 w-7 items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-11 [@media(hover:none)]:hidden transition-colors hover:bg-ink/[0.06] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${
              pinned ? 'text-ink-soft' : 'text-ink-faint hover:text-ink'
            }`}
          >
            <Icon name="pin" size={14} />
          </button>
        )}
        <button
          type="button"
          aria-label={t('sidebar.sessionActionsFor', { title: label })}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(rect.right + 4, rect.top, true);
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-11 text-[13px] leading-none text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      )}
    </div>
  );
});

/**
 * A room row is a thread row with one kind glyph: the `#` the room page's
 * header also uses. Same status slot, same weight rules (active / needs you /
 * unread carry the emphasis), same trailing time that yields to the hover
 * actions, same one-fact second line. A room never nests and never hosts.
 */
const RoomConversationRow = memo(function RoomConversationRow({
  item,
  active,
  menuOpen,
  showLocation = true,
  showPin = false,
  location,
  remoteSpaceName,
  remoteOffline = false,
  onOpen,
  onMenu,
  onTogglePin,
  justRenamed = false,
  archiving = false,
  archiveError,
}: {
  item: Extract<ConversationListItem, { kind: 'room' }>;
  active: boolean;
  menuOpen: boolean;
  /** False when the grouping already says where the room lives. */
  showLocation?: boolean;
  /** True only when no Pinned group exists to say it. */
  showPin?: boolean;
  /** Resolved workspace name or shortened root; omitted when unknown. */
  location?: string | undefined;
  /** Subtle remote computer label shown only in `All computers` scope for remote rows. */
  remoteSpaceName?: string;
  /** True when the remote computer is offline. */
  remoteOffline?: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number, toggle: boolean) => void;
  onTogglePin: () => void;
  /** Brief confirmation tick shown right after an inline rename lands. */
  justRenamed?: boolean;
  /** Its archive is in flight: the row keeps its place and says so, in the
      same words a thread row uses. */
  archiving?: boolean;
  /** The last archive refusal, said in place until the next attempt. */
  archiveError?: string;
}) {
  const { t } = useI18n();
  const archived = item.archived === true;
  const state = roomRowState(item);
  const life = roomRowLife(item, state);
  const needsYouText = item.pending_interaction === 'approval'
    ? t('sidebar.statusTag.approval')
    : item.pending_interaction === 'question'
      ? t('sidebar.statusTag.question')
      // needs_you without a pending interaction is the budget pause.
      : t('activity.reason.budget');
  const failedUnseen = state === 'unread' && item.failed;
  const visibleLocation = showLocation && location !== undefined ? location : undefined;
  // A room archives the same way a thread does, so it says the same things:
  // the in-flight state and the refusal outrank the row's standing facts.
  const fact: { kind: 'needs-you' | 'failed' | 'running' | 'archiving' | 'archive-error'; text: string } | undefined =
    archiving
      ? { kind: 'archiving', text: t('sidebar.archiving') }
    : archiveError !== undefined
      ? { kind: 'archive-error', text: archiveError }
    : state === 'needs-me'
      ? { kind: 'needs-you', text: needsYouText }
      : failedUnseen
        ? { kind: 'failed', text: t('sidebar.rowState.failed') }
      : state === 'running'
        ? { kind: 'running', text: t('sidebar.status.working') }
        : undefined;
  const hasFacts = visibleLocation !== undefined || fact !== undefined || archived || remoteSpaceName !== undefined;
  const markTitle =
    state === 'needs-me'
      ? needsYouText
      : state === 'running'
        ? t('sidebar.status.working')
        : state === 'unread'
          ? (item.failed ? t('sidebar.rowState.failed') : t('sidebar.rowState.unread'))
          : undefined;
  const hasSignal = state === 'running' || state === 'needs-me' || state === 'unread';
  const archiveState = archiveError !== undefined ? 'failed' : archiving ? 'archiving' : undefined;
  return (
    <div
      className="group relative"
      data-room-row={item.id}
      data-room-row-state={state}
      data-room-archive={archiveState}
      aria-busy={archiving || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY, false);
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className="row-interactive flex min-h-8 w-full items-start gap-2 py-1.5 pr-2 pl-2 text-left pointer-coarse:min-h-11"
      >
        <SidebarRowDot
          signal={hasSignal}
          kind={state === 'needs-me' ? 'needs_you' : state === 'running' ? 'working' : 'unread'}
          label={markTitle}
          dataAttr={{ 'data-room-status': state === 'read' ? 'idle' : state }}
        />
        <span className="min-w-0 flex-1">
          <span
            data-room-title
            className={`flex items-center gap-1 text-[13px] leading-5 font-normal ${
              hasSignal
                ? 'text-ink'
                : archived
                  ? 'text-ink-faint'
                  : 'text-ink-soft'
            }`}
          >
            {/* Pinned is said by the Pinned group; only a list with no groups
              * needs the glyph. */}
            {item.pinned && showPin ? <PinIcon className="text-ink-faint" /> : null}
            {/* The one kind glyph: a room is a channel, so the channel mark. */}
            <span data-room-kind aria-hidden className="shrink-0 font-mono text-ink-faint">#</span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {justRenamed ? (
              <span
                role="status"
                data-rename-saved
                aria-label={t('st.savedTick')}
                title={t('st.savedTick')}
                className="anim-enter inline-flex shrink-0 items-center text-success"
              >
                <Icon name="check" size={12} />
              </span>
            ) : null}
            <span
              data-room-time
              className={`min-w-13 shrink-0 text-right text-[12px] leading-4 font-normal text-ink-faint tabular-nums ${
                menuOpen ? 'invisible' : 'group-focus-within:invisible group-hover:invisible [@media(hover:none)]:invisible'
              }`}
            >
              <RelativeTime at={item.updated_at} />
            </span>
          </span>
          {/* Always there on touch: it carries the time the ⋯ covers above. */}
          <span className={`mt-px min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint ${hasFacts ? 'flex' : 'hidden [@media(hover:none)]:flex'}`}>
            {visibleLocation === undefined ? null : (
              <span data-room-location className="min-w-0 flex-1 truncate" title={location}>{visibleLocation}</span>
            )}
            {visibleLocation === undefined || fact === undefined ? null : <span aria-hidden>·</span>}
            {fact === undefined ? null : fact.kind === 'needs-you' ? (
              <span data-room-needs-you className="min-w-0 truncate font-normal text-attention">{fact.text}</span>
            ) : fact.kind === 'failed' ? (
              <span data-room-failed className="min-w-0 truncate text-ink-soft">{fact.text}</span>
            ) : fact.kind === 'running' ? (
              <span data-room-live className="shrink-0 whitespace-nowrap text-ink-soft">{fact.text}</span>
            ) : fact.kind === 'archiving' ? (
              <span data-room-archiving role="status" className="flex min-w-0 items-center gap-1 truncate text-ink-soft">
                <Spinner label={t('sidebar.archivingAria', { title: item.title })} size={12} />
                <span className="truncate">{fact.text}</span>
              </span>
            ) : (
              <span data-room-archive-error className="min-w-0 truncate" title={fact.text}>{fact.text}</span>
            )}
            {remoteSpaceName !== undefined ? (
              <>
                {visibleLocation === undefined && fact === undefined ? null : <span aria-hidden>·</span>}
                <span
                  data-room-space-label
                  title={remoteOffline ? t('sidebar.space.remoteOfflineTitle', { name: remoteSpaceName }) : remoteSpaceName}
                  className="inline-flex min-w-0 shrink items-center gap-1 truncate text-ink-faint/90"
                >
                  {remoteOffline ? (
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full border border-ink-faint/75" />
                  ) : null}
                  <span className="truncate">{remoteSpaceName}</span>
                </span>
              </>
            ) : null}
            {archived ? <span className="shrink-0">{visibleLocation === undefined && fact === undefined && remoteSpaceName === undefined ? '' : '· '}{t('sidebar.archived')}</span> : null}
            <span data-room-time-touch className="ml-auto hidden shrink-0 pl-1 tabular-nums [@media(hover:none)]:inline">
              <RelativeTime at={item.updated_at} />
            </span>
          </span>
        </span>
      </button>

      {/* Hover/focus affordances, same contract as the thread row: quick pin
        * toggle, then the full action menu, over the trailing time slot. */}
      <div
        className={`absolute top-0.5 right-1 flex items-center transition-opacity duration-[var(--kiki-motion-quick)] ${
          menuOpen ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'
        }`}
      >
        {archived ? null : (
          <button
            type="button"
            data-room-pin-toggle
            disabled={archiving}
            aria-label={item.pinned ? t('sidebar.unpinSessionFor', { title: item.title }) : t('sidebar.pinSessionFor', { title: item.title })}
            title={item.pinned ? t('menu.unpin') : t('menu.pin')}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
            className={`flex h-7 w-7 items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-11 [@media(hover:none)]:hidden transition-colors hover:bg-ink/[0.06] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${
              item.pinned ? 'text-ink-soft' : 'text-ink-faint hover:text-ink'
            }`}
          >
            <Icon name="pin" size={14} />
          </button>
        )}
        <button
          type="button"
          data-room-menu-toggle
          aria-label={t('sidebar.sessionActionsFor', { title: item.title })}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(rect.right + 4, rect.top, true);
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-11 text-[13px] leading-none text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="more" size={14} />
        </button>
      </div>
    </div>
  );
});

/** A row-menu entry (thread and room menus). Inside the phone's bottom sheet
 * the sheet's own rule resizes it for a thumb. */
const ROW_MENU_ITEM =
  'w-full rounded-md px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper pointer-coarse:min-h-11 pointer-coarse:text-[14px]';

/**
 * The room row's menu: the thread menu's shared spine (link, pin, rename,
 * archive) plus the room's own entries (members, budget, pause). Delete is a
 * room-only destructive action and asks through ConfirmDialog upstream. The
 * summary row carries no pause flag, so the full room document (cached by an
 * open room page) answers the pause/continue label. In phone mode the same
 * entries come up as a bottom sheet.
 */
interface RoomMenuProps {
  item: Extract<ConversationListItem, { kind: 'room' }>;
  x: number;
  y: number;
  onClose: () => void;
  onTogglePin: (room: Extract<ConversationListItem, { kind: 'room' }>) => void;
  /** `paused` is the current state; the action flips it. */
  onTogglePause: (room: Extract<ConversationListItem, { kind: 'room' }>, paused: boolean) => void;
  onRename: () => void;
  onArchive: (room: Extract<ConversationListItem, { kind: 'room' }>) => void;
  onRestore: (room: Extract<ConversationListItem, { kind: 'room' }>) => void;
  onDelete: (room: Extract<ConversationListItem, { kind: 'room' }>) => void;
  /** Its archive is in flight: only the entries that would race it go quiet;
      reading the room and copying its link stay available. */
  archiving?: boolean;
}

function RoomListMenu(props: RoomMenuProps) {
  const { t } = useI18n();
  if (!usePhoneMode()) return <RoomPointerMenu {...props} />;
  return (
    <ActionSheet ariaLabel={t('room.menu')} overlayId="room-list-menu" dataAttribute="data-room-menu" onClose={props.onClose}>
      <RoomMenuEntries {...props} />
    </ActionSheet>
  );
}

/** The desktop form: a small menu at the pointer (or under the row's ⋯). */
function RoomPointerMenu(props: RoomMenuProps) {
  const { x, y, onClose } = props;
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  // Focus holder to hand back to on Escape / item activation — whatever was
  // focused when the menu opened. Outside-pointer closes do not restore: the
  // pointer's own target takes the focus.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = menuRef.current;
    if (node !== null) setSize({ width: node.offsetWidth, height: node.offsetHeight });
    node?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, []);

  const restoreTriggerFocus = () => {
    const trigger = returnFocusRef.current;
    if (trigger === null || trigger === document.body || !trigger.isConnected) return;
    trigger.focus();
  };
  const point = unzoomedPoint(x, y);
  const position = clampOverlayPosition(
    point.x,
    point.y,
    size ?? { width: 176, height: 0 },
    unzoomedViewport(),
  );
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const unregister = registerOverlay('room-list-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const owned = menuRef.current?.contains(document.activeElement) === true;
      closeRef.current();
      if (owned) restoreTriggerFocus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-room-menu]') === null) {
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  return (
    <div
      ref={menuRef}
      data-room-menu
      role="menu"
      aria-label={t('room.menu')}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
        if (items.length === 0) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
        items[next]?.focus();
      }}
      onClick={(event) => {
        // Item activation hands focus back to the opener — but only after
        // the click's commit has landed: an in-place toggle (pin/pause keeps
        // this menu open) keeps its focus, and a surface the action opened
        // focuses itself on mount. Checking post-commit restores exactly
        // when neither happened.
        if (!(event.target instanceof HTMLElement) || event.target.closest('[role="menuitem"]') === null) return;
        const menuNode = menuRef.current;
        queueMicrotask(() => {
          if (menuNode === null || menuNode.isConnected) return;
          const active = document.activeElement;
          if (active !== null && active !== document.body && active instanceof HTMLElement && active.isConnected) return;
          restoreTriggerFocus();
        });
      }}
      className="anim-enter fixed z-50 w-44 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgb(var(--kiki-shadow-ink)/0.3)]"
      style={{ left: position.left, top: position.top }}
    >
      <RoomMenuEntries {...props} />
    </div>
  );
}

/** The room menu's entries, shared by the desktop menu and the phone sheet. */
function RoomMenuEntries({ item, onClose, onTogglePin, onTogglePause, onRename, onArchive, onRestore, onDelete, archiving = false }: RoomMenuProps) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const roomApi = useBotRoomApi();
  const isRemote = item.isRemote === true;
  const targetHref = isRemote && item.spaceKey !== undefined ? placeHrefForSpaceKey(item.spaceKey, item.href) : item.href;
  const archived = item.archived === true;
  const roomQuery = useQuery({
    queryKey: roomQueryKey(item.id),
    queryFn: () => roomApi.getRoom(item.id),
    enabled: !isRemote,
    staleTime: 15_000,
    retry: false,
  });
  const paused = roomQuery.data?.paused;
  const openPanel = (focus: 'members' | 'budget') => {
    onClose();
    void navigate(focus === 'budget' ? `${targetHref}?panel=members&focus=budget` : `${targetHref}?panel=members`);
  };
  const itemClass = ROW_MENU_ITEM;
  if (isRemote) {
    return (
      <>
        {!archived ? (
          <>
            <button type="button" role="menuitem" data-menu-item="members" className={itemClass} onClick={() => { openPanel('members'); }}>
              {t('room.members')}
            </button>
            <button type="button" role="menuitem" data-menu-item="budget" className={itemClass} onClick={() => { openPanel('budget'); }}>
              {t('room.adjustBudget')}
            </button>
            <div className="mx-1 my-1 border-t border-hairline" />
          </>
        ) : null}
        <button
          type="button"
          role="menuitem"
          data-menu-item="copy-link"
          className={itemClass}
          onClick={() => {
            onClose();
            runToastAction(t('menu.copyLink'), () => copyTextToClipboard(targetHref));
          }}
        >
          {t('menu.copyLink')}
        </button>
      </>
    );
  }
  return (
    <>
      {archived ? (
        <>
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onRestore(item); }}>
            {t('menu.restore')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-link"
            className={itemClass}
            onClick={() => {
              onClose();
              runToastAction(t('menu.copyLink'), () => copyTextToClipboard(roomRefLink(item.id)));
            }}
          >
            {t('menu.copyLink')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="delete"
            className={`${itemClass} hover:text-danger`}
            onClick={() => { onDelete(item); }}
          >
            {t('room.deleteRoom')}
          </button>
        </>
      ) : (
        <>
          <button type="button" role="menuitem" data-menu-item="members" className={itemClass} onClick={() => { openPanel('members'); }}>
            {t('room.members')}
          </button>
          <button type="button" role="menuitem" data-menu-item="budget" className={itemClass} onClick={() => { openPanel('budget'); }}>
            {t('room.adjustBudget')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item="pause"
            disabled={paused === undefined}
            className={`${itemClass} disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent`}
            onClick={() => { onTogglePause(item, paused === true); }}
          >
            {paused === true ? t('room.resume') : t('room.pause')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-link"
            className={itemClass}
            onClick={() => {
              onClose();
              runToastAction(t('menu.copyLink'), () => copyTextToClipboard(roomRefLink(item.id)));
            }}
          >
            {t('menu.copyLink')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="pin"
            disabled={archiving}
            className={`${itemClass} disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent`}
            onClick={() => { onTogglePin(item); }}
          >
            {item.pinned ? t('menu.unpin') : t('menu.pin')}
          </button>
          <button type="button" role="menuitem" data-menu-item="rename" className={itemClass} onClick={onRename}>
            {t('menu.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item="archive"
            disabled={archiving}
            className={`${itemClass} hover:text-danger disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent`}
            onClick={() => { onArchive(item); }}
          >
            {archiving ? t('sidebar.archiving') : t('menu.archive')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="delete"
            className={`${itemClass} hover:text-danger`}
            onClick={() => { onDelete(item); }}
          >
            {t('room.deleteRoom')}
          </button>
        </>
      )}
    </>
  );
}

/**
 * A bucket header in the workspace view (a workspace, Pinned, Ungrouped):
 * fold toggle (chevron in the rows' 7px state column), name, count, and for
 * a registered workspace the new-session plus and pin toggle in the trailing
 * slots. The workspace holding the open session says so; a folded one still
 * marks what inside needs you or is running. Toggle, plus, and pin are
 * sibling buttons, never nested.
 */
const WorkspaceGroupHeader = memo(function WorkspaceGroupHeader({
  groupKey,
  label,
  count,
  totalCount,
  collapsed,
  foldable,
  current,
  foldedLife,
  workspace,
  pinBusy,
  onToggle,
  onTogglePin,
  onNewInWorkspace,
}: {
  groupKey: string;
  label: string;
  count: number;
  /** Every session of the workspace, when a filter shows only some. */
  totalCount: number | undefined;
  collapsed: boolean;
  foldable: boolean;
  current: boolean;
  foldedLife: LifeState;
  workspace: WorkspaceCatalogEntry | undefined;
  pinBusy: boolean;
  onToggle: () => void;
  onTogglePin: (() => void) | undefined;
  /** Opens /new in this header's workspace. Absent for Pinned and Ungrouped. */
  onNewInWorkspace: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const pinned = workspace?.pinned === true;
  const countText = totalCount !== undefined && totalCount > count
    ? t('sidebar.groupCountOf', { count, total: totalCount })
    : String(count);
  const body = (
    <>
      <span aria-hidden className="flex w-[7px] shrink-0 justify-center">
        {foldable ? <DisclosureChevron open={!collapsed} /> : null}
      </span>
      {/* Neutral ink throughout; the only colour on a header is the
          "Current" mark and a folded group's status dot. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate">{label}</span>
        <span data-session-group-count className="shrink-0 font-normal text-ink-faint tabular-nums">{countText}</span>
        {current ? (
          <span data-session-group-current className="shrink-0 text-[12px] leading-4 font-normal text-selected-ink">{t('sidebar.currentWorkspace')}</span>
        ) : null}
      </span>
      {foldedLife !== 'idle' ? (
        <span data-session-group-life={foldedLife} className="flex shrink-0 items-center">
          <SidebarRowDot signal kind={sidebarDotKindFromLife(foldedLife)} />
        </span>
      ) : null}
      {onNewInWorkspace !== undefined ? <span aria-hidden className="w-7 shrink-0" /> : null}
      {/* Trailing slot, as wide as the pin action: a kept pin mark, which
          the action takes over on hover / focus. */}
      <span
        className={`flex w-7 shrink-0 items-center justify-center text-ink-faint ${
          onTogglePin === undefined ? '' : 'group-focus-within/ws:invisible group-hover/ws:invisible [@media(hover:none)]:invisible'
        }`}
      >
        {pinned ? <span data-session-group-pinned><PinIcon /></span> : null}
      </span>
    </>
  );
  const rowClass = 'flex h-7 w-full items-center gap-2 pr-1 pl-2 text-left text-[12px] leading-4 font-bold text-ink-soft';
  return (
    <div className="group/ws sticky top-0 z-[1] bg-canvas" data-session-group-header={groupKey}>
      {foldable ? (
        <button
          type="button"
          data-session-group={groupKey}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('sidebar.expandGroup', { label }) : t('sidebar.collapseGroup', { label })}
          title={workspace?.root}
          onClick={onToggle}
          className={`row-interactive ${rowClass} hover:text-ink`}
        >
          {body}
        </button>
      ) : (
        <p data-session-group={groupKey} title={workspace?.root} className={rowClass}>{body}</p>
      )}
      {onNewInWorkspace === undefined ? null : (
        <button
          type="button"
          data-session-group-new={groupKey}
          aria-label={t('sidebar.newSessionInWorkspace', { name: label })}
          title={t('sidebar.newSessionInWorkspace', { name: label })}
          onClick={(event) => {
            event.stopPropagation();
            onNewInWorkspace();
          }}
          className="absolute top-1/2 right-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint transition-[opacity,background-color,color] duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink opacity-0 group-focus-within/ws:opacity-100 group-hover/ws:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Icon name="plus" size={14} />
        </button>
      )}
      {onTogglePin === undefined ? null : (
        <button
          type="button"
          data-session-group-pin={groupKey}
          disabled={pinBusy}
          aria-pressed={pinned}
          aria-label={pinned ? t('sidebar.unpinWorkspaceFor', { name: label }) : t('sidebar.pinWorkspaceFor', { name: label })}
          title={pinned ? t('sidebar.unpinWorkspace') : t('sidebar.pinWorkspace')}
          onClick={onTogglePin}
          className={`absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md transition-[opacity,background-color,color] duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
            pinned ? 'text-ink-soft' : 'text-ink-faint'
          } opacity-0 group-focus-within/ws:opacity-100 group-hover/ws:opacity-100 [@media(hover:none)]:opacity-100`}
        >
          <Icon name="pin" size={14} />
        </button>
      )}
    </div>
  );
});

/** A revocable trace for one active filter: the body reopens the filter
 * menu, the × resets that one filter. Two sibling buttons, not nested. */
function FilterChip({
  kind,
  label,
  clearLabel,
  openLabel,
  onOpen,
  onClear,
}: {
  kind: string;
  label: string;
  clearLabel: string;
  openLabel: string;
  onOpen: () => void;
  onClear: () => void;
}) {
  return (
    <span
      data-sidebar-filter-chip={kind}
      className="inline-flex h-6 max-w-full items-center rounded-md bg-paper pr-0.5 pl-2 text-[12px] text-ink-soft shadow-[var(--kiki-sheet-shadow)]"
    >
      <button type="button" onClick={onOpen} aria-label={openLabel} className="min-w-0 truncate transition-colors hover:text-ink">
        {label}
      </button>
      <button
        type="button"
        data-sidebar-filter-clear={kind}
        onClick={onClear}
        aria-label={clearLabel}
        title={clearLabel}
        className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded leading-none text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

const RESULT_ROW =
  'flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100';

function ResultHeading({ children }: { children: React.ReactNode }) {
  return <p className="px-2 pt-2 pb-1 text-[12px] font-normal text-ink-faint">{children}</p>;
}

/**
 * The search surface that stands in for the list while a query is typed:
 * Workspaces (pick = filter to it) · Sessions (local, instant) · Messages
 * (server content). Every row is a listbox option addressed by its key so
 * the input's ↑↓ can drive it.
 */
function SearchResults({
  search,
  personas = [],
  filtersActive,
  activeKey,
  onHover,
  onOpen,
  onContextMenuSession,
  workspaceNames,
}: {
  search: SessionSearchState;
  personas?: readonly PersonaDirectoryEntry[];
  filtersActive: boolean;
  activeKey: string | undefined;
  onHover: (key: string) => void;
  onOpen: (key: string) => void;
  onContextMenuSession?: (session: Session, x: number, y: number) => void;
  workspaceNames: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  const seen = useSessionSeen();
  const option = (key: string) => ({
    id: `sidebar-result-${key}`,
    role: 'option' as const,
    'aria-selected': activeKey === key,
    'data-search-result': key,
    onMouseMove: () => { onHover(key); },
    onClick: () => { onOpen(key); },
    className: `${RESULT_ROW} ${activeKey === key ? 'bg-paper' : 'hover:bg-paper/70'}`,
  });
  const { local, parsed } = search;
  const nothingLocal = personas.length === 0 && local.workspaces.length === 0 && local.sessions.length === 0;
  const contentSettledEmpty = search.contentActive && !search.contentPending && search.contentInitialError === null && search.hits.length === 0;
  const personaQuery = parsed.text.trim();
  const totalResultRows = personas.length + local.workspaces.length + local.sessions.length + search.hits.length;
  const resultsWindowed = totalResultRows > SIDEBAR_VIRTUALIZE_THRESHOLD;

  type FlatSearchEntry =
    | { readonly kind: 'heading'; readonly key: string; readonly label: string }
    | { readonly kind: 'persona'; readonly key: string; readonly optionKey: string; readonly persona: PersonaDirectoryEntry }
    | { readonly kind: 'workspace'; readonly key: string; readonly optionKey: string; readonly match: SessionSearchState['local']['workspaces'][number] }
    | { readonly kind: 'session'; readonly key: string; readonly optionKey: string; readonly match: SessionSearchState['local']['sessions'][number] }
    | { readonly kind: 'message'; readonly key: string; readonly optionKey: string; readonly hit: SessionSearchState['hits'][number] };

  const flatResults = useMemo<readonly FlatSearchEntry[]>(() => {
    if (!resultsWindowed) return [];
    const out: FlatSearchEntry[] = [];
    if (personas.length > 0) {
      out.push({ kind: 'heading', key: 'hdr:personas', label: t('sidebar.persona.resultsHeading') });
      for (const persona of personas) {
        out.push({ kind: 'persona', key: `p:${persona.id}`, optionKey: `p:${persona.id}`, persona });
      }
    }
    if (local.workspaces.length > 0) {
      out.push({ kind: 'heading', key: 'hdr:workspaces', label: t('sidebar.results.workspaces') });
      for (const match of local.workspaces) {
        out.push({ kind: 'workspace', key: `ws:${match.workspace.id}`, optionKey: `ws:${match.workspace.id}`, match });
      }
    }
    if (local.sessions.length > 0) {
      out.push({ kind: 'heading', key: 'hdr:sessions', label: t('sidebar.results.sessions') });
      for (const match of local.sessions) {
        out.push({ kind: 'session', key: `s:${match.session.id}`, optionKey: `s:${match.session.id}`, match });
      }
    }
    if (search.hits.length > 0) {
      out.push({ kind: 'heading', key: 'hdr:messages', label: t('sidebar.results.messages') });
      for (let index = 0; index < search.hits.length; index += 1) {
        const hit = search.hits[index]!;
        out.push({
          kind: 'message',
          key: `h:${hit.session_id}-${hit.turn ?? 'x'}-${hit.role}-${index}`,
          optionKey: `h:${index}`,
          hit,
        });
      }
    }
    return out;
  }, [resultsWindowed, personas, local.workspaces, local.sessions, search.hits, t]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: resultsWindowed ? flatResults.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const entry = flatResults[index];
      if (entry === undefined) return 48;
      if (entry.kind === 'heading') return 28;
      return entry.kind === 'message' ? 62 : 48;
    },
    getItemKey: (index) => flatResults[index]?.key ?? index,
    overscan: 8,
    initialRect: { width: 260, height: 640 },
    measureElement: (element, _entry, instance) => {
      const height = Math.round(element.getBoundingClientRect().height);
      return height > 0 ? height : instance.options.estimateSize(Number(element.getAttribute('data-index') ?? 0));
    },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    useFlushSync: false,
  });

  useEffect(() => {
    if (!resultsWindowed || activeKey === undefined) return;
    const index = flatResults.findIndex((entry) => entry.kind !== 'heading' && entry.optionKey === activeKey);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [resultsWindowed, activeKey, flatResults, virtualizer]);

  const messagesFooter = (
    <>
      {!isSearchable(parsed.text) && parsed.text.trim() !== '' ? (
        <p className="px-2 pt-2 text-[12px] text-ink-faint">{t('sidebar.results.typeMore')}</p>
      ) : null}
      {search.contentPending && search.hits.length === 0 ? (
        <p role="status" className="flex items-center gap-2 px-2 py-1 text-[12px] text-ink-faint">
          <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-faint" />
          {t('sidebar.searching')}
        </p>
      ) : null}
      {search.contentInitialError !== null ? (
        <div className="mx-2 mt-1 border-l-2 border-danger py-0.5 pl-3" data-search-error>
          <p className="text-[12.5px] font-normal text-danger">{t('sidebar.searchFailed')}</p>
          <p className="text-[12px] text-ink-soft">{search.contentInitialError.message || t('common.unknownError')}</p>
          <button type="button" data-search-initial-retry onClick={search.retry} className="mt-1 text-[12px] font-normal text-ink underline underline-offset-2">
            {t('common.retry')}
          </button>
        </div>
      ) : null}
      {search.unavailable !== undefined ? (
        <div data-search-unavailable role="status" className="px-2 pt-1.5 text-[12px] text-ink-faint">
          {t(`sidebar.results.unavailable.${search.unavailable.reason ?? 'generic'}`)}
          {search.unavailable.reason !== 'disabled' && search.unavailable.reason !== 'runtime_disabled' ? (
            <button type="button" data-search-unavailable-retry onClick={() => { void search.retryUnavailable().catch(() => search.retry()); }}
              className="ml-2 font-normal text-ink underline underline-offset-2">{t('common.retry')}</button>
          ) : null}
        </div>
      ) : search.building !== undefined ? (
        <p data-search-building role="status" className="flex items-center gap-1.5 px-2 pt-1.5 text-[12px] text-ink-faint">
          <Spinner label={t('sidebar.results.building', { indexed: search.building.indexed_sessions, total: search.building.total_sessions })} size={12} />
          {t('sidebar.results.building', { indexed: search.building.indexed_sessions, total: search.building.total_sessions })}
        </p>
      ) : search.incomplete ? (
        <p data-search-incomplete role="status" className="px-2 pt-1.5 text-[12px] text-ink-faint">{t('sidebar.results.incomplete')}</p>
      ) : null}
      {search.hasNextPage ? (
        <button
          type="button"
          data-search-load-more
          disabled={search.isFetchingNextPage || search.isFetching}
          onClick={search.fetchNextPage}
          className="mt-1 h-8 w-full rounded-md text-center text-[12px] text-ink-soft transition-colors hover:bg-paper hover:text-ink disabled:opacity-60"
        >
          {search.isFetchingNextPage ? t('sidebar.loadingMore') : t('sidebar.searchLoadMore')}
        </button>
      ) : null}
      {search.contentAppendError ? (
        <div className="mx-2 mt-1 border-l-2 border-danger py-0.5 pl-3">
          <p className="text-[12.5px] font-normal text-danger">{t('sidebar.searchFailed')}</p>
          <button
            type="button"
            data-search-retry
            disabled={search.isFetchingNextPage}
            onClick={search.fetchNextPage}
            className="mt-1 text-[12px] font-normal text-ink underline underline-offset-2"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <div
      ref={scrollRef}
      id="sidebar-search-results"
      role="listbox"
      aria-label={t('sidebar.searchAria')}
      data-search-results
      data-search-results-virtualized={resultsWindowed ? 'true' : undefined}
      className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2"
    >
      {filtersActive || parsed.workspaceTerm !== undefined || parsed.role !== undefined ? (
        <p data-search-scope className="flex flex-wrap items-center gap-1 px-2 pt-1 text-[12px] text-ink-faint">
          <span>{t('sidebar.results.scoped')}</span>
          {parsed.workspaceTerm !== undefined ? (
            <span className="rounded bg-paper px-1.5 text-ink-soft">{t('sidebar.prefixWorkspace', { name: parsed.workspaceTerm })}</span>
          ) : null}
          {parsed.role !== undefined ? (
            <span className="rounded bg-paper px-1.5 text-ink-soft">{t('sidebar.prefixRole', { role: parsed.role })}</span>
          ) : null}
        </p>
      ) : null}

      {resultsWindowed ? (
        <>
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = flatResults[virtualRow.index];
              if (entry === undefined) return null;
              let content: React.ReactNode;
              if (entry.kind === 'heading') {
                content = <ResultHeading>{entry.label}</ResultHeading>;
              } else if (entry.kind === 'persona') {
                const persona = entry.persona;
                content = (
                  <button type="button" {...option(entry.optionKey)}>
                    <PersonaAvatar persona={personaAvatarOf(persona)} size={20} decorative />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">
                        <Highlighted text={persona.name} ranges={highlightTerms(persona.name, personaQuery)} />
                      </span>
                      {persona.title !== undefined && persona.title.trim() !== '' ? (
                        <span className="block truncate text-[11.5px] text-ink-faint">{persona.title}</span>
                      ) : null}
                    </span>
                  </button>
                );
              } else if (entry.kind === 'workspace') {
                const match = entry.match;
                content = (
                  <button type="button" {...option(entry.optionKey)}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">
                        <Highlighted text={match.workspace.name} ranges={match.nameRanges} />
                      </span>
                      <span className="block truncate font-mono text-[11.5px] text-ink-faint">{shortCwd(match.workspace.root)}</span>
                    </span>
                    <span className="shrink-0 pt-px text-[12px] text-ink-faint">{t('sidebar.results.filterTo', { name: '' }).trim()}</span>
                  </button>
                );
              } else if (entry.kind === 'session') {
                const match = entry.match;
                content = (
                  <button
                    type="button"
                    {...option(entry.optionKey)}
                    onContextMenu={onContextMenuSession === undefined ? undefined : (event) => {
                      event.preventDefault();
                      onContextMenuSession(match.session.source, event.clientX, event.clientY);
                    }}
                  >
                    <span className="flex h-[19px] w-[7px] shrink-0 items-center">
                      <StatusMark session={match.session.source} state={sessionRowState(match.session.source, seen)} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">
                        <Highlighted text={match.session.title} ranges={match.titleRanges} />
                      </span>
                      <span className="block truncate text-[12px] text-ink-faint">
                        {workspaceNames.get(match.session.workspace_id) ?? shortCwd(match.session.cwd)}
                        {' · '}
                        <RelativeTime at={match.session.updated_at} />
                      </span>
                    </span>
                  </button>
                );
              } else {
                const hit = entry.hit;
                content = (
                  <button type="button" {...option(entry.optionKey)}>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] leading-snug text-ink-soft">
                        <Highlighted text={hit.snippet} ranges={highlightTerms(hit.snippet, search.contentQuery)} />
                      </span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-ink-faint">
                        <span className="min-w-0 truncate text-ink-soft"><ThreadTitle text={sanitizeDisplayTitle(hit.session_title) ?? t('sidebar.untitled')} /></span>
                        <span className="shrink-0">· {t(hit.role === 'tool' ? 'search.toolOutput' : `sidebar.results.role.${hit.role}`)}</span>
                        <span className="shrink-0">· <RelativeTime at={new Date(hit.time).toISOString()} /></span>
                      </span>
                    </span>
                  </button>
                );
              }
              return (
                <div
                  key={entry.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0"
                  style={{ top: virtualRow.start }}
                >
                  {content}
                </div>
              );
            })}
          </div>
          <div role="group" aria-label={t('sidebar.results.messages')} data-search-messages>
            {messagesFooter}
          </div>
        </>
      ) : (
        <>
          {personas.length > 0 ? (
            <div role="group" aria-label={t('sidebar.persona.resultsHeading')} data-search-personas>
              <ResultHeading>{t('sidebar.persona.resultsHeading')}</ResultHeading>
              {personas.map((persona) => (
                <button key={persona.id} type="button" {...option(`p:${persona.id}`)}>
                  <PersonaAvatar persona={personaAvatarOf(persona)} size={20} decorative />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">
                      <Highlighted text={persona.name} ranges={highlightTerms(persona.name, personaQuery)} />
                    </span>
                    {persona.title !== undefined && persona.title.trim() !== '' ? (
                      <span className="block truncate text-[11.5px] text-ink-faint">{persona.title}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {local.workspaces.length > 0 ? (
            <div role="group" aria-label={t('sidebar.results.workspaces')}>
              <ResultHeading>{t('sidebar.results.workspaces')}</ResultHeading>
              {local.workspaces.map((match) => (
                <button key={match.workspace.id} type="button" {...option(`ws:${match.workspace.id}`)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">
                      <Highlighted text={match.workspace.name} ranges={match.nameRanges} />
                    </span>
                    <span className="block truncate font-mono text-[11.5px] text-ink-faint">{shortCwd(match.workspace.root)}</span>
                  </span>
                  <span className="shrink-0 pt-px text-[12px] text-ink-faint">{t('sidebar.results.filterTo', { name: '' }).trim()}</span>
                </button>
              ))}
            </div>
          ) : null}

          {local.sessions.length > 0 ? (
            <div role="group" aria-label={t('sidebar.results.sessions')}>
              <ResultHeading>{t('sidebar.results.sessions')}</ResultHeading>
              {local.sessions.map((match) => (
                <button
                  key={match.session.id}
                  type="button"
                  {...option(`s:${match.session.id}`)}
                  onContextMenu={onContextMenuSession === undefined ? undefined : (event) => {
                    event.preventDefault();
                    onContextMenuSession(match.session.source, event.clientX, event.clientY);
                  }}
                >
                  <span className="flex h-[19px] w-[7px] shrink-0 items-center">
                    <StatusMark session={match.session.source} state={sessionRowState(match.session.source, seen)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">
                      <Highlighted text={match.session.title} ranges={match.titleRanges} />
                    </span>
                    <span className="block truncate text-[12px] text-ink-faint">
                      {workspaceNames.get(match.session.workspace_id) ?? shortCwd(match.session.cwd)}
                      {' · '}
                      <RelativeTime at={match.session.updated_at} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <div role="group" aria-label={t('sidebar.results.messages')} data-search-messages>
            {search.hits.length > 0 || search.contentPending || search.contentInitialError !== null || search.unavailable !== undefined ? (
              <ResultHeading>{t('sidebar.results.messages')}</ResultHeading>
            ) : null}
            {search.hits.map((hit, index) => (
              <button key={`${hit.session_id}-${hit.turn ?? 'x'}-${hit.role}-${index}`} type="button" {...option(`h:${index}`)}>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[13px] leading-snug text-ink-soft">
                    <Highlighted text={hit.snippet} ranges={highlightTerms(hit.snippet, search.contentQuery)} />
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-ink-faint">
                    <span className="min-w-0 truncate text-ink-soft"><ThreadTitle text={sanitizeDisplayTitle(hit.session_title) ?? t('sidebar.untitled')} /></span>
                    <span className="shrink-0">· {t(hit.role === 'tool' ? 'search.toolOutput' : `sidebar.results.role.${hit.role}`)}</span>
                    <span className="shrink-0">· <RelativeTime at={new Date(hit.time).toISOString()} /></span>
                  </span>
                </span>
              </button>
            ))}
            {messagesFooter}
          </div>
        </>
      )}

      {nothingLocal && (contentSettledEmpty || !isSearchable(parsed.text)) && search.contentInitialError === null && !search.contentPending ? (
        <p data-search-empty className="px-2 pt-3 text-[12.5px] text-ink-faint">
          {t('sidebar.results.none', { query: search.parsed.text.trim() || searchQueryDisplay(search) })}
        </p>
      ) : null}
    </div>
  );
}

function searchQueryDisplay(search: SessionSearchState): string {
  return [search.parsed.workspaceTerm === undefined ? '' : `in:${search.parsed.workspaceTerm}`, search.parsed.role === undefined ? '' : `role:${search.parsed.role}`]
    .filter((part) => part !== '')
    .join(' ');
}

/** Rows beyond this are reachable through "manage workspaces"; the menu is a
 * shortcut list, not a workspace browser. */
const MENU_WORKSPACE_ROWS = 8;
const MENU_HEADING = 'px-3 pt-1.5 pb-0.5 text-[11px] font-normal text-ink-faint phone:px-4 phone:pt-2 phone:pb-1 phone:text-[13px]';
const MENU_ITEM =
  'flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-left text-[12.5px] text-ink transition-colors hover:bg-paper phone:h-9 phone:text-[14px] pointer-coarse:min-h-11';

/** The selection column: reserved on every row so labels stay aligned. */
function MenuMark({ on }: { on: boolean }) {
  return (
    <span aria-hidden className="flex w-3 shrink-0 text-ink">
      {on ? <Icon name="check" size={12} /> : null}
    </span>
  );
}


/** Menu-key semantics shared by the sidebar's anchored menus: ↑↓/Home/End
 * rove between items, consumed here so AnchoredPopover only owns Escape. */
function menuArrowKeys(event: React.KeyboardEvent<HTMLDivElement>): boolean {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return false;
  const items = [...(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
  if (items.length === 0) return false;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
    : event.key === 'ArrowDown' ? (index + 1) % items.length
    : (index - 1 + items.length) % items.length;
  items[next]?.focus();
  return true;
}

/**
 * Arrangement only: grouping, sorting, and which tools the sidebar pins.
 * Nothing here hides a session. Anchored under its button on a desktop; a
 * bottom sheet in phone mode, where the button sits at the top of a
 * full-screen drawer, far from the thumb.
 */
function SidebarViewMenu({
  anchor,
  onClose,
  groupBy,
  onGroupBy,
  sortBy,
  onSortBy,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  groupBy: 'time' | 'workspace' | 'none';
  onGroupBy: (groupBy: 'time' | 'workspace' | 'none') => void;
  sortBy: SessionSortOrder;
  onSortBy: (sortBy: SessionSortOrder) => void;
}) {
  const { t } = useI18n();
  const layoutPrefs = useLayoutPreferences();
  const phone = usePhoneMode();
  // The checks mirror what the nav shows, and a toggle starts from that list,
  // so on a phone the first pin saves just the one tool.
  const pinnedNavItems = shownPinnedNavItems(layoutPrefs, phone);
  const pinnedSet = useMemo(() => new Set<SidebarNavKey>(pinnedNavItems), [pinnedNavItems]);
  const groups: readonly { value: 'time' | 'workspace' | 'none'; label: string }[] = [
    { value: 'time', label: t('sidebar.groupByTime') },
    { value: 'workspace', label: t('sidebar.groupByWorkspace') },
    { value: 'none', label: t('sidebar.groupByNone') },
  ];
  const sortLabel: Record<SessionSortOrder, string> = {
    'updated-desc': t('sidebar.sortUpdatedDesc'),
    'updated-asc': t('sidebar.sortUpdatedAsc'),
    'created-desc': t('sidebar.sortCreated'),
    title: t('sidebar.sortTitle'),
  };
  const body = (
    <>
      <p className={MENU_HEADING}>{t('sidebar.viewGroupHeading')}</p>
      {groups.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={groupBy === option.value}
          data-group-by={option.value}
          className={`${MENU_ITEM} w-full`}
          onClick={() => { onGroupBy(option.value); }}
        >
          <MenuMark on={groupBy === option.value} />
          <span className="truncate">{option.label}</span>
        </button>
      ))}
      <div className="mx-1 my-1 border-t border-hairline" />
      <p className={MENU_HEADING}>{t('sidebar.viewSortHeading')}</p>
      {SESSION_SORT_ORDERS.map((value) => (
        <button
          key={value}
          type="button"
          role="menuitemradio"
          aria-checked={sortBy === value}
          data-sort-by={value}
          className={`${MENU_ITEM} w-full`}
          onClick={() => { onSortBy(value); }}
        >
          <MenuMark on={sortBy === value} />
          <span className="truncate">{sortLabel[value]}</span>
        </button>
      ))}
      <div className="mx-1 my-1 border-t border-hairline" />
      <p className={MENU_HEADING}>{t('st.sidebarNav.title')}</p>
      {ALL_SIDEBAR_NAV_KEYS.map((key) => {
        const isPinned = pinnedSet.has(key);
        const label = key === 'personas'
          ? t('persona.nav')
          : key === 'discover'
            ? t('discovery.title')
            : t(`nav.${key}`);
        return (
          <button
            key={key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={isPinned}
            data-nav-item-toggle={key}
            className={`${MENU_ITEM} w-full`}
            onClick={() => {
              const next = isPinned
                ? pinnedNavItems.filter((entry) => entry !== key)
                : [...pinnedNavItems, key];
              writeLayoutPreferences({ pinnedNavItems: next });
            }}
          >
            <MenuMark on={isPinned} />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </>
  );
  return phone ? (
    <ActionSheet ariaLabel={t('sidebar.viewMenu')} overlayId="sidebar-view-menu" dataAttribute="data-view-menu" onClose={onClose}>
      {body}
    </ActionSheet>
  ) : (
    <AnchoredPopover
      open
      onClose={onClose}
      anchorRef={anchor}
      id="sidebar-view-menu"
      label={t('sidebar.viewMenu')}
      role="menu"
      align="end"
      widthClassName="w-[232px]"
      className="p-1"
      data={{ 'data-view-menu': '' }}
      onSurfaceKeyDown={menuArrowKeys}
    >
      {body}
    </AnchoredPopover>
  );
}

/**
 * Everything that changes WHICH sessions are visible: status, workspaces
 * (multi-select, with the server-side pin toggle per row) and archived.
 * The panel stays open across clicks — the list rearranges live behind it.
 * A bottom sheet in phone mode, like the view menu.
 */
function SidebarFilterMenu({
  anchor,
  onClose,
  filters,
  presentStatuses,
  onToggleStatus,
  onToggleWorkspace,
  onArchived,
  onPrivate,
  workspaceOptions,
  workspacePinBusy,
  onToggleWorkspacePin,
  onManageWorkspaces,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  filters: SessionListFilters;
  /** The states some listed session is in now; a chosen one stays offered
   * even when it empties, so it can still be turned off here. */
  presentStatuses: ReadonlySet<SessionStatusFilter>;
  onToggleStatus: (status: SessionStatusFilter) => void;
  onToggleWorkspace: (workspaceId: string) => void;
  onArchived: (archived: SessionArchivedFilter) => void;
  onPrivate: (privateFilter: SessionPrivateFilter) => void;
  workspaceOptions: readonly WorkspaceCatalogEntry[];
  workspacePinBusy: boolean;
  onToggleWorkspacePin: (workspace: WorkspaceCatalogEntry) => void;
  onManageWorkspaces: () => void;
}) {
  const { t } = useI18n();
  const phone = usePhoneMode();
  const privateFilter = filters.private ?? 'hide';
  const allStatuses: readonly { value: SessionStatusFilter; label: string }[] = [
    { value: 'running', label: t('sidebar.statusRunning') },
    { value: 'needs-me', label: t('sidebar.statusNeedsMe') },
    { value: 'cleanup-pending', label: t('sidebar.rowState.cleanupPending') },
    { value: 'idle', label: t('sidebar.statusIdle') },
  ];
  const statuses = allStatuses.filter((option) => presentStatuses.has(option.value) || filters.status.includes(option.value));
  const head = workspaceOptions.slice(0, MENU_WORKSPACE_ROWS);
  const extra = workspaceOptions.filter((workspace) => filters.workspaces.includes(workspace.id) && !head.includes(workspace));
  const archivedOptions: readonly { value: SessionArchivedFilter; label: string }[] = [
    { value: 'hide', label: t('sidebar.archivedHide') },
    { value: 'include', label: t('sidebar.archivedInclude') },
    { value: 'only', label: t('sidebar.archivedOnly') },
  ];
  const privateOptions: readonly { value: SessionPrivateFilter; label: string }[] = [
    { value: 'hide', label: t('sidebar.privateHide') },
    { value: 'include', label: t('sidebar.privateInclude') },
    { value: 'only', label: t('sidebar.privateOnly') },
  ];
  const body = (
    <>
      {statuses.length > 0 ? (
        <>
          <p className={MENU_HEADING}>{t('sidebar.filterStatusHeading')}</p>
          {statuses.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemcheckbox"
              aria-checked={filters.status.includes(option.value)}
              data-status-filter={option.value}
              className={`${MENU_ITEM} w-full`}
              onClick={() => { onToggleStatus(option.value); }}
            >
              <MenuMark on={filters.status.includes(option.value)} />
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </>
      ) : null}
      {workspaceOptions.length > 0 ? (
        <>
          {statuses.length > 0 ? <div className="mx-1 my-1 border-t border-hairline" /> : null}
          <p className={MENU_HEADING}>{t('sidebar.viewWorkspaceHeading')}</p>
          {[...head, ...extra].map((workspace) => (
            <div key={workspace.id} className="group flex items-center">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={filters.workspaces.includes(workspace.id)}
                data-workspace-filter={workspace.id}
                className={MENU_ITEM}
                onClick={() => { onToggleWorkspace(workspace.id); }}
              >
                <MenuMark on={filters.workspaces.includes(workspace.id)} />
                <span className="truncate">{workspace.name}</span>
              </button>
              <button
                type="button"
                data-workspace-pin-toggle
                data-workspace-pin-for={workspace.id}
                disabled={workspacePinBusy}
                aria-pressed={workspace.pinned}
                aria-label={
                  workspace.pinned
                    ? t('sidebar.unpinWorkspaceFor', { name: workspace.name })
                    : t('sidebar.pinWorkspaceFor', { name: workspace.name })
                }
                title={workspace.pinned ? t('sidebar.unpinWorkspace') : t('sidebar.pinWorkspace')}
                onClick={() => { onToggleWorkspacePin(workspace); }}
                // Without hover the unpinned mark would never show, leaving
                // an invisible target in the row: touch keeps it faint.
                className={`mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors hover:bg-paper disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:w-11 ${
                  workspace.pinned
                    ? 'text-ink-soft'
                    : 'text-transparent group-focus-within:text-ink-faint group-hover:text-ink-faint hover:!text-ink [@media(hover:none)]:text-ink-faint'
                }`}
              >
                <PinIcon />
              </button>
            </div>
          ))}
          <button type="button" role="menuitem" data-manage-workspaces className={`${MENU_ITEM} w-full`} onClick={onManageWorkspaces}>
            <MenuMark on={false} />
            <span className="truncate text-ink-soft">{t('sidebar.manageWorkspaces')}</span>
          </button>
        </>
      ) : null}
      {statuses.length > 0 || workspaceOptions.length > 0 ? <div className="mx-1 my-1 border-t border-hairline" /> : null}
      <p className={MENU_HEADING}>{t('sidebar.filterArchivedHeading')}</p>
      {archivedOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={filters.archived === option.value}
          data-archived-filter={option.value}
          {...(option.value === 'include' ? { 'data-show-archived': '' } : {})}
          className={`${MENU_ITEM} w-full`}
          onClick={() => { onArchived(option.value); }}
        >
          <MenuMark on={filters.archived === option.value} />
          <span className="truncate">{option.label}</span>
        </button>
      ))}
      <div className="mx-1 my-1 border-t border-hairline" />
      <p className={MENU_HEADING}>{t('sidebar.filterPrivateHeading')}</p>
      {privateOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={privateFilter === option.value}
          data-private-filter={option.value}
          className={`${MENU_ITEM} w-full`}
          onClick={() => { onPrivate(option.value); }}
        >
          <MenuMark on={privateFilter === option.value} />
          <span className="truncate">{option.label}</span>
        </button>
      ))}
    </>
  );
  return phone ? (
    <ActionSheet ariaLabel={t('sidebar.filterMenu')} overlayId="sidebar-filter-menu" dataAttribute="data-filter-menu" onClose={onClose}>
      {body}
    </ActionSheet>
  ) : (
    <AnchoredPopover
      open
      onClose={onClose}
      anchorRef={anchor}
      id="sidebar-filter-menu"
      label={t('sidebar.filterMenu')}
      role="menu"
      align="end"
      widthClassName="w-[232px]"
      className="p-1"
      data={{ 'data-filter-menu': '', 'data-view-menu-filters': '' }}
      onSurfaceKeyDown={menuArrowKeys}
    >
      {body}
    </AnchoredPopover>
  );
}

/**
 * The one/two-value tier: renaming a session or room edits the row it names,
 * not a dialog. The editor portals to <body> over the row's title so the row
 * never reflows while the field is open; Enter, the inline check button, or
 * clicking outside a modified draft saves, while Escape or the close button
 * cancels without writing. The title it covers carries data-session-title /
 * data-room-title, so the field lands directly over it.
 */
function SidebarRenameEditor({
  item,
  heading,
  untitled,
  resolveTitle,
  onSubmit,
  onClose,
}: {
  item: ConversationListItem;
  heading: string;
  untitled: string;
  resolveTitle: (text: string) => string;
  onSubmit: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const persistedTitle = item.kind === 'room' ? item.title.trim() : item.session.title.trim();
  const [title, setTitle] = useState(() => {
    if (item.kind === 'room') return item.title;
    if (item.session.title.trim() !== '') return item.session.title;
    const rawPrompt = item.session.last_prompt?.trim() ?? '';
    if (rawPrompt === '') return '';
    return resolveTitle(rawPrompt).replace(/\s+/g, ' ').trim().slice(0, 200);
  });
  const placeholder = item.kind === 'session' ? untitled : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const didAutoFocusRef = useRef(false);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);
  const tabKeyActiveRef = useRef(false);
  const tabClearTimerRef = useRef<number | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  const persistedTitleRef = useRef(persistedTitle);
  persistedTitleRef.current = persistedTitle;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number; minHeight: number } | null>(null);

  useLayoutEffect(() => {
    const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(item.id) : item.id;
    const selector = item.kind === 'room'
      ? `[data-room-row="${escapedId}"] [data-room-title]`
      : `[data-session-row="${escapedId}"] [data-session-title]`;
    const computeAnchor = (target: HTMLElement) => {
      const rect = unzoomedRect(target.getBoundingClientRect());
      const row = target.closest<HTMLElement>('[data-session-row], [data-room-row]');
      const rowRect = row === null ? null : unzoomedRect(row.getBoundingClientRect());
      const hasRowBox = rowRect !== null && rowRect.width > 0;
      const left = hasRowBox ? Math.max(4, rowRect.left) : Math.max(4, rect.left - 4);
      const top = hasRowBox ? rowRect.top : rect.top - 5;
      const minHeight = hasRowBox ? Math.max(36, rowRect.height) : 36;
      const rowSpan = hasRowBox ? rowRect.width : rect.width + 32;
      const viewport = unzoomedViewport();
      const maxWidth = viewport.width > left + 8 ? viewport.width - left - 8 : Infinity;
      const width = Math.min(Math.max(rowSpan, 200), maxWidth);
      return { left, top, width, minHeight };
    };
    const initialTarget = document.querySelector<HTMLElement>(selector);
    if (initialTarget === null) {
      onCloseRef.current();
      return undefined;
    }
    setAnchor(computeAnchor(initialTarget));
    const updateOnViewportChange = () => {
      const target = document.querySelector<HTMLElement>(selector);
      if (target === null) return;
      const next = computeAnchor(target);
      setAnchor((prev) =>
        prev !== null
          && prev.left === next.left
          && prev.top === next.top
          && prev.width === next.width
          && prev.minHeight === next.minHeight
          ? prev
          : next,
      );
    };
    window.addEventListener('scroll', updateOnViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', updateOnViewportChange, { passive: true });
    return () => {
      window.removeEventListener('scroll', updateOnViewportChange, true);
      window.removeEventListener('resize', updateOnViewportChange);
    };
  }, [item.kind, item.id]);

  const hasAnchor = anchor !== null;
  const inputCallbackRef = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (node !== null && !didAutoFocusRef.current) {
      didAutoFocusRef.current = true;
      node.focus();
      node.select();
    }
  }, []);

  useEffect(() => {
    if (!hasAnchor || didAutoFocusRef.current) return;
    const input = inputRef.current;
    if (input === null) return;
    didAutoFocusRef.current = true;
    input.focus();
    input.select();
  }, [hasAnchor]);

  const submitCurrent = useCallback(() => {
    if (submittingRef.current) return;
    const trimmed = titleRef.current.trim();
    if (trimmed === '') return;
    if (trimmed === persistedTitleRef.current) {
      submittingRef.current = true;
      onCloseRef.current();
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    void Promise.resolve(onSubmitRef.current(trimmed)).catch((cause: unknown) => {
      submittingRef.current = false;
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    });
  }, []);

  const cancelCurrent = useCallback(() => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    onCloseRef.current();
  }, []);

  const commitOrCloseOnExit = useCallback(() => {
    if (submittingRef.current || composingRef.current) return;
    const trimmed = titleRef.current.trim();
    if (trimmed !== '' && trimmed !== persistedTitleRef.current) {
      submitCurrent();
    } else {
      cancelCurrent();
    }
  }, [cancelCurrent, submitCurrent]);

  useEffect(() => {
    const unregister = registerOverlay('sidebar-rename');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !isImeKeyEvent(event) && fieldRef.current?.contains(event.target as Node)) {
        tabKeyActiveRef.current = true;
        if (tabClearTimerRef.current !== null) window.clearTimeout(tabClearTimerRef.current);
        tabClearTimerRef.current = window.setTimeout(() => {
          tabKeyActiveRef.current = false;
          tabClearTimerRef.current = null;
        }, 0);
        return;
      }
      // An IME Escape cancels the candidate, not the rename.
      if (event.key !== 'Escape' || isImeKeyEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      cancelCurrent();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (fieldRef.current === null || fieldRef.current.contains(event.target as Node)) return;
      commitOrCloseOnExit();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      if (tabClearTimerRef.current !== null) {
        window.clearTimeout(tabClearTimerRef.current);
        tabClearTimerRef.current = null;
      }
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [cancelCurrent, commitOrCloseOnExit]);

  if (anchor === null) return null;
  const trimmed = title.trim();
  const dirty = trimmed !== '' && trimmed !== persistedTitle;
  const virtualAnchor = {
    getBoundingClientRect: () => ({
      x: anchor.left,
      y: anchor.top,
      top: anchor.top,
      left: anchor.left,
      right: anchor.left + anchor.width,
      bottom: anchor.top,
      width: anchor.width,
      height: 0,
      toJSON: () => ({}),
    }),
  };
  return (
    <Popover.Root open modal={false}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={virtualAnchor}
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          positionMethod="fixed"
          className="z-50"
        >
          <Popover.Popup
            ref={fieldRef}
            role="dialog"
            aria-label={heading}
            aria-busy={busy || undefined}
            data-rename-editor={item.id}
            data-rename-saving={busy ? '' : undefined}
            initialFocus={inputRef}
            finalFocus={false}
            onBlur={(event) => {
              if (submittingRef.current || composingRef.current || fieldRef.current === null) return;
              const next = event.relatedTarget;
              if (next instanceof Node) {
                if (fieldRef.current.contains(next)) return;
                commitOrCloseOnExit();
                return;
              }
              if (!tabKeyActiveRef.current) return;
              tabKeyActiveRef.current = false;
              queueMicrotask(() => {
                if (submittingRef.current || composingRef.current || fieldRef.current === null) return;
                const active = document.activeElement;
                if (active instanceof Node && fieldRef.current.contains(active)) return;
                commitOrCloseOnExit();
              });
            }}
            className="anim-enter flex flex-col justify-center rounded-xl border border-hairline-strong bg-panel px-2 py-1 shadow-[0_8px_24px_-10px_rgb(var(--kiki-shadow-ink)/0.32)] outline-none focus-within:border-selected-ink focus-within:ring-2 focus-within:ring-selected-ink/25"
            style={{ width: anchor.width, minHeight: anchor.minHeight }}
          >
      <div className="flex items-center gap-1">
        <input
          ref={inputCallbackRef}
          data-autofocus
          data-rename-input
          aria-label={heading}
          aria-invalid={error !== null || undefined}
          placeholder={placeholder}
          disabled={busy}
          style={{ outline: 'none' }}
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[13px] font-normal text-ink placeholder:font-normal placeholder:text-ink-faint disabled:opacity-65"
          value={title}
          maxLength={200}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onChange={(event) => {
            titleRef.current = event.target.value;
            setTitle(event.target.value);
            if (error !== null) setError(null);
          }}
          onKeyDown={(event) => {
            // The Enter that commits an IME candidate must not save a
            // half-typed title.
            if (event.key === 'Enter' && !isImeKeyEvent(event)) {
              event.preventDefault();
              submitCurrent();
            }
          }}
        />
        <button
          type="button"
          data-rename-confirm
          disabled={busy || trimmed === ''}
          aria-label={t(busy ? 'common.saving' : 'common.save')}
          title={t(busy ? 'common.saving' : 'common.save')}
          onPointerDown={(event) => { event.preventDefault(); }}
          onClick={submitCurrent}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${
            dirty && !busy
              ? 'bg-accent/12 text-accent hover:bg-accent/20'
              : 'text-ink-soft hover:bg-ink/[0.06] hover:text-ink'
          }`}
        >
          {busy ? <Spinner label={t('common.saving')} size={12} /> : <Icon name="check" size={14} />}
        </button>
        <button
          type="button"
          data-rename-cancel
          disabled={busy}
          aria-label={t('common.cancel')}
          title={t('common.cancel')}
          onPointerDown={(event) => { event.preventDefault(); }}
          onClick={cancelCurrent}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {error !== null ? (
        <p role="alert" data-rename-error className="mt-1 px-1.5 py-0.5 text-[11.5px] leading-4 text-danger">
          {error}
        </p>
      ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
