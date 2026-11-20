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

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
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
import { appendToDraft, requestComposerInsert, threadRefLink } from '@kiki/session-core/composer';
import { errorText } from '@kiki/session-core/i18n';
import {
  formatElapsedClock,
  hasActiveSessionFilters,
  highlightTerms,
  isPinnedSession,
  isSearchable,
  pinMetadataPatch,
  projectAttachedConversationGroups,
  buildConversationInbox,
  roomRefLink,
  sessionRowState,
  type ConversationListItem,
  type SessionRowState,
  SESSION_SORT_ORDERS,
  sessionStatusOf,
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
  readLastSessionId,
  shownPinnedNavItems,
  writeLayoutPreferences,
  type SessionArchivedFilter,
  type SessionPrivateFilter,
  type SessionSeenMap,
  type SessionListFilters,
  type SessionStatusFilter,
  type SidebarNavKey,
} from '@kiki/session-core/settings';
import { useHost } from '../host';
import { useI18n } from '../i18n';
import { ROOMS_QUERY_KEY, roomQueryKey, useBotRoomApi } from '../lib/botRooms';
import { copyTextToClipboard } from '../lib/clipboard';
import { useLayerHistory } from '../lib/layerHistory';
import { useCoarsePointer, useLayoutPreferences, useMediaQuery, usePaneResize, usePhoneMode } from '../lib/layoutHooks';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { unzoomedPoint, unzoomedRect, unzoomedViewport } from '../lib/uiZoom';
import { readExternalClientMark } from '../lib/externalClients';
import { ROOM_ITEMS_QUERY_KEY } from '../lib/useConversationList';
import { useSessionSearch, type SessionSearchState } from '../lib/sessionSearch';
import { SESSION_SEARCH_EVENT } from '../lib/sidebarSearch';
import { lifeOf, type LifeState } from '../lib/motion';
import { nestConversationItems, sessionRelationOf, type ConversationTreeNode, type SessionRelation } from '../lib/sessionThreads';
import { readTopLevelThreads, writeTopLevelThreads } from '../lib/threadDisplayMemory';
import { pushToast, runToastAction } from '../lib/toasts';
import { useThreadTitleResolver } from '../lib/threadTitles';
import { readWorkspaceGroupMemory, writeWorkspaceGroupMemory } from '../lib/sidebarGroupMemory';
import { anyOverlayOpen, registerOverlay } from '../lib/uiBusy';
import { isEditableTarget, isImeKeyEvent } from '../lib/shortcuts';
import { useConnection } from '../state/connection';
import { RelativeTime, useElapsedSince } from './RelativeTime';
import { useSessionSeen } from './ActivityPage';
import { useSessionActivity } from './ActivityPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { useGuardedNavigate } from './dirtyGuard';
import { ActionSheet } from './overlays/ActionSheet';
import { AnchoredPopover } from './overlays/AnchoredPopover';
import { LifeMark } from './LifeMark';
import { DisclosureChevron, Icon, resolvePluginSlotIconName, Spinner } from './icons';
import { SpaceSwitcher } from './SpaceSwitcher';
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
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors pointer-coarse:h-10 pointer-coarse:w-10 hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink aria-[current=page]:bg-ink/[0.06] aria-[current=page]:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';
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
  const title = session.title.trim();
  const prompt = session.last_prompt?.trim() ?? '';
  if (nestedForkParentTitle !== undefined && title.startsWith('Fork: ')) {
    const rest = title.slice(6).trim();
    if (rest !== '' && rest !== nestedForkParentTitle) return rest;
    if (prompt !== '' && prompt !== nestedForkParentTitle) return prompt;
    if (rest !== '') return rest;
  }
  if (title !== '') return session.title;
  if (prompt !== '') return session.last_prompt!;
  return untitled;
}

/** Only a fresh, active list can still carry the failure on the clicked row.
 * Inactive caches may retain an archived root; other session queries may have no pages. */
function isSessionStillListed(queryClient: QueryClient, sessionId: string): boolean {
  return queryClient.getQueryCache().findAll({ queryKey: ['sessions'], type: 'active' })
    .some(({ state }) => !state.isInvalidated && (state.data as SessionListData | undefined)?.pages?.some((page) =>
      page.items.some((item) => item.id === sessionId && item.archived !== true)) === true);
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
  return (
    <span data-session-status={state === 'read' ? 'idle' : state} className="flex h-[7px] w-[7px]">
      <LifeMark
        markId={`row:${session.id}`}
        life={life}
        still
        title={title}
        // A run that did not complete is a fact, not an alarm: a neutral
        // square (the shape still says "failed"), same as the inspector. Only
        // what needs the user carries a color of its own.
        tone={life === 'failed' ? 'bg-ink-faint' : life === 'waiting' ? 'bg-attention' : undefined}
      />
    </span>
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
          className={`row-interactive flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] pointer-coarse:h-10 ${
            current ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
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
              className="shrink-0 px-0.5 text-[12px] leading-4 font-medium text-accent-ink tabular-nums"
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
                className={`row-interactive flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] pointer-coarse:h-10 ${
                  current ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
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
                className="row-interactive flex h-7 w-full items-center gap-2 px-2 text-left text-[12px] font-medium text-ink-faint hover:text-ink transition-colors duration-[var(--kiki-motion-quick)]"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-faint">
                  <DisclosureChevron open={false} size={12} className="shrink-0" />
                </span>
                <span className="min-w-0 flex-1 truncate">{t('sidebar.moreTools')}</span>
                {foldedBadgeCount > 0 ? (
                  <span
                    data-secondary-badges-count
                    className="shrink-0 px-0.5 text-[11px] font-medium text-accent-ink tabular-nums"
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
                className="row-interactive flex h-7 w-full items-center gap-2 px-2 text-left text-[12px] font-medium text-ink-faint hover:text-ink transition-colors duration-[var(--kiki-motion-quick)]"
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
  const renderRailNavItem = (item: (typeof NAV_ITEMS)[number]) => {
    const current = location.pathname === item.route
      || (item.key === 'capabilities' && location.pathname.startsWith('/capabilities'));
    const label = item.key === 'personas' ? t('persona.nav') : item.key === 'discover' ? t('discovery.title') : t(`nav.${item.key}`);
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
        {secondaryRailItems.map(renderRailNavItem)}
      </nav>
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
  onClose,
  nowMs,
}: {
  activeSessionId: string | undefined;
  /** Every loaded session (unfiltered); the pending badge and search read it. */
  sessions: readonly Session[];
  /** Cross-workspace session snapshot for persona activity when `sessions` is workspace-filtered. */
  personaSessions?: readonly Session[];
  rooms?: readonly RoomListItem[];
  /** Filtered, sorted, grouped conversations (threads and rooms interleaved). */
  sessionGroups: readonly SessionGroup<ConversationListItem>[];
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
  /** Phone-drawer exit (a ✕ in the wordmark row); absent where the sidebar is docked. */
  onClose?: () => void;
  /** Current time reference for time grouping and the recency projection;
   *  defaults to `Date.now()`. */
  nowMs?: number;
}) {
  const host = useHost();
  const navigate = useGuardedNavigate();
  const { client, scopeId } = useConnection();
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
      for (const session of rawSessions) titles.set(`session:${session.id}`, session.title);
      for (const room of rawRooms) titles.set(`room:${room.id}`, room.title);
      const next = new Map(current);
      for (const [key, override] of current) {
        const title = titles.get(key);
        if (title !== undefined && title !== override.from) next.delete(key);
      }
      return next.size === current.size ? current : next;
    });
  }, [rawSessions, rawRooms, rawSessionGroups, renamedTitles]);
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
  const [topLevelThreads, setTopLevelThreads] = useState(() => readTopLevelThreads(scopeId));
  const memoryScope = useRef(scopeId);
  useEffect(() => {
    if (memoryScope.current === scopeId) return;
    memoryScope.current = scopeId;
    const memory = readWorkspaceGroupMemory(scopeId);
    setCollapsedGroups(new Set(memory.collapsed));
    setExpandedGroups(new Set(memory.expanded));
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
  const seen = useSessionSeen();
  const inbox = useMemo(() => buildConversationInbox(sessions, rooms, seen, workspaceOptions), [sessions, rooms, seen, workspaceOptions]);
  // Blocked-only keeps the "needs you" wording; once finished runs are in the
  // count too, the label says "new items" instead of overstating urgency.
  const activityLabel = inbox.total === 0
    ? t('sidebar.activityAria')
    : inbox.needsYou.length === inbox.total
      ? tp('sidebar.activityCount', inbox.total)
      : tp('activity.badgeCount', inbox.total);
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
  const layoutPrefs = useLayoutPreferences();
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
  const isCollapsed = isDesktop && (layoutPrefs.sidebarCollapsed ?? isNarrowDesktop);

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
  const visibleSessions = useMemo(
    () => sessionGroups.flatMap((group) => group.items).flatMap((item) => (item.kind === 'session' ? [item.session] : [])),
    [sessionGroups],
  );
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
  const searchableSessions = useMemo(
    () => (!searchMounted ? EMPTY_SESSIONS : narrowsBeyondWorkspace ? visibleSessions : sessions.filter((session) => session.archived !== true && session.private !== true)),
    [searchMounted, narrowsBeyondWorkspace, visibleSessions, sessions],
  );
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

  const togglePin = (session: Session) => {
    setMenu(null);
    setActionError(null);
    const next = togglePinned(isPinnedSession(session));
    const metadata = pinMetadataPatch(session, next);
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
    const patchSessionLists = (transform: (entry: Session) => Session) => {
      queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
        old === undefined || !Array.isArray(old.pages)
          ? old
          : {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.map((entry) => (entry.id === session.id ? transform(entry) : entry)),
              })),
            },
      );
      if (queryClient.getQueryData(['session', session.id]) !== undefined) {
        queryClient.setQueryData<Session>(['session', session.id], (old) =>
          old === undefined ? old : transform(old),
        );
      }
    };
    const previousMetadata = session.metadata;
    patchSessionLists((entry) => applyPatch(entry));
    void client
      .updateSessionProfile(session.id, { metadata })
      .then((updated) => {
        patchSessionLists((entry) => applyPatch(entry, updated));
        void queryClient.invalidateQueries({
          queryKey: ['sessions'],
          predicate: (query) =>
            !Array.isArray((query.state.data as SessionListData | undefined)?.pages) ||
            JSON.stringify(query.queryKey).includes('"pinned"'),
        });
      })
      .catch((error: unknown) => {
        patchSessionLists((entry) => ({ ...entry, metadata: previousMetadata }));
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };

  const togglePrivate = (session: Session) => {
    setMenu(null);
    if (pendingPrivacyRef.current.has(session.id)) return;
    pendingPrivacyRef.current.add(session.id);
    setPendingPrivacy((current) => new Set(current).add(session.id));
    setActionError(null);
    const nextPrivate = session.private !== true;
    void client
      .updateSession(session.id, { private: nextPrivate })
      .then((updated) => {
        queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
          old === undefined || !Array.isArray(old.pages)
            ? old
            : {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) => (item.id === session.id ? { ...item, ...updated, private: nextPrivate } : item)),
                })),
              },
        );
        if (queryClient.getQueryData(['session', session.id]) !== undefined) {
          queryClient.setQueryData<Session>(['session', session.id], (old) =>
            old === undefined ? old : { ...old, ...updated, private: nextPrivate },
          );
        }
        refreshSessions();
        void queryClient.invalidateQueries({ queryKey: ['global-search'] });
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
      pages: old.pages.map((page) => ({
        ...page,
        items: page.items.map((session) => ids.has(session.id) ? { ...session, archived: true } : session),
      })),
    });
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

  const archive = (session: Session, key: string) => {
    setMenu(null);
    setActionError(null);
    // A worktree session asks once whether its checkout goes too.
    if (session.worktree !== undefined) {
      setConfirmArchiveWorktree(session);
      return;
    }
    if (pendingArchives.has(key)) return;
    beginArchive(key);
    // Archiving a parent takes its attached conversations with it. The only
    // rows held back are the ones explicitly promoted to the top level — that
    // preference, read from this space's display memory, and nothing derived
    // from what happens to be loaded, filtered, grouped or paged in.
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

  const restore = (session: Session) => {
    setMenu(null);
    setActionError(null);
    void client
      .restoreSession(session.id)
      .then(() => { refreshSessions(); })
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
      items.push({ key: `s:${match.session.id}`, open: () => { void navigate(`/s/${match.session.id}`); } });
    }
    search.hits.forEach((hit, index) => {
      items.push({
        key: `h:${index}`,
        open: () => {
          const route = hit.agent_id && hit.agent_id !== 'main'
            ? `/s/${encodeURIComponent(hit.session_id)}/agent/${encodeURIComponent(hit.agent_id)}`
            : `/s/${encodeURIComponent(hit.session_id)}`;
          const params = new URLSearchParams();
          if (hit.turn !== undefined) params.set('turn', String(hit.turn));
          if (hit.step_id !== undefined && hit.step_id !== '') params.set('step', hit.step_id);
          if (search.parsed.text.trim() !== '') params.set('q', search.parsed.text.trim());
          const qs = params.toString();
          void navigate(qs === '' ? route : `${route}?${qs}`);
        },
      });
    });
    return items;
    // setFilters closes over the latest filters; recompute with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchingPersonas, search.local, search.hits, filters, navigate]);
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
  const counts = { running: activity.model.running.length };
  // The status filter offers only the states some session is in right now,
  // among the archived ones the list shows: an entry with nothing behind it
  // ("process cleanup unconfirmed" on a quiet day) is a choice nobody can use.
  const presentStatuses = useMemo(() => new Set<SessionStatusFilter>(sessions
    .filter((session) => (filters.archived === 'only' ? session.archived === true
      : filters.archived === 'hide' ? session.archived !== true : true))
    .filter((session) => (privateFilter === 'only' ? session.private === true
      : privateFilter === 'hide' ? session.private !== true : true))
    .map((session) => sessionStatusOf(session))), [sessions, filters.archived, privateFilter]);

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeWorkspaceGroupMemory(scopeId, { collapsed: [...next] });
      return next;
    });
  };
  const toggleGroupExpanded = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeWorkspaceGroupMemory(scopeId, { expanded: [...next] });
      return next;
    });
  };
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
  const onListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const top = event.currentTarget.scrollTop;
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { writeWorkspaceGroupMemory(scopeId, { scrollTop: top }); }, 150);
  };
  useEffect(() => () => { clearTimeout(scrollTimer.current); }, []);
  useEffect(() => { scrollRestored.current = false; }, [search.active, scopeId]);
  useLayoutEffect(() => {
    const node = listRef.current;
    if (node === null || scrollRestored.current || sessionGroups.length === 0) return;
    scrollRestored.current = true;
    const top = readWorkspaceGroupMemory(scopeId).scrollTop;
    if (top > 0) node.scrollTop = top;
  });

  // Threads a session started (ThreadCreate) and branches forked off it nest
  // under it. When ordered by update recency, an attached child's activity
  // lifts the parent family to the child's recency bucket while preserving
  // each session's own timestamp and relation facts. Explicitly promoted
  // top-level threads stay independent.
  // Time buckets are not meaningful for an attached thread — it belongs with
  // its creator — so there a child follows its parent across buckets; the
  // workspace and pinned buckets are meaningful, so nesting stays inside one.
  // Rooms never nest: a room has no creator session, and none names it parent.
  const sessionTree = useMemo(() => {
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
  }, [sessionGroups, groupBy, topLevelThreads, sortBy, sessions, t, nowMs]);
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
    refetchInterval: 15_000,
    enabled: inert !== true,
  });
  const ephemeralSessions = useMemo(
    () => ephemeralQuery.data?.pages.flatMap((page) => page.items) ?? EMPTY_SESSIONS,
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
    ? sessionTree.map((group) => group.key)
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
    return [...byId.values()];
  }, [sessions, ephemeralSessions, sessionGroups]);
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
    for (const session of sessions) {
      const label = sessionLabel(session, untitled);
      map.set(session.id, label.includes('[[') || label.includes('/s/') ? resolveTitle(label) : label);
    }
    return map;
  }, [sessions, untitled, resolveTitle]);

  type SidebarFlatEntry =
    | {
        readonly kind: 'ws-header';
        readonly key: string;
        readonly group: (typeof sessionTree)[number];
        readonly collapsed: boolean;
        readonly foldedLife: LifeState;
        readonly workspace: WorkspaceCatalogEntry | undefined;
        readonly workspaceTarget: WorkspaceCatalogEntry | undefined;
        readonly isFirst: boolean;
      }
    | {
        readonly kind: 'time-header';
        readonly key: string;
        readonly group: (typeof sessionTree)[number];
        readonly isFirst: boolean;
      }
    | {
        readonly kind: 'row';
        readonly key: string;
        readonly groupKey: string;
        readonly node: ConversationTreeNode;
        readonly nested: boolean;
        readonly groupNamesWorkspace: boolean;
      }
    | {
        readonly kind: 'group-more';
        readonly key: string;
        readonly groupKey: string;
        readonly hidden: number;
        readonly expanded: boolean;
      };

  const flatSessionEntries = useMemo<readonly SidebarFlatEntry[]>(() => {
    const entries: SidebarFlatEntry[] = [];
    const collapsible = groupBy === 'workspace';
    for (let groupIndex = 0; groupIndex < sessionTree.length; groupIndex += 1) {
      const group = sessionTree[groupIndex]!;
      const collapsed = collapsible && !foldsSuspended && collapsedGroups.has(group.key);
      const expanded = expandedGroups.has(group.key);
      const limit = collapsible && !expanded && group.key !== 'pinned' ? WORKSPACE_GROUP_PREVIEW : Infinity;
      const shown = collapsed ? [] : group.nodes.slice(0, limit);
      const hidden = collapsed ? 0 : group.nodes.length - shown.length;
      const groupNamesWorkspace = collapsible && group.key !== 'pinned' && group.key !== WORKSPACE_UNGROUPED_KEY;
      const isFirst = groupIndex === 0;

      if (collapsible) {
        const workspace = workspaceById.get(group.key);
        const workspaceTarget = workspace !== undefined && groupNamesWorkspace ? workspace : undefined;
        const foldedLife = collapsed ? foldedGroupLife(group.nodes, seen) : 'idle';
        entries.push({
          kind: 'ws-header',
          key: `hdr:${group.key}`,
          group,
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
          group,
          isFirst,
        });
      }

      const pushNode = (node: ConversationTreeNode, nested: boolean) => {
        entries.push({
          kind: 'row',
          key: `${group.key}:${node.item.key}`,
          groupKey: group.key,
          node,
          nested,
          groupNamesWorkspace,
        });
        for (const child of node.children) {
          pushNode(child, true);
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
    return entries;
  }, [sessionTree, groupBy, foldsSuspended, collapsedGroups, expandedGroups, workspaceById, seen]);

  const listWindowed = !isCollapsed && !search.active && flatSessionEntries.length > SIDEBAR_VIRTUALIZE_THRESHOLD;
  const virtualAnchorRef = useRef<HTMLDivElement | null>(null);
  const [listScrollMargin, setListScrollMargin] = useState(0);
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
    observer.observe(scroller);
    return () => { observer.disconnect(); };
  }, [listWindowed, flatSessionEntries.length, ephemeralSessions.length, filterChips.length]);

  const listVirtualizer = useVirtualizer({
    count: listWindowed ? flatSessionEntries.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => {
      const entry = flatSessionEntries[index];
      if (entry === undefined) return 46;
      if (entry.kind === 'ws-header') return entry.isFirst ? 28 : (entry.collapsed ? 30 : 40);
      if (entry.kind === 'time-header') return entry.isFirst ? 28 : 40;
      if (entry.kind === 'group-more') return 28;
      return entry.nested ? 34 : 46;
    },
    getItemKey: (index) => flatSessionEntries[index]?.key ?? index,
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
        <div className="min-w-0 flex-1"><SpaceSwitcher /></div>
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
          {inbox.total > 0 ? (
            inbox.needsYou.length > 0 ? (
              <span
                data-activity-badge={inbox.total}
                data-activity-badge-tone="needs-you"
                aria-hidden
                className="pointer-events-none absolute top-1 right-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-attention px-[3px] text-[10px] leading-none font-semibold tabular-nums text-on-accent ring-2 ring-canvas"
              >
                {inbox.needsYou.length > 99 ? '99+' : inbox.needsYou.length}
              </span>
            ) : (
              <span
                data-activity-badge={inbox.total}
                data-activity-badge-tone="unread"
                aria-hidden
                className="pointer-events-none absolute top-1.5 right-1.5 h-[7px] w-[7px] rounded-full bg-ink-soft/65 ring-2 ring-canvas"
              />
            )
          ) : null}
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
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-medium text-ink transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] pointer-coarse:h-10"
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
            className="h-8 w-full rounded-lg border border-transparent bg-transparent pr-7 pl-7 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-ink/[0.04] focus:border-hairline-strong focus:bg-paper focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:text-[16px]"
          />
          {searchInput === '' ? (
            <kbd aria-hidden className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-hairline px-1 font-sans text-[11px] leading-4 text-ink-faint pointer-coarse:hidden">/</kbd>
          ) : (
            <button
              type="button"
              aria-label={t('sidebar.clearSearch')}
              onClick={() => { setSearchInput(''); searchRef.current?.focus(); }}
              className="absolute top-1/2 right-1 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-faint transition-colors hover:bg-hairline hover:text-ink pointer-coarse:h-9 pointer-coarse:w-9"
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
            workspaceNames={workspaceNameById}
          />
        </>
      ) : (
      <div ref={listRef} onScroll={onListScroll} className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2" data-session-list role="region" aria-label={t('sidebar.listAria')}>
        <SidebarPersonaSection sessions={personaSessions ?? sessions} activeSessionId={activeSessionId} seen={seen} workspaceOptions={workspaceOptions} rooms={rooms} />

        <div className="flex items-center gap-0.5 pt-2 pr-0 pb-0.5 pl-2">
          {/* The section label never gives way: it is T5, unshrinkable and
              single-line; the shortcuts beside it are what yield when the
              sidebar is dragged narrow. "Needs you" is counted once, on the
              bell above — here only the aggregate running mark remains. */}
          <h2 className="shrink-0 text-[12px] leading-4 font-medium whitespace-nowrap text-section-ink">{t('sidebar.results.sessions')}</h2>
          <span className="min-w-0 flex-1" />
          {counts.running > 0 ? (
            <button
              type="button"
              data-status-shortcut="running"
              data-activity-summary
              aria-pressed={filters.status.includes('running')}
              title={tp('sidebar.runningCount', counts.running)}
              onClick={() => { toggleStatus('running'); }}
              className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-soft tabular-nums transition-colors hover:bg-ink/[0.05] hover:text-ink aria-pressed:bg-ink/[0.06] aria-pressed:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
            >
              <LifeMark markId="sidebar:running" life="working" className="h-1.5 w-1.5" />
              <span className="min-w-0 truncate">{tp('sidebar.runningCount', counts.running)}</span>
            </button>
          ) : null}
          {workspaceGroupKeys.length > 1 && !foldsSuspended ? (
            <button
              type="button"
              data-session-groups-fold-all={allFolded ? 'expand' : 'collapse'}
              aria-label={allFolded ? t('sidebar.expandAllGroups') : t('sidebar.collapseAllGroups')}
              title={allFolded ? t('sidebar.expandAllGroups') : t('sidebar.collapseAllGroups')}
              onClick={() => { setAllGroupsCollapsed(workspaceGroupKeys, !allFolded); }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md pointer-coarse:h-10 pointer-coarse:w-10 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
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
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md pointer-coarse:h-10 pointer-coarse:w-10 transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink ${filtersActive ? 'text-selected-ink' : 'text-ink-faint'}`}
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
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md pointer-coarse:h-10 pointer-coarse:w-10 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink"
          >
            <Icon name="sliders" size={14} />
          </button>
        </div>

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
              className="font-medium text-ink underline underline-offset-2"
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
              className="font-medium text-ink underline underline-offset-2"
            >
              {t('common.retry')}
            </button>
          </p>
        ) : null}
        {sessionGroups.length === 0 && !sessionsQuery.isLoading && !sessionsQuery.isError ? (
          <div className="px-2 pt-4" data-sidebar-empty>
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              {filtersActive ? t('sidebar.noFilterMatches') : t('sidebar.noSessions')}
            </p>
            {filtersActive ? (
              <button
                type="button"
                onClick={() => { onFiltersChange({ status: [], workspaces: [], archived: 'hide' }); }}
                className="mt-1 text-[12px] font-medium text-ink underline underline-offset-2"
              >
                {t('sidebar.clearAllFilters')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { setFilters({ archived: 'include' }); }}
                className="mt-1 text-[12px] font-medium text-ink underline underline-offset-2"
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
            <span className="min-w-0 flex-1 truncate font-medium tabular-nums">{t('room.selectionCount', { count: selected.size })}</span>
            <button type="button" data-session-selection-room
              disabled={threadCommsEnabled === false || selected.size < 2}
              title={threadCommsEnabled === false ? t('room.commsOff') : selected.size < 2 ? t('room.threadsNeeded') : undefined}
              onClick={() => { setRoomDraft(sessions.filter((item) => selected.has(item.id))); }}
              className="h-7 shrink-0 rounded-md px-2 font-medium transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-55">
              {t('room.fromThreads')}
            </button>
            <button type="button" data-session-selection-clear aria-label={t('room.clearSelection')} title={t('room.clearSelection')}
              onClick={() => { setSelected(new Set()); }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md pointer-coarse:h-10 pointer-coarse:w-10 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
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
            <p data-session-group="ephemeral" className="flex min-h-7 w-full shrink-0 items-center gap-2 px-2 py-1.5 text-left text-[12px] leading-4 font-medium text-section-ink">
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
                  onOpen={() => { void navigate(`/s/${session.id}`); }}
                  onMenu={() => undefined}
                  onTogglePin={() => undefined}
                  seen={seen}
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
            style={{ height: listVirtualizer.getTotalSize() }}
          >
            {listVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = flatSessionEntries[virtualRow.index];
              if (entry === undefined) return null;
              let content: React.ReactNode;
              if (entry.kind === 'ws-header') {
                content = (
                  <div
                    data-session-group-block={entry.group.key}
                    data-session-group-folded={entry.collapsed ? '' : undefined}
                    className={entry.isFirst ? '' : entry.collapsed ? 'pt-0.5' : 'pt-3'}
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
                  <div data-session-group-block={entry.group.key} className={entry.isFirst ? '' : 'pt-3'}>
                    <p data-session-group={entry.group.key} className="flex min-h-7 w-full shrink-0 items-center gap-2 px-2 py-1.5 text-left text-[12px] leading-4 font-medium text-section-ink">
                      <span className="min-w-0 truncate">{entry.group.label}</span>
                    </p>
                  </div>
                );
              } else if (entry.kind === 'group-more') {
                content = (
                  <div className="pt-0.5">
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
              } else {
                const { node, nested, groupNamesWorkspace } = entry;
                const item = node.item;
                if (item.kind === 'room') {
                  const roomLocation = workspaceNameById.get(item.workspace_id)
                    ?? (item.room.workspace === '' ? undefined : shortCwd(item.room.workspace));
                  content = (
                    <div data-session-node="root" className="py-px">
                      <RoomConversationRow
                        item={item}
                        active={location.pathname === item.href}
                        menuOpen={menu?.item.key === item.key}
                        showLocation={!groupNamesWorkspace}
                        showPin={groupBy === 'none'}
                        location={roomLocation}
                        onOpen={() => { void navigate(item.href); }}
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
                  content = (
                    <div data-session-node={nested ? 'thread' : 'root'} className="relative py-px">
                      {nested ? (
                        <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 left-[13px] w-px bg-hairline" />
                      ) : null}
                      <SessionRow
                        session={session}
                        active={session.id === activeSessionId}
                        menuOpen={menu?.item.key === item.key}
                        untitled={untitled}
                        resolveTitle={resolveTitle}
                        activity={activity.byId.get(session.id)}
                        anchorFor={activity.anchorFor}
                        relation={node.relation}
                        nested={nested}
                        showLocation={!groupNamesWorkspace}
                        showPin={groupBy === 'none'}
                        parentTitle={node.relation === undefined
                          ? undefined
                          : titleOf.get(node.relation.parentId) ?? t('sidebar.thread.unknownParent')}
                        onOpen={() => { void navigate(`/s/${session.id}`); }}
                        selected={selected.has(session.id)}
                        onToggleSelect={session.archived === true || isSubagentSession(session) ? undefined : () => { toggleSelected(session); }}
                        onMenu={(x, y, toggle) => {
                          setMenu((current) =>
                            toggle && current?.item.key === item.key ? null : { item, x, y });
                        }}
                        onTogglePin={() => { togglePin(session); }}
                        seen={seen}
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
                  ref={listVirtualizer.measureElement}
                  className="absolute inset-x-0"
                  style={{ top: virtualRow.start - listScrollMargin }}
                >
                  {content}
                </div>
              );
            })}
          </div>
        ) : sessionTree.map((group) => {
          // In the workspace view every bucket, Pinned included, uses the one
          // workspace header: fold, count, remembered state. Pinned keeps
          // every row visible (those are the sessions asked to stay on top).
          const collapsible = groupBy === 'workspace';
          const collapsed = collapsible && !foldsSuspended && collapsedGroups.has(group.key);
          const expanded = expandedGroups.has(group.key);
          const limit = collapsible && !expanded && group.key !== 'pinned' ? WORKSPACE_GROUP_PREVIEW : Infinity;
          const shown = collapsed ? [] : group.nodes.slice(0, limit);
          const hidden = collapsed ? 0 : group.nodes.length - shown.length;
          // Only a real workspace bucket names the location in its header;
          // Pinned and Ungrouped are organizational buckets, not places.
          const groupNamesWorkspace = collapsible && group.key !== 'pinned' && group.key !== WORKSPACE_UNGROUPED_KEY;
          const renderRow = (node: ConversationTreeNode, nested: boolean) => {
            const item = node.item;
            if (item.kind === 'room') {
              // Location line, like a thread row's cwd: the resolved workspace
              // name when registered, else the room's own root path shortened.
              const roomLocation = workspaceNameById.get(item.workspace_id)
                ?? (item.room.workspace === '' ? undefined : shortCwd(item.room.workspace));
              return (
                <div key={item.key} data-session-node="root">
                  <RoomConversationRow
                    item={item}
                    active={location.pathname === item.href}
                    menuOpen={menu?.item.key === item.key}
                    showLocation={!groupNamesWorkspace}
                    showPin={groupBy === 'none'}
                    location={roomLocation}
                    onOpen={() => { void navigate(item.href); }}
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
            }
            const session = item.session;
            const threads = node.children;
            return (
              <div key={item.key} data-session-node={nested ? 'thread' : 'root'}>
                <SessionRow
                  session={session}
                  active={session.id === activeSessionId}
                  menuOpen={menu?.item.key === item.key}
                  untitled={untitled}
                  resolveTitle={resolveTitle}
                  activity={activity.byId.get(session.id)}
                  anchorFor={activity.anchorFor}
                  relation={node.relation}
                  nested={nested}
                  showLocation={!groupNamesWorkspace}
                  showPin={groupBy === 'none'}
                  parentTitle={node.relation === undefined
                    ? undefined
                    : titleOf.get(node.relation.parentId) ?? t('sidebar.thread.unknownParent')}
                  onOpen={() => { void navigate(`/s/${session.id}`); }}
                  selected={selected.has(session.id)}
                  onToggleSelect={session.archived === true || isSubagentSession(session) ? undefined : () => { toggleSelected(session); }}
                  onMenu={(x, y, toggle) => {
                    setMenu((current) =>
                      toggle && current?.item.key === item.key ? null : { item, x, y });
                  }}
                  onTogglePin={() => { togglePin(session); }}
                  seen={seen}
                  justRenamed={justRenamed?.key === item.key}
                  archiving={pendingArchives.has(item.key)}
                  archiveError={archiveErrors.get(item.key)}
                />
                {threads.length > 0 ? (
                  <div data-session-threads={session.id} className="relative mt-0.5 flex flex-col gap-0.5">
                    <span aria-hidden className="pointer-events-none absolute top-1.5 bottom-1.5 left-[13px] w-px bg-hairline" />
                    {threads.map((child) => renderRow(child, true))}
                  </div>
                ) : null}
              </div>
            );
          };
          // The workspace view gives every bucket (workspaces, Pinned,
          // Ungrouped) one header, WorkspaceGroupHeader: fold, count, the
          // current-workspace mark, pin, and — for a registered workspace —
          // a new-session plus. Time buckets keep the plain T5 label, 28px
          // tall. A folded group still says when something inside needs you
          // or is running.
          const foldedLife = collapsed ? foldedGroupLife(group.nodes, seen) : 'idle';
          if (collapsible) {
            const workspace = workspaceById.get(group.key);
            const workspaceTarget = workspace !== undefined && groupNamesWorkspace ? workspace : undefined;
            return (
              <div
                key={group.key}
                data-session-group-block={group.key}
                data-session-group-folded={collapsed ? '' : undefined}
                // Folded workspaces stack like a list of places; an open one
                // takes a full step of air (S4) so its rows read as its own.
                className={`flex flex-col gap-0.5 ${collapsed ? 'not-first:mt-0.5' : 'not-first:mt-3'}`}
                role="group"
                aria-label={group.label}
              >
                <WorkspaceGroupHeader
                  groupKey={group.key}
                  label={group.label}
                  count={group.total}
                  totalCount={filtersActive ? (group.key === 'pinned' ? pinnedTotal : workspaceTotals.get(group.key)) : undefined}
                  collapsed={collapsed}
                  foldable={!foldsSuspended}
                  current={group.key === activeWorkspaceId}
                  foldedLife={foldedLife}
                  workspace={workspace}
                  pinBusy={workspacePinBusy}
                  onToggle={() => { toggleGroupCollapsed(group.key); }}
                  onTogglePin={workspace === undefined ? undefined : () => { toggleWorkspacePin(workspace); }}
                  onNewInWorkspace={workspaceTarget === undefined ? undefined : () => {
                    void navigate(`/new?workspace=${encodeURIComponent(workspaceTarget.id)}`);
                  }}
                />
                {shown.map((node) => renderRow(node, false))}
                {hidden > 0 || (expanded && !collapsed && group.nodes.length > WORKSPACE_GROUP_PREVIEW) ? (
                  <button
                    type="button"
                    data-session-group-more={group.key}
                    onClick={() => { toggleGroupExpanded(group.key); }}
                    className="row-interactive h-7 self-start pr-2 pl-6 text-[12px] text-ink-faint hover:text-ink"
                  >
                    {hidden > 0 ? t('sidebar.showMoreInGroup', { count: hidden }) : t('sidebar.showLessInGroup')}
                  </button>
                ) : null}
              </div>
            );
          }
          const headerClass = 'flex min-h-7 w-full shrink-0 items-center gap-2 px-2 py-1.5 text-left text-[12px] leading-4 font-medium text-section-ink';
          return (
            <div
              key={group.key}
              data-session-group-block={group.key}
              className="flex flex-col gap-0.5 not-first:mt-3"
              role="group"
              aria-label={group.label}
            >
              {groupBy === 'none' && group.key === 'all' ? null : (
                <p data-session-group={group.key} className={headerClass}>
                  <span className="min-w-0 truncate">{group.label}</span>
                </p>
              )}
              {shown.map((node) => renderRow(node, false))}
            </div>
          );
        })}
        {sessionsQuery.hasNextPage ? (
          <button
            type="button"
            data-session-load-more
            disabled={sessionsQuery.isFetchingNextPage}
            onClick={() => void sessionsQuery.fetchNextPage?.()}
            className="mt-1 h-8 w-full rounded-lg px-2 text-center text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink-soft disabled:opacity-60"
          >
            {sessionsQuery.isFetchingNextPage ? t('sidebar.loadingMore') : t('sidebar.loadMore')}
          </button>
        ) : null}
      </div>
      )}

      {/* Footer: one row — Settings, then the connection while it is down,
        * then the collapse toggle (it keeps its place at the end whether or
        * not the connection words are there). The row never overlaps the
        * list above it: it is a flex sibling, not an overlay, and the list
        * keeps bottom padding for its last row. */}
      <div className="relative flex h-12 shrink-0 items-center gap-1 px-2.5" data-sidebar-footer>
        <button
          type="button"
          data-nav-settings
          aria-current={location.pathname.startsWith('/settings') ? 'page' : undefined}
          onClick={() => { void navigate('/settings'); }}
          className={`row-interactive flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-left text-[13px] pointer-coarse:h-11 ${
            location.pathname.startsWith('/settings') ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
          }`}
        >
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${location.pathname.startsWith('/settings') ? 'text-ink' : 'text-ink-faint'}`}><Icon name="settings" size={16} className={ICON} /></span>
          <span className="min-w-0 flex-1 truncate">{t('sidebar.settings')}</span>
        </button>
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
        <SessionMenu
          session={menuItem.session}
          title={resolveTitle(sessionLabel(menuItem.session, untitled))}
          topLevel={topLevelThreads.has(menuItem.id)}
          onToggleThreadDisplay={() => { toggleThreadDisplay(menuItem.id); }}
          scopeId={scopeId}
          activeSessionId={activeSessionId}
          x={menu!.x}
          y={menu!.y}
          onClose={() => { setMenu(null); }}
          onRename={() => {
            setRenaming(menuItem);
            setMenu(null);
          }}
          onTogglePin={() => { togglePin(menuItem.session); }}
          onTogglePrivate={() => { togglePrivate(menuItem.session); }}
          onCreateBranch={(seed) => { runCreateBranch(menuItem.session, seed); }}
          onForkSession={(seed) => { runForkSession(menuItem.session, seed); }}
          onAction={(action) => { runAction(menuItem.session, action); }}
          onArchive={() => { archive(menuItem.session, menuItem.key); }}
          onRestore={() => { restore(menuItem.session); }}
          archiving={pendingArchives.has(menuItem.key)}
          privateBusy={pendingPrivacy.has(menuItem.id)}
          threadCommsEnabled={threadCommsEnabled}
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
                      pages: old.pages.map((page) => ({
                        ...page,
                        items: page.items.map((entry) => (entry.id === target.id ? mergeUpdated(entry) : entry)),
                      })),
                    },
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
            try {
              const updated = await client.updateSessionProfile(target.id, { title });
              if (renameSequences.current.get(target.key) !== sequence) return;
              patchSessionTitle(title, updated);
              setJustRenamed((prev) => ({ key: target.key, seq: (prev?.seq ?? 0) + 1 }));
              setRenaming((current) => current === target ? null : current);
              void queryClient.invalidateQueries({
                queryKey: ['sessions'],
                predicate: (query) => !Array.isArray((query.state.data as SessionListData | undefined)?.pages),
              });
              if (target.session.agent_config?.persona !== undefined) {
                invalidatePersonaSessionLists(queryClient);
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
          onClose={() => { setConfirmArchiveWorktree(null); }}
          onArchiveFailed={() => { refreshSessions(); }}
          onArchived={(result) => {
            const archivedRootId = confirmArchiveWorktree.id;
            setConfirmArchiveWorktree(null);
            void queryClient.invalidateQueries({ queryKey: ['archived-sessions'] }).catch(() => undefined);
            refreshSessions();
            const archivedSet = new Set<string>([archivedRootId]);
            for (const candidate of sessions) {
              if (sessionRelationOf(candidate)?.parentId === archivedRootId && !topLevelThreads.has(candidate.id)) {
                archivedSet.add(candidate.id);
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
function SessionRow({
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
  parentTitle,
  onOpen,
  onMenu,
  onTogglePin,
  seen,
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
  /** True while the row sits indented under the session it came from. */
  nested?: boolean;
  /** False when the grouping already says where the session lives. */
  showLocation?: boolean;
  /** True only when no Pinned group exists to say it. */
  showPin?: boolean;
  parentTitle?: string;
  onOpen: () => void;
  onMenu: (x: number, y: number, toggle: boolean) => void;
  onTogglePin: () => void;
  /** Local read-state marks; drives the unread state. */
  seen: SessionSeenMap;
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
  const rowState = sessionRowState(session, seen);
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
  const relationNote = relation !== undefined && parentTitle !== undefined
    ? t(
        relation.kind === 'branch'
          ? 'sidebar.thread.branchedFrom'
          : relation.kind === 'fork'
            ? 'sidebar.thread.forkedFrom'
            : 'sidebar.thread.from',
        { title: parentTitle },
      )
    : undefined;
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
  const fact: { kind: 'needs-you' | 'cleanup-pending' | 'failed' | 'live' | 'archiving' | 'archive-error' | 'relation'; text: string; detail?: string } | undefined = archiveStatus !== undefined
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
        : relationNote !== undefined
          ? { kind: 'relation', text: relationNote }
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
  const emphasis = active || rowState === 'needs-me' || rowState === 'unread';
  const archiveState = archiveError !== undefined ? 'failed' : archiving ? 'archiving' : undefined;
  const hasFacts = location !== undefined || fact !== undefined || archived || session.worktree !== undefined || externalSource !== undefined;
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
        className={`row-interactive flex w-full gap-2 py-1.5 pr-2 text-left ${selected ? 'bg-ink/[0.05] shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]' : ''} ${
          nested ? 'min-h-8 items-center pl-6' : 'items-start pl-2'
        }`}
      >
        <span className="flex h-[19px] w-[7px] shrink-0 items-center">
          <StatusMark session={session} state={rowState} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            data-session-title
            className={`flex items-center gap-1 text-[13px] leading-[19px] ${
              emphasis
                ? 'font-medium text-ink'
                : archived
                  ? 'text-ink-faint'
                  : rowState === 'running'
                    ? 'text-ink'
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
                <span data-session-location className="min-w-0 flex-1 truncate" title={locationPath}>{location}</span>
              )}
              {location === undefined || fact === undefined ? null : <span aria-hidden>·</span>}
              {fact === undefined ? null : fact.kind === 'needs-you' ? (
                <span data-session-needs-you className="min-w-0 truncate font-medium text-attention">{fact.text}</span>
              ) : fact.kind === 'cleanup-pending' ? (
                <span data-session-cleanup-pending className="min-w-0 truncate text-ink-soft">{fact.text}</span>
              ) : fact.kind === 'failed' ? (
                <span
                  data-session-failed
                  className="min-w-0 truncate text-ink-soft"
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
              ) : fact.kind === 'relation' ? (
                // Could not nest (the creator is filtered out or not loaded).
                <span data-session-relation-note={relation?.kind} className="min-w-0 truncate">{fact.text}</span>
              ) : null}
              <WorktreeMark worktree={session.worktree} className={fact === undefined && location === undefined ? 'max-w-full' : 'max-w-[40%] shrink-0'} />
              {archived ? <span className="shrink-0">{fact === undefined && location === undefined ? '' : '· '}{t('sidebar.archived')}</span> : null}
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
            className={`flex h-7 w-7 items-center justify-center rounded-md pointer-coarse:h-10 pointer-coarse:w-10 [@media(hover:none)]:hidden transition-colors hover:bg-ink/[0.06] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${
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
          className="flex h-7 w-7 items-center justify-center rounded-md pointer-coarse:h-10 pointer-coarse:w-10 text-[13px] leading-none text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      )}
    </div>
  );
}

/**
 * A room row is a thread row with one kind glyph: the `#` the room page's
 * header also uses. Same status slot, same weight rules (active / needs you /
 * unread carry the emphasis), same trailing time that yields to the hover
 * actions, same one-fact second line. A room never nests and never hosts.
 */
function RoomConversationRow({
  item,
  active,
  menuOpen,
  showLocation = true,
  showPin = false,
  location,
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
  const hasFacts = visibleLocation !== undefined || fact !== undefined || archived;
  const markTitle =
    state === 'needs-me'
      ? needsYouText
      : state === 'running'
        ? t('sidebar.status.working')
        : state === 'unread'
          ? (item.failed ? t('sidebar.rowState.failed') : t('sidebar.rowState.unread'))
          : undefined;
  const emphasis = active || state === 'needs-me' || state === 'unread';
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
        className="row-interactive flex w-full items-start gap-2 py-1.5 pr-2 pl-2 text-left"
      >
        <span className="flex h-[19px] w-[7px] shrink-0 items-center">
          <span data-room-status={state === 'read' ? 'idle' : state} className="flex h-[7px] w-[7px]">
            <LifeMark
              markId={`row:${item.key}`}
              life={life}
              still
              title={markTitle}
              tone={life === 'failed' ? 'bg-ink-faint' : life === 'waiting' ? 'bg-attention' : undefined}
            />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span
            data-room-title
            className={`flex items-center gap-1 text-[13px] leading-[19px] ${
              emphasis
                ? 'font-medium text-ink'
                : archived
                  ? 'text-ink-faint'
                  : state === 'running'
                    ? 'text-ink'
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
              <span data-room-needs-you className="min-w-0 truncate font-medium text-attention">{fact.text}</span>
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
            {archived ? <span className="shrink-0">{visibleLocation === undefined && fact === undefined ? '' : '· '}{t('sidebar.archived')}</span> : null}
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
            className={`flex h-7 w-7 items-center justify-center rounded-md pointer-coarse:h-10 pointer-coarse:w-10 [@media(hover:none)]:hidden transition-colors hover:bg-ink/[0.06] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${
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
          className="flex h-7 w-7 items-center justify-center rounded-md pointer-coarse:h-10 pointer-coarse:w-10 text-[13px] leading-none text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="more" size={14} />
        </button>
      </div>
    </div>
  );
}

/** A row-menu entry (thread and room menus). Inside the phone's bottom sheet
 * the sheet's own rule resizes it for a thumb. */
const ROW_MENU_ITEM =
  'w-full rounded-md px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper pointer-coarse:min-h-11 pointer-coarse:text-[14px]';
const ROW_MENU_DISABLED = 'disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent';

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
  const archived = item.archived === true;
  const roomQuery = useQuery({
    queryKey: roomQueryKey(item.id),
    queryFn: () => roomApi.getRoom(item.id),
    staleTime: 15_000,
    retry: false,
  });
  const paused = roomQuery.data?.paused;
  const openPanel = (focus: 'members' | 'budget') => {
    onClose();
    void navigate(focus === 'budget' ? `${item.href}?panel=members&focus=budget` : `${item.href}?panel=members`);
  };
  const itemClass = ROW_MENU_ITEM;
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
function WorkspaceGroupHeader({
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
          <span data-session-group-current className="shrink-0 text-[11px] font-normal text-selected-ink">{t('sidebar.currentWorkspace')}</span>
        ) : null}
      </span>
      {foldedLife !== 'idle' ? (
        <span data-session-group-life={foldedLife} className="flex shrink-0 items-center">
          <LifeMark markId={`group:${groupKey}`} life={foldedLife} still />
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
  const rowClass = 'flex h-7 w-full items-center gap-2 pr-1 pl-2 text-left text-[12px] leading-4 font-medium text-ink-soft';
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
}

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
  return <p className="px-2 pt-2 pb-1 text-[12px] font-medium text-ink-faint">{children}</p>;
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
  workspaceNames,
}: {
  search: SessionSearchState;
  personas?: readonly PersonaDirectoryEntry[];
  filtersActive: boolean;
  activeKey: string | undefined;
  onHover: (key: string) => void;
  onOpen: (key: string) => void;
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
          <p className="text-[12.5px] font-medium text-danger">{t('sidebar.searchFailed')}</p>
          <p className="text-[12px] text-ink-soft">{search.contentInitialError.message || t('common.unknownError')}</p>
          <button type="button" data-search-initial-retry onClick={search.retry} className="mt-1 text-[12px] font-medium text-ink underline underline-offset-2">
            {t('common.retry')}
          </button>
        </div>
      ) : null}
      {search.unavailable !== undefined ? (
        <div data-search-unavailable role="status" className="px-2 pt-1.5 text-[12px] text-ink-faint">
          {t(`sidebar.results.unavailable.${search.unavailable.reason ?? 'generic'}`)}
          {search.unavailable.reason !== 'disabled' && search.unavailable.reason !== 'runtime_disabled' ? (
            <button type="button" data-search-unavailable-retry onClick={() => { void search.retryUnavailable().catch(() => search.retry()); }}
              className="ml-2 font-medium text-ink underline underline-offset-2">{t('common.retry')}</button>
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
          <p className="text-[12.5px] font-medium text-danger">{t('sidebar.searchFailed')}</p>
          <button
            type="button"
            data-search-retry
            disabled={search.isFetchingNextPage}
            onClick={search.fetchNextPage}
            className="mt-1 text-[12px] font-medium text-ink underline underline-offset-2"
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
                  <button type="button" {...option(entry.optionKey)}>
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
                        <span className="min-w-0 truncate text-ink-soft"><ThreadTitle text={hit.session_title.trim() !== '' ? hit.session_title : t('sidebar.untitled')} /></span>
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
                <button key={match.session.id} type="button" {...option(`s:${match.session.id}`)}>
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
                    <span className="min-w-0 truncate text-ink-soft"><ThreadTitle text={hit.session_title.trim() !== '' ? hit.session_title : t('sidebar.untitled')} /></span>
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
const MENU_HEADING = 'px-3 pt-1.5 pb-0.5 text-[11px] font-medium text-ink-faint phone:px-4 phone:pt-2 phone:pb-1 phone:text-[13px]';
const MENU_ITEM =
  'flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-left text-[12.5px] text-ink transition-colors hover:bg-paper phone:h-9 phone:text-[14px] pointer-coarse:min-h-10';

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
                className={`mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors hover:bg-paper disabled:opacity-50 pointer-coarse:h-10 pointer-coarse:w-10 ${
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

type SessionContentAction = 'undo' | 'compact' | 'export';
type SessionSubmenuKey = 'branch' | 'fork' | 'more';

const BRANCH_SEED_MODES: readonly SessionSeedMode[] = ['fresh', 'compact', 'verbatim'];
const FORK_SEED_MODES: readonly SessionSeedMode[] = ['verbatim', 'fresh', 'compact'];

interface SessionMenuProps {
  session: Session;
  /** The row's shown title, for the menu's accessible name. */
  title: string;
  topLevel: boolean;
  onToggleThreadDisplay: () => void;
  scopeId: string;
  /** The open conversation; the thread-reference entry needs one to insert into. */
  activeSessionId: string | undefined;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onTogglePrivate: () => void;
  onCreateBranch: (seed: SessionSeedMode) => void;
  onForkSession: (seed: SessionSeedMode) => void;
  onAction: (action: SessionContentAction) => void;
  onArchive: () => void;
  onRestore: () => void;
  /** `[thread_communication].enabled`; undefined while the config loads. */
  threadCommsEnabled: boolean | undefined;
  onJoinRoom: () => void;
  /** Its archive is in flight: only the entries that would race it go quiet. */
  archiving?: boolean;
  /** Its privacy toggle is in flight: prevents concurrent conflicting toggles. */
  privateBusy?: boolean;
}

/**
 * The session row's menu. Its first level holds list management plus direct
 * branch and fork entry points (each expanding into the three context-seed
 * modes). Export, compact, and undo remain one level down under More on
 * desktop; phone mode shows the first level in a bottom sheet and steps into
 * the seed-mode choices when branch or fork is tapped.
 */
function SessionMenu(props: SessionMenuProps) {
  const { t } = useI18n();
  const [sheetSubmenu, setSheetSubmenu] = useState<'branch' | 'fork' | null>(null);
  if (!usePhoneMode()) return <SessionPointerMenu {...props} />;
  const modes = sheetSubmenu === 'branch' ? BRANCH_SEED_MODES : FORK_SEED_MODES;
  return (
    <ActionSheet
      ariaLabel={t('sidebar.sessionActionsFor', { title: props.title })}
      overlayId="session-menu"
      dataAttribute="data-session-menu"
      onClose={() => {
        setSheetSubmenu(null);
        props.onClose();
      }}
    >
      {sheetSubmenu === null ? (
        <SessionMenuEntries
          {...props}
          phone
          onOpenSeedSubmenu={(kind) => { setSheetSubmenu(kind); }}
        />
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            data-menu-item="seed-back"
            className={`${ROW_MENU_ITEM} text-ink-soft`}
            onClick={() => { setSheetSubmenu(null); }}
          >
            {t(sheetSubmenu === 'branch' ? 'menu.branch' : 'menu.fork')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitem"
              data-menu-item={`${sheetSubmenu}-${mode}`}
              className={ROW_MENU_ITEM}
              onClick={() => {
                const kind = sheetSubmenu;
                setSheetSubmenu(null);
                if (kind === 'branch') props.onCreateBranch(mode);
                else props.onForkSession(mode);
              }}
            >
              {t(`transcript.branch.seed.${mode}`)}
            </button>
          ))}
        </>
      )}
    </ActionSheet>
  );
}

/** The menu's first level, shared by the desktop menu and the phone sheet. */
function SessionMenuEntries({
  session,
  phone,
  topLevel,
  onToggleThreadDisplay,
  scopeId,
  activeSessionId,
  onClose,
  onRename,
  onTogglePin,
  onTogglePrivate,
  onCreateBranch,
  onForkSession,
  onArchive,
  onRestore,
  threadCommsEnabled,
  onJoinRoom,
  archiving = false,
  privateBusy = false,
  activeSubmenu = null,
  branchRef,
  forkRef,
  onOpenSeedSubmenu,
}: SessionMenuProps & {
  phone: boolean;
  activeSubmenu?: SessionSubmenuKey | null;
  branchRef?: RefObject<HTMLButtonElement | null>;
  forkRef?: RefObject<HTMLButtonElement | null>;
  onOpenSeedSubmenu?: (kind: 'branch' | 'fork') => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const archived = session.archived === true;
  const canBranchOrFork = session.ephemeral !== true && !isSubagentSession(session);
  // The lightweight link is the in-app route (the protocol-level kiki:// deep
  // link is deliberately out of scope). Opening the folder rides the desktop
  // opener commands, so the browser build and a phone get the copy only.
  const cwd = session.metadata.cwd;
  const canReveal = !phone && !scopeId.startsWith('ssh:') && host.revealPath !== undefined && cwd !== '';
  // A thread reference goes into the open conversation's composer: with
  // nothing open, or with this row being the open one, there is nowhere to
  // add it, so the entry is not offered.
  const canAddToConversation = activeSessionId !== undefined && activeSessionId !== session.id;
  // Rooms need thread communication: switched off, the entry is not offered
  // at all. Still loading is not off, so it stays.
  const canJoinRoom = !isSubagentSession(session) && threadCommsEnabled !== false;
  const runAndClose = (label: string, action: () => Promise<void>) => {
    onClose();
    runToastAction(label, action);
  };
  return (
    <>
      {sessionRelationOf(session)?.kind === 'thread' ? (
        <>
          <button type="button" role="menuitem" data-menu-item="thread-display" className={ROW_MENU_ITEM} onClick={onToggleThreadDisplay}>
            {topLevel ? t('menu.showNested') : t('menu.showTopLevel')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
        </>
      ) : null}
      {archived ? (
        <button type="button" role="menuitem" data-menu-item="restore" className={ROW_MENU_ITEM} onClick={onRestore}>
          {t('menu.restore')}
        </button>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            data-menu-item="pin"
            disabled={archiving}
            className={`${ROW_MENU_ITEM} ${ROW_MENU_DISABLED}`}
            onClick={onTogglePin}
          >
            {isPinnedSession(session) ? t('menu.unpin') : t('menu.pin')}
          </button>
          <button type="button" role="menuitem" data-menu-item="rename" className={ROW_MENU_ITEM} onClick={onRename}>
            {t('menu.rename')}
          </button>
          {canBranchOrFork ? (
            <>
              <button
                type="button"
                role="menuitem"
                data-menu-item="private"
                disabled={archiving || privateBusy}
                className={`${ROW_MENU_ITEM} ${ROW_MENU_DISABLED}`}
                onClick={onTogglePrivate}
              >
                {t(session.private === true ? 'private.exitPrivate' : 'private.makePrivate')}
              </button>
              <div className="mx-1 my-1 border-t border-hairline" />
              <button
                ref={branchRef}
                type="button"
                role="menuitem"
                data-menu-item="branch"
                disabled={archiving}
                aria-haspopup={phone ? undefined : 'menu'}
                aria-expanded={phone ? undefined : activeSubmenu === 'branch'}
                className={`${ROW_MENU_ITEM} ${ROW_MENU_DISABLED} flex items-center gap-2 ${!phone && activeSubmenu === 'branch' ? 'bg-paper' : ''}`}
                onClick={() => {
                  if (phone && onOpenSeedSubmenu !== undefined) {
                    onOpenSeedSubmenu('branch');
                    return;
                  }
                  onCreateBranch('fresh');
                }}
              >
                <span className="min-w-0 flex-1 truncate">{t('menu.branch')}</span>
                <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
              </button>
              <button
                ref={forkRef}
                type="button"
                role="menuitem"
                data-menu-item="fork"
                disabled={archiving}
                aria-haspopup={phone ? undefined : 'menu'}
                aria-expanded={phone ? undefined : activeSubmenu === 'fork'}
                className={`${ROW_MENU_ITEM} ${ROW_MENU_DISABLED} flex items-center gap-2 ${!phone && activeSubmenu === 'fork' ? 'bg-paper' : ''}`}
                onClick={() => {
                  if (phone && onOpenSeedSubmenu !== undefined) {
                    onOpenSeedSubmenu('fork');
                    return;
                  }
                  onForkSession('verbatim');
                }}
              >
                <span className="min-w-0 flex-1 truncate">{t('menu.fork')}</span>
                <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
              </button>
            </>
          ) : null}
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-link"
            className={ROW_MENU_ITEM}
            onClick={() => {
              runAndClose(t('menu.copyThreadLink'), () => copyTextToClipboard(`/s/${session.id}`));
            }}
          >
            {t('menu.copyThreadLink')}
          </button>
          {canAddToConversation ? (
            // A thread reference into the open conversation's composer, at its caret.
            <button
              type="button"
              role="menuitem"
              data-menu-item="add-to-conversation"
              className={ROW_MENU_ITEM}
              onClick={() => {
                if (activeSessionId === undefined) return;
                onClose();
                const link = threadRefLink(session.id);
                if (!requestComposerInsert(activeSessionId, link)) appendToDraft(activeSessionId, link);
              }}
            >
              {t('menu.addToConversation')}
            </button>
          ) : null}
          {canJoinRoom ? (
            <button type="button" role="menuitem" data-menu-item="join-room" className={ROW_MENU_ITEM} onClick={onJoinRoom}>
              {t('room.joinRoom')}
            </button>
          ) : null}
          {cwd !== '' ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="copy-path"
              className={ROW_MENU_ITEM}
              onClick={() => { runAndClose(t('menu.copyWorkingDirectory'), () => copyTextToClipboard(cwd)); }}
            >
              {t('menu.copyWorkingDirectory')}
            </button>
          ) : null}
          {canReveal ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="open-folder"
              className={ROW_MENU_ITEM}
              onClick={() => { runAndClose(t('menu.openWorkingDirectory'), () => host.revealPath!(cwd)); }}
            >
              {t('menu.openWorkingDirectory')}
            </button>
          ) : null}
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="archive"
            disabled={archiving}
            className={`${ROW_MENU_ITEM} hover:text-danger ${ROW_MENU_DISABLED}`}
            onClick={onArchive}
          >
            {archiving ? t('sidebar.archiving') : t('menu.archive')}
          </button>
        </>
      )}
    </>
  );
}

/**
 * The desktop form: a small hand-rolled menu (no Radix) at the pointer or
 * beside the row's ⋯ — fixed panel, outside-click and Escape to close, the
 * panel size measured after mount so the position clamps inside the viewport
 * on both axes (right-click near an edge) — with More at its end.
 */
function SessionPointerMenu(props: SessionMenuProps) {
  const { session, title, x, y, onClose, onAction } = props;
  const { t } = useI18n();
  const archived = session.archived === true;
  const menuRef = useRef<HTMLDivElement>(null);
  // Focus holder to hand back to on Escape / item activation — whatever was
  // focused when the menu opened (a row's inner button for a Shift+F10 that
  // bubbled up, never an assumed row container). Outside-pointer closes do
  // not restore: the pointer's own target takes the focus.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  // Layout effect: the clamped position lands before the first paint, and the
  // first item takes focus with it so the menu is keyboard-operable at once.
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
  // Latest onClose via ref: the parent passes inline closures and the sidebar
  // re-renders on its poll interval, so a deps-keyed listener would churn and
  // could swallow an Escape mid-reattach.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // On a phone the back button closes this menu first, instead of taking the
  // drawer underneath (and the menu with it) in one press.
  useLayerHistory('session-menu', useCoarsePointer(), onClose);
  useEffect(() => {
    const unregister = registerOverlay('session-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const owned = menuRef.current?.contains(document.activeElement) === true;
      closeRef.current();
      if (owned) restoreTriggerFocus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-session-menu]') === null) {
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
    // onClose rides the ref; attach once.
  }, []);

  // Submenus (`branch`, `fork`, `more`): ArrowRight or mouse hover opens a
  // submenu; ArrowLeft or hovering another level-1 entry closes it; Escape
  // closes the whole menu. Clicking `More` opens its submenu, whereas clicking
  // `Branch` or `Fork` directly invokes its default seed mode immediately.
  const branchRef = useRef<HTMLButtonElement>(null);
  const forkRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<SessionSubmenuKey | null>(null);
  const [submenuFocus, setSubmenuFocus] = useState(0);
  const anchorForSubmenu = (key: SessionSubmenuKey | null): HTMLButtonElement | null => {
    if (key === 'branch') return branchRef.current;
    if (key === 'fork') return forkRef.current;
    if (key === 'more') return moreRef.current;
    return null;
  };
  const openSubmenu = (key: SessionSubmenuKey, focus: boolean) => {
    setActiveSubmenu(key);
    if (focus) setSubmenuFocus((count) => count + 1);
  };
  useEffect(() => {
    if (submenuFocus > 0) submenuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [submenuFocus]);
  // Clamp the active submenu against the bottom and right viewport edges.
  const [submenuPlace, setSubmenuPlace] = useState<{ top: number; left: boolean }>({ top: 0, left: false });
  useLayoutEffect(() => {
    const submenu = submenuRef.current;
    const anchor = anchorForSubmenu(activeSubmenu);
    const menuNode = menuRef.current;
    if (activeSubmenu === null || submenu === null || anchor === null || menuNode === null) return;
    const rect = anchor.getBoundingClientRect();
    const menuRect = menuNode.getBoundingClientRect();
    const baseTop = rect.top - menuRect.top - 5;
    const overflow = rect.top - 5 + submenu.offsetHeight - (window.innerHeight - 8);
    setSubmenuPlace({
      top: overflow > 0 ? baseTop - overflow : baseTop,
      left: rect.right + 8 + submenu.offsetWidth > window.innerWidth - 8,
    });
  }, [activeSubmenu]);
  const contentActions: readonly { action: SessionContentAction; label: string; danger?: boolean }[] = [
    { action: 'export', label: t('menu.export') },
    { action: 'compact', label: t('menu.compact') },
    { action: 'undo', label: t('menu.undo'), danger: true },
  ];

  const submenuEntries = activeSubmenu === 'branch'
    ? BRANCH_SEED_MODES.map((mode) => ({
        key: `branch-${mode}`,
        label: t(`transcript.branch.seed.${mode}`),
        danger: false,
        onSelect: () => { props.onCreateBranch(mode); },
      }))
    : activeSubmenu === 'fork'
      ? FORK_SEED_MODES.map((mode) => ({
          key: `fork-${mode}`,
          label: t(`transcript.branch.seed.${mode}`),
          danger: false,
          onSelect: () => { props.onForkSession(mode); },
        }))
      : activeSubmenu === 'more'
        ? contentActions.map((entry) => ({
            key: entry.action,
            label: entry.label,
            danger: entry.danger === true,
            onSelect: () => { onAction(entry.action); },
          }))
        : [];
  const submenuLabel = activeSubmenu === 'branch'
    ? t('menu.branch')
    : activeSubmenu === 'fork'
      ? t('menu.fork')
      : t('sidebar.menu.more');

  return (
    <div
      ref={menuRef}
      data-session-menu
      role="menu"
      aria-label={t('sidebar.sessionActionsFor', { title })}
      onKeyDown={(event) => {
        const submenu = submenuRef.current;
        const inSubmenu = submenu !== null && event.target instanceof Node && submenu.contains(event.target);
        if (inSubmenu && event.key === 'ArrowLeft') {
          event.preventDefault();
          const parent = anchorForSubmenu(activeSubmenu);
          setActiveSubmenu(null);
          parent?.focus();
          return;
        }
        if (!inSubmenu && event.key === 'ArrowRight') {
          const key: SessionSubmenuKey | null = event.target === branchRef.current ? 'branch'
            : event.target === forkRef.current ? 'fork'
              : event.target === moreRef.current ? 'more'
                : null;
          if (key !== null) {
            event.preventDefault();
            openSubmenu(key, true);
            return;
          }
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        const scope = inSubmenu ? submenu : menuRef.current;
        const items = [...(scope?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
          .filter((item) => inSubmenu || submenu === null || !submenu.contains(item));
        if (items.length === 0) return;
        event.preventDefault();
        if (!inSubmenu) setActiveSubmenu(null);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
        items[next]?.focus();
      }}
      onPointerOver={(event) => {
        if (event.pointerType !== 'mouse' || !(event.target instanceof Element)) return;
        const item = event.target.closest('[role="menuitem"]');
        if (item === null || submenuRef.current?.contains(item) === true) return;
        if (item === branchRef.current) openSubmenu('branch', false);
        else if (item === forkRef.current) openSubmenu('fork', false);
        else if (item === moreRef.current) openSubmenu('more', false);
        else setActiveSubmenu(null);
      }}
      onClick={(event) => {
        // Item activation hands focus back to the opener — but only after
        // the click's commit has landed: an in-place toggle (More keeps this
        // menu open) keeps its focus, and a dialog the action opened
        // (rename, join-room, undo) focuses itself on mount. Checking
        // post-commit restores exactly when neither happened.
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
      <SessionMenuEntries
        {...props}
        phone={false}
        activeSubmenu={activeSubmenu}
        branchRef={branchRef}
        forkRef={forkRef}
      />
      {archived ? null : (
        <>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            ref={moreRef}
            type="button"
            role="menuitem"
            data-menu-item="more"
            aria-haspopup="menu"
            aria-expanded={activeSubmenu === 'more'}
            className={`${ROW_MENU_ITEM} flex items-center gap-2 ${activeSubmenu === 'more' ? 'bg-paper' : ''}`}
            onClick={() => { openSubmenu('more', true); }}
          >
            <span className="min-w-0 flex-1 truncate">{t('sidebar.menu.more')}</span>
            <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
          </button>
          {activeSubmenu !== null ? (
            <div
              ref={submenuRef}
              role="menu"
              aria-label={submenuLabel}
              data-session-submenu={activeSubmenu}
              className={`anim-enter absolute w-40 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgb(var(--kiki-shadow-ink)/0.3)] ${
                submenuPlace.left ? 'right-full mr-2' : 'left-full ml-2'
              }`}
              style={{ top: submenuPlace.top }}
            >
              {submenuEntries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="menuitem"
                  data-menu-item={entry.key}
                  className={`${ROW_MENU_ITEM} ${entry.danger ? 'hover:text-danger' : ''}`}
                  onClick={entry.onSelect}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
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
  return createPortal(
    <div
      ref={fieldRef}
      role="dialog"
      aria-label={heading}
      aria-busy={busy || undefined}
      data-rename-editor={item.id}
      data-rename-saving={busy ? '' : undefined}
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
      className="anim-enter fixed z-50 flex flex-col justify-center rounded-xl border border-hairline-strong bg-panel px-2 py-1 shadow-[0_8px_24px_-10px_rgb(var(--kiki-shadow-ink)/0.32)] focus-within:border-selected-ink focus-within:ring-2 focus-within:ring-selected-ink/25"
      style={{ left: anchor.left, top: anchor.top, width: anchor.width, minHeight: anchor.minHeight }}
    >
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          data-autofocus
          data-rename-input
          aria-label={heading}
          aria-invalid={error !== null || undefined}
          placeholder={placeholder}
          disabled={busy}
          style={{ outline: 'none' }}
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[13px] font-medium text-ink placeholder:font-normal placeholder:text-ink-faint disabled:opacity-65"
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
    </div>,
    document.body,
  );
}
