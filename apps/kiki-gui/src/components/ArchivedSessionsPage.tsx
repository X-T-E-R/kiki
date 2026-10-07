/**
 * /archived — the archive, as a page of its own.
 *
 * Archived conversations are native sessions, so this runs on the ordinary
 * session list and the two deletion routes. Reading one lands on `/s/:id`,
 * which is the ordinary conversation view; nothing here restores.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import type { DeleteArchivedSessionsResponse, Session } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { readTopLevelThreads } from '../lib/threadDisplayMemory';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { PageHeader } from './PageChrome';
import { RelativeTime } from './RelativeTime';
import { ThreadTitle } from './ThreadTitle';
import { DANGER_GHOST_BUTTON, SECONDARY_BUTTON } from './ui';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const DELETE_ALL = 'all';

interface FailedEntry {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

interface DeleteOutcome {
  readonly failed: readonly FailedEntry[];
  readonly error: string | null;
}

const NO_FAILURES: DeleteOutcome = { failed: [], error: null };

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

/**
 * One connection's archive.
 *
 * The whole body is keyed by scope, so a scope switch unmounts it rather than
 * leaving another home's dialogs, pending state or failure list on screen.
 * A deletion started in the previous scope still settles when it answers; it
 * only reaches the previous scope's own query client, and its UI is gone.
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
  const [outcome, setOutcome] = useState<DeleteOutcome>(NO_FAILURES);

  // Unmounting stops a stale setState, but not a module-level toast: a
  // deletion started here can still answer after the connection has changed,
  // and its result belongs to the scope that asked. The guard closes that.
  // The re-read is deliberately not gated — the captured client must still
  // learn what this scope did to its own list.
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
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
  const titles = useMemo(
    () => new Map(sessions.map((session) => [
      session.id,
      session.title.trim() === '' ? t('archive.untitled') : session.title.trim(),
    ])),
    [sessions, t],
  );

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['archived-sessions'] }).catch(() => undefined);
  }, [queryClient]);

  const readOutcome = useCallback((result: DeleteArchivedSessionsResponse): DeleteOutcome => ({
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
    if (session === null || deleting !== null) return;
    const exclude = promotedTopLevelIds(scopeId).filter((id) => id !== session.id);
    const title = titles.get(session.id) ?? session.id;
    void runDelete(session.id, () => client.deleteArchivedSession(session.id, { exclude_session_ids: exclude }), (result) => {
      if (result.failed.length > 0) setOutcome(readOutcome(result));
      else pushToast({ tone: 'success', text: t('archive.deleteOneDone', { title }) });
      setConfirmOne(null);
    });
  }, [client, confirmOne, deleting, readOutcome, runDelete, scopeId, t, titles]);

  const confirmDeleteAll = useCallback(() => {
    if (deleting !== null) return;
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
  }, [client, deleting, readOutcome, runDelete, t]);

  const busy = deleting !== null;
  const searching = term !== '';
  const loaded = sessions.length;
  const firstReadFailed = loaded === 0 && listQuery.isError;
  // Delete-all reaches the whole archive, so it does not disappear with a
  // search that misses; only a genuinely empty archive withdraws it.
  const archiveEmpty = loaded === 0 && !searching;

  return (
    <>
      <PageHeader title={t('archive.title')} onToggleSidebar={onToggleSidebar}>
        <button
          type="button"
          data-archive-back
          onClick={() => { navigate('/settings/sessions'); }}
          className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
        >
          <span className="inline-flex items-center gap-1.5">
            <Icon name="arrowLeft" size={12} className="text-ink-faint" />
            {t('archive.backSettings')}
          </span>
        </button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-12 lg:px-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="max-w-[62ch] text-[13px] leading-relaxed text-ink-soft">{t('archive.lede')}</p>
            <p className="text-[12px] text-ink-faint" title={t('archive.scopeNoteHint')}>
              {t('archive.scopeNote')}
            </p>
          </div>

          <input
            type="search"
            data-archive-search
            value={search}
            onChange={(event) => { setSearch(event.target.value); }}
            placeholder={t('archive.searchPlaceholder')}
            aria-label={t('archive.searchAria')}
            className="h-9 w-full max-w-[420px] rounded-md border border-hairline bg-paper px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent pointer-coarse:h-11"
          />

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
                  onOpen={() => { navigate(`/s/${encodeURIComponent(session.id)}`); }}
                  onDelete={() => { setConfirmOne(session); }}
                />
              ))}
            </ul>
          )}

          {loaded > 0 ? (
            <div className="flex items-center gap-3 pt-1">
              {listQuery.hasNextPage ? (
                <button
                  type="button"
                  data-archive-load-older
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => { void listQuery.fetchNextPage(); }}
                  className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
                >
                  {listQuery.isFetchingNextPage ? t('archive.loading') : t('archive.loadOlder')}
                </button>
              ) : (
                <span data-archive-end className="text-[12px] text-ink-faint">{t('archive.allLoaded')}</span>
              )}
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

function ArchivedRow({
  session,
  title,
  workspaceName,
  divider,
  busy,
  deleting,
  onOpen,
  onDelete,
}: {
  readonly session: Session;
  readonly title: string;
  readonly workspaceName: string | undefined;
  readonly divider: boolean;
  readonly busy: boolean;
  readonly deleting: boolean;
  readonly onOpen: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <li
      data-archive-item={session.id}
      className={`group flex min-w-0 items-start gap-1 py-1 ${divider ? 'border-t border-hairline' : ''}`}
    >
      <button
        type="button"
        data-archive-open={session.id}
        onClick={onOpen}
        title={t('archive.openHint')}
        className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
      >
        <span className="min-w-0 max-w-full truncate text-[13.5px] leading-[19px] font-medium text-ink">
          <ThreadTitle text={title} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
          <Icon name="folder" size={12} />
          <span className="min-w-0 truncate">{workspaceName ?? t('archive.workspaceUnknown')}</span>
          <span aria-hidden>·</span>
          <RelativeTime at={session.updated_at} className="shrink-0 tabular-nums" />
        </span>
      </button>
      <button
        type="button"
        data-archive-delete={session.id}
        disabled={busy}
        onClick={onDelete}
        aria-label={deleting ? t('archive.pending') : t('archive.delete')}
        className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:opacity-40"
      >
        <Icon name={deleting ? 'clock' : 'close'} size={14} />
      </button>
    </li>
  );
}