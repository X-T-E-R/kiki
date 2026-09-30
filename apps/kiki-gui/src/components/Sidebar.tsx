/**
 * Session sidebar — session-first and quiet.
 *
 * Top to bottom: the wordmark, New session (the surface's one primary) and
 * search, a short primary nav (task board, scheduled tasks, usage,
 * capabilities), the filter chip row, then the session list. The footer keeps
 * settings, the "waiting on you" badge and the connection dot on one line.
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
 * anywhere on the row; the undo confirmation and rename dialog build on the
 * shared `Dialog` primitive.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';

import type { RoomListItem, Session, Workspace } from '@kiki/protocol';

import {
  compactSessionContext,
  exportSessionArchive,
  forkSession,
  sessionActionErrorText,
  undoLastTurn,
  type SessionActionContext,
} from '@kiki/session-core/commands';
import { appendToDraft, requestComposerInsert, threadRefLink } from '@kiki/session-core/composer';
import {
  formatElapsedClock,
  hasActiveSessionFilters,
  highlightTerms,
  isPinnedSession,
  isSearchable,
  pinMetadataPatch,
  buildConversationInbox,
  sessionRowState,
  type SessionRowState,
  SESSION_SORT_ORDERS,
  sessionStatusOf,
  shortCwd,
  splitByRanges,
  togglePinned,
  type ActivityEntry,
  type ActivityTask,
  type MatchRange,
  type SessionGroup,
  type SessionSortOrder,
} from '@kiki/session-core/sessions';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  writeLayoutPreferences,
  type SessionArchivedFilter,
  type SessionSeenMap,
  type SessionListFilters,
  type SessionStatusFilter,
} from '@kiki/session-core/settings';
import { useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { useLayoutPreferences, usePaneResize } from '../lib/layoutHooks';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { useSessionSearch, type SessionSearchState } from '../lib/sessionSearch';
import { SESSION_SEARCH_EVENT } from '../lib/sidebarSearch';
import { lifeOf, type LifeState } from '../lib/motion';
import { nestSessionThreads, type SessionRelation, type SessionTreeNode } from '../lib/sessionThreads';
import { runToastAction } from '../lib/toasts';
import { readWorkspaceGroupMemory, writeWorkspaceGroupMemory } from '../lib/sidebarGroupMemory';
import { registerOverlay } from '../lib/uiBusy';
import { useConnection } from '../state/connection';
import { RelativeTime } from './RelativeTime';
import { useSessionSeen } from './ActivityPage';
import { useSessionActivity } from './ActivityPanel';
import { Dialog } from './Dialog';
import { useGuardedNavigate } from './dirtyGuard';
import { LifeMark } from './LifeMark';
import { DisclosureChevron, Icon } from './icons';
import { SpaceSwitcher } from './SpaceSwitcher';
import { isBotOrRoomSession, SidebarBotRoomGroups } from './bot/SidebarBotRoomGroups';
import { JoinRoomDialog, NewThreadRoomDialog } from './room/ThreadRoomDialogs';
import { isSubagentSession, ROOM_MAX_MEMBERS, useThreadCommsEnabled } from './room/threadRooms';
import { WorktreeArchiveDialog } from './WorktreeArchiveDialog';
import { WorktreeMark } from './WorktreeMark';

// Re-exported for callers and tests that paged the old in-component search.
export { mergeSearchPages, searchNextPageParam } from '../lib/sessionSearch';

/** How many sessions a workspace group shows before "Show N more". */
export const WORKSPACE_GROUP_PREVIEW = 8;

// Nav icons all come from the shared family (components/icons.tsx).
const ICON = 'h-4 w-4 shrink-0';
/** Quiet square control for the wordmark row (search, activity). */
const HEADER_ICON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink aria-[current=page]:bg-ink/[0.06] aria-[current=page]:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

const BoardIcon = () => <Icon name="board" size={16} />;
const ClockIcon = () => <Icon name="clock" size={16} />;
const UsageIcon = () => <Icon name="usage" size={16} />;
/** Memory is a kept leaf of notes (a place), not the timeline's spark. */
const MemoryIcon = () => <Icon name="notes" size={16} />;
const PersonaIcon = () => <Icon name="persona" size={16} />;
const CapabilitiesIcon = () => <Icon name="star" size={16} />

function PinIcon({ className = '' }: { className?: string }) {
  return <Icon name="pin" size={12} className={className} />;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null);
}

function sessionLabel(session: Session, untitled: string): string {
  if (session.title.trim() !== '') return session.title;
  if (session.last_prompt !== undefined && session.last_prompt.trim() !== '') {
    return session.last_prompt;
  }
  return untitled;
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
  if (state === 'needs-me') return 'waiting';
  if (state === 'running') return 'working';
  if (state === 'read') return 'idle';
  // Unread: the run's outcome decides the tone; an old finish still reads as
  // "done", because unseen is the fact, not recency.
  const life = lifeOf(session);
  return life === 'failed' ? 'failed' : 'done';
}

/**
 * What a folded group is hiding that you would want to know: a session that
 * needs you, else one still running. Finished and failed rows stay behind the
 * fold (the bell counts them).
 */
function foldedGroupLife(nodes: readonly SessionTreeNode[], seen: SessionSeenMap): LifeState {
  const states: SessionRowState[] = [];
  const visit = (node: SessionTreeNode) => {
    states.push(sessionRowState(node.session, seen));
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return states.includes('needs-me') ? 'waiting' : states.includes('running') ? 'working' : 'idle';
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

type NavKey = 'board' | 'cron' | 'memory' | 'personas' | 'usage' | 'capabilities';

const NAV_ITEMS: readonly { key: NavKey; route: string; hook: Record<string, string>; icon: () => React.ReactNode }[] = [
  { key: 'board', route: '/board', hook: { 'data-nav-board': '' }, icon: BoardIcon },
  { key: 'cron', route: '/cron', hook: { 'data-nav-cron': '' }, icon: ClockIcon },
  // Always present, on or off: switched off it opens the turn-on guide, so
  // "what does Kiki remember" has one stable address either way.
  { key: 'memory', route: '/memory', hook: { 'data-nav-memory': '' }, icon: MemoryIcon },
  // Who talks to you sits beside what it remembers: a persona owns a memory
  // namespace, and carries no tools or permissions (those are Capabilities).
  { key: 'personas', route: '/personas', hook: { 'data-nav-personas': '' }, icon: PersonaIcon },
  { key: 'usage', route: '/usage', hook: { 'data-nav-usage': '' }, icon: UsageIcon },
  { key: 'capabilities', route: '/capabilities', hook: { 'data-nav-capabilities': '' }, icon: CapabilitiesIcon },
];

const WORKSPACE_SCOPED_ROUTES: readonly string[] = ['/board', '/cron', '/memory'];

/** Workspace-scoped pages open pre-filtered to the active session's
 * workspace; the page's own switcher widens to all workspaces. */
function scopedRoute(route: string, workspaceId: string | undefined): string {
  if (workspaceId === undefined || !WORKSPACE_SCOPED_ROUTES.includes(route)) return route;
  return `${route}?workspace=${encodeURIComponent(workspaceId)}`;
}

function PrimaryNav({
  activeWorkspaceId,
  badges,
}: {
  activeWorkspaceId: string | undefined;
  badges?: Partial<Record<NavKey, { count: number; label: string }>>;
}) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const location = useLocation();
  return (
    <nav aria-label={t('nav.aria')} data-primary-nav className="px-2 pb-2">
      <ul className="space-y-px">
        {NAV_ITEMS.map((item) => {
          const current = location.pathname === item.route
            || (item.key === 'capabilities' && location.pathname.startsWith('/capabilities'));
          const badge = badges?.[item.key];
          const Icon = item.icon;
          return (
            <li key={item.key}>
              <button
                type="button"
                {...item.hook}
                aria-current={current ? 'page' : undefined}
                onClick={() => { navigate(scopedRoute(item.route, activeWorkspaceId)); }}
                className={`row-interactive flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] ${
                  current ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
                }`}
              >
                <span className={current ? 'text-selected-ink' : 'text-ink-faint'}><Icon /></span>
                <span className="min-w-0 flex-1 truncate">{item.key === 'personas' ? t('persona.nav') : t(`nav.${item.key}`)}</span>
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
        })}
      </ul>
    </nav>
  );
}

export function Sidebar({
  activeSessionId,
  sessions,
  rooms = [],
  sessionGroups: allSessionGroups,
  sessionsQuery,
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
}: {
  activeSessionId: string | undefined;
  /** Every loaded session (unfiltered); the pending badge and search read it. */
  sessions: readonly Session[];
  rooms?: readonly RoomListItem[];
  /** Filtered, sorted, grouped rows for the list. */
  sessionGroups: readonly SessionGroup[];
  sessionsQuery: {
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    fetchNextPage?: () => Promise<unknown>;
  };
  workspaceOptions: readonly Workspace[];
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
}) {
  const host = useHost();
  const navigate = useGuardedNavigate();
  const { client, meta, wsStatus, scopeId } = useConnection();
  const { t, tp, locale } = useI18n();
  const untitled = t('sidebar.untitled');
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  // Ctrl/⌘-click multi-select, for pulling several threads into one room.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [roomDraft, setRoomDraft] = useState<readonly Session[] | null>(null);
  const [joiningRoom, setJoiningRoom] = useState<Session | null>(null);
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
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(new Set()); };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [selected.size]);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<Session | null>(null);
  const [confirmArchiveWorktree, setConfirmArchiveWorktree] = useState<Session | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [workspacePinBusy, setWorkspacePinBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<'view' | 'filter' | null>(null);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);
  const filterMenuButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchInput, setSearchInput] = useState('');
  // Search is a header icon (Codex-style): the field only takes vertical space
  // while it is in use, and `/` opens it from anywhere. Closing clears the
  // query so the list is never left silently filtered behind a collapsed box.
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  // Folded and fully shown workspace groups, plus the list's scroll position,
  // survive a reload; they are per space and per connection (sidebarGroupMemory).
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set(readWorkspaceGroupMemory(scopeId).collapsed));
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set(readWorkspaceGroupMemory(scopeId).expanded));
  const memoryScope = useRef(scopeId);
  useEffect(() => {
    if (memoryScope.current === scopeId) return;
    memoryScope.current = scopeId;
    const memory = readWorkspaceGroupMemory(scopeId);
    setCollapsedGroups(new Set(memory.collapsed));
    setExpandedGroups(new Set(memory.expanded));
  }, [scopeId]);

  // A live Bot home or room-member session is reached from its Bot / room
  // row above; archived ones (a deleted room's members) stay findable here.
  const sessionGroups = useMemo(
    () => allSessionGroups
      .map((group) => ({ ...group, items: group.items.filter((session) => session.archived === true || !isBotOrRoomSession(session)) }))
      .filter((group) => group.items.length > 0),
    [allSessionGroups],
  );
  const activity = useSessionActivity(sessions);
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

  const refreshSessions = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    [queryClient],
  );
  const actionContext: SessionActionContext = useMemo(
    () => ({ client, host, refreshSessions, navigate }),
    [client, host, refreshSessions, navigate],
  );

  // Search scopes to the active filters: the workspace chips narrow both
  // layers; status/archived narrow content hits to the visible sessions.
  const visibleSessions = useMemo(() => sessionGroups.flatMap((group) => group.items), [sessionGroups]);
  const narrowsBeyondWorkspace = filters.status.length > 0 || filters.archived !== 'hide';
  const allowedSessionIds = useMemo(
    () => (narrowsBeyondWorkspace ? new Set(visibleSessions.map((session) => session.id)) : undefined),
    [narrowsBeyondWorkspace, visibleSessions],
  );
  const searchableSessions = useMemo(
    () => (narrowsBeyondWorkspace ? visibleSessions : sessions.filter((session) => session.archived !== true)),
    [narrowsBeyondWorkspace, visibleSessions, sessions],
  );
  const search = useSessionSearch({
    text: searchInput,
    sessions: searchableSessions,
    workspaces: workspaceOptions,
    untitled,
    workspaceScope: filters.workspaces,
    allowedSessionIds,
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
    onFiltersChange({ ...filters, ...patch });
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
  const toggleWorkspacePin = (workspace: Workspace) => {
    setWorkspacePinBusy(true);
    setActionError(null);
    void client
      .setWorkspacePinned(workspace.id, !workspace.pinned)
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
    void client
      .updateSessionProfile(session.id, { metadata })
      .then(() => { refreshSessions(); })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };

  useEffect(() => {
    if (actionNotice === null) return;
    const timer = setTimeout(() => { setActionNotice(null); }, 3000);
    return () => { clearTimeout(timer); };
  }, [actionNotice]);

  const runAction = (session: Session, action: 'fork' | 'undo' | 'compact' | 'export') => {
    setMenu(null);
    if (action === 'undo') {
      setConfirmUndo(session);
      return;
    }
    setActionError(null);
    setActionNotice(null);
    if (action === 'fork') {
      void forkSession(actionContext, session).catch((error: unknown) => {
        setActionError(t('action.forkFailed', { detail: sessionActionErrorText(locale, error) }));
      });
    } else if (action === 'export') {
      void exportSessionArchive(actionContext, session)
        .then((saved) => {
          if (saved) setActionNotice(t('action.exportDone', { title: sessionLabel(session, untitled) }));
        })
        .catch((error: unknown) => {
          setActionError(t('action.exportFailed', { detail: sessionActionErrorText(locale, error) }));
        });
    } else {
      void compactSessionContext(actionContext, session)
        .then(() => {
          setActionNotice(t('action.compactRequested', { title: sessionLabel(session, untitled) }));
        })
        .catch((error: unknown) => {
          setActionError(t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }));
        });
    }
  };

  const archive = (session: Session) => {
    setMenu(null);
    setActionError(null);
    // A worktree session asks once whether its checkout goes too.
    if (session.worktree !== undefined) {
      setConfirmArchiveWorktree(session);
      return;
    }
    void client
      .archiveSession(session.id)
      .then(() => { refreshSessions(); })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
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
  const results = useMemo(() => {
    const items: { key: string; open: () => void }[] = [];
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
      items.push({ key: `s:${match.session.id}`, open: () => { setSearchInput(''); navigate(`/s/${match.session.id}`); } });
    }
    search.hits.forEach((hit, index) => {
      items.push({
        key: `h:${index}`,
        open: () => {
          setSearchInput('');
          const route = hit.agent_id && hit.agent_id !== 'main'
            ? `/s/${hit.session_id}/agent/${hit.agent_id}` : `/s/${hit.session_id}`;
          navigate(hit.turn === undefined ? route : `${route}?turn=${hit.turn}`);
        },
      });
    });
    return items;
    // setFilters closes over the latest filters; recompute with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.local, search.hits, filters, navigate]);
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
      label: t(status === 'running' ? 'sidebar.statusRunning' : status === 'needs-me' ? 'sidebar.statusNeedsMe' : 'sidebar.statusIdle'),
      clear: () => { toggleStatus(status); },
    })),
    ...filters.workspaces.map((id) => ({
      key: `ws:${id}`,
      label: workspaceOptions.find((workspace) => workspace.id === id)?.name ?? id,
      clear: () => { toggleWorkspace(id); },
    })),
    ...(filters.archived === 'hide'
      ? []
      : [{
          key: 'archived',
          label: filters.archived === 'only' ? t('sidebar.filterArchivedOnly') : t('sidebar.filterArchived'),
          clear: () => { setFilters({ archived: 'hide' }); },
        }]),
  ];
  const filtersActive = hasActiveSessionFilters(filters);
  const counts = { running: activity.model.running.length };

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
  // under it. Time buckets are not meaningful for a thread — it belongs with
  // its creator — so there a child follows its parent across buckets; the
  // workspace and pinned buckets are meaningful, so nesting stays inside one.
  const sessionTree = useMemo(
    () => nestSessionThreads(sessionGroups, { crossGroups: groupBy !== 'workspace' }),
    [sessionGroups, groupBy],
  );
  // Temporary conversations stay out of the paged list (and its search and
  // grouping); they get their own block at the top while any exist. The key
  // sits under ['sessions'], so every list refresh refreshes it too.
  const ephemeralQuery = useQuery({
    queryKey: ['sessions', 'ephemeral'],
    queryFn: () => client.listEphemeralSessions(),
    refetchInterval: 15_000,
  });
  const ephemeralSessions = ephemeralQuery.data?.items ?? [];
  // While a filter narrows the list, a workspace group shows what matched
  // even if it is folded (the fold is kept for later), and its header counts
  // the matches against everything loaded in that workspace.
  const foldsSuspended = filtersActive;
  const workspaceTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const session of sessions) {
      if (session.archived === true) continue;
      totals.set(session.workspace_id, (totals.get(session.workspace_id) ?? 0) + 1);
    }
    return totals;
  }, [sessions]);
  const pinnedTotal = useMemo(
    () => sessions.filter((session) => session.archived !== true && isPinnedSession(session)).length,
    [sessions],
  );
  const workspaceGroupKeys = groupBy === 'workspace'
    ? sessionTree.map((group) => group.key)
    : [];
  const allFolded = workspaceGroupKeys.length > 0 && workspaceGroupKeys.every((key) => collapsedGroups.has(key));
  const titleOf = useMemo(
    () => new Map(sessions.map((session) => [session.id, sessionLabel(session, untitled)])),
    [sessions, untitled],
  );

  return (
    <aside
      className={className ?? 'app-sidebar'}
      style={{ '--kiki-sidebar-width': `${sidebarWidthValue}px` } as React.CSSProperties}
      data-session-sidebar
      aria-label={t('sidebar.navAria')}
    >
      <div
        data-sidebar-resizer
        className="app-sidebar__resizer hidden md:block"
        aria-hidden
        title={t('sidebar.resizeAria')}
        onPointerDown={startResize}
        onDoubleClick={reset}
      />
      {/* Wordmark row doubles as the utility row: search and activity are two
          quiet icons, so the vertical space a permanent search field used to
          take belongs to the session list. The wordmark itself is the space
          menu (§6.4) and carries the current space's color and name. */}
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
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
            // The count itself; attention tone while anything is blocked on
            // the user, the accent when it is only finished runs to read.
            <span
              data-activity-badge={inbox.total}
              data-activity-badge-tone={inbox.needsYou.length > 0 ? 'needs-you' : 'unread'}
              aria-hidden
              className={`pointer-events-none absolute -top-1 -right-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-[3px] text-[10px] leading-none font-semibold tabular-nums text-on-accent ring-2 ring-canvas ${
                inbox.needsYou.length > 0 ? 'bg-attention' : 'bg-accent'
              }`}
            >
              {inbox.total > 99 ? '99+' : inbox.total}
            </span>
          ) : null}
        </button>
      </div>

      <div className="space-y-1 px-2 pb-3">
        {/* The surface's one primary action, set as a raised paper chip — the
            same lift as the content sheet — so it reads as the first thing to
            reach for without an ink block competing with the wordmark. */}
        <button
          type="button"
          data-new-session
          onClick={onNewSession}
          className="flex h-8 w-full items-center gap-2 rounded-lg bg-paper px-2 text-left text-[13px] font-medium text-ink shadow-[var(--kiki-sheet-shadow)] transition-colors duration-[var(--kiki-motion-quick)] hover:bg-panel"
        >
          <span className="text-accent"><Icon name="plus" size={14} /></span>
          <span className="min-w-0 flex-1 truncate">{t('sidebar.newSession')}</span>
        </button>
        {searchOpen ? (
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
            className="h-8 w-full rounded-lg border border-transparent bg-transparent pr-7 pl-7 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-ink/[0.04] focus:border-hairline-strong focus:bg-paper focus-visible:outline-none"
          />
          {searchInput === '' ? (
            <kbd aria-hidden className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-hairline px-1 font-sans text-[11px] leading-4 text-ink-faint">/</kbd>
          ) : (
            <button
              type="button"
              aria-label={t('sidebar.clearSearch')}
              onClick={() => { setSearchInput(''); searchRef.current?.focus(); }}
              className="absolute top-1/2 right-1 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
        ) : null}
      </div>

      <PrimaryNav activeWorkspaceId={activeWorkspaceId} badges={navBadges} />
      <SidebarBotRoomGroups sessions={sessions} activeSessionId={activeSessionId} seen={seen} />

      <div className="flex items-center gap-0.5 pt-3 pr-2 pb-0.5 pl-4">
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
            aria-label={tp('sidebar.runningCount', counts.running)}
            title={tp('sidebar.runningCount', counts.running)}
            onClick={() => { toggleStatus('running'); }}
            className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-soft tabular-nums transition-colors hover:bg-ink/[0.05] hover:text-ink aria-pressed:bg-ink/[0.06] aria-pressed:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
          >
            {/* The one breathing mark in the list: rows stay still. */}
            <LifeMark markId="sidebar:running" life="working" className="h-1.5 w-1.5" />
            {counts.running}
          </button>
        ) : null}
        {workspaceGroupKeys.length > 1 && !foldsSuspended && !search.active ? (
          <button
            type="button"
            data-session-groups-fold-all={allFolded ? 'expand' : 'collapse'}
            aria-label={allFolded ? t('sidebar.expandAllGroups') : t('sidebar.collapseAllGroups')}
            title={allFolded ? t('sidebar.expandAllGroups') : t('sidebar.collapseAllGroups')}
            onClick={() => { setAllGroupsCollapsed(workspaceGroupKeys, !allFolded); }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
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
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink ${filtersActive ? 'text-accent-ink' : 'text-ink-faint'}`}
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink"
        >
          <Icon name="sliders" size={14} />
        </button>
      </div>

      {filterChips.length > 0 ? (
        <div data-sidebar-filters aria-label={t('sidebar.filtersAria')} className="flex flex-wrap items-center gap-1 px-3 pb-1.5">
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

      {search.active ? (
        <SearchResults
          search={search}
          filtersActive={filtersActive}
          activeKey={activeKey}
          onHover={(key) => {
            const index = results.findIndex((entry) => entry.key === key);
            if (index >= 0) setActiveResult(index);
          }}
          onOpen={(key) => { results.find((entry) => entry.key === key)?.open(); }}
          workspaceNames={new Map(workspaceOptions.map((workspace) => [workspace.id, workspace.name]))}
        />
      ) : (
      <div ref={listRef} onScroll={onListScroll} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-session-list role="region" aria-label={t('sidebar.listAria')}>
        {sessionsQuery.isLoading && sessions.length === 0 ? (
          <div className="flex items-center gap-2 px-2 pt-4 text-[12.5px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-faint" />
            {t('sidebar.loadingSessions')}
          </div>
        ) : null}
        {sessionsQuery.isError ? (
          <div className="mx-1 mt-2 border-l-2 border-danger py-1 pl-3">
            <p className="text-[12.5px] font-medium text-danger">{t('sidebar.loadFailed')}</p>
            <p className="mt-0.5 text-[12px] text-ink-soft">
              {sessionsQuery.error?.message ?? t('common.unknownError')}
            </p>
            <button
              type="button"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['sessions'] })}
              className="mt-1 text-[12px] font-medium text-ink underline underline-offset-2"
            >
              {t('common.retry')}
            </button>
          </div>
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
            className="sticky top-0 z-[2] mb-1 flex min-h-9 items-center gap-1.5 rounded-lg bg-selected px-2 text-[12.5px] text-selected-ink">
            <span className="min-w-0 flex-1 truncate font-medium tabular-nums">{t('room.selectionCount', { count: selected.size })}</span>
            <button type="button" data-session-selection-room
              disabled={threadCommsEnabled === false || selected.size < 2}
              title={threadCommsEnabled === false ? t('room.commsOff') : selected.size < 2 ? t('room.threadsNeeded') : undefined}
              onClick={() => { setRoomDraft(sessions.filter((item) => selected.has(item.id))); }}
              className="h-7 shrink-0 rounded-md px-2 font-medium transition-colors hover:bg-paper/70 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-55">
              {t('room.fromThreads')}
            </button>
            <button type="button" data-session-selection-clear aria-label={t('room.clearSelection')} title={t('room.clearSelection')}
              onClick={() => { setSelected(new Set()); }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-paper/70 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
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
            <p data-session-group="ephemeral" className="sticky top-0 z-[1] flex h-7 w-full items-center gap-2 bg-canvas px-2 text-left text-[12px] leading-4 font-medium text-section-ink">
              <span className="min-w-0 truncate">{t('ephemeral.group')}</span>
            </p>
            {ephemeralSessions.map((session) => (
              <div key={session.id} data-session-node="root" data-session-ephemeral>
                <SessionRow
                  session={session}
                  active={session.id === activeSessionId}
                  menuOpen={false}
                  untitled={untitled}
                  activity={activity.byId.get(session.id)}
                  elapsedFor={activity.elapsedFor}
                  showLocation
                  temporary
                  onOpen={() => { navigate(`/s/${session.id}`); }}
                  onMenu={() => undefined}
                  onTogglePin={() => undefined}
                  seen={seen}
                />
              </div>
            ))}
          </div>
        ) : null}
        {sessionTree.map((group) => {
          // In the workspace view every bucket, Pinned included, uses the one
          // workspace header: fold, count, remembered state. Pinned keeps
          // every row visible (those are the sessions asked to stay on top).
          const collapsible = groupBy === 'workspace';
          const collapsed = collapsible && !foldsSuspended && collapsedGroups.has(group.key);
          const expanded = expandedGroups.has(group.key);
          const limit = collapsible && !expanded && group.key !== 'pinned' ? WORKSPACE_GROUP_PREVIEW : Infinity;
          const shown = collapsed ? [] : group.nodes.slice(0, limit);
          const hidden = collapsed ? 0 : group.nodes.length - shown.length;
          const renderRow = (node: SessionTreeNode, nested: boolean) => {
            const session = node.session;
            const threads = node.children;
            return (
              <div key={session.id} data-session-node={nested ? 'thread' : 'root'}>
                <SessionRow
                  session={session}
                  active={session.id === activeSessionId}
                  menuOpen={menu?.session.id === session.id}
                  untitled={untitled}
                  activity={activity.byId.get(session.id)}
                  elapsedFor={activity.elapsedFor}
                  relation={node.relation}
                  nested={nested}
                  showLocation={groupBy !== 'workspace'}
                  showPin={groupBy === 'none'}
                  parentTitle={node.relation === undefined
                    ? undefined
                    : titleOf.get(node.relation.parentId) ?? t('sidebar.thread.unknownParent')}
                  onOpen={() => { navigate(`/s/${session.id}`); }}
                  selected={selected.has(session.id)}
                  onToggleSelect={session.archived === true || isSubagentSession(session) ? undefined : () => { toggleSelected(session); }}
                  onMenu={(x, y, toggle) => {
                    setMenu((current) =>
                      toggle && current?.session.id === session.id ? null : { session, x, y });
                  }}
                  onTogglePin={() => { togglePin(session); }}
                  seen={seen}
                />
                {threads.length > 0 ? (
                  // Children follow their parent directly: the indent lives in
                  // the child row's own padding, so there is no spine and no
                  // fold bar, and hover / selection stay full width.
                  <div data-session-threads={session.id} className="mt-0.5 flex flex-col gap-0.5">
                    {threads.map((child) => renderRow(child, true))}
                  </div>
                ) : null}
              </div>
            );
          };
          // The workspace view gives every bucket (workspaces, Pinned,
          // Ungrouped) one header, WorkspaceGroupHeader: fold, count, the
          // current-workspace mark, and pin for a registered workspace. Time
          // buckets keep the plain T5 label, 28px tall. A folded group still
          // says when something inside needs you or is running.
          const foldedLife = collapsed ? foldedGroupLife(group.nodes, seen) : 'idle';
          if (collapsible) {
            const workspace = workspaceOptions.find((entry) => entry.id === group.key);
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
          const headerClass = 'sticky top-0 z-[1] flex h-7 w-full items-center gap-2 bg-canvas px-2 text-left text-[12px] leading-4 font-medium text-section-ink';
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

      {/* Footer: one full-width row. The whole row opens Settings; the
        * connection dot sits at its end as its own small target (it opens
        * the connection page), so both stay reachable by keyboard. The row
        * never overlaps the list above it: it is a flex sibling, not an
        * overlay, and the list keeps bottom padding for its last row. */}
      <div className="relative flex h-12 shrink-0 items-center px-2" data-sidebar-footer>
        <button
          type="button"
          data-nav-settings
          aria-current={location.pathname.startsWith('/settings') ? 'page' : undefined}
          onClick={() => navigate('/settings')}
          className={`row-interactive flex h-9 w-full min-w-0 items-center gap-2 pr-10 pl-2 text-left text-[13px] ${
            location.pathname.startsWith('/settings') ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
          }`}
        >
          <span className={location.pathname.startsWith('/settings') ? 'text-selected-ink' : 'text-ink-faint'}><Icon name="settings" size={16} className={ICON} /></span>
          <span className="min-w-0 flex-1 truncate">{t('sidebar.settings')}</span>
        </button>
        {/* "Waiting on you" lives in the header's activity entry now; a second
            footer copy of the same count was three readings of one fact. */}
        <button
          type="button"
          data-connection-status
          onClick={() => navigate('/settings/connection')}
          aria-label={t('sidebar.connStatusAria')}
          title={t('sidebar.connTitle', {
            version: meta.server_version,
            status: t(`sidebar.ws.${wsStatus}`),
          })}
          className="absolute top-1/2 right-3 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.06]"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              wsStatus === 'open'
                ? 'bg-success'
                : wsStatus === 'connecting'
                  ? 'status-dot-busy bg-amber-rule'
                  : 'bg-danger'
            }`}
          />
        </button>
      </div>

      {openMenu === 'view' ? (
        <SidebarViewMenu
          anchor={viewMenuButtonRef.current}
          onClose={() => { setOpenMenu(null); }}
          groupBy={groupBy}
          onGroupBy={onGroupBy}
          sortBy={sortBy}
          onSortBy={onSortBy}
        />
      ) : null}
      {openMenu === 'filter' ? (
        <SidebarFilterMenu
          anchor={filterMenuButtonRef.current}
          onClose={() => { setOpenMenu(null); }}
          filters={filters}
          onToggleStatus={toggleStatus}
          onToggleWorkspace={toggleWorkspace}
          onArchived={(archived) => { setFilters({ archived }); }}
          workspaceOptions={workspaceOptions}
          workspacePinBusy={workspacePinBusy}
          onToggleWorkspacePin={toggleWorkspacePin}
          onManageWorkspaces={() => {
            setOpenMenu(null);
            navigate('/settings/workspaces');
          }}
        />
      ) : null}
      {menu !== null ? (
        <SessionMenu
          session={menu.session}
          scopeId={scopeId}
          activeSessionId={activeSessionId}
          x={menu.x}
          y={menu.y}
          onClose={() => { setMenu(null); }}
          onRename={() => {
            setRenaming(menu.session);
            setMenu(null);
          }}
          onTogglePin={() => { togglePin(menu.session); }}
          onAction={(action) => { runAction(menu.session, action); }}
          onArchive={() => { archive(menu.session); }}
          onRestore={() => { restore(menu.session); }}
          roomSelection={selected.has(menu.session.id) ? selected.size : 0}
          threadCommsEnabled={threadCommsEnabled}
          onNewRoom={() => {
            const ids = selected.has(menu.session.id) && selected.size >= 2 ? selected : new Set([menu.session.id]);
            setRoomDraft(sessions.filter((item) => ids.has(item.id)));
            setMenu(null);
          }}
          onJoinRoom={() => { setJoiningRoom(menu.session); setMenu(null); }}
        />
      ) : null}
      {roomDraft !== null ? (
        <NewThreadRoomDialog threads={roomDraft} onClose={() => { setRoomDraft(null); setSelected(new Set()); }} />
      ) : null}
      {joiningRoom !== null ? <JoinRoomDialog session={joiningRoom} onClose={() => { setJoiningRoom(null); }} /> : null}
      {renaming !== null ? (
        <RenameDialog
          session={renaming}
          onClose={() => { setRenaming(null); }}
          onRenamed={() => {
            setRenaming(null);
            refreshSessions();
          }}
        />
      ) : null}
      {confirmUndo !== null ? (
        <Dialog
          onClose={() => { setConfirmUndo(null); }}
          ariaLabel={t('undo.title')}
          overlayId="sidebar-confirm-undo"
        >
          <h2 className="font-display text-[18px] font-semibold text-ink">{t('undo.title')}</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            {t('undo.bodyNamed', { title: sessionLabel(confirmUndo, untitled) })}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setConfirmUndo(null); }}
              className="rounded-md border border-hairline px-3 py-1.5 text-[13px] text-ink-soft transition-colors hover:text-ink"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                const session = confirmUndo;
                setConfirmUndo(null);
                setActionError(null);
                void undoLastTurn(actionContext, session)
                  .then(() => {
                    setActionNotice(t('action.undoDone', { title: sessionLabel(session, untitled) }));
                  })
                  .catch((error: unknown) => {
                    setActionError(t('action.undoFailed', { detail: sessionActionErrorText(locale, error) }));
                  });
              }}
              className="rounded-md bg-danger px-3 py-1.5 text-[13px] font-medium text-on-danger transition-colors hover:bg-danger/90"
            >
              {t('undo.confirm')}
            </button>
          </div>
        </Dialog>
      ) : null}
      {confirmArchiveWorktree?.worktree !== undefined ? (
        <WorktreeArchiveDialog
          session={{ ...confirmArchiveWorktree, worktree: confirmArchiveWorktree.worktree }}
          onClose={() => { setConfirmArchiveWorktree(null); }}
          onArchived={(result) => {
            setConfirmArchiveWorktree(null);
            refreshSessions();
            if (result?.tone === 'error') setActionError(result.text);
            else if (result !== null) setActionNotice(result.text);
          }}
        />
      ) : null}
    </aside>
  );
}

/**
 * One session row = status slot + title + trailing time, then at most one
 * quiet fact on a second line (root rows only). Nested rows are a single
 * indented line. Weight is reserved for state (unread / needs you / active),
 * never for hierarchy.
 */
function SessionRow({
  session,
  active,
  menuOpen,
  untitled,
  activity,
  elapsedFor,
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
}: {
  session: Session;
  active: boolean;
  menuOpen: boolean;
  untitled: string;
  activity: ActivityEntry | undefined;
  elapsedFor: (entry: ActivityEntry) => number | undefined;
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
}) {
  const { t, tp } = useI18n();
  const archived = session.archived === true;
  const pinned = isPinnedSession(session);
  const status = sessionStatusOf(session);
  // Four states share one row: blocked, running, finished-unseen, caught up.
  // Weight and marker carry the difference; the active row still wins on lift.
  const rowState = sessionRowState(session, seen);
  const label = sessionLabel(session, untitled);
  const elapsed = activity === undefined ? undefined : elapsedFor(activity);
  // The second line holds one fact, the first that exists (nested rows have
  // none: their position already says where they came from):
  //   1. what the session waits for        2. countable live progress
  //   3. where it came from (not nested)   4. where it lives (not in a workspace group)
  const liveFacts = activity === undefined || status !== 'running'
    ? []
    : [
        elapsed === undefined ? undefined : formatElapsedClock(elapsed),
        activity.queuedCount > 0 ? tp('activity.queueChip', activity.queuedCount) : undefined,
      ].filter((entry): entry is string => entry !== undefined);
  // Background tasks are not queued work: they ride their own terminal glyph
  // and count after the fact, with the task list on hover.
  const backgroundTasks = activity === undefined || status !== 'running' ? [] : activity.runningTasks;
  const relationNote = relation !== undefined && parentTitle !== undefined
    ? t(relation.kind === 'branch' ? 'sidebar.thread.branchedFrom' : 'sidebar.thread.from', { title: parentTitle })
    : undefined;
  // A worktree session lives in its source repository; the checkout path is Kiki's own.
  const locationPath = session.worktree?.source_root ?? session.metadata.cwd;
  const location = showLocation && locationPath !== '' ? shortCwd(locationPath) : undefined;
  // An unseen run that did not complete says so in words, so failure never
  // rests on the mark's colour alone.
  const failedUnseen = rowState === 'unread' && lifeOf(session) === 'failed';
  const fact: { kind: 'needs-you' | 'failed' | 'live' | 'relation' | 'location'; text: string } | undefined = nested
    ? undefined
    : status === 'needs-me'
      ? { kind: 'needs-you', text: session.pending_interaction === 'question' ? t('sidebar.statusTag.question') : t('sidebar.statusTag.approval') }
      : failedUnseen
        ? { kind: 'failed', text: failedLabel(session, t) }
      : liveFacts.length > 0
        ? { kind: 'live', text: liveFacts.join(' · ') }
        : relationNote !== undefined
          ? { kind: 'relation', text: relationNote }
          : location !== undefined
            ? { kind: 'location', text: location }
            : undefined;
  // Nested rows carry the relation in their accessible name and tooltip,
  // since on screen it is only the indent (plus the branch glyph).
  const nestedName = nested && relation !== undefined
    ? t(relation.kind === 'branch' ? 'sidebar.branch.rowAria' : 'sidebar.thread.rowAria', {
        title: label,
        parent: parentTitle ?? t('sidebar.thread.unknownParent'),
      })
    : undefined;
  const emphasis = active || rowState === 'needs-me' || rowState === 'unread';
  return (
    <div
      className="group relative"
      data-session-row={session.id}
      data-session-row-state={rowState}
      data-session-selected={selected || undefined}
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
        className={`row-interactive flex w-full gap-2 py-1.5 pr-2 text-left ${selected ? 'shadow-[inset_0_0_0_1px_var(--color-selected-ink)]' : ''} ${
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
            {/* The one kind glyph: a fork. Sessions a parent started carry none. */}
            {nested && relation?.kind === 'branch' ? (
              <span data-session-relation="branch" aria-hidden className="shrink-0 text-ink-faint">
                <Icon name="branch" size={12} />
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {/* Trailing slot: the time, replaced by the row actions on hover /
              * focus. Wide enough for the two 28px actions so the title never
              * slides under them. */}
            <span
              data-session-time
              className={`min-w-13 shrink-0 text-right text-[12px] leading-4 font-normal text-ink-faint tabular-nums ${
                temporary ? '' : menuOpen ? 'invisible' : 'group-focus-within:invisible group-hover:invisible [@media(hover:none)]:invisible'
              }`}
            >
              <RelativeTime at={session.updated_at} />
            </span>
          </span>
          {fact !== undefined || archived || session.worktree !== undefined || backgroundTasks.length > 0 ? (
            <span className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
              {fact === undefined ? null : fact.kind === 'needs-you' ? (
                <span data-session-needs-you className="min-w-0 truncate font-medium text-attention">{fact.text}</span>
              ) : fact.kind === 'failed' ? (
                <span
                  data-session-failed
                  className="min-w-0 truncate text-ink-soft"
                >
                  {fact.text}
                </span>
              ) : fact.kind === 'live' ? (
                <span data-session-live className="min-w-0 truncate text-ink-soft tabular-nums">{fact.text}</span>
              ) : fact.kind === 'relation' ? (
                // Could not nest (the creator is filtered out or not loaded).
                <span data-session-relation-note={relation?.kind} className="min-w-0 truncate">{fact.text}</span>
              ) : (
                <span data-session-location className="min-w-0 truncate" title={locationPath}>{fact.text}</span>
              )}
              <WorktreeMark worktree={session.worktree} className={fact === undefined ? 'max-w-full' : 'max-w-[55%] shrink-0'} />
              {backgroundTasks.length > 0 ? <BackgroundTasksMark tasks={backgroundTasks} /> : null}
              {archived ? <span className="shrink-0">{fact === undefined ? '' : '· '}{t('sidebar.archived')}</span> : null}
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
            aria-label={pinned ? t('sidebar.unpinSessionFor', { title: label }) : t('sidebar.pinSessionFor', { title: label })}
            title={pinned ? t('menu.unpin') : t('menu.pin')}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.06] ${
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
          className="flex h-7 w-7 items-center justify-center rounded-md text-[13px] leading-none text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      )}
    </div>
  );
}

/**
 * A bucket header in the workspace view (a workspace, Pinned, Ungrouped):
 * fold toggle (chevron in the rows' 7px state column), name, count, and for
 * a registered workspace the pin toggle in the trailing slot. The workspace
 * holding the open session says so; a folded one still marks what inside
 * needs you or is running. Toggle and pin are sibling buttons, never nested.
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
  workspace: Workspace | undefined;
  pinBusy: boolean;
  onToggle: () => void;
  onTogglePin: (() => void) | undefined;
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

/**
 * Running background tasks on a session row: a terminal glyph and the count,
 * never a "+N" chip (that shape reads as queued or pending work). The hover
 * title lists what is running; the accessible name says it in words.
 */
function BackgroundTasksMark({ tasks }: { tasks: readonly ActivityTask[] }) {
  const { tp } = useI18n();
  const summary = tp('sidebar.backgroundTasks', tasks.length);
  const list = tasks.map((task) => `· ${task.description.trim() || task.command || task.id}`).join('\n');
  return (
    <span
      data-session-background-tasks={tasks.length}
      title={`${summary}\n${list}`}
      className="flex shrink-0 items-center gap-0.5 text-ink-faint tabular-nums"
    >
      <Icon name="terminal" size={12} />
      <span aria-hidden>{tasks.length}</span>
      <span className="sr-only">{summary}</span>
    </span>
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
  filtersActive,
  activeKey,
  onHover,
  onOpen,
  workspaceNames,
}: {
  search: SessionSearchState;
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
  const nothingLocal = local.workspaces.length === 0 && local.sessions.length === 0;
  const contentSettledEmpty = search.contentActive && !search.contentPending && search.contentInitialError === null && search.hits.length === 0;
  return (
    <div
      id="sidebar-search-results"
      role="listbox"
      aria-label={t('sidebar.searchAria')}
      data-search-results
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
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
        {search.hits.map((hit, index) => (
          <button key={`${hit.session_id}-${hit.turn ?? 'x'}-${hit.role}-${index}`} type="button" {...option(`h:${index}`)}>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-[13px] leading-snug text-ink-soft">
                <Highlighted text={hit.snippet} ranges={highlightTerms(hit.snippet, search.contentQuery)} />
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-ink-faint">
                <span className="min-w-0 truncate text-ink-soft">{hit.session_title.trim() !== '' ? hit.session_title : t('sidebar.untitled')}</span>
                <span className="shrink-0">· {t(`sidebar.results.role.${hit.role}`)}</span>
                <span className="shrink-0">· <RelativeTime at={new Date(hit.time).toISOString()} /></span>
              </span>
            </span>
          </button>
        ))}
        {search.unavailable !== undefined ? (
          <div data-search-unavailable role="status" className="px-2 pt-1.5 text-[12px] text-ink-faint">
            {t(`sidebar.results.unavailable.${search.unavailable.reason ?? 'generic'}`)}
            {search.unavailable.reason !== 'disabled' && search.unavailable.reason !== 'runtime_disabled' ? (
              <button type="button" data-search-unavailable-retry onClick={() => { void search.retryUnavailable().catch(() => search.retry()); }}
                className="ml-2 font-medium text-ink underline underline-offset-2">{t('common.retry')}</button>
            ) : null}
          </div>
        ) : search.building !== undefined ? (
          <p data-search-building className="px-2 pt-1.5 text-[12px] text-ink-faint">
            {t('sidebar.results.building', { indexed: search.building.indexed_sessions, total: search.building.total_sessions })}
          </p>
        ) : search.incomplete ? (
          <p data-search-incomplete className="px-2 pt-1.5 text-[12px] text-ink-faint">{t('sidebar.results.incomplete')}</p>
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
      </div>

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

const MENU_WIDTH = 232;
/** Rows beyond this are reachable through "manage workspaces"; the menu is a
 * shortcut list, not a workspace browser. */
const MENU_WORKSPACE_ROWS = 8;
const MENU_HEADING = 'px-3 pt-2 pb-1 text-[12px] font-medium text-ink-faint';
const MENU_ITEM =
  'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper';

/** The selection column: reserved on every row so labels stay aligned. */
function MenuMark({ on }: { on: boolean }) {
  return (
    <span aria-hidden className="flex w-3 shrink-0 text-ink">
      {on ? <Icon name="check" size={12} /> : null}
    </span>
  );
}

/** Shared anchored-popover plumbing: measured clamp, Escape, outside click. */
function useAnchoredMenu(anchor: HTMLElement | null, onClose: () => void, overlayId: string, selector: string) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (node !== null) setSize({ width: node.offsetWidth, height: node.offsetHeight });
  }, []);
  useEffect(() => {
    const unregister = registerOverlay(overlayId);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // The triggers are excluded so their own click can toggle the menu shut.
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest(selector) === null) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose, overlayId, selector]);
  const rect = anchor?.getBoundingClientRect();
  const position = clampOverlayPosition(
    (rect?.right ?? MENU_WIDTH) - MENU_WIDTH,
    (rect?.bottom ?? 0) + 4,
    size ?? { width: MENU_WIDTH, height: 0 },
    { width: window.innerWidth, height: window.innerHeight },
  );
  return { menuRef, style: { left: position.left, top: position.top, width: MENU_WIDTH } };
}

const MENU_PANEL =
  'anim-enter fixed z-50 max-h-[min(72vh,480px)] overflow-y-auto rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]';

/** Arrangement only: grouping and sorting. Nothing here hides a session. */
function SidebarViewMenu({
  anchor,
  onClose,
  groupBy,
  onGroupBy,
  sortBy,
  onSortBy,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  groupBy: 'time' | 'workspace' | 'none';
  onGroupBy: (groupBy: 'time' | 'workspace' | 'none') => void;
  sortBy: SessionSortOrder;
  onSortBy: (sortBy: SessionSortOrder) => void;
}) {
  const { t } = useI18n();
  const { menuRef, style } = useAnchoredMenu(anchor, onClose, 'sidebar-view-menu', '[data-view-menu], [data-view-menu-toggle]');
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
  return (
    <div ref={menuRef} data-view-menu role="menu" aria-label={t('sidebar.viewMenu')} style={style} className={MENU_PANEL}>
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
    </div>
  );
}

/**
 * Everything that changes WHICH sessions are visible: status, workspaces
 * (multi-select, with the server-side pin toggle per row) and archived.
 * The panel stays open across clicks — the list rearranges live behind it.
 */
function SidebarFilterMenu({
  anchor,
  onClose,
  filters,
  onToggleStatus,
  onToggleWorkspace,
  onArchived,
  workspaceOptions,
  workspacePinBusy,
  onToggleWorkspacePin,
  onManageWorkspaces,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  filters: SessionListFilters;
  onToggleStatus: (status: SessionStatusFilter) => void;
  onToggleWorkspace: (workspaceId: string) => void;
  onArchived: (archived: SessionArchivedFilter) => void;
  workspaceOptions: readonly Workspace[];
  workspacePinBusy: boolean;
  onToggleWorkspacePin: (workspace: Workspace) => void;
  onManageWorkspaces: () => void;
}) {
  const { t } = useI18n();
  const { menuRef, style } = useAnchoredMenu(anchor, onClose, 'sidebar-filter-menu', '[data-filter-menu], [data-filter-menu-toggle]');
  const statuses: readonly { value: SessionStatusFilter; label: string }[] = [
    { value: 'running', label: t('sidebar.statusRunning') },
    { value: 'needs-me', label: t('sidebar.statusNeedsMe') },
    { value: 'idle', label: t('sidebar.statusIdle') },
  ];
  const head = workspaceOptions.slice(0, MENU_WORKSPACE_ROWS);
  const extra = workspaceOptions.filter((workspace) => filters.workspaces.includes(workspace.id) && !head.includes(workspace));
  const archivedOptions: readonly { value: SessionArchivedFilter; label: string }[] = [
    { value: 'hide', label: t('sidebar.archivedHide') },
    { value: 'include', label: t('sidebar.archivedInclude') },
    { value: 'only', label: t('sidebar.archivedOnly') },
  ];
  return (
    <div ref={menuRef} data-filter-menu data-view-menu-filters role="menu" aria-label={t('sidebar.filterMenu')} style={style} className={MENU_PANEL}>
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
      {workspaceOptions.length > 0 ? (
        <>
          <div className="mx-1 my-1 border-t border-hairline" />
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
                className={`mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors hover:bg-paper disabled:opacity-50 ${
                  workspace.pinned
                    ? 'text-ink-soft'
                    : 'text-transparent group-focus-within:text-ink-faint group-hover:text-ink-faint hover:!text-ink'
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
      <div className="mx-1 my-1 border-t border-hairline" />
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
    </div>
  );
}

/** Small hand-rolled context menu (no Radix): fixed panel, outside-click and
 * Escape to close. The panel size is measured after mount so the position can
 * be clamped inside the viewport on both axes (right-click near an edge). */
function SessionMenu({
  session,
  scopeId,
  activeSessionId,
  x,
  y,
  onClose,
  onRename,
  onTogglePin,
  onAction,
  onArchive,
  onRestore,
  roomSelection,
  threadCommsEnabled,
  onNewRoom,
  onJoinRoom,
}: {
  session: Session;
  scopeId: string;
  /** The open conversation; the thread-reference entry needs one to insert into. */
  activeSessionId: string | undefined;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onAction: (action: 'fork' | 'undo' | 'compact' | 'export') => void;
  onArchive: () => void;
  onRestore: () => void;
  /** Size of the multi-select this row belongs to (0 when it is not selected). */
  roomSelection: number;
  /** `[thread_communication].enabled`; undefined while the config loads. */
  threadCommsEnabled: boolean | undefined;
  onNewRoom: () => void;
  onJoinRoom: () => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const archived = session.archived === true;
  const menuRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  // Layout effect: the clamped position lands before the first paint.
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (node !== null) setSize({ width: node.offsetWidth, height: node.offsetHeight });
  }, []);
  const position = clampOverlayPosition(
    x,
    y,
    size ?? { width: 176, height: 0 },
    { width: window.innerWidth, height: window.innerHeight },
  );
  // Latest onClose via ref: the parent passes inline closures and the sidebar
  // re-renders on its poll interval, so a deps-keyed listener would churn and
  // could swallow an Escape mid-reattach.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const unregister = registerOverlay('session-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
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

  // 「Location & link」group: the lightweight link is the in-app route (the
  // protocol-level kiki:// deep link is deliberately out of scope); folder/
  // editor actions ride the desktop opener commands, so the browser build
  // degrades to the two copy entries only.
  const cwd = session.metadata.cwd;
  const desktop = !scopeId.startsWith('ssh:') && host.revealPath !== undefined && host.openPath !== undefined;
  const runAndClose = (label: string, action: () => Promise<void>) => {
    onClose();
    runToastAction(label, action);
  };

  const itemClass =
    'w-full rounded-md px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper';
  return (
    <div
      ref={menuRef}
      data-session-menu
      role="menu"
      className="anim-enter fixed z-50 w-44 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgb(var(--kiki-shadow-ink)/0.3)]"
      style={{ left: position.left, top: position.top }}
    >
      {archived ? (
        <button type="button" role="menuitem" className={itemClass} onClick={onRestore}>
          {t('menu.restore')}
        </button>
      ) : (
        <>
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onAction('fork'); }}>
            {t('menu.fork')}
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onAction('export'); }}>
            {t('menu.export')}
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onAction('compact'); }}>
            {t('menu.compact')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${itemClass} hover:text-danger`}
            onClick={() => { onAction('undo'); }}
          >
            {t('menu.undo')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-link"
            className={itemClass}
            onClick={() => {
              runAndClose(t('menu.copyLink'), () => copyTextToClipboard(`/s/${session.id}`));
            }}
          >
            {t('menu.copyLink')}
          </button>
          {/* A thread reference into the open conversation's composer, at its
              caret. Nothing open, or this row IS the open one: nothing to add to. */}
          <button
            type="button"
            role="menuitem"
            data-menu-item="add-to-conversation"
            disabled={activeSessionId === undefined || activeSessionId === session.id}
            title={
              activeSessionId === undefined
                ? t('menu.addToConversationNone')
                : activeSessionId === session.id
                  ? t('menu.addToConversationSelf')
                  : undefined
            }
            className={`${itemClass} disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent`}
            onClick={() => {
              if (activeSessionId === undefined) return;
              onClose();
              const link = threadRefLink(session.id);
              if (!requestComposerInsert(activeSessionId, link)) appendToDraft(activeSessionId, link);
            }}
          >
            {t('menu.addToConversation')}
          </button>
          {isSubagentSession(session) ? null : (
            <>
              <div className="mx-1 my-1 border-t border-hairline" />
              <button
                type="button"
                role="menuitem"
                data-menu-item="new-thread-room"
                disabled={threadCommsEnabled === false}
                title={threadCommsEnabled === false ? t('room.commsOff') : undefined}
                className={`${itemClass} disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent`}
                onClick={onNewRoom}
              >
                {roomSelection >= 2 ? t('room.fromThreadsCount', { count: roomSelection }) : t('room.fromThreads')}
              </button>
              <button
                type="button"
                role="menuitem"
                data-menu-item="join-room"
                disabled={threadCommsEnabled === false}
                title={threadCommsEnabled === false ? t('room.commsOff') : undefined}
                className={`${itemClass} disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent`}
                onClick={onJoinRoom}
              >
                {t('room.joinRoom')}
              </button>
              {threadCommsEnabled === false ? (
                <p className="px-3 pt-0.5 pb-1 text-[11.5px] leading-4 text-ink-faint">{t('room.commsOffShort')}</p>
              ) : null}
            </>
          )}
          {cwd !== '' ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="copy-path"
              className={itemClass}
              onClick={() => { runAndClose(t('menu.copyPath'), () => copyTextToClipboard(cwd)); }}
            >
              {t('menu.copyPath')}
            </button>
          ) : null}
          {desktop && cwd !== '' ? (
            <>
              <button
                type="button"
                role="menuitem"
                data-menu-item="open-folder"
                className={itemClass}
                onClick={() => { runAndClose(t('menu.openFolder'), () => host.revealPath!(cwd)); }}
              >
                {t('menu.openFolder')}
              </button>
              <button
                type="button"
                role="menuitem"
                data-menu-item="open-default-app"
                className={itemClass}
                onClick={() => { runAndClose(t('menu.openDefaultApp'), () => host.openPath!(cwd)); }}
              >
                {t('menu.openDefaultApp')}
              </button>
            </>
          ) : null}
          <div className="mx-1 my-1 border-t border-hairline" />
          <button type="button" role="menuitem" className={itemClass} onClick={onTogglePin}>
            {isPinnedSession(session) ? t('menu.unpin') : t('menu.pin')}
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={onRename}>
            {t('menu.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${itemClass} hover:text-danger`}
            onClick={onArchive}
          >
            {t('menu.archive')}
          </button>
        </>
      )}
    </div>
  );
}

/** Rename dialog seeded with the current title; POSTs the profile update. */
function RenameDialog({
  session,
  onClose,
  onRenamed,
}: {
  session: Session;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = title.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    // A bare title patch omits `metadata`, so the server leaves the
    // stored custom document (and with it any client-local pin) untouched.
    void client
      .updateSessionProfile(session.id, { title: trimmed })
      .then(onRenamed)
      .catch((error: unknown) => {
        setBusy(false);
        setError(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <Dialog onClose={onClose} ariaLabel={t('rename.title')} overlayId="rename-dialog">
      <h2 className="font-display text-[18px] font-semibold text-ink">{t('rename.title')}</h2>
      <input
        data-autofocus
        className="mt-3 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
        value={title}
        onChange={(event) => { setTitle(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
        }}
      />
      {error !== null ? (
        <p className="mt-2 font-mono text-[11px] text-danger">{error}</p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:text-ink"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          disabled={busy || title.trim() === ''}
          onClick={submit}
          className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-deep disabled:opacity-50"
        >
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Dialog>
  );
}
