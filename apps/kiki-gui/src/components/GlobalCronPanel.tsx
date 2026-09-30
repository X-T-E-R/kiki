/**
 * /cron — the one scheduled-tasks page (`GET /api/cron`, every workspace).
 *
 * Workspace is a client-side filter: `?workspace=<id>` (pre-filled when the
 * sidebar nav or the inspector link opens it from a session) narrows the
 * list; the scope bar under the title widens back to all workspaces. Every row
 * keeps its workspace tag either way. Rows split into Active / Paused
 * sections on the server's paused-last order, next fire time leading.
 *
 * Row actions ride the per-task routes (`:pause` / `:resume` / `:run` /
 * DELETE); the list's `session_id` always travels back as the disambiguating
 * query so a shared id never trips 40001. Pause/resume patch the row from the
 * returned task and invalidate, so the server's paused-last ordering settles
 * on the same pass. Delete goes through a ConfirmDialog.
 */

import { useCallback, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { Session, Workspace } from '@kiki/protocol';
import { ErrorCode } from '@kiki/protocol';
import type { To } from 'react-router-dom';

import type { I18nKey, I18nParams } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { ApiError, type CronTask, type ListCronTasksResponse } from '../lib/client';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { PageHeader, useWorkspaceScope } from './PageChrome';
import { useNow } from './RelativeTime';
import { DANGER_GHOST_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { WorkspaceScopeControl } from './WorkspaceScopeControl';

export const CRON_TASKS_QUERY_KEY = ['cron-tasks'] as const;

export interface CronPageProps {
  readonly sessions: readonly Session[];
  readonly workspaceOptions: readonly Workspace[];
  readonly onNavigate: (target: To) => void;
  readonly onToggleSidebar: () => void;
}

/** Client-side workspace scope for the cross-workspace list. */
export function filterCronTasks<T extends { readonly workspace_id: string }>(
  tasks: readonly T[],
  workspaceId: string | undefined,
): T[] {
  return workspaceId === undefined ? [...tasks] : tasks.filter((task) => task.workspace_id === workspaceId);
}

type Translate = (key: I18nKey, params?: I18nParams) => string;

/** Friendly text for the cron route's two actionable error codes. */
function cronErrorText(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.code === ErrorCode.TASK_NOT_FOUND) return t('cron.error.notFound');
    if (error.code === ErrorCode.VALIDATION_FAILED) return t('cron.error.ambiguous');
  }
  return error instanceof Error ? error.message : String(error);
}

function ClockGlyph({ className }: { readonly className?: string }) {
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
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.6" />
    </svg>
  );
}

/** Countdown to the next fire ("in 5m"), aging with the shared 1s clock. */
function NextFire({ at }: { readonly at: string }) {
  const { time } = useI18n();
  useNow();
  return (
    <span className="tabular-nums" title={time.absoluteTime(at)}>
      {time.timeUntil(at)}
    </span>
  );
}

function LastFire({ at }: { readonly at: string | null }) {
  const { t, time } = useI18n();
  useNow();
  if (at === null) return <>{t('cron.neverRun')}</>;
  return (
    <span className="tabular-nums" title={time.absoluteTime(at)}>
      {time.relativeTime(at)}
    </span>
  );
}

const CHIP_BASE =
  'shrink-0 rounded-sm border border-transparent px-1.5 py-px text-[12px] font-medium';

function StatusChip({ task }: { readonly task: CronTask }) {
  const { t } = useI18n();
  if (task.paused) {
    return (
      <span data-cron-status="paused" className={`${CHIP_BASE} bg-panel text-ink-faint`}>
        {t('cron.status.paused')}
      </span>
    );
  }
  return (
    <span data-cron-status="running" className={`${CHIP_BASE} bg-success/10 text-success`}>
      {t('cron.status.running')}
    </span>
  );
}

interface CronTaskRowProps {
  readonly task: CronTask;
  readonly sessionTitle: string | undefined;
  readonly workspaceName: string | undefined;
  readonly pending: boolean;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onPauseResume: (task: CronTask, pause: boolean) => void;
  readonly onRun: (task: CronTask) => void;
  readonly onDelete: (task: CronTask) => void;
}

function CronTaskRow({
  task,
  sessionTitle,
  workspaceName,
  pending,
  onOpenSession,
  onPauseResume,
  onRun,
  onDelete,
}: CronTaskRowProps) {
  const { t } = useI18n();
  const sessionId = task.session_id;
  return (
    <li
      data-cron-task={task.id}
      aria-busy={pending}
      className={`group grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 transition-opacity lg:grid-cols-[9.5rem_minmax(0,1fr)_auto] lg:px-5 ${pending ? 'opacity-60' : ''}`}
    >
      {/* When: the next fire is the fact a scheduler page is read for. */}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 lg:flex-col lg:gap-0.5">
        {task.next_fire_at !== null ? (
          <>
            <span className="text-[11px] text-ink-faint">{t('cron.nextFire')}</span>
            <span className="font-display text-[18px] leading-tight font-semibold text-ink">
              <NextFire at={task.next_fire_at} />
            </span>
          </>
        ) : (
          <StatusChip task={task} />
        )}
        <span className="text-[11.5px] text-ink-faint lg:mt-1">
          {t('cron.lastFire')}: <LastFire at={task.last_fired_at} />
        </span>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-[14px] font-medium text-ink">
            {task.human_schedule}
          </span>
          {task.next_fire_at !== null ? <StatusChip task={task} /> : null}
          <span className={`${CHIP_BASE} border-hairline bg-paper text-ink-faint`}>
            {task.recurring ? t('cron.kind.recurring') : t('cron.kind.oneShot')}
          </span>
          {task.stale ? (
            <span data-cron-status="stale" className={`${CHIP_BASE} bg-amber-card text-amber-ink`}>
              {t('cron.status.stale')}
            </span>
          ) : null}
        </div>
        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">
          {task.prompt_preview}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">
          <span className="font-mono text-[11.5px]">{task.cron}</span>
          <span data-cron-workspace className="inline-flex max-w-44 items-center gap-1 truncate" title={task.workspace_id}>
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-hairline-strong" />
            <span className={`truncate ${workspaceName === undefined ? 'font-mono' : ''}`}>{workspaceName ?? task.workspace_id}</span>
          </span>
          {sessionId !== null ? (
            sessionTitle !== undefined ? (
              <button
                type="button"
                data-cron-session={sessionId}
                onClick={() => { onOpenSession(sessionId); }}
                className="max-w-56 truncate font-medium text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline"
                title={sessionTitle}
              >
                {sessionTitle}
              </button>
            ) : (
              <span className="max-w-48 truncate font-mono" title={sessionId}>
                {sessionId}
              </span>
            )
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-start justify-start gap-1.5 lg:justify-end">
        <button
          type="button"
          data-cron-action="run"
          disabled={pending}
          onClick={() => { onRun(task); }}
          className={SECONDARY_BUTTON}
        >
          {t('cron.action.run')}
        </button>
        <button
          type="button"
          data-cron-action={task.paused ? 'resume' : 'pause'}
          disabled={pending}
          onClick={() => { onPauseResume(task, !task.paused); }}
          className={task.paused ? PRIMARY_BUTTON : SECONDARY_BUTTON}
        >
          {task.paused ? t('cron.action.resume') : t('cron.action.pause')}
        </button>
        <button
          type="button"
          data-cron-action="delete"
          disabled={pending}
          onClick={() => { onDelete(task); }}
          className={DANGER_GHOST_BUTTON}
        >
          {t('cron.action.delete')}
        </button>
      </div>
    </li>
  );
}

export function CronPage({ sessions, workspaceOptions, onNavigate, onToggleSidebar }: CronPageProps) {
  const { client } = useConnection();
  const { t, tp } = useI18n();
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<CronTask | null>(null);
  const { scope, setScope } = useWorkspaceScope(workspaceOptions);

  const tasksQuery = useInfiniteQuery({
    queryKey: CRON_TASKS_QUERY_KEY,
    queryFn: ({ pageParam }) => client.listCronTasks({ page_size: 100, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.next_offset,
  });

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const workspacesById = useMemo(
    () => new Map(workspaceOptions.map((workspace) => [workspace.id, workspace])),
    [workspaceOptions],
  );

  const reportError = useCallback(
    (error: unknown) => {
      pushToast({ tone: 'error', text: cronErrorText(error, t) });
    },
    [t],
  );

  const pauseResumeMutation = useMutation({
    mutationFn: ({ task, pause }: { task: CronTask; pause: boolean }) =>
      pause
        ? client.pauseCronTask(task.id, task.session_id ?? undefined)
        : client.resumeCronTask(task.id, task.session_id ?? undefined),
    onSuccess: (result, { pause }) => {
      queryClient.setQueryData<InfiniteData<ListCronTasksResponse, number>>(CRON_TASKS_QUERY_KEY, (old) =>
        old === undefined ? undefined : {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((entry) =>
              entry.id === result.task.id && entry.workspace_id === result.task.workspace_id ? result.task : entry),
          })),
        },
      );
      pushToast({ tone: 'success', text: pause ? t('cron.toast.paused') : t('cron.toast.resumed') });
    },
    onError: reportError,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
  });

  const runMutation = useMutation({
    mutationFn: (task: CronTask) => client.runCronTask(task.id, task.session_id ?? undefined),
    onSuccess: () => {
      pushToast({ tone: 'success', text: t('cron.toast.triggered') });
    },
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: (task: CronTask) => client.deleteCronTask(task.id, task.session_id ?? undefined),
    onSuccess: (_result, task) => {
      queryClient.setQueryData<InfiniteData<ListCronTasksResponse, number>>(CRON_TASKS_QUERY_KEY, (old) =>
        old === undefined ? undefined : {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.filter((entry) =>
              !(entry.id === task.id && entry.workspace_id === task.workspace_id)),
          })),
        },
      );
      pushToast({ tone: 'success', text: t('cron.toast.deleted') });
      setPendingDelete(null);
    },
    onError: (error) => {
      reportError(error);
      setPendingDelete(null);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
  });

  const busyTaskId = pauseResumeMutation.isPending
    ? pauseResumeMutation.variables.task.id
    : runMutation.isPending
      ? runMutation.variables.id
      : deleteMutation.isPending
        ? deleteMutation.variables.id
        : undefined;

  const openSession = useCallback(
    (sessionId: string) => {
      onNavigate(`/s/${sessionId}`);
    },
    [onNavigate],
  );

  const allTasks = tasksQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const tasks = filterCronTasks(allTasks, scope);
  // The server already orders paused plans last; split on that boundary so the
  // "what will run next" list is never interleaved with dormant ones.
  const activeTasks = tasks.filter((task) => !task.paused);
  const pausedTasks = tasks.filter((task) => task.paused);
  const renderRow = (task: CronTask) => (
    <CronTaskRow
      key={`${task.workspace_id}:${task.id}`}
      task={task}
      sessionTitle={task.session_id === null ? undefined : sessionsById.get(task.session_id)?.title}
      workspaceName={workspacesById.get(task.workspace_id)?.name}
      pending={busyTaskId === task.id}
      onOpenSession={openSession}
      onPauseResume={(target, pause) => { pauseResumeMutation.mutate({ task: target, pause }); }}
      onRun={(target) => { runMutation.mutate(target); }}
      onDelete={(target) => { setPendingDelete(target); }}
    />
  );
  const section = (key: 'active' | 'paused', rows: readonly CronTask[]) => (rows.length === 0 ? null : (
    <section data-cron-section={key} aria-labelledby={`cron-section-${key}`}>
      <h2 id={`cron-section-${key}`} className="mb-2 flex items-baseline gap-2 px-1 text-[12px] font-medium text-ink-soft">
        {t(key === 'active' ? 'cron.section.active' : 'cron.section.paused')}
        <span className="text-ink-faint tabular-nums">{rows.length}</span>
      </h2>
      <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-panel">
        {rows.map(renderRow)}
      </ul>
    </section>
  ));

  return (
    <div data-cron-page className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('cron.panel.title')} onToggleSidebar={onToggleSidebar}>
        <button
          type="button"
          data-cron-refresh
          disabled={tasksQuery.isFetching}
          onClick={() => { void tasksQuery.refetch(); }}
          className="h-8 rounded-md border border-hairline px-3 text-[13px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('cron.panel.refresh')}
        </button>
      </PageHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline px-4 py-2.5 lg:px-6">
        <WorkspaceScopeControl workspaces={workspaceOptions} value={scope} onChange={setScope} />
        {tasksQuery.data !== undefined ? (
          <p data-cron-summary className="ml-auto text-[12px] text-ink-faint tabular-nums">
            {tp('cron.panel.count', tasks.length)}
            {tasks.length > 0 ? ` · ${tp('cron.summary.active', activeTasks.length)} · ${tp('cron.summary.paused', pausedTasks.length)}` : ''}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-8 lg:px-6" data-cron-panel-body>
        {tasksQuery.isPending ? (
          <div
            role="status"
            className="flex h-full items-center justify-center gap-2 text-[12.5px] text-ink-faint"
          >
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            {t('cron.panel.loading')}
          </div>
        ) : tasksQuery.isError ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5" data-cron-error>
            <p className="text-[12.5px] font-medium text-danger">{t('cron.panel.error.title')}</p>
            <p className="mt-1 font-mono text-[10.5px] text-danger/80">
              {cronErrorText(tasksQuery.error, t)}
            </p>
            <button
              type="button"
              onClick={() => { void tasksQuery.refetch(); }}
              className="mt-2 text-[11.5px] font-medium text-danger underline"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : tasks.length === 0 && scope !== undefined && allTasks.length > 0 ? (
          <div data-cron-scope-empty className="mx-auto max-w-[960px] py-10">
            <p className="text-[13px] text-ink-soft">{t('cron.scope.empty')}</p>
            <button type="button" onClick={() => { setScope(undefined); }} className="mt-1 text-[13px] font-medium text-ink underline underline-offset-2">
              {t('cron.scope.showAll')}
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <div
            data-cron-empty
            className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-panel text-ink-faint">
              <ClockGlyph className="h-5 w-5" />
            </span>
            <p className="text-[13px] font-medium text-ink">{t('cron.panel.empty.title')}</p>
            <p className="max-w-md text-[12px] leading-relaxed text-ink-soft">
              {t('cron.panel.empty.description')}
            </p>
          </div>
        ) : (
          <>
            <div className="mx-auto max-w-[960px] space-y-6" data-cron-list>
              {section('active', activeTasks)}
              {section('paused', pausedTasks)}
            </div>
            {tasksQuery.hasNextPage ? (
              <button type="button" disabled={tasksQuery.isFetchingNextPage}
                onClick={() => { void tasksQuery.fetchNextPage(); }}
                className="mx-auto mt-4 block h-8 rounded-md border border-hairline px-3 text-[13px] text-ink-soft disabled:opacity-50">
                {t('cron.panel.loadMore')}
              </button>
            ) : null}
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('cron.delete.title')}
        body={pendingDelete === null
          ? undefined
          : t('cron.delete.body', { schedule: pendingDelete.human_schedule })}
        confirmLabel={t('cron.action.delete')}
        tone="danger"
        busy={deleteMutation.isPending}
        overlayId="cron-delete-confirm"
        onCancel={() => { setPendingDelete(null); }}
        onConfirm={() => {
          if (pendingDelete !== null) deleteMutation.mutate(pendingDelete);
        }}
      />
    </div>
  );
}
