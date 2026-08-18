/**
 * TasksPage (/s/:id/tasks) — the per-session background-task browser.
 *
 * The right rail's Tasks chapter shows at most a bounded, scrolling slice of
 * the session's tasks; this page is the full inventory behind its "View all"
 * entry. The wire has no cross-session tasks endpoint (REST.md §3.7 only
 * scopes tasks under `/sessions/{id}/tasks*`), so the page stays
 * session-scoped and keeps a "back to session" exit.
 *
 * Data: the list rides `listTasks` (unpaginated — the server returns every
 * task incl. terminal "ghost" tasks) and polls only while something is still
 * running. Row expansion lazily fetches `GET tasks/{id}?with_output=true`
 * for the tail-of-log preview; cancellation reuses the same
 * `:cancel` route as the rail and treats 40904 (already finished) as a
 * success-shaped refetch, matching `KikiClient.cancelTask`'s okCodes.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import type { Task, TaskStatus } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';

const STATUS_FILTERS: readonly (TaskStatus | 'all')[] = [
  'all',
  'running',
  'completed',
  'failed',
  'cancelled',
];

/** Running work first, then newest-created first within each status tier. */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) {
      return a.status === 'running' ? -1 : 1;
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function statusPillTone(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return 'bg-accent-soft text-accent';
    case 'completed':
      return 'bg-success/10 text-success';
    case 'failed':
      return 'bg-danger/10 text-danger';
    case 'cancelled':
      return 'bg-paper text-ink-soft';
  }
}

function DetailRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-[10.5px] text-ink-faint">{label}</span>
      <span
        className={`min-w-0 truncate text-[11.5px] text-ink ${mono ? 'font-mono' : ''}`}
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
    <div className="mt-2.5 space-y-2 border-t border-hairline pt-2.5" data-task-detail>
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
          <p className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {t('tasks.field.command')}
          </p>
          <pre className="overflow-x-auto rounded-lg bg-paper px-3 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-ink">
            {task.command}
          </pre>
        </div>
      ) : null}
      <div>
        <p className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          {t('tasks.field.output')}
        </p>
        {detailQuery.isPending && output === undefined ? (
          <p className="flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
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
  const { t, tp, time } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id: sessionId = '' } = useParams<{ id: string }>();
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ['session-tasks', sessionId],
    queryFn: () => client.listTasks(sessionId).then((response) => response.items),
    enabled: sessionId !== '',
    refetchInterval: (query) =>
      (query.state.data ?? []).some((task) => task.status === 'running') ? 3000 : false,
  });

  const cancelMutation = useMutation({
    mutationFn: (taskId: string) => client.cancelTask(sessionId, taskId),
    onSettled: (_data, error, taskId) => {
      setPendingCancelId(null);
      if (error !== null) {
        pushToast({
          tone: 'error',
          text: t('sv.stopTaskFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      // 40904 (already finished) resolves as success-shaped data; either way a
      // refetch reconciles the row with the server's truth.
      void queryClient.invalidateQueries({ queryKey: ['session-tasks', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['session-task', sessionId, taskId] });
    },
  });

  const tasks = useMemo(() => sortTasks(tasksQuery.data ?? []), [tasksQuery.data]);
  const counts = useMemo(() => {
    const map = new Map<TaskStatus, number>();
    for (const task of tasks) map.set(task.status, (map.get(task.status) ?? 0) + 1);
    return map;
  }, [tasks]);
  const visible = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((task) => task.status === filter)),
    [tasks, filter],
  );

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('sv.openMenuAria')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
        >
          <span aria-hidden>☰</span>
        </button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          {t('tasks.title')}
        </h1>
        <button
          type="button"
          onClick={() => void navigate(`/s/${sessionId}`)}
          className="shrink-0 rounded-lg border border-hairline px-2.5 py-1 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
        >
          {t('tasks.back')}
        </button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">
        <div className="mx-auto max-w-[860px] space-y-4" data-tasks-page>
          {tasksQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-panel px-4 py-10 text-[12px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('tasks.loading')}
            </div>
          ) : tasksQuery.isError ? (
            <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5">
              <p className="text-[12.5px] font-medium text-danger">{t('tasks.loadFailed')}</p>
              <p className="mt-1 font-mono text-[10.5px] text-danger/80">
                {tasksQuery.error instanceof Error
                  ? tasksQuery.error.message
                  : t('common.unknownError')}
              </p>
              <button
                type="button"
                onClick={() => void tasksQuery.refetch()}
                className="mt-2 text-[11.5px] font-medium text-danger underline"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : tasks.length === 0 ? (
            <p className="rounded-2xl border border-hairline bg-panel px-4 py-10 text-center text-[12.5px] text-ink-faint">
              {t('tasks.empty')}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <div
                  role="group"
                  aria-label={t('tasks.title')}
                  className="inline-flex rounded-lg border border-hairline bg-panel p-0.5"
                >
                  {STATUS_FILTERS.map((candidate) => {
                    const count =
                      candidate === 'all' ? tasks.length : (counts.get(candidate) ?? 0);
                    return (
                      <button
                        key={candidate}
                        type="button"
                        data-status-filter={candidate}
                        onClick={() => { setFilter(candidate); }}
                        aria-pressed={filter === candidate}
                        className={`rounded-md px-2.5 py-1 text-[11.5px] transition-colors ${
                          filter === candidate
                            ? 'bg-accent-soft font-semibold text-accent'
                            : 'text-ink-soft hover:text-ink'
                        }`}
                      >
                        {candidate === 'all'
                          ? t('tasks.filter.all')
                          : t(`rail.taskStatus.${candidate}`)}
                        <span className="ml-1 font-mono text-[10px] tabular-nums opacity-70">
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <span className="ml-auto text-[11px] text-ink-faint">
                  {tp('tasks.count', visible.length)}
                </span>
              </div>

              {visible.length === 0 ? (
                <p className="rounded-2xl border border-hairline bg-panel px-4 py-10 text-center text-[12.5px] text-ink-faint">
                  {t('tasks.emptyFilter')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {visible.map((task) => {
                    const expanded = expandedId === task.id;
                    const running = task.status === 'running';
                    return (
                      <li
                        key={task.id}
                        data-task-row
                        className={`rounded-2xl border bg-panel px-4 py-3 shadow-[0_2px_4px_rgba(28,25,23,0.03)] transition-colors ${
                          running ? 'border-accent/40' : 'border-hairline'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`shrink-0 rounded-full px-2 py-px text-[10.5px] font-medium ${statusPillTone(task.status)}`}
                          >
                            {running ? (
                              <span
                                aria-hidden
                                className="status-dot-busy mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent"
                              />
                            ) : null}
                            {t(`rail.taskStatus.${task.status}`)}
                          </span>
                          <span className="shrink-0 rounded-md border border-hairline px-1.5 py-px text-[10px] text-ink-faint">
                            {t(`tasks.kind.${task.kind}`)}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink"
                            title={task.description}
                          >
                            {task.description}
                          </span>
                          <span className="hidden shrink-0 font-mono text-[10.5px] text-ink-faint sm:inline">
                            {time.relativeTime(task.created_at)}
                          </span>
                          {running ? (
                            <button
                              type="button"
                              disabled={pendingCancelId === task.id}
                              onClick={() => {
                                setPendingCancelId(task.id);
                                cancelMutation.mutate(task.id);
                              }}
                              title={t('rail.stopTitle')}
                              className="shrink-0 rounded-md border border-hairline px-2 py-0.5 text-[10.5px] text-ink-soft transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
                            >
                              {pendingCancelId === task.id ? t('tasks.stopping') : t('rail.stop')}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={expanded ? t('tasks.collapse') : t('tasks.expand')}
                            onClick={() => { setExpandedId(expanded ? null : task.id); }}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-hairline text-[9px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
                          >
                            <span
                              aria-hidden
                              className={`inline-block transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                            >
                              ▶
                            </span>
                          </button>
                        </div>
                        {task.command !== undefined ? (
                          <p className="mt-1.5 truncate font-mono text-[11px] text-ink-faint">
                            {task.command}
                          </p>
                        ) : null}
                        {expanded ? <TaskDetail task={task} /> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
