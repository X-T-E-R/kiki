/**
 * TasksPage (/s/:id/tasks) — the per-session background-task browser.
 *
 * The right rail's Tasks chapter shows at most a bounded, scrolling slice of
 * the session's tasks; this page is the full inventory behind its "View all"
 * entry. The wire has no cross-session tasks endpoint (REST.md §3.7 only
 * scopes tasks under `/sessions/{id}/tasks*`), so the page stays
 * session-scoped; the page header's back arrow returns to the session.
 *
 * Rows sit in two groups, running and finished, each row two lines: the
 * state as a word with the task's name, then its command. A running row stops
 * in place; the status filter appears only on a long list.
 *
 * Data: the list rides paged `listTasks` (including terminal "ghost" tasks)
 * and polls only while something is still running. Row expansion lazily
 * fetches `GET tasks/{id}?with_output=true` for the tail-of-log preview;
 * cancellation reuses the same
 * `:cancel` route as the rail and treats 40904 (already finished) as a
 * success-shaped refetch, matching `KikiClient.cancelTask`'s okCodes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';

import type { Task, TaskStatus } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { sortTasks } from '@kiki/session-core/sessions';
import { useI18n } from '../i18n';
import { DisclosureChevron, Icon } from './icons';
import { PAGE_WIDTH, PageHeader } from './PageChrome';
import { LIST_TOOLS_MIN_ITEMS } from './settings/list';
import { SECONDARY_BUTTON } from './ui';
import { useConnection } from '../state/connection';

const STATUS_FILTERS: readonly (TaskStatus | 'all')[] = [
  'all',
  'running',
  'completed',
  'failed',
  'cancelled',
];

const DESKTOP_SPLIT_QUERY = '(min-width: 1024px)';

function useDesktopSplit(): boolean {
  const read = () => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(DESKTOP_SPLIT_QUERY).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DESKTOP_SPLIT_QUERY);
    const onChange = () => { setMatches(media.matches); };
    setMatches(media.matches);
    media.addEventListener?.('change', onChange);
    return () => { media.removeEventListener?.('change', onChange); };
  }, []);
  return matches;
}

function CopyTextButton({ text, label }: { readonly text: string; readonly label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => { setCopied(false); }, 1500);
    }).catch(() => {});
  };
  return (
    <button
      type="button"
      data-task-copy
      onClick={copy}
      className="inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-2.5"
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      <span>{copied ? t('cb.copied') : label}</span>
    </button>
  );
}

function DetailRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <span className="w-20 shrink-0 text-[12px] text-ink-faint">{label}</span>
      <span
        className={`min-w-0 truncate text-[12px] text-ink ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/** Selected/expanded detail: static fields from the list row + lazy bounded tail snapshot. */
function TaskDetail({
  task,
  split = false,
  cancelling = false,
  stopFailure,
  onStop,
}: {
  readonly task: Task;
  readonly split?: boolean;
  readonly cancelling?: boolean;
  readonly stopFailure?: string;
  readonly onStop?: () => void;
}) {
  const { client } = useConnection();
  const { t, time, locale } = useI18n();
  const detailQuery = useQuery({
    queryKey: ['session-task', task.session_id, task.id],
    queryFn: () => client.getTask(task.session_id, task.id, { with_output: true }),
    // Keep the bounded tail fresh only for this selected running task.
    refetchInterval: (query) => {
      const status = query.state.data?.status ?? task.status;
      return status === 'running' ? 3000 : false;
    },
  });
  const current = detailQuery.data ?? task;
  const output = detailQuery.data?.output_preview ?? task.output_preview;

  const startedMs = new Date(current.started_at ?? current.created_at).getTime();
  const finishedMs =
    current.completed_at !== undefined ? new Date(current.completed_at).getTime() : undefined;
  const durationMs =
    finishedMs !== undefined && !Number.isNaN(startedMs) && !Number.isNaN(finishedMs)
      ? Math.max(0, finishedMs - startedMs)
      : undefined;
  const stamp = (iso: string) =>
    `${new Date(iso).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en')} · ${time.relativeTime(iso)}`;

  return (
    <div
      className={split ? 'space-y-4' : 'mt-2 space-y-3 border-t border-hairline pt-3'}
      data-task-detail
      data-task-detail-id={current.id}
    >
      {split ? (
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-hairline pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[16px] font-semibold leading-6 text-ink" title={current.description}>
              {current.description}
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint tabular-nums">
              <span className={current.status === 'failed' ? 'font-medium text-danger' : current.status === 'running' ? 'font-medium text-selected-ink' : 'text-ink-soft'}>
                {t(`rail.taskStatus.${current.status}`)}
              </span>
              <span aria-hidden>·</span>
              <span>{t(`tasks.kind.${current.kind}`)}</span>
              {durationMs !== undefined ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{time.formatDuration(durationMs)}</span>
                </>
              ) : null}
            </p>
          </div>
          {current.status === 'running' && onStop !== undefined ? (
            <button
              type="button"
              data-task-detail-stop
              disabled={cancelling}
              onClick={onStop}
              title={t('rail.stopTitle')}
              className="shrink-0 rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
            >
              {cancelling ? t('tasks.stopping') : t('rail.stop')}
            </button>
          ) : null}
        </div>
      ) : null}
      {split && stopFailure !== undefined ? (
        <p role="alert" data-task-stop-error className="text-[12px] text-danger">
          {t('tasks.stopFailed', { detail: stopFailure })}
        </p>
      ) : null}
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <DetailRow label={t('tasks.field.id')} value={current.id} />
        <DetailRow label={t('tasks.field.kind')} value={t(`tasks.kind.${current.kind}`)} mono={false} />
        <DetailRow label={t('tasks.field.created')} value={stamp(current.created_at)} />
        {current.started_at !== undefined ? (
          <DetailRow label={t('tasks.field.started')} value={stamp(current.started_at)} />
        ) : null}
        {current.completed_at !== undefined ? (
          <DetailRow label={t('tasks.field.finished')} value={stamp(current.completed_at)} />
        ) : null}
        {durationMs !== undefined ? (
          <DetailRow label={t('tasks.field.duration')} value={time.formatDuration(durationMs)} />
        ) : null}
        {current.model !== undefined ? (
          <DetailRow label={t('rail.model')} value={current.model} />
        ) : null}
        {current.exit_code !== undefined ? (
          <DetailRow label={t('tasks.detail.exitCode')} value={String(current.exit_code)} />
        ) : null}
        {current.stop_reason !== undefined ? (
          <DetailRow label={t('tasks.detail.stopReason')} value={current.stop_reason} mono={false} />
        ) : null}
      </div>
      {current.command !== undefined ? (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[12px] font-medium text-ink-soft">
              {t('tasks.field.command')}
            </p>
            <CopyTextButton text={current.command} label={t('tasks.detail.copyCommand')} />
          </div>
          <pre className="overflow-x-auto rounded-lg bg-ink/[0.04] px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-ink">
            {current.command}
          </pre>
        </div>
      ) : null}
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-ink-soft">
            {t('tasks.field.output')}
          </p>
          {output !== undefined && output !== '' ? (
            <CopyTextButton text={output} label={t('contextMenu.copy')} />
          ) : null}
        </div>
        {detailQuery.isPending && output === undefined ? (
          <p className="flex items-center gap-2 text-[11.5px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
            {t('tasks.outputLoading')}
          </p>
        ) : detailQuery.isError && output === undefined ? (
          <div role="alert" data-task-output-error className="flex flex-wrap items-center gap-2 text-[12px] text-ink-soft">
            <span>{errorText(locale, detailQuery.error)}</span>
            <button
              type="button"
              onClick={() => { void detailQuery.refetch(); }}
              className="font-medium text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : output !== undefined && output !== '' ? (
          <pre
            data-task-output
            className={`${split ? 'max-h-[420px]' : 'max-h-72'} overflow-auto rounded-lg bg-ink/[0.04] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre text-ink-soft`}
          >
            {output}
          </pre>
        ) : (
          <p className="text-[11.5px] text-ink-faint">{t('tasks.noOutput')}</p>
        )}
      </div>
    </div>
  );
}

export function TasksPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { client } = useConnection();
  const { t, tp, time, locale } = useI18n();
  const queryClient = useQueryClient();
  const { id: sessionId = '' } = useParams<{ id: string }>();
  const desktopSplit = useDesktopSplit();
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);
  const [stopFailure, setStopFailure] = useState<{ readonly taskId: string; readonly detail: string } | null>(null);
  // Tracks the last poll where a task was running. Once the set goes quiet the
  // interval switches to a short grace pass so a "running → completed" flip
  // that straddled a tick still flushes to the DOM before polling stops.
  const lastRunningAtRef = useRef(0);

  const tasksQuery = useInfiniteQuery({
    queryKey: ['session-tasks', sessionId, filter],
    queryFn: ({ pageParam }) => client.listTasks(sessionId, {
      status: filter === 'all' ? undefined : filter,
      page_size: 100,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.next_offset,
    enabled: sessionId !== '',
    refetchInterval: (query) => {
      const data = query.state.data?.pages.flatMap((page) => page.items) ?? [];
      const running = data.some((task) => task.status === 'running');
      if (running) {
        lastRunningAtRef.current = Date.now();
        return 3000;
      }
      // Grace pass: keep polling shortly after the last running task so a
      // completion that landed between polls is still picked up.
      return Date.now() - lastRunningAtRef.current < 8000 ? 4000 : false;
    },
    refetchOnWindowFocus: true,
  });

  const cancelMutation = useMutation({
    mutationFn: (taskId: string) => client.cancelTask(sessionId, taskId),
    onSettled: (_data, error, taskId) => {
      setPendingCancelId(null);
      // A failed stop is said on the row it failed for, not in a toast that
      // leaves the reader to work out which task it meant.
      setStopFailure(error === null ? null : { taskId, detail: errorText(locale, error) });
      // 40904 (already finished) resolves as success-shaped data; either way a
      // refetch reconciles the row with the server's truth.
      void queryClient.invalidateQueries({ queryKey: ['session-tasks', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['session-task', sessionId, taskId] });
    },
  });

  const tasks = useMemo(
    () => sortTasks(tasksQuery.data?.pages.flatMap((page) => page.items) ?? []),
    [tasksQuery.data],
  );
  const running = tasks.filter((task) => task.status === 'running');
  const finished = tasks.filter((task) => task.status !== 'running');
  // The status filter is a list tool: it appears on a long list, and stays
  // while it is narrowing one so it can be turned back off.
  const showFilter = filter !== 'all' || tasks.length >= LIST_TOOLS_MIN_ITEMS;
  const selectedSplitTask = desktopSplit && tasks.length > 0
    ? (tasks.find((task) => task.id === expandedId) ?? tasks[0])
    : undefined;

  const stopTask = (taskId: string) => {
    setPendingCancelId(taskId);
    setStopFailure(null);
    cancelMutation.mutate(taskId);
  };

  const renderRow = (task: Task) => {
    const selected = desktopSplit ? selectedSplitTask?.id === task.id : expandedId === task.id;
    const isRunning = task.status === 'running';
    const failure = stopFailure?.taskId === task.id ? stopFailure.detail : undefined;
    const statusTone = task.status === 'failed'
      ? 'text-danger'
      : isRunning
        ? 'text-selected-ink font-medium'
        : 'text-ink-soft';
    return (
      <li
        key={task.id}
        data-task-row
        data-task-selected={selected ? 'true' : undefined}
        className={`py-2.5 transition-colors ${desktopSplit && selected ? 'relative -mx-2 rounded-lg bg-ink/[0.045] px-2 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-selected-ink' : ''}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {isRunning ? (
            <span aria-hidden className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-selected-ink" />
          ) : null}
          {desktopSplit ? (
            <button
              type="button"
              onClick={() => { setExpandedId(task.id); }}
              className="min-w-0 flex-1 truncate rounded-sm text-left text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
              title={task.description}
            >
              <span data-task-status={task.status} className={statusTone}>{t(`rail.taskStatus.${task.status}`)}</span>
              <span aria-hidden className="text-ink-faint"> · </span>
              <span className="font-medium">{task.description}</span>
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={task.description}>
              <span data-task-status={task.status} className={statusTone}>{t(`rail.taskStatus.${task.status}`)}</span>
              <span aria-hidden className="text-ink-faint"> · </span>
              <span className="font-medium">{task.description}</span>
            </span>
          )}
          <span className="hidden shrink-0 text-[12px] text-ink-faint tabular-nums sm:inline">
            {time.relativeTime(task.created_at)}
          </span>
          {isRunning ? (
            <button
              type="button"
              disabled={pendingCancelId === task.id}
              onClick={() => { stopTask(task.id); }}
              title={t('rail.stopTitle')}
              className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
            >
              {pendingCancelId === task.id ? t('tasks.stopping') : t('rail.stop')}
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={selected}
            aria-label={selected ? t('tasks.collapse') : t('tasks.expand')}
            onClick={() => {
              if (desktopSplit) {
                setExpandedId(task.id);
              } else {
                setExpandedId(selected ? null : task.id);
              }
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
          >
            {desktopSplit ? (
              <Icon name="chevron" size={12} className="text-current" />
            ) : (
              <DisclosureChevron open={selected} className="text-current" />
            )}
          </button>
        </div>
        {task.command !== undefined ? (
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" title={task.command}>
            {task.command}
          </p>
        ) : null}
        {failure !== undefined ? (
          <p role="alert" data-task-stop-error className="mt-1 text-[12px] text-danger">
            {t('tasks.stopFailed', { detail: failure })}
          </p>
        ) : null}
        {!desktopSplit && selected ? <TaskDetail task={task} /> : null}
      </li>
    );
  };
  const group = (key: 'running' | 'finished', rows: readonly Task[]) => (rows.length === 0 ? null : (
    <section data-task-group={key} aria-labelledby={`task-group-${key}`}>
      <h2 id={`task-group-${key}`} className="mb-1 flex items-baseline gap-2 text-[12px] font-medium text-ink-soft">
        {t(key === 'running' ? 'tasks.group.running' : 'tasks.group.finished')}
        <span className="text-ink-faint tabular-nums">{rows.length}</span>
      </h2>
      <ul className="divide-y divide-hairline border-t border-hairline">
        {rows.map(renderRow)}
      </ul>
    </section>
  ));

  return (
    <>
      <PageHeader title={t('tasks.title')} onToggleSidebar={onToggleSidebar} width={desktopSplit ? 'dashboard' : 'split'} />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-10 lg:px-6">
        <div className={`mx-auto ${desktopSplit ? PAGE_WIDTH.dashboard : PAGE_WIDTH.split} space-y-6`} data-tasks-page>
          {tasksQuery.isPending ? (
            <p role="status" className="flex items-center gap-2 py-6 text-[13px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
              {t('tasks.loading')}
            </p>
          ) : tasksQuery.isError ? (
            <div role="alert" data-tasks-error className="py-4 text-[13px]">
              <p className="font-medium text-ink">{t('tasks.loadFailed')}</p>
              <p className="mt-1 text-[12px] text-ink-soft">{errorText(locale, tasksQuery.error)}</p>
              <button
                type="button"
                onClick={() => void tasksQuery.refetch()}
                className={`mt-3 ${SECONDARY_BUTTON}`}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : tasks.length === 0 && filter === 'all' ? (
            <div data-tasks-empty className="py-6 text-[13px] leading-relaxed">
              <p className="text-ink">{t('tasks.empty')}</p>
              <p className="mt-1 max-w-[62ch] text-ink-soft">{t('tasks.emptyExplain')}</p>
            </div>
          ) : (
            <>
              {showFilter ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div
                    role="group"
                    aria-label={t('tasks.title')}
                    className="inline-flex flex-wrap rounded-md bg-ink/[0.04] p-0.5"
                  >
                    {STATUS_FILTERS.map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        data-status-filter={candidate}
                        onClick={() => { setFilter(candidate); }}
                        aria-pressed={filter === candidate}
                        className={`rounded-[5px] px-3 py-1 text-[12px] transition-colors pointer-coarse:min-h-11 ${
                          filter === candidate
                            ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                            : 'text-ink-soft hover:text-ink'
                        }`}
                      >
                        {candidate === 'all'
                          ? t('tasks.filter.all')
                          : t(`rail.taskStatus.${candidate}`)}
                      </button>
                    ))}
                  </div>
                  <span className="ml-auto text-[12px] text-ink-faint tabular-nums">
                    {tp('tasks.count', tasks.length)}
                  </span>
                </div>
              ) : null}

              {tasks.length === 0 ? (
                <p className="py-6 text-[13px] text-ink-faint">{t('tasks.emptyFilter')}</p>
              ) : desktopSplit && selectedSplitTask !== undefined ? (
                <div data-tasks-split className="grid grid-cols-[minmax(0,360px)_minmax(0,1fr)] items-start gap-8">
                  <div className="min-w-0 space-y-6">
                    {group('running', running)}
                    {group('finished', finished)}
                    {tasksQuery.hasNextPage ? (
                      <button type="button" disabled={tasksQuery.isFetchingNextPage}
                        onClick={() => { void tasksQuery.fetchNextPage(); }}
                        className={`${SECONDARY_BUTTON} disabled:opacity-50`}>
                        {t('tasks.loadMore')}
                      </button>
                    ) : null}
                  </div>
                  <section
                    aria-label={t('tasks.detail.title')}
                    className="sticky top-0 min-w-0 border-l border-hairline pl-6"
                  >
                    <TaskDetail
                      key={selectedSplitTask.id}
                      task={selectedSplitTask}
                      split
                      cancelling={pendingCancelId === selectedSplitTask.id}
                      stopFailure={stopFailure?.taskId === selectedSplitTask.id ? stopFailure.detail : undefined}
                      onStop={() => { stopTask(selectedSplitTask.id); }}
                    />
                  </section>
                </div>
              ) : (
                <>
                  {group('running', running)}
                  {group('finished', finished)}
                  {tasksQuery.hasNextPage ? (
                    <button type="button" disabled={tasksQuery.isFetchingNextPage}
                      onClick={() => { void tasksQuery.fetchNextPage(); }}
                      className={`${SECONDARY_BUTTON} disabled:opacity-50`}>
                      {t('tasks.loadMore')}
                    </button>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
