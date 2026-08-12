/**
 * Session sidebar — wordmark header with connection pill, new-session shortcut,
 * global search, settings entry, and the session list (polled every 5s).
 *
 * The search box queries `POST /search` (global full-text index); results
 * replace the list while a query is active. Hits carry no message id — only
 * session_id + turn — so navigation opens the session.
 *
 * The session row menu opens from the hover ⋯ button or a right-click
 * anywhere on the row; the undo confirmation and rename dialog build on the
 * shared `Dialog` primitive.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { Session } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { groupSearchHits, isSearchable, SEARCH_DEBOUNCE_MS } from '../lib/search';
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
import { Dialog } from './Dialog';
import { PendingBadge } from './PendingBadge';
import { Wordmark } from './Wordmark';

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

export function Sidebar({
  activeSessionId,
  sessions,
  sessionsQuery,
  showArchived,
  onToggleArchived,
  onNewSession,
  className,
}: {
  activeSessionId: string | undefined;
  sessions: readonly Session[];
  sessionsQuery: {
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    fetchNextPage?: () => Promise<unknown>;
  };
  showArchived: boolean;
  onToggleArchived: () => void;
  /** Opens the new-session dialog (the /new page stays the no-session landing). */
  onNewSession: () => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const { client, meta, wsStatus, disconnect } = useConnection();
  const { t, locale, time } = useI18n();
  const untitled = t('sidebar.untitled');
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<Session | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

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
  const searchResultsQuery = useQuery({
    queryKey: ['global-search', searchQuery],
    queryFn: ({ signal }) =>
      client.searchMessages({ query: searchQuery, page_size: 30, sort: 'score' }, signal),
    enabled: searchActive,
    staleTime: 15_000,
  });
  const searchGroups = useMemo(
    () => groupSearchHits(searchResultsQuery.data?.items ?? []),
    [searchResultsQuery.data],
  );

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
    <aside className={className ?? 'flex h-full w-[264px] shrink-0 flex-col border-r border-hairline bg-panel'}>
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <Wordmark />
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            wsStatus === 'open'
              ? 'border-success/30 text-success'
              : wsStatus === 'connecting'
                ? 'border-amber-rule/40 text-amber-ink'
                : 'border-danger/30 text-danger'
          }`}
          title={`kap-server ${meta.server_version} · ws ${wsStatus}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              wsStatus === 'open'
                ? 'bg-success'
                : wsStatus === 'connecting'
                  ? 'bg-amber-rule'
                  : 'bg-danger'
            }`}
          />
          {wsStatus === 'open'
            ? `v${meta.server_version}`
            : t(wsStatus === 'connecting' ? 'sidebar.ws.connecting' : 'sidebar.ws.closed')}
        </span>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-accent hover:text-accent"
        >
          <span aria-hidden className="text-[14px] leading-none">＋</span> {t('sidebar.newSession')}
        </button>
        <div className="relative mt-2">
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
            className="w-full rounded-lg border border-hairline bg-paper px-2.5 py-1.5 pr-9 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
          {searchInput === '' ? null : (
            <button
              type="button"
              aria-label={t('sidebar.clearSearch')}
              onClick={() => { setSearchInput(''); }}
              className="absolute top-1/2 right-2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {searchActive ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-search-results>
          {searchResultsQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 px-2 pt-6 text-[12px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('sidebar.searching')}
            </div>
          ) : searchResultsQuery.isError ? (
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
                <div key={group.sessionId} className="mb-2">
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
              {searchResultsQuery.data !== undefined &&
              (searchResultsQuery.data.index_state.state === 'building' ||
                searchResultsQuery.data.incomplete !== undefined) ? (
                <p className="px-2 pt-1 text-center font-mono text-[9.5px] text-ink-faint">
                  {searchResultsQuery.data.index_state.state === 'building'
                    ? t('sidebar.indexBuilding', {
                        indexed: searchResultsQuery.data.index_state.indexed_sessions,
                        total: searchResultsQuery.data.index_state.total_sessions,
                      })
                    : t('sidebar.indexIncomplete')}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
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
          <p className="px-2 pt-6 text-center text-[12px] text-ink-faint">
            {t('sidebar.noSessions')}
          </p>
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
        {sessions.map((session) => {
          const active = session.id === activeSessionId;
          const archived = session.archived === true;
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
                    className={`block truncate text-[12.5px] leading-snug ${
                      active ? 'font-semibold text-ink' : 'font-medium text-ink'
                    }`}
                  >
                    {sessionLabel(session, untitled)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                    <span className="truncate font-mono">{shortCwd(session.metadata.cwd)}</span>
                    <span className="shrink-0">· {time.relativeTime(session.updated_at)}</span>
                    {archived ? <span className="shrink-0">· {t('sidebar.archived')}</span> : null}
                  </span>
                </span>
              </button>
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
                className={`absolute top-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[12px] leading-none text-ink-faint transition-opacity hover:bg-panel hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none ${
                  menu?.session.id === session.id
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                ⋯
              </button>
            </div>
          );
        })}
        {sessionsQuery.hasNextPage ? (
          <button
            type="button"
            disabled={sessionsQuery.isFetchingNextPage}
            onClick={() => void sessionsQuery.fetchNextPage?.()}
            className="mt-2 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-center text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-60"
          >
            {sessionsQuery.isFetchingNextPage ? t('sidebar.loadingMore') : t('sidebar.loadMore')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggleArchived}
          className="mt-1 w-full rounded-md px-2 py-1 text-center text-[10.5px] text-ink-faint transition-colors hover:text-ink-soft focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none"
        >
          {showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')}
        </button>
      </div>
      )}

      <div className="border-t border-hairline px-3 py-2.5 space-y-1">
        <PendingBadge sessions={sessions} />
        <button
          type="button"
          onClick={() => void navigate('/settings')}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] text-ink-soft transition-colors hover:bg-paper hover:text-ink"
        >
          <span aria-hidden className="text-[13px]">⚙</span> {t('sidebar.settings')}
        </button>
        <button
          type="button"
          onClick={disconnect}
          className="w-full rounded-lg px-2 py-1 text-left text-[11.5px] text-ink-soft transition-colors hover:text-danger"
        >
          {t('sidebar.disconnect')}
        </button>
      </div>

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

/** Small hand-rolled context menu (no Radix): fixed panel, outside-click and
 * Escape to close. The panel size is measured after mount so the position can
 * be clamped inside the viewport on both axes (right-click near an edge). */
function SessionMenu({
  session,
  x,
  y,
  onClose,
  onRename,
  onAction,
  onArchive,
  onRestore,
}: {
  session: Session;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
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
  useEffect(() => {
    const unregister = registerOverlay('session-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-session-menu]') === null) {
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

function shortCwd(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter((part) => part !== '');
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join('/')}`;
}
