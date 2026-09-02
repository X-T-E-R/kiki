/**
 * Session sidebar — wordmark header, new-session shortcut, global search,
 * settings entry, and the session list (polled every 5s).
 *
 * Entry distribution follows the desktop convention: the wordmark row carries
 * the browse-only usage destination and the footer keeps just the settings
 * entry plus a connection status dot that deep-links to
 * settings → connection. Disconnect lives in that settings section.
 *
 * The search box queries `POST /search` (global full-text index); results
 * stand in for the session list while a query is active, and "load more"
 * appends later pages to the current results. Hits carry no message id —
 * only session_id + turn — so navigation opens the session.
 *
 * The session row menu opens from the hover ⋯ button or a right-click
 * anywhere on the row; the undo confirmation and rename dialog build on the
 * shared `Dialog` primitive.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import type { Session, Workspace } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import type { SearchMessageHit, SearchMessagesResponse } from '../lib/client';
import { copyTextToClipboard } from '../lib/clipboard';
import { isDesktopRuntime } from '../lib/desktop';
import { openHostPath, revealHostPath } from '../lib/hostFileOps';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { groupSearchHits, isSearchable, SEARCH_DEBOUNCE_MS } from '../lib/search';
import { runToastAction } from '../lib/toasts';
import {
  isPinnedSession,
  pinMetadataPatch,
  shortCwd,
  togglePinned,
  type SessionGroup,
  type SessionSortOrder,
} from '../lib/sessionList';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useLayoutPreferences,
  usePaneResize,
  writeLayoutPreferences,
} from '../lib/layoutPrefs';
import {
  compactSessionContext,
  exportSessionArchive,
  forkSession,
  sessionActionErrorText,
  undoLastTurn,
  type SessionActionContext,
} from '../lib/sessionActions';
import { registerOverlay } from '../lib/uiBusy';
import { useConnection } from '../state/connection';
import { ActivityPanel } from './ActivityPanel';
import { Dialog } from './Dialog';
import { useGuardedNavigate } from './dirtyGuard';
import { PendingBadge } from './PendingBadge';
import { Wordmark } from './Wordmark';

/** Wordmark-row icon buttons (usage): glyph-only, ink-faint at rest so the
 * header stays quiet next to the wordmark. */
const HEADER_ICON_BUTTON =
  'flex h-6 w-6 items-center justify-center rounded-md text-[12.5px] leading-none text-ink-faint transition-colors hover:bg-paper hover:text-ink';

/** Slider glyph for the view-options menu (grouping / sorting / scope). */
function SlidersIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className={className}
    >
      <path d="M2 4.5h9M13.5 4.5h.5M2 8h3M7.5 8h6.5M2 11.5h8M12.5 11.5h1.5" />
      <circle cx="12" cy="4.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="6" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="11" cy="11.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Pin glyph for a pinned session row and the hover pin/unpin toggle. */
function PinIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M9.6 1.9l4.5 4.5-1.6 1.6-1-.3-3 3 .5 3.4-1.1 1.1-2.6-3.7-3.2 2.4 5-5.7-.3-1 3-3-.3-1z" />
    </svg>
  );
}

function StatusDot({ session }: { session: Session }) {
  const { t } = useI18n();
  const pending = session.pending_interaction ?? 'none';
  if (pending === 'approval' || pending === 'question') {
    return (
      <span
        title={pending === 'approval' ? t('sidebar.status.approval') : t('sidebar.status.question')}
        className="block h-2 w-2 shrink-0 rounded-full bg-amber-rule shadow-[0_0_0_2px_rgba(232,176,75,0.25)]"
      />
    );
  }
  if (session.busy) {
    return (
      <span
        title={t('sidebar.status.working')}
        className="status-dot-busy block h-2 w-2 shrink-0 rounded-full bg-accent"
      />
    );
  }
  return (
    <span
      title={t('sidebar.status.idle')}
      className="block h-2 w-2 shrink-0 rounded-full border border-hairline-strong bg-panel"
    />
  );
}

function sessionLabel(session: Session, untitled: string): string {
  if (session.title.trim() !== '') return session.title;
  if (session.last_prompt !== undefined && session.last_prompt.trim() !== '') {
    return session.last_prompt;
  }
  return untitled;
}

/** Concatenate pages in server order, keeping every page's `items` verbatim —
 * duplicates re-ranked across a page boundary are kept, never collapsed.
 * Later pages append; they never replace. */
export function mergeSearchPages(
  pages: readonly SearchMessagesResponse[],
): SearchMessageHit[] {
  const hits: SearchMessageHit[] = [];
  for (const page of pages) {
    for (const hit of page.items) {
      hits.push(hit);
    }
  }
  return hits;
}

/** Next-page cursor; the server omits `page_token` on the final page. */
export function searchNextPageParam(
  lastPage: SearchMessagesResponse,
): string | undefined {
  return lastPage.has_more ? lastPage.page_token : undefined;
}

export function Sidebar({
  activeSessionId,
  sessions,
  sessionGroups,
  sessionsQuery,
  workspaceOptions,
  workspaceFilter,
  onWorkspaceFilter,
  showArchived,
  onToggleArchived,
  onNewSession,
  groupBy,
  onGroupBy,
  sortBy,
  onSortBy,
  className,
}: {
  activeSessionId: string | undefined;
  sessions: readonly Session[];
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
  workspaceFilter: string | undefined;
  onWorkspaceFilter: (workspaceId: string | undefined) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  groupBy: 'time' | 'workspace';
  onGroupBy: (groupBy: 'time' | 'workspace') => void;
  sortBy: SessionSortOrder;
  onSortBy: (sortBy: SessionSortOrder) => void;
  /** Opens the new-session dialog (the /new page stays the no-session landing). */
  onNewSession: () => void;
  className?: string;
}) {
  const navigate = useGuardedNavigate();
  const { client, meta, wsStatus } = useConnection();
  const { t, locale, time } = useI18n();
  const untitled = t('sidebar.untitled');
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<Session | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [workspacePinBusy, setWorkspacePinBusy] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Local panel-layout prefs: the sidebar owns its own width (screen readers
  // prefer explicit resize handles as buttons, but we keep the drag-only
  // interaction consistent with the preview workbench) and mirrors the
  // persisted grouping/sorting selection through the parent's controlled state.
  const layoutPrefs = useLayoutPreferences();
  // Local live width drives the inline CSS var during a drag so the panel
  // resizes on every pointer-move; the persisted pref is only written on
  // pointer-up. Cross-document changes (storage event) re-sync the local copy.
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
    () => ({ client, refreshSessions, navigate }),
    [client, refreshSessions, navigate],
  );

  // Debounced global search; react-query cancels superseded requests.
  useEffect(() => {
    const timer = setTimeout(() => { setSearchQuery(searchInput.trim()); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [searchInput]);
  const searchActive = isSearchable(searchQuery);
  // `useInfiniteQuery` accumulates pages under one key, so loading more
  // appends to the current results instead of replacing them; a changed
  // `searchQuery` swaps the key and starts again from the first page.
  const searchResultsQuery = useInfiniteQuery({
    queryKey: ['global-search', searchQuery],
    queryFn: ({ signal, pageParam }) =>
      client.searchMessages(
        { query: searchQuery, page_size: 30, sort: 'score', page_token: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: searchNextPageParam,
    enabled: searchActive,
    staleTime: 15_000,
  });
  const searchHits = useMemo(
    () => mergeSearchPages(searchResultsQuery.data?.pages ?? []),
    [searchResultsQuery.data],
  );
  const searchGroups = useMemo(
    () => groupSearchHits(searchHits),
    [searchHits],
  );
  // Only the initial fetch (no successful page yet) warrants the full-screen
  // error card; a failed "load more" keeps the pages already rendered and the
  // retry affordance below the list.
  const searchHasNoPages = searchResultsQuery.data === undefined;
  const searchInitialError = searchResultsQuery.isError && searchHasNoPages;
  const searchAppendError = searchResultsQuery.isFetchNextPageError;
  // A shortfall on any loaded page keeps the warning visible; `building` wins
  // the copy so the indexed-count line stays meaningful for the whole query.
  const searchBuildingPage =
    searchResultsQuery.data?.pages.findLast(
      (page) => page.index_state.state === 'building',
    );
  const searchIncomplete =
    searchResultsQuery.data?.pages.some(
      (page) => page.incomplete !== undefined,
    ) === true;
  const searchIndexNotice = searchBuildingPage !== undefined || searchIncomplete;

  // Workspace pin: one toggle per row inside the view menu. It writes the
  // server-side `pinned` field, so the order it produces is shared by every
  // client.
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

  const runAction = (
    session: Session,
    action: 'fork' | 'undo' | 'compact' | 'export',
  ) => {
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
          setActionError(
            t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }),
          );
        });
    }
  };

  const archive = (session: Session) => {
    setMenu(null);
    setActionError(null);
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
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <Wordmark />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            data-nav-usage
            onClick={() => void navigate('/usage')}
            aria-label={t('usage.navAria')}
            title={t('usage.nav')}
            className={HEADER_ICON_BUTTON}
          >
            <span aria-hidden>$</span>
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-accent hover:text-accent"
        >
          <span aria-hidden className="text-[14px] leading-none">＋</span> {t('sidebar.newSession')}
        </button>
        {/* Search owns this row; every view preference (grouping, sorting,
          * scope, archived) sits behind the one glyph beside it. */}
        <div className="mt-2 flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <input
              type="text"
              value={searchInput}
              data-search-box
              onChange={(event) => { setSearchInput(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearchInput('');
                  event.currentTarget.blur();
                }
              }}
              placeholder={t('sidebar.searchPlaceholder')}
              aria-label={t('sidebar.searchAria')}
              className="w-full rounded-lg bg-paper px-2.5 py-1.5 pr-7 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:ring-2 focus:ring-accent/40"
            />
            {searchInput === '' ? null : (
              <button
                type="button"
                aria-label={t('sidebar.clearSearch')}
                onClick={() => { setSearchInput(''); }}
                className="absolute top-1/2 right-1.5 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
              >
                ×
              </button>
            )}
          </div>
          <button
            type="button"
            ref={viewMenuButtonRef}
            data-view-menu-toggle
            aria-haspopup="menu"
            aria-expanded={viewMenuOpen}
            aria-label={t('sidebar.viewMenu')}
            title={t('sidebar.viewMenu')}
            onClick={() => { setViewMenuOpen((open) => !open); }}
            className="flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-paper hover:text-ink aria-expanded:bg-paper aria-expanded:text-ink"
          >
            <SlidersIcon className="h-[13px] w-[13px]" />
          </button>
        </div>
      </div>

      <ActivityPanel sessions={sessions} />

      {/* Filters change WHICH sessions are visible, so they leave a revocable
        * trace here; grouping and sorting only rearrange and stay in the menu. */}
      {!searchActive && (workspaceFilter !== undefined || showArchived) ? (
        <div
          data-sidebar-filters
          aria-label={t('sidebar.filtersAria')}
          className="flex flex-wrap items-center gap-1 px-3 pb-1.5"
        >
          {workspaceFilter !== undefined ? (
            <FilterChip
              kind="workspace"
              label={
                workspaceOptions.find((workspace) => workspace.id === workspaceFilter)?.name
                ?? workspaceFilter
              }
              clearLabel={t('sidebar.clearWorkspaceFilter')}
              onOpen={() => { setViewMenuOpen(true); }}
              onClear={() => { onWorkspaceFilter(undefined); }}
              openLabel={t('sidebar.viewMenu')}
            />
          ) : null}
          {showArchived ? (
            <FilterChip
              kind="archived"
              label={t('sidebar.filterArchived')}
              clearLabel={t('sidebar.clearArchivedFilter')}
              onOpen={() => { setViewMenuOpen(true); }}
              onClear={onToggleArchived}
              openLabel={t('sidebar.viewMenu')}
            />
          ) : null}
        </div>
      ) : null}

      {searchActive ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-search-results role="region" aria-label={t('sidebar.searchAria')}>
          {searchResultsQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 px-2 pt-6 text-[12px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('sidebar.searching')}
            </div>
          ) : searchInitialError ? (
            <div className="mx-1 mt-2 rounded-md border border-danger/30 bg-danger/5 p-2">
              <p className="text-[11.5px] font-medium text-danger">{t('sidebar.searchFailed')}</p>
              <p className="font-mono text-[10px] text-danger/80">
                {searchResultsQuery.error instanceof Error
                  ? searchResultsQuery.error.message
                  : t('common.unknownError')}
              </p>
            </div>
          ) : searchGroups.length === 0 ? (
            <p className="px-2 pt-6 text-center text-[12px] text-ink-faint">
              {t('sidebar.noMatches', { query: searchQuery })}
            </p>
          ) : (
            <>
              {searchGroups.map((group) => (
                <div key={group.sessionId} className="mb-2" role="group" aria-label={group.title.trim() !== '' ? group.title : untitled}>
                  <p className="truncate px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
                    {group.title.trim() !== '' ? group.title : untitled}
                  </p>
                  {group.hits.map((hit, index) => (
                    <button
                      key={`${hit.session_id}-${hit.turn ?? 'x'}-${hit.role}-${index}`}
                      type="button"
                      onClick={() => {
                        setSearchInput('');
                        void navigate(`/s/${hit.session_id}`);
                      }}
                      className="flex w-full flex-col gap-0.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-paper"
                    >
                      <span className="line-clamp-2 text-[11.5px] leading-snug text-ink">
                        {hit.snippet}
                      </span>
                      <span className="flex items-center gap-1.5 text-[9.5px] text-ink-faint">
                        <span className="rounded border border-hairline px-1 font-mono">
                          {hit.role}
                        </span>
                        <span>{time.relativeTime(new Date(hit.time).toISOString())}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {searchIndexNotice ? (
                <p className="px-2 pt-1 text-center font-mono text-[9.5px] text-ink-faint">
                  {searchBuildingPage !== undefined
                    ? t('sidebar.indexBuilding', {
                        indexed: searchBuildingPage.index_state.indexed_sessions,
                        total: searchBuildingPage.index_state.total_sessions,
                      })
                    : t('sidebar.indexIncomplete')}
                </p>
              ) : null}
              {searchResultsQuery.hasNextPage ? (
                <button
                  type="button"
                  data-search-load-more
                  disabled={searchResultsQuery.isFetchingNextPage || searchResultsQuery.isFetching}
                  onClick={() => { void searchResultsQuery.fetchNextPage(); }}
                  className="mt-2 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-center text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-60"
                >
                  {searchResultsQuery.isFetchingNextPage
                    ? t('sidebar.loadingMore')
                    : t('sidebar.searchLoadMore')}
                </button>
              ) : null}
              {searchAppendError ? (
                <div className="mx-1 mt-2 rounded-md border border-danger/30 bg-danger/5 p-2">
                  <p className="text-[11.5px] font-medium text-danger">{t('sidebar.searchFailed')}</p>
                  <button
                    type="button"
                    data-search-retry
                    disabled={searchResultsQuery.isFetchingNextPage}
                    onClick={() => { void searchResultsQuery.fetchNextPage(); }}
                    className="mt-1.5 text-[11px] font-medium text-danger underline"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-session-list role="region" aria-label={t('sidebar.listAria')}>
        {sessionsQuery.isLoading && sessions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-2 pt-6 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('sidebar.loadingSessions')}
          </div>
        ) : null}
        {sessionsQuery.isError ? (
          <div className="mx-1 mt-2 rounded-md border border-danger/30 bg-danger/5 p-2">
            <p className="text-[11.5px] font-medium text-danger">{t('sidebar.loadFailed')}</p>
            <p className="font-mono text-[10px] text-danger/80">
              {sessionsQuery.error?.message ?? t('common.unknownError')}
            </p>
            <button
              type="button"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['sessions'] })}
              className="mt-1.5 text-[11px] font-medium text-danger underline"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : null}
        {sessions.length === 0 && !sessionsQuery.isLoading && !sessionsQuery.isError ? (
          <div className="mx-1 mt-2 rounded-lg border border-hairline bg-paper px-3 py-4 text-center" data-sidebar-empty>
            <p className="text-[12px] text-ink-soft">{t('sidebar.noSessions')}</p>
            {!showArchived ? (
              <button
                type="button"
                onClick={onToggleArchived}
                className="mt-1 text-[11px] font-medium text-accent underline underline-offset-2"
              >
                {t('sidebar.emptyShowArchived')}
              </button>
            ) : null}
          </div>
        ) : null}
        {actionError !== null ? (
          <p className="mx-1 mb-1 rounded-md border border-danger/30 bg-danger/5 px-2 py-1 font-mono text-[10.5px] text-danger">
            {actionError}
          </p>
        ) : null}
        {actionNotice !== null ? (
          <p className="mx-1 mb-1 rounded-md border border-success/30 bg-success/5 px-2 py-1 font-mono text-[10.5px] text-success">
            {actionNotice}
          </p>
        ) : null}
        {sessionGroups.map((group) => (
          <div key={group.key} className="mb-1" role="group" aria-label={group.label}>
            <p
              data-session-group={group.key}
              className="sticky top-0 z-[1] bg-[var(--color-panel)] px-2 py-1 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase"
            >
              {group.label}
            </p>
            {group.items.map((session) => {
              const active = session.id === activeSessionId;
              const archived = session.archived === true;
              const pinned = isPinnedSession(session);
              return (
                <div
                  key={session.id}
                  className="group relative mb-0.5"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ session, x: event.clientX, y: event.clientY });
                  }}
                >
                  <button
                    type="button"
                    onClick={() => void navigate(`/s/${session.id}`)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      active
                        ? 'border-hairline bg-accent-soft'
                        : 'border-transparent hover:bg-paper'
                    } ${archived ? 'opacity-55' : ''}`}
                  >
                    <span className="flex w-2 shrink-0 justify-center pt-[7px]">
                      <StatusDot session={session} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        data-session-title
                        className={`flex items-center gap-1 text-[12.5px] leading-snug ${
                          active ? 'font-semibold text-ink' : 'font-medium text-ink'
                        }`}
                      >
                        {pinned ? (
                          <PinIcon
                            className="h-[11px] w-[11px] shrink-0 text-accent"
                          />
                        ) : null}
                        <span className="min-w-0 truncate">{sessionLabel(session, untitled)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                        <span className="truncate font-mono">{shortCwd(session.metadata.cwd)}</span>
                        <span className="shrink-0">· {time.relativeTime(session.updated_at)}</span>
                        {archived ? <span className="shrink-0">· {t('sidebar.archived')}</span> : null}
                      </span>
                    </span>
                  </button>
                  {/* Hover/focus row affordances: quick pin toggle, then the
                    * full action menu. Both stay reachable from the keyboard
                    * through the row's `focus-within`. */}
                  <div
                    className={`absolute top-1.5 right-1.5 flex items-center gap-0.5 transition-opacity ${
                      menu?.session.id === session.id
                        ? 'opacity-100'
                        : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
                    }`}
                  >
                    {archived ? null : (
                      <button
                        type="button"
                        data-session-pin-toggle
                        aria-label={
                          pinned
                            ? t('sidebar.unpinSessionFor', { title: sessionLabel(session, untitled) })
                            : t('sidebar.pinSessionFor', { title: sessionLabel(session, untitled) })
                        }
                        title={pinned ? t('menu.unpin') : t('menu.pin')}
                        onClick={(event) => {
                          event.stopPropagation();
                          togglePin(session);
                        }}
                        className={`flex h-[18px] w-[18px] items-center justify-center rounded-md transition-colors hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none ${
                          pinned ? 'text-accent' : 'text-ink-faint hover:text-ink'
                        }`}
                      >
                        <PinIcon className="h-[11px] w-[11px]" />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={t('sidebar.sessionActionsFor', { title: sessionLabel(session, untitled) })}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenu((current) =>
                          current?.session.id === session.id
                            ? null
                            : { session, x: rect.right + 4, y: rect.top },
                        );
                      }}
                      className="rounded-md px-1.5 py-0.5 text-[12px] leading-none text-ink-faint transition-colors hover:bg-panel hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none"
                    >
                      ⋯
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {sessionsQuery.hasNextPage ? (
          <button
            type="button"
            data-session-load-more
            disabled={sessionsQuery.isFetchingNextPage}
            onClick={() => void sessionsQuery.fetchNextPage?.()}
            className="mt-1.5 w-full rounded-md px-2 py-1 text-center text-[11px] text-ink-faint transition-colors hover:text-ink-soft focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none disabled:opacity-60"
          >
            {sessionsQuery.isFetchingNextPage ? t('sidebar.loadingMore') : t('sidebar.loadMore')}
          </button>
        ) : null}
      </div>
      )}

      <div className="flex items-center gap-1.5 border-t border-hairline px-3 py-2.5">
        <PendingBadge sessions={sessions} />
        <button
          type="button"
          onClick={() => void navigate('/settings')}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] text-ink-soft transition-colors hover:bg-paper hover:text-ink"
        >
          <span aria-hidden className="text-[13px]">⚙</span> {t('sidebar.settings')}
        </button>
        <button
          type="button"
          data-connection-status
          onClick={() => void navigate('/settings/connection')}
          aria-label={t('sidebar.connStatusAria')}
          title={t('sidebar.connTitle', {
            version: meta.server_version,
            status: t(`sidebar.ws.${wsStatus}`),
          })}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-paper"
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

      {viewMenuOpen ? (
        <SidebarViewMenu
          anchor={viewMenuButtonRef.current}
          onClose={() => { setViewMenuOpen(false); }}
          workspaceOptions={workspaceOptions}
          workspaceFilter={workspaceFilter}
          onWorkspaceFilter={onWorkspaceFilter}
          workspacePinBusy={workspacePinBusy}
          onToggleWorkspacePin={toggleWorkspacePin}
          onManageWorkspaces={() => {
            setViewMenuOpen(false);
            void navigate('/settings/workspaces');
          }}
          groupBy={groupBy}
          onGroupBy={onGroupBy}
          sortBy={sortBy}
          onSortBy={onSortBy}
          showArchived={showArchived}
          onToggleArchived={onToggleArchived}
        />
      ) : null}
      {menu !== null ? (
        <SessionMenu
          session={menu.session}
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
        />
      ) : null}
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
          <h2 className="font-display text-[16px] font-semibold text-ink">{t('undo.title')}</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
            {t('undo.bodyNamed', { title: sessionLabel(confirmUndo, untitled) })}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setConfirmUndo(null); }}
              className="rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:text-ink"
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
                    setActionNotice(
                      t('action.undoDone', { title: sessionLabel(session, untitled) }),
                    );
                  })
                  .catch((error: unknown) => {
                    setActionError(
                      t('action.undoFailed', { detail: sessionActionErrorText(locale, error) }),
                    );
                  });
              }}
              className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-deep"
            >
              {t('undo.confirm')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </aside>
  );
}

/** A revocable trace for one active filter: the body reopens the view menu,
 * the × resets that one filter. Two buttons side by side rather than nested,
 * so both stay reachable from the keyboard. */
function FilterChip({
  kind,
  label,
  clearLabel,
  openLabel,
  onOpen,
  onClear,
}: {
  kind: 'workspace' | 'archived';
  label: string;
  clearLabel: string;
  openLabel: string;
  onOpen: () => void;
  onClear: () => void;
}) {
  return (
    <span
      data-sidebar-filter-chip={kind}
      className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-accent-soft pr-0.5 pl-1.5 text-[10.5px] text-accent"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        className="min-w-0 truncate py-0.5 transition-opacity hover:opacity-75"
      >
        {label}
      </button>
      <button
        type="button"
        data-sidebar-filter-clear={kind}
        onClick={onClear}
        aria-label={clearLabel}
        title={clearLabel}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full leading-none transition-colors hover:bg-accent/15"
      >
        ×
      </button>
    </span>
  );
}

const VIEW_MENU_WIDTH = 224;
/** Rows beyond this are reachable through "manage workspaces"; the menu is a
 * shortcut list, not a workspace browser. */
const VIEW_MENU_WORKSPACE_ROWS = 6;

const VIEW_MENU_HEADING =
  'px-2.5 pt-2 pb-1 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase';
const VIEW_MENU_ITEM =
  'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper';

/** The selection column: reserved on every row so labels stay aligned whether
 * or not the row is the active one. */
function ViewMenuMark({ on, glyph = '✓' }: { on: boolean; glyph?: string }) {
  return (
    <span aria-hidden className="w-3 shrink-0 text-[10px] text-accent">
      {on ? glyph : ''}
    </span>
  );
}

/**
 * The sidebar's one view-preference surface: workspace scope, grouping,
 * sorting, and archived visibility. Every option writes through the same
 * callbacks the old inline selects used, so persistence is unchanged. The
 * panel stays open across option clicks — the list rearranges live behind it.
 */
function SidebarViewMenu({
  anchor,
  onClose,
  workspaceOptions,
  workspaceFilter,
  onWorkspaceFilter,
  workspacePinBusy,
  onToggleWorkspacePin,
  onManageWorkspaces,
  groupBy,
  onGroupBy,
  sortBy,
  onSortBy,
  showArchived,
  onToggleArchived,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  workspaceOptions: readonly Workspace[];
  workspaceFilter: string | undefined;
  onWorkspaceFilter: (workspaceId: string | undefined) => void;
  workspacePinBusy: boolean;
  onToggleWorkspacePin: (workspace: Workspace) => void;
  onManageWorkspaces: () => void;
  groupBy: 'time' | 'workspace';
  onGroupBy: (groupBy: 'time' | 'workspace') => void;
  sortBy: SessionSortOrder;
  onSortBy: (sortBy: SessionSortOrder) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (node !== null) setSize({ width: node.offsetWidth, height: node.offsetHeight });
  }, []);
  useEffect(() => {
    const unregister = registerOverlay('sidebar-view-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // The trigger is excluded so its own click can toggle the menu shut
    // instead of this handler closing and the click reopening.
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.closest('[data-view-menu], [data-view-menu-toggle]') === null
      ) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  const rect = anchor?.getBoundingClientRect();
  const position = clampOverlayPosition(
    (rect?.right ?? VIEW_MENU_WIDTH) - VIEW_MENU_WIDTH,
    (rect?.bottom ?? 0) + 4,
    size ?? { width: VIEW_MENU_WIDTH, height: 0 },
    { width: window.innerWidth, height: window.innerHeight },
  );

  const head = workspaceOptions.slice(0, VIEW_MENU_WORKSPACE_ROWS);
  const scoped = workspaceOptions.find((workspace) => workspace.id === workspaceFilter);
  const rows = scoped !== undefined && !head.includes(scoped) ? [...head, scoped] : head;

  const sortOptions: readonly { value: SessionSortOrder; label: string }[] = [
    { value: 'updated-desc', label: t('sidebar.sortUpdatedDesc') },
    { value: 'updated-asc', label: t('sidebar.sortUpdatedAsc') },
    { value: 'title', label: t('sidebar.sortTitle') },
  ];

  return (
    <div
      ref={menuRef}
      data-view-menu
      role="menu"
      aria-label={t('sidebar.viewMenu')}
      style={{ left: position.left, top: position.top, width: VIEW_MENU_WIDTH }}
      className="anim-enter fixed z-50 max-h-[min(70vh,440px)] overflow-y-auto rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgb(var(--kiki-shadow-ink)/0.3)]"
    >
      {workspaceOptions.length > 0 ? (
        <>
          <p className={VIEW_MENU_HEADING}>{t('sidebar.viewWorkspaceHeading')}</p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={workspaceFilter === undefined}
            data-workspace-filter=""
            className={VIEW_MENU_ITEM}
            onClick={() => { onWorkspaceFilter(undefined); }}
          >
            <ViewMenuMark on={workspaceFilter === undefined} />
            <span className="truncate">{t('sidebar.workspaceAll')}</span>
          </button>
          {rows.map((workspace) => (
            <div key={workspace.id} className="group flex items-center">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={workspaceFilter === workspace.id}
                data-workspace-filter={workspace.id}
                className={VIEW_MENU_ITEM}
                onClick={() => { onWorkspaceFilter(workspace.id); }}
              >
                <ViewMenuMark on={workspaceFilter === workspace.id} />
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
                className={`mr-0.5 flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-md transition-colors hover:bg-paper disabled:opacity-50 ${
                  workspace.pinned
                    ? 'text-accent'
                    : 'text-transparent group-focus-within:text-ink-faint group-hover:text-ink-faint hover:!text-ink'
                }`}
              >
                <PinIcon className="h-[11px] w-[11px]" />
              </button>
            </div>
          ))}
          <button
            type="button"
            role="menuitem"
            data-manage-workspaces
            className={VIEW_MENU_ITEM}
            onClick={onManageWorkspaces}
          >
            <ViewMenuMark on={false} />
            <span className="truncate text-ink-soft">{t('sidebar.manageWorkspaces')}</span>
          </button>
          <div className="mx-1 mt-1 border-t border-hairline" />
        </>
      ) : null}

      <p className={VIEW_MENU_HEADING}>{t('sidebar.viewGroupHeading')}</p>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={groupBy === 'time'}
        data-group-by="time"
        className={VIEW_MENU_ITEM}
        onClick={() => { onGroupBy('time'); }}
      >
        <ViewMenuMark on={groupBy === 'time'} />
        <span className="truncate">{t('sidebar.groupByTime')}</span>
      </button>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={groupBy === 'workspace'}
        data-group-by="workspace"
        className={VIEW_MENU_ITEM}
        onClick={() => { onGroupBy('workspace'); }}
      >
        <ViewMenuMark on={groupBy === 'workspace'} />
        <span className="truncate">{t('sidebar.groupByWorkspace')}</span>
      </button>

      <p className={VIEW_MENU_HEADING}>{t('sidebar.viewSortHeading')}</p>
      {sortOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={sortBy === option.value}
          data-sort-by={option.value}
          className={VIEW_MENU_ITEM}
          onClick={() => { onSortBy(option.value); }}
        >
          <ViewMenuMark on={sortBy === option.value} />
          <span className="truncate">{option.label}</span>
        </button>
      ))}

      <div className="mx-1 mt-1 border-t border-hairline" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={showArchived}
        data-show-archived
        className={`${VIEW_MENU_ITEM} mt-1`}
        onClick={onToggleArchived}
      >
        <ViewMenuMark on={showArchived} />
        <span className="truncate">{t('sidebar.showArchived')}</span>
      </button>
    </div>
  );
}

/** Small hand-rolled context menu (no Radix): fixed panel, outside-click and
 * Escape to close. The panel size is measured after mount so the position can
 * be clamped inside the viewport on both axes (right-click near an edge). */
function SessionMenu({
  session,
  x,
  y,
  onClose,
  onRename,
  onTogglePin,
  onAction,
  onArchive,
  onRestore,
}: {
  session: Session;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onAction: (action: 'fork' | 'undo' | 'compact' | 'export') => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
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
  const desktop = isDesktopRuntime();
  const runAndClose = (label: string, action: () => Promise<void>) => {
    onClose();
    runToastAction(label, action);
  };

  const itemClass =
    'w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper';
  return (
    <div
      ref={menuRef}
      data-session-menu
      role="menu"
      className="anim-enter fixed z-50 w-44 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]"
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
                onClick={() => { runAndClose(t('menu.openFolder'), () => revealHostPath(cwd)); }}
              >
                {t('menu.openFolder')}
              </button>
              <button
                type="button"
                role="menuitem"
                data-menu-item="open-default-app"
                className={itemClass}
                onClick={() => { runAndClose(t('menu.openDefaultApp'), () => openHostPath(cwd)); }}
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
      <h2 className="font-display text-[16px] font-semibold text-ink">{t('rename.title')}</h2>
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
          className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-50"
        >
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Dialog>
  );
}
