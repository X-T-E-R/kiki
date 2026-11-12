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

import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';

import type { Task, TaskStatus } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { sortTasks } from '@kiki/session-core/sessions';
import { useI18n } from '../i18n';
import { DisclosureChevron } from './icons';
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

function DetailRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
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

/** Expanded detail: static fields from the list row + lazy output preview. */
function TaskDetail({ task }: { task: Task }) {
  const { client } = useConnection();
  const { t, time, locale } = useI18n();
  const detailQuery = useQuery({
    queryKey: ['session-task', task.session_id, task.id],
    queryFn: () => client.getTask(task.session_id, task.id, { with_output: true }),
    // Keep the tail fresh while the task is still producing output.
    refetchInterval: task.status === 'running' ? 3000 : false,
  });
  const output = detailQuery.data?.output_preview ?? task.output_preview;

  const startedMs = new Date(task.started_at ?? task.created_at).getTime();
  const finishedMs =
    task.completed_at !== undefined ? new Date(task.completed_at).getTime() : undefined;
  const durationMs =
    finishedMs !== undefined && !Number.isNaN(startedMs) && !Number.isNaN(finishedMs)
      ? finishedMs - startedMs
      : undefined;
  const stamp = (iso: string) =>
    `${new Date(iso).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en')} · ${time.relativeTime(iso)}`;

  return (
    <div className="mt-2 space-y-2 border-t border-hairline pt-3" data-task-detail>
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <DetailRow label={t('tasks.field.id')} value={task.id} />
        <DetailRow label={t('tasks.field.kind')} value={t(`tasks.kind.${task.kind}`)} mono={false} />
        <DetailRow label={t('tasks.field.created')} value={stamp(task.created_at)} />
        {task.started_at !== undefined ? (
          <DetailRow label={t('tasks.field.started')} value={stamp(task.started_at)} />
        ) : null}
        {task.completed_at !== undefined ? (
          <DetailRow label={t('tasks.field.finished')} value={stamp(task.completed_at)} />
        ) : null}
        {durationMs !== undefined ? (
          <DetailRow label={t('tasks.field.duration')} value={time.formatDuration(durationMs)} />
        ) : null}
        {task.model !== undefined ? (
          <DetailRow label={t('rail.model')} value={task.model} />
        ) : null}
      </div>
      {task.command !== undefined ? (
        <div>
          <p className="mb-1 text-[12px] font-medium text-ink-soft">
            {t('tasks.field.command')}
          </p>
          <pre className="overflow-x-auto rounded-lg bg-paper px-3 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-ink">
            {task.command}
          </pre>
        </div>
      ) : null}
      <div>
        <p className="mb-1 text-[12px] font-medium text-ink-soft">
          {t('tasks.field.output')}
        </p>
        {detailQuery.isPending && output === undefined ? (
          <p className="flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
            {t('tasks.outputLoading')}
          </p>
        ) : output !== undefined && output !== '' ? (
          <pre
            data-task-output
            className="max-h-72 overflow-auto rounded-lg bg-paper px-3 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-ink-soft"
          >
            {output}
          </pre>
        ) : (
          <p className="text-[11px] text-ink-faint">{t('tasks.noOutput')}</p>
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

  const renderRow = (task: Task) => {
    const expanded = expandedId === task.id;
    const isRunning = task.status === 'running';
    const failure = stopFailure?.taskId === task.id ? stopFailure.detail : undefined;
    return (
      <li key={task.id} data-task-row className="py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {isRunning ? (
            <span aria-hidden className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={task.description}>
            <span data-task-status={task.status} className="text-ink-soft">{t(`rail.taskStatus.${task.status}`)}</span>
            <span aria-hidden className="text-ink-faint"> · </span>
            <span className="font-medium">{task.description}</span>
          </span>
          <span className="hidden shrink-0 text-[12px] text-ink-faint tabular-nums sm:inline">
            {time.relativeTime(task.created_at)}
          </span>
          {isRunning ? (
            <button
              type="button"
              disabled={pendingCancelId === task.id}
              onClick={() => {
                setPendingCancelId(task.id);
                setStopFailure(null);
                cancelMutation.mutate(task.id);
              }}
              title={t('rail.stopTitle')}
              className="shrink-0 rounded-md border border-hairline px-2 py-0.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
            >
              {pendingCancelId === task.id ? t('tasks.stopping') : t('rail.stop')}
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t('tasks.collapse') : t('tasks.expand')}
            onClick={() => { setExpandedId(expanded ? null : task.id); }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <DisclosureChevron open={expanded} className="text-current" />
          </button>
        </div>
        {task.command !== undefined ? (
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" title={task.command}>
            {task.command}
          </p>
        ) : null}
        {failure !== undefined ? (
          <p role="alert" data-task-stop-error className="mt-1 text-[12px] text-ink-soft">
            {t('tasks.stopFailed', { detail: failure })}
          </p>
        ) : null}
        {expanded ? <TaskDetail task={task} /> : null}
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
      <PageHeader title={t('tasks.title')} onToggleSidebar={onToggleSidebar} width="split" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-10 lg:px-6">
        <div className={`mx-auto ${PAGE_WIDTH.split} space-y-6`} data-tasks-page>
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
              ) : (
                <>
                  {group('running', running)}
                  {group('finished', finished)}
                </>
              )}
              {tasksQuery.hasNextPage ? (
                <button type="button" disabled={tasksQuery.isFetchingNextPage}
                  onClick={() => { void tasksQuery.fetchNextPage(); }}
                  className={`${SECONDARY_BUTTON} disabled:opacity-50`}>
                  {t('tasks.loadMore')}
                </button>
              ) : null}
            </>
          )}
        </div>
      </main>
    </>
  );
}
