/**
 * /archived — the archive, as a page of its own.
 *
 * Archived conversations are native sessions, so this runs on the ordinary
 * session list, the restore route and the two deletion routes. Reading one
 * lands on `/s/:id`, the ordinary conversation view. A row's own verbs —
 * restore, delete for good — sit behind its ⋯, while multi-select mode offers
 * bounded subset restore of explicitly loaded rows without exposing bulk
 * subset deletion (whole-archive deletion remains explicit at the bottom).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { DeleteArchivedSessionsResponse, Session } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { readTopLevelThreads } from '../lib/threadDisplayMemory';
import { pushToast, runToastAction } from '../lib/toasts';
import { useConnection, useOptionalConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { isOnKikiComputer } from './imageActions';
import { invalidatePersonaSessionLists } from '../lib/personaFreshness';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { PAGE_WIDTH, PageHeader } from './PageChrome';
import { RelativeTime } from './RelativeTime';
import { ThreadTitle } from './ThreadTitle';
import { ListBulkBar, RowCheck } from './settings/list/ListParts';
import { DANGER_GHOST_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const DELETE_ALL = 'all';
export const ARCHIVE_VIRTUALIZE_THRESHOLD = 60;
export const MAX_ARCHIVE_RESTORE_CONCURRENCY = 4;

/** Fine-hover reveal rule: visible on touch/keyboard/open-menu, quiet at rest on hover-capable desktops. */
const ROW_ACTION_QUIET =
  'opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/row:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/row:opacity-100 focus-visible:opacity-100';

interface FailedEntry {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

interface ActionOutcome {
  readonly failed: readonly FailedEntry[];
  readonly error: string | null;
}

const NO_FAILURES: ActionOutcome = { failed: [], error: null };

interface ArchivedPage {
  readonly items: readonly Session[];
  readonly has_more: boolean;
  readonly next_cursor?: string | null;
}

function dedupe(sessions: readonly Session[]): Session[] {
  const seen = new Set<string>();
  const out: Session[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    out.push(session);
  }
  return out;
}

function promotedTopLevelIds(scopeId: string): string[] {
  try {
    return [...readTopLevelThreads(scopeId)];
  } catch {
    return [];
  }
}

/** Runs async work across `items` with at most `limit` concurrent promises. */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const current = items[cursor]!;
        cursor += 1;
        await worker(current);
      }
    }),
  );
}

/**
 * One connection's archive.
 *
 * The whole body is keyed by scope, so a scope switch unmounts it rather than
 * leaving another home's dialogs, selection, pending state or failure list on
 * screen. A deletion or restore started in the previous scope still settles
 * when it answers; it only reaches the previous scope's own query client, and
 * its UI is gone.
 */
export function ArchivedSessionsPage({ onToggleSidebar }: { readonly onToggleSidebar: () => void }) {
  const { scopeId } = useConnection();
  return (
    <div data-archive-page data-archive-scope={scopeId} className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <ArchivedSessionsScope key={scopeId} onToggleSidebar={onToggleSidebar} />
    </div>
  );
}

function ArchivedSessionsScope({ onToggleSidebar }: { readonly onToggleSidebar: () => void }) {
  const { client, scopeId } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => { setTerm(search.trim()); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [search]);

  const [confirmOne, setConfirmOne] = useState<Session | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [restoringIds, setRestoringIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [outcome, setOutcome] = useState<ActionOutcome>(NO_FAILURES);

  // Reset multi-select whenever the query identity changes so a subset picked
  // under one search never rides invisibly into another result set.
  useEffect(() => {
    setSelectedIds(new Set());
    setSelecting(false);
  }, [term]);

  // Unmounting stops a stale setState, but not a module-level toast: an action
  // started here can still answer after the connection has changed, and its
  // result belongs to the scope that asked. The guard closes that.
  // The re-read is deliberately not gated — the captured client must still
  // learn what this scope did to its own list.
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  // The archived list only labels rows with the owning workspace's name, so it
  // reads the metadata-only catalog instead of the full workspace listing.
  const workspacesQuery = useQuery({
    queryKey: ['workspaces', 'catalog'],
    queryFn: () => client.listWorkspaceCatalog(),
    staleTime: 30_000,
  });
  const workspaceNames = useMemo(
    () => new Map((workspacesQuery.data?.items ?? []).map((workspace) => [workspace.id, workspace.name])),
    [workspacesQuery.data],
  );

  const listQuery = useInfiniteQuery({
    queryKey: ['archived-sessions', scopeId, term],
    queryFn: ({ pageParam }) => client.listSessions({
      archived_only: true,
      page_size: PAGE_SIZE,
      before_id: pageParam,
      q: term === '' ? undefined : term,
    }) as Promise<ArchivedPage>,
    getNextPageParam: (lastPage) => (lastPage.has_more
      ? lastPage.next_cursor ?? lastPage.items.at(-1)?.id ?? undefined
      : undefined),
    initialPageParam: undefined as string | undefined,
    retry: false,
  });

  const sessions = useMemo(
    () => dedupe((listQuery.data?.pages ?? []).flatMap((page) => page.items)),
    [listQuery.data],
  );
  const loadedIdSet = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const validSelectedIds = useMemo(() => {
    if (selectedIds.size === 0) return selectedIds;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (loadedIdSet.has(id)) next.add(id);
    }
    return next;
  }, [loadedIdSet, selectedIds]);

  const titles = useMemo(
    () => new Map(sessions.map((session) => [
      session.id,
      session.title.trim() === '' ? t('archive.untitled') : session.title.trim(),
    ])),
    [sessions, t],
  );

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['archived-sessions'] }).catch(() => undefined),
      queryClient.invalidateQueries({ queryKey: ['sessions'] }).catch(() => undefined),
    ]);
  }, [queryClient]);

  const readOutcome = useCallback((result: DeleteArchivedSessionsResponse): ActionOutcome => ({
    failed: result.failed.map((entry) => ({
      id: entry.id,
      name: entry.title?.trim() || titles.get(entry.id) || t('archive.untitled'),
      reason: entry.message,
    })),
    error: null,
  }), [t, titles]);

  const runDelete = useCallback(async (
    marker: string,
    send: () => Promise<DeleteArchivedSessionsResponse>,
    settle: (result: DeleteArchivedSessionsResponse) => void,
  ) => {
    setDeleting(marker);
    setOutcome(NO_FAILURES);
    try {
      const result = await send();
      if (active.current) settle(result);
    } catch (error) {
      if (active.current) setOutcome({ failed: [], error: errorText(locale, error) });
    } finally {
      // Pending lasts until the fresh read has answered, so a second delete
      // cannot start against the pre-delete list.
      await refresh();
      if (active.current) setDeleting(null);
    }
  }, [locale, refresh]);

  const confirmDeleteOne = useCallback(() => {
    const session = confirmOne;
    if (session === null || deleting !== null || restoringIds.size > 0) return;
    const exclude = promotedTopLevelIds(scopeId).filter((id) => id !== session.id);
    const title = titles.get(session.id) ?? session.id;
    void runDelete(session.id, () => client.deleteArchivedSession(session.id, { exclude_session_ids: exclude }), (result) => {
      if (result.failed.length > 0) setOutcome(readOutcome(result));
      else pushToast({ tone: 'success', text: t('archive.deleteOneDone', { title }) });
      setConfirmOne(null);
    });
  }, [client, confirmOne, deleting, readOutcome, restoringIds.size, runDelete, scopeId, t, titles]);

  const confirmDeleteAll = useCallback(() => {
    if (deleting !== null || restoringIds.size > 0) return;
    void runDelete(DELETE_ALL, () => client.deleteAllArchivedSessions(), (result) => {
      if (result.failed.length > 0) {
        setOutcome(readOutcome(result));
        pushToast({
          tone: 'error',
          text: t('archive.deletePartial', {
            deleted: result.deleted_ids.length,
            total: result.deleted_ids.length + result.failed.length,
            failed: result.failed.length,
          }),
        });
      } else if (result.deleted_ids.length === 0) {
        pushToast({ tone: 'info', text: t('archive.deleteNoneDone') });
      } else {
        pushToast({ tone: 'success', text: t('archive.deleteAllDone', { count: result.deleted_ids.length }) });
      }
      setConfirmAll(false);
    });
  }, [client, deleting, readOutcome, restoringIds.size, runDelete, t]);

  const removeFromCache = useCallback((restoredIds: ReadonlySet<string>) => {
    if (restoredIds.size === 0) return;
    queryClient.setQueriesData<{ pages: Array<{ items: Session[]; has_more: boolean; next_cursor?: string | null }>; pageParams: unknown[] }>(
      { queryKey: ['archived-sessions'] },
      (old) =>
        old === undefined || !Array.isArray(old.pages)
          ? old
          : {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.filter((entry) => !restoredIds.has(entry.id)),
              })),
            },
    );
  }, [queryClient]);

  // Restoring puts the conversation back in the sidebar list, so both lists
  // are read again; a failure lands in the same recovery block a delete uses.
  const restore = useCallback((session: Session) => {
    if (deleting !== null || restoringIds.size > 0) return;
    setOutcome(NO_FAILURES);
    setRestoringIds(new Set([session.id]));
    void client.restoreSession(session.id)
      .then(async () => {
        removeFromCache(new Set([session.id]));
        invalidatePersonaSessionLists(queryClient);
        await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['sessions'] }).catch(() => undefined)]);
      })
      .catch((error: unknown) => {
        if (active.current) setOutcome({ failed: [], error: errorText(locale, error) });
      })
      .finally(() => {
        if (active.current) setRestoringIds(new Set());
      });
  }, [client, deleting, locale, queryClient, refresh, removeFromCache, restoringIds.size]);

  const restoreSelected = useCallback(() => {
    if (deleting !== null || restoringIds.size > 0 || validSelectedIds.size === 0) return;
    const targets = sessions.filter((session) => validSelectedIds.has(session.id));
    if (targets.length === 0) return;
    setOutcome(NO_FAILURES);
    setRestoringIds(new Set(targets.map((session) => session.id)));

    void (async () => {
      const succeeded = new Set<string>();
      const failed: FailedEntry[] = [];
      await runBounded(targets, MAX_ARCHIVE_RESTORE_CONCURRENCY, async (session) => {
        try {
          await client.restoreSession(session.id);
          succeeded.add(session.id);
        } catch (error) {
          failed.push({
            id: session.id,
            name: titles.get(session.id) ?? t('archive.untitled'),
            reason: errorText(locale, error),
          });
        }
      });

      removeFromCache(succeeded);
      if (succeeded.size > 0) {
        invalidatePersonaSessionLists(queryClient);
      }
      await refresh();

      if (!active.current) return;
      setRestoringIds(new Set());
      if (failed.length > 0) {
        setOutcome({ failed, error: null });
        // Failed items remain selected and retryable in place.
        setSelectedIds(new Set(failed.map((entry) => entry.id)));
        setSelecting(true);
      } else {
        setSelectedIds(new Set());
        setSelecting(false);
      }
    })();
  }, [client, deleting, locale, queryClient, refresh, removeFromCache, restoringIds.size, sessions, t, titles, validSelectedIds]);

  const toggleRowSelection = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelecting(false);
  }, []);

  const selectAllLoaded = useCallback(() => {
    setSelectedIds(new Set(sessions.map((session) => session.id)));
    setSelecting(true);
  }, [sessions]);

  const busy = deleting !== null || restoringIds.size > 0;
  const searching = term !== '';
  const loaded = sessions.length;
  const firstReadFailed = loaded === 0 && listQuery.isError;
  // Delete-all reaches the whole archive, so it does not disappear with a
  // search that misses; only a genuinely empty archive withdraws it.
  const archiveEmpty = loaded === 0 && !searching;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const windowed = loaded > ARCHIVE_VIRTUALIZE_THRESHOLD;

  useLayoutEffect(() => {
    if (!windowed) return;
    const list = listRef.current;
    const scroller = scrollRef.current;
    if (list === null || scroller === null) return;
    const measure = () => {
      const listRect = list.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (listRect.height === 0 && scrollerRect.height === 0) return;
      const next = Math.max(0, Math.round(listRect.top - scrollerRect.top + scroller.scrollTop));
      setScrollMargin((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    const observeAncestorsAndPreceding = () => {
      observer.disconnect();
      observer.observe(scroller);
      let node: Element | null = list;
      while (node !== null && node !== scroller) {
        const parent: Element | null = node.parentElement;
        if (parent === null) break;
        if (parent !== scroller) observer.observe(parent);
        let child: Element | null = parent.firstElementChild;
        while (child !== null && child !== node) {
          observer.observe(child);
          child = child.nextElementSibling;
        }
        node = parent;
      }
    };
    observeAncestorsAndPreceding();
    return () => { observer.disconnect(); };
  }, [windowed, loaded, selecting, validSelectedIds.size]);

  const virtualizer = useVirtualizer({
    count: windowed ? loaded : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    getItemKey: (index) => sessions[index]?.id ?? index,
    overscan: 8,
    scrollMargin,
    initialRect: { width: 720, height: 640 },
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

  return (
    <>
      <PageHeader title={t('archive.title')} onToggleSidebar={onToggleSidebar} width="split" />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-12 lg:px-6">
        <div className={`mx-auto flex w-full ${PAGE_WIDTH.split} flex-col gap-4`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline pb-3">
            <label className="relative flex h-8 min-w-0 flex-1 basis-[240px] max-w-[440px] items-center pointer-coarse:h-11">
              <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 text-ink-faint" />
              <input
                type="search"
                data-archive-search
                value={search}
                onChange={(event) => { setSearch(event.target.value); }}
                placeholder={t('archive.searchPlaceholder')}
                aria-label={t('archive.searchAria')}
                className="h-8 w-full min-w-0 rounded-md bg-ink/[0.04] pr-3 pl-8 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-ink/[0.06] focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)] pointer-coarse:h-11"
              />
            </label>
            <div className="flex items-center gap-3 sm:ml-auto">
              <span data-archive-scope-note className="text-[12px] text-ink-faint" title={t('archive.scopeNoteHint')}>
                {t('archive.scopeNote')}
              </span>
              {loaded > 0 ? (
                <button
                  type="button"
                  data-archive-select-toggle
                  aria-pressed={selecting}
                  disabled={busy}
                  onClick={() => {
                    if (selecting) clearSelection();
                    else setSelecting(true);
                  }}
                  className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
                >
                  {selecting ? t('common.cancel') : t('st.workspaces.select')}
                </button>
              ) : null}
            </div>
          </div>

          <ListBulkBar count={validSelectedIds.size} active={selecting} onClear={clearSelection}>
            {validSelectedIds.size < loaded ? (
              <button
                type="button"
                data-archive-select-all
                disabled={busy}
                onClick={selectAllLoaded}
                className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
              >
                {t('st.list.selectAll')}
              </button>
            ) : null}
            <button
              type="button"
              data-archive-bulk-restore
              disabled={busy || validSelectedIds.size === 0}
              onClick={restoreSelected}
              className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}
            >
              {t('archive.restore')}
            </button>
          </ListBulkBar>

          {outcome.error !== null || outcome.failed.length > 0 ? (
            <div data-archive-error role="alert" className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5">
              {outcome.error !== null ? (
                <p className="text-[13px] leading-relaxed text-ink-soft">{outcome.error}</p>
              ) : null}
              {outcome.failed.length > 0 ? (
                <>
                  <p data-archive-failed-title className="text-[13px] font-medium text-danger">
                    {t('archive.keptTitle')} · {outcome.failed.length}
                  </p>
                  <ul data-archive-failed className="flex flex-col gap-1">
                    {outcome.failed.map((entry) => (
                      <li key={entry.id} data-archive-failed-item={entry.id} className="text-[12.5px] leading-snug text-ink-soft">
                        <span className="font-medium text-ink">{entry.name}</span>
                        <span aria-hidden> · </span>
                        <span>{entry.reason}</span>
                        <span className="ml-1 font-mono text-[11px] text-ink-faint">{entry.id}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  data-archive-error-retry
                  onClick={() => { void refresh(); }}
                  className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
                >
                  {t('archive.refreshList')}
                </button>
                <button
                  type="button"
                  data-archive-error-dismiss
                  onClick={() => { setOutcome(NO_FAILURES); }}
                  className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
                >
                  {t('archive.dismiss')}
                </button>
              </div>
            </div>
          ) : null}

          {firstReadFailed ? (
            <div data-archive-load-failed className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
              <p className="text-[13px] font-medium text-danger">{t('archive.loadFailed')}</p>
              <p className="mt-0.5 font-mono text-[11px] text-danger">{errorText(locale, listQuery.error)}</p>
              <button
                type="button"
                onClick={() => { void listQuery.refetch(); }}
                className={`${SECONDARY_BUTTON} mt-2 pointer-coarse:min-h-11`}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : listQuery.isPending ? (
            <p role="status" data-archive-loading className="flex items-center gap-2 py-6 text-[13px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('archive.loading')}
            </p>
          ) : loaded === 0 ? (
            <div data-archive-empty className="flex flex-col gap-1 py-8">
              <p className="font-display text-[18px] text-ink">
                {searching ? t('archive.emptySearch', { query: term }) : t('archive.empty')}
              </p>
              <p className="max-w-[52ch] text-[13px] leading-relaxed text-ink-soft">
                {searching ? t('archive.emptySearchHint') : t('archive.emptyHint')}
              </p>
            </div>
          ) : windowed ? (
            <ul
              ref={listRef}
              aria-label={t('archive.listAria')}
              data-archive-list
              data-archive-virtualized="true"
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((row) => {
                const session = sessions[row.index];
                if (session === undefined) return null;
                return (
                  <ArchivedRow
                    key={session.id}
                    session={session}
                    title={titles.get(session.id) ?? session.id}
                    workspaceName={workspaceNames.get(session.workspace_id)}
                    divider={row.index > 0}
                    busy={busy}
                    deleting={deleting === session.id}
                    restoring={restoringIds.has(session.id)}
                    selecting={selecting}
                    selected={validSelectedIds.has(session.id)}
                    onToggleSelect={() => { toggleRowSelection(session.id); }}
                    virtualRow={{ index: row.index, top: row.start - scrollMargin, measureRef: virtualizer.measureElement }}
                    onOpen={() => { void navigate(`/s/${encodeURIComponent(session.id)}`); }}
                    onRestore={() => { restore(session); }}
                    onDelete={() => { setConfirmOne(session); }}
                  />
                );
              })}
            </ul>
          ) : (
            <ul aria-label={t('archive.listAria')} data-archive-list className="flex flex-col">
              {sessions.map((session, index) => (
                <ArchivedRow
                  key={session.id}
                  session={session}
                  title={titles.get(session.id) ?? session.id}
                  workspaceName={workspaceNames.get(session.workspace_id)}
                  divider={index > 0}
                  busy={busy}
                  deleting={deleting === session.id}
                  restoring={restoringIds.has(session.id)}
                  selecting={selecting}
                  selected={validSelectedIds.has(session.id)}
                  onToggleSelect={() => { toggleRowSelection(session.id); }}
                  onOpen={() => { void navigate(`/s/${encodeURIComponent(session.id)}`); }}
                  onRestore={() => { restore(session); }}
                  onDelete={() => { setConfirmOne(session); }}
                />
              ))}
            </ul>
          )}

          {loaded > 0 ? (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {listQuery.hasNextPage ? (
                <button
                  type="button"
                  data-archive-load-older
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => { void listQuery.fetchNextPage(); }}
                  className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
                >
                  {listQuery.isFetchingNextPage
                    ? t('archive.loading')
                    : listQuery.isFetchNextPageError
                      ? t('common.retry')
                      : t('archive.loadOlder')}
                </button>
              ) : (
                <span data-archive-end className="text-[12px] text-ink-faint">{t('archive.allLoaded')}</span>
              )}
              {listQuery.isFetchNextPageError ? (
                <span role="alert" data-archive-load-older-error className="text-[12px] text-danger">
                  {errorText(locale, listQuery.error)}
                </span>
              ) : null}
              <span data-archive-count className="text-[12px] tabular-nums text-ink-faint">{loaded}</span>
            </div>
          ) : null}

          {!archiveEmpty ? (
            <section data-archive-danger className="mt-2 flex flex-col gap-1 border-t border-hairline pt-5">
              <h2 className="font-display text-[15px] text-ink">{t('archive.deleteAll')}</h2>
              <p className="max-w-[62ch] text-[12.5px] leading-relaxed text-ink-faint">{t('archive.deleteAllBody')}</p>
              <div className="pt-1">
                <button
                  type="button"
                  data-archive-delete-all
                  disabled={busy}
                  onClick={() => { setConfirmAll(true); }}
                  className={`${DANGER_GHOST_BUTTON} pointer-coarse:min-h-11`}
                >
                  {t('archive.deleteAll')}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOne !== null}
        overlayId="confirm-delete-archived-one"
        title={t('archive.deleteOneTitle')}
        body={confirmOne === null
          ? undefined
          : t('archive.deleteOneBody', { title: titles.get(confirmOne.id) ?? confirmOne.id })}
        consequences={confirmOne === null ? undefined : [
          t('archive.deleteOneFamily'),
          t('archive.deleteOneTopLevel'),
        ]}
        confirmLabel={t('archive.deleteOneConfirm')}
        busy={busy}
        onConfirm={confirmDeleteOne}
        onCancel={() => { if (!busy) setConfirmOne(null); }}
      />
      <ConfirmDialog
        open={confirmAll}
        overlayId="confirm-delete-archived-all"
        title={t('archive.deleteAllTitle')}
        body={t('archive.deleteAllBody')}
        consequences={[t('archive.deleteAllScope')]}
        confirmLabel={t('archive.deleteAllConfirm')}
        busy={busy}
        onConfirm={confirmDeleteAll}
        onCancel={() => { if (!busy) setConfirmAll(false); }}
      />
    </>
  );
}

function shortCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1];
}

function ArchivedRow({
  session,
  title,
  workspaceName,
  divider,
  busy,
  deleting,
  restoring,
  selecting,
  selected,
  onToggleSelect,
  virtualRow,
  onOpen,
  onRestore,
  onDelete,
}: {
  readonly session: Session;
  readonly title: string;
  readonly workspaceName: string | undefined;
  readonly divider: boolean;
  readonly busy: boolean;
  readonly deleting: boolean;
  readonly restoring: boolean;
  readonly selecting: boolean;
  readonly selected: boolean;
  readonly onToggleSelect: () => void;
  readonly virtualRow?: { readonly index: number; readonly top: number; readonly measureRef: (node: HTMLElement | null) => void };
  readonly onOpen: () => void;
  readonly onRestore: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const connection = useOptionalConnection();
  const localKikiComputer = isOnKikiComputer(connection);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const cwd = session.metadata?.cwd ?? '';
  const resolvedWorkspace = workspaceName ?? shortCwd(session.metadata?.cwd);
  const rowPending = deleting || restoring;
  const entries = useMemo<readonly MiniMenuEntry[]>(() => {
    const list: MiniMenuEntry[] = [
      { key: 'restore', label: t('archive.restore'), run: onRestore },
      {
        key: 'copy-link',
        label: t('menu.copyLink'),
        run: () => {
          runToastAction(t('menu.copyThreadLink'), () => copyTextToClipboard(`/s/${encodeURIComponent(session.id)}`));
        },
      },
    ];
    if (cwd !== '') {
      list.push({
        key: 'copy-path',
        label: t('menu.copyPath'),
        run: () => {
          runToastAction(t('menu.copyWorkingDirectory'), () => copyTextToClipboard(cwd));
        },
      });
      if (localKikiComputer && host.openPath !== undefined) {
        const openPath = host.openPath;
        list.push({
          key: 'open-folder',
          label: t('menu.openFolder'),
          run: () => {
            runToastAction(t('menu.openFolder'), () => openPath(cwd));
          },
        });
      }
    }
    list.push({ separator: true });
    list.push({ key: 'delete', label: t('archive.delete'), danger: true, run: onDelete });
    return list;
  }, [cwd, host.openPath, localKikiComputer, onDelete, onRestore, session.id, t]);
  return (
    <li
      ref={virtualRow?.measureRef}
      data-index={virtualRow?.index}
      data-archive-item={session.id}
      data-archive-selected={selected ? 'true' : undefined}
      style={virtualRow !== undefined ? { top: virtualRow.top } : undefined}
      onContextMenu={(event) => {
        if (busy) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      className={`group/row flex min-w-0 items-center gap-1 py-1 ${virtualRow !== undefined ? 'absolute inset-x-0 ' : ''}${divider ? 'border-t border-hairline' : ''} ${rowPending ? 'opacity-60' : ''}`}
    >
      {selecting ? (
        <RowCheck
          checked={selected}
          onChange={onToggleSelect}
          label={t('st.list.selectRow', { name: title })}
        />
      ) : null}
      {/* Fixed grid tracks keep every date aligned on a single right edge across hover, focus, menu-open, and touch. */}
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_2.75rem_5.25rem] items-center gap-x-2 rounded-md pr-2 transition-colors group-hover/row:bg-ink/[0.03] sm:grid-cols-[minmax(0,1fr)_7.25rem_5.5rem]">
        <button
          type="button"
          data-archive-open={session.id}
          onClick={onOpen}
          title={t('archive.openHint')}
          className="flex min-h-11 min-w-0 flex-col items-start justify-center gap-0.5 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
        >
          <span className="min-w-0 max-w-full truncate text-[13.5px] leading-[19px] font-medium text-ink">
            <ThreadTitle text={title} />
          </span>
          {resolvedWorkspace !== undefined ? (
            <span className="flex min-w-0 max-w-full items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
              <Icon name="folder" size={12} className="shrink-0" />
              <span className="min-w-0 truncate">{resolvedWorkspace}</span>
            </span>
          ) : null}
        </button>

        <div className="flex items-center justify-end gap-0.5">
          {!selecting ? (
            <button
              type="button"
              data-archive-quick-restore={session.id}
              disabled={busy}
              onClick={onRestore}
              className={`hidden h-8 shrink-0 items-center justify-center rounded-md px-2 text-[12px] font-medium text-ink-soft transition-all hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-40 sm:inline-flex ${
                menu !== null || rowPending ? 'opacity-100' : ROW_ACTION_QUIET
              }`}
            >
              {t('archive.restore')}
            </button>
          ) : null}
          <button
            ref={moreRef}
            type="button"
            data-archive-more={session.id}
            // Only the open row's trigger counts as inside its menu, so pressing
            // it toggles the menu shut while another row's ⋯ still closes it.
            data-archive-row-menu={menu !== null ? '' : undefined}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={() => {
              if (menu !== null) { setMenu(null); return; }
              const rect = moreRef.current?.getBoundingClientRect();
              setMenu({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
            }}
            aria-label={deleting ? t('archive.pending') : t('transcript.moreActions')}
            title={deleting ? t('archive.pending') : t('transcript.moreActions')}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-faint transition-all hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:opacity-40 ${
              menu !== null || rowPending ? 'opacity-100' : ROW_ACTION_QUIET
            }`}
          >
            <Icon name={rowPending ? 'clock' : 'more'} size={14} />
          </button>
        </div>

        <span data-archive-date={session.id} className="block w-full text-right text-[12px] whitespace-nowrap text-ink-faint tabular-nums">
          <RelativeTime at={session.updated_at} />
        </span>
      </div>
      {menu !== null ? (
        <MiniContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={t('transcript.moreActions')}
          overlayId="archive-row-menu"
          dataAttribute="data-archive-row-menu"
          itemDataAttribute="data-archive-action"
          onClose={() => { setMenu(null); }}
          entries={entries}
        />
      ) : null}
    </li>
  );
}
