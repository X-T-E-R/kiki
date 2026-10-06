/**
 * /cron — the one scheduled-tasks page (`GET /api/cron`, every workspace).
 *
 * Workspace is a client-side filter: `?workspace=<id>` (pre-filled when the
 * sidebar nav or the inspector link opens it from a session) narrows the
 * list; the scope bar under the title widens back to all workspaces. Every row
 * keeps its workspace tag either way. `?session=<id>` (the rail's per-
 * conversation entry) is a server-side filter instead: the server narrows to
 * that conversation before it pages, so page N is page N of this
 * conversation's own tasks. Neither filter is a substitute for the other.
 * Rows split into Active / Paused sections on the server's paused-last order,
 * next fire time leading.
 *
 * A row leads with what a person reads a schedule by: the human cadence, in
 * the active locale. The engine's English string ("at minute 0 of every
 * hour") and the raw expression are facts about the rule, not the interface,
 * so they live in the row's expanded panel instead of standing in for the
 * schedule. `next_fire_at` is the only timing this page ever shows, and it is
 * the server's number, never a schedule phrase re-evaluated into a moment.
 *
 * Row actions ride the per-task routes (`:pause` / `:resume` / `:run` /
 * PATCH / DELETE); the list's `session_id` always travels back as the
 * disambiguating query so a shared id never trips 40001. Pause/resume patch
 * the row from the returned task and invalidate, so the server's paused-last
 * ordering settles on the same pass. Delete goes through a ConfirmDialog.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { CronDeliveryMode, Session, Workspace } from '@kiki/protocol';
import { ErrorCode } from '@kiki/protocol';
import { useSearchParams } from 'react-router-dom';
import type { To } from 'react-router-dom';

import type { I18nKey, I18nParams } from '@kiki/session-core/i18n';
import { cronScheduleLabel } from '@kiki/session-core/util';

import { useI18n } from '../i18n';
import {
  ApiError,
  type CronTask,
  type CronTaskDetail,
  type ListCronTasksResponse,
  type UpdateCronTaskRequest,
} from '../lib/client';
import { pushToast } from '../lib/toasts';
import { useThreadTitle } from '../lib/threadTitles';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { CronTaskEditor } from './CronTaskEditor';
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

/** Friendly text for the cron route's actionable error codes. */
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

/**
 * The delivery mode a row advertises. Absent on an older host, and on a task
 * that predates modes: both read as the default the host will apply on the
 * next fire, so the label never claims a distinction the server is not making.
 */
export function cronDeliveryMode(task: CronTask): CronDeliveryMode {
  return task.delivery_mode ?? 'idle';
}

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

/** A label, a field: the two-line shape every value row in the panel uses. */
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0 sm:grid sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3 sm:py-0.5">
      <dt className="text-[12px] text-ink-faint sm:pt-px">{label}</dt>
      <dd className="min-w-0 text-[12.5px] leading-relaxed text-ink-soft">{children}</dd>
    </div>
  );
}

interface CronDetailProps {
  readonly task: CronTask;
  readonly sessionTitle: string | undefined;
  readonly workspaceName: string | undefined;
  readonly onOpenSession: (sessionId: string) => void;
}

/**
 * The row opened. It shows the two things the collapsed row cannot: the
 * prompt in full, and the expression behind the schedule. The full prompt is
 * read from the server on open, because the list row only ever carries a
 * truncated preview.
 */
function CronDetail({ task, sessionTitle, workspaceName, onOpenSession }: CronDetailProps) {
  const { t, time } = useI18n();
  return (
    <div
      data-cron-detail
      className="mt-3 space-y-3 border-t border-hairline pt-3"
    >
      <div className="min-w-0">
        <p className="text-[11px] text-ink-faint">{t('cron.detail.prompt')}</p>
        <CronDetailPrompt task={task} />
      </div>
      <dl className="space-y-1.5">
        <Fact label={t('cron.detail.schedule')}>
          {task.next_fire_at === null
            ? <span className="text-ink-faint">{t('cron.status.paused')}</span>
            : <span className="tabular-nums">{time.absoluteTime(task.next_fire_at)}</span>}
        </Fact>
        {/* The detail says what firing the prompt does to a busy conversation,
            because that is the one fact the schedule itself cannot carry. */}
        <Fact label={t('cron.detail.delivery')}>
          {t(`cron.delivery.${cronDeliveryMode(task)}`)}
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-faint">
            {t(`cron.delivery.hint.${cronDeliveryMode(task)}`)}
          </span>
        </Fact>
        <Fact label={t('cron.detail.expression')}>
          <span className="font-mono text-[12px] text-ink">{task.cron}</span>
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-faint">
            {t('cron.detail.expressionHint')}
          </span>
        </Fact>
        <Fact label={t('cron.detail.owner')}>
          {task.session_id === null ? (
            <>
              <span className="text-ink-faint">{t('cron.detail.unbound')}</span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-faint">
                {t('cron.detail.unboundHint')}
              </span>
            </>
          ) : sessionTitle === undefined ? (
            <span className="font-mono text-[11.5px]">{task.session_id}</span>
          ) : (
            <button
              type="button"
              data-cron-detail-session={task.session_id}
              onClick={() => { onOpenSession(task.session_id as string); }}
              className="max-w-full truncate text-left font-medium text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline"
              title={sessionTitle}
            >
              {sessionTitle}
            </button>
          )}
        </Fact>
        <Fact label={t('cron.detail.workspace')}>{workspaceName ?? task.workspace_id}</Fact>
        <Fact label={t('cron.detail.created')}>{time.absoluteTime(task.created_at)}</Fact>
      </dl>
    </div>
  );
}

interface CronTaskRowProps {
  readonly task: CronTask;
  readonly sessionTitle: string | undefined;
  readonly workspaceName: string | undefined;
  readonly schedule: string;
  readonly pending: boolean;
  readonly expanded: boolean;
  readonly onToggleDetail: () => void;
  readonly onEdit: () => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onPauseResume: (task: CronTask, pause: boolean) => void;
  readonly onRun: (task: CronTask) => void;
  readonly onDelete: (task: CronTask) => void;
}

function CronTaskRow({
  task,
  sessionTitle,
  workspaceName,
  schedule,
  pending,
  expanded,
  onToggleDetail,
  onEdit,
  onOpenSession,
  onPauseResume,
  onRun,
  onDelete,
}: CronTaskRowProps) {
  const { t } = useI18n();
  const sessionId = task.session_id;
  const shownTitle = useThreadTitle(sessionTitle ?? '');
  return (
    <li
      data-cron-task={task.id}
      aria-busy={pending}
      className={`group px-4 py-4 transition-opacity lg:px-5 ${pending ? 'opacity-60' : ''}`}
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 lg:grid-cols-[9.5rem_minmax(0,1fr)_auto]">
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
            {/* The schedule, in the reader's language. The expression that
                produced it is one click away, not in their way. */}
            <span data-cron-schedule className="min-w-0 text-[14px] font-medium text-ink">
              {schedule}
            </span>
            {task.next_fire_at !== null ? <StatusChip task={task} /> : null}
            <span className={`${CHIP_BASE} border-hairline bg-paper text-ink-faint`}>
              {task.recurring ? t('cron.kind.recurring') : t('cron.kind.oneShot')}
            </span>
            <span
              data-cron-delivery={cronDeliveryMode(task)}
              className={`${CHIP_BASE} border-hairline bg-paper text-ink-soft`}
            >
              {t(`cron.delivery.${cronDeliveryMode(task)}`)}
            </span>
            {task.stale ? (
              <span data-cron-status="stale" className={`${CHIP_BASE} bg-amber-card text-amber-ink`}>
                {t('cron.status.stale')}
              </span>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">
            {task.prompt_preview.replace('…(truncated)', '…')}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">
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
                  title={shownTitle}
                >
                  {shownTitle}
                </button>
              ) : (
                <span className="max-w-48 truncate font-mono" title={sessionId}>
                  {sessionId}
                </span>
              )
            ) : null}
          </div>

          {/* The row's own controls: read the detail, or change the rule. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-cron-action="expand"
              aria-expanded={expanded}
              aria-label={t(expanded ? 'cron.action.collapseAria' : 'cron.action.expandAria', { schedule })}
              onClick={onToggleDetail}
              className={`inline-flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink ${expanded ? 'text-ink' : ''}`}
            >
              <Chevron open={expanded} />
              {t(expanded ? 'cron.action.collapse' : 'cron.action.expand')}
            </button>
            <button
              type="button"
              data-cron-action="edit"
              aria-label={t('cron.action.editAria', { schedule })}
              onClick={onEdit}
              className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
            >
              {t('cron.action.edit')}
            </button>
          </div>

          {expanded ? (
            <CronDetail
              task={task}
              sessionTitle={sessionTitle}
              workspaceName={workspaceName}
              onOpenSession={onOpenSession}
            />
          ) : null}
        </div>

        {/* Run now sits at the bottom left of the row: it is the one
            action that runs work, so it is the one a person reaches for
            last and least often. Pause and delete stay apart from it. */}
        <div className="flex flex-wrap items-start justify-start gap-1.5 lg:justify-end">
          <button
            type="button"
            data-cron-action="pause"
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
      </div>
      {/* Run now sits on the row's own lower line, at the left edge under
          the "when" column. It is the one action that runs work, so it is
          the one a person reaches for last and least often; pause and
          delete stay in their own group at the far end. */}
      <div className="mt-3 flex justify-start lg:pl-[9.5rem]">
        <button
          type="button"
          data-cron-action="run"
          aria-label={t('cron.action.runAria', { schedule })}
          disabled={pending}
          onClick={() => { onRun(task); }}
          className={SECONDARY_BUTTON}
        >
          {t('cron.action.run')}
        </button>
      </div>
    </li>
  );
}

/** The same chevron the rail's folded blocks use, at row-button size. */
function Chevron({ open }: { readonly open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3 w-3 shrink-0 transition-transform duration-[var(--kiki-motion-quick)] ${open ? 'rotate-90' : ''}`}
    >
      <path d="m4.5 2.5 3 3.5-3 3.5" />
    </svg>
  );
}

/**
 * The full prompt for one opened row.
 *
 * The list carries a truncated preview precisely so a page of 100 rows stays
 * small; pulling every prompt up front would undo that. Each opened row reads
 * its own detail, keyed by workspace, id and owning session, so a task id
 * shared across workspaces can never show another one's prompt.
 */
function CronDetailPrompt({ task }: { readonly task: CronTask }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const detail = useQuery({
    queryKey: ['cron-task-detail', task.workspace_id, task.id, task.session_id],
    queryFn: async (): Promise<CronTaskDetail> =>
      (await client.getCronTask(task.id, task.session_id ?? undefined)).task,
    staleTime: 30_000,
    retry: false,
  });
  if (detail.isError) {
    return (
      <p role="status" data-cron-detail-error className="mt-0.5 text-[12.5px] text-ink-faint">
        {t('cron.form.detailUnavailable')}
      </p>
    );
  }
  if (detail.data === undefined) {
    return <p data-cron-detail-loading className="mt-0.5 text-[12.5px] text-ink-faint">{t('cron.panel.loading')}</p>;
  }
  return (
    <p
      data-cron-detail-prompt
      className="mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-soft"
    >
      {detail.data.prompt}
    </p>
  );
}

export function CronPage({ sessions, workspaceOptions, onNavigate, onToggleSidebar }: CronPageProps) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<CronTask | null>(null);
  const [editing, setEditing] = useState<{ readonly task: CronTask | undefined } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { scope, setScope } = useWorkspaceScope(workspaceOptions);
  // `?session=<id>` (the rail's "manage" entry) narrows the list to one
  // conversation at the server, so it pages that conversation's own tasks.
  const [params, setParams] = useSearchParams();
  const sessionScope = params.get('session') ?? undefined;
  const tasksQueryKey = useMemo(
    () => [...CRON_TASKS_QUERY_KEY, 'filter', sessionScope ?? null] as const,
    [sessionScope],
  );
  const clearSessionScope = useCallback(() => {
    const updated = new URLSearchParams(params);
    updated.delete('session');
    setParams(updated, { replace: true });
  }, [params, setParams]);

  const tasksQuery = useInfiniteQuery({
    queryKey: tasksQueryKey,
    queryFn: ({ pageParam }) => client.listCronTasks({ session_id: sessionScope, page_size: 100, offset: pageParam }),
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
      queryClient.setQueryData<InfiniteData<ListCronTasksResponse, number>>(tasksQueryKey, (old) =>
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
      queryClient.setQueryData<InfiniteData<ListCronTasksResponse, number>>(tasksQueryKey, (old) =>
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

  const createMutation = useMutation({
    mutationFn: (input: {
      readonly session_id: string;
      readonly cron: string;
      readonly prompt: string;
      readonly recurring: boolean;
      readonly delivery_mode: CronDeliveryMode;
      /** Whether the form states the mode; a create always sends it. */
      readonly sendDeliveryMode: boolean;
    }): Promise<{ readonly task: CronTaskDetail }> => client.createCronTask({
      session_id: input.session_id,
      cron: input.cron,
      prompt: input.prompt,
      recurring: input.recurring,
      delivery_mode: input.delivery_mode,
    }),
    onSuccess: () => {
      pushToast({ tone: 'success', text: t('cron.toast.created') });
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
    // The editor stays open with its draft; the message says what to do.
    onError: () => { /* surfaced in the editor */ },
  });

  const updateMutation = useMutation({
    mutationFn: ({ task, patch }: { task: CronTask; patch: UpdateCronTaskRequest }) =>
      client.updateCronTask(task.id, patch, task.session_id ?? undefined),
    onSuccess: () => {
      pushToast({ tone: 'success', text: t('cron.toast.updated') });
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: CRON_TASKS_QUERY_KEY });
    },
    onError: () => { /* surfaced in the editor */ },
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

  const toggleDetail = useCallback((task: CronTask) => {
    const key = `${task.workspace_id}:${task.id}`;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const openEditor = useCallback((task: CronTask) => {
    setEditing({ task });
  }, []);

  const allTasks = tasksQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const tasks = filterCronTasks(allTasks, scope);
  // The server already orders paused plans last; split on that boundary so the
  // "what will run next" list is never interleaved with dormant ones.
  const activeTasks = tasks.filter((task) => !task.paused);
  const pausedTasks = tasks.filter((task) => task.paused);

  const renderRow = (task: CronTask) => {
    const key = `${task.workspace_id}:${task.id}`;
    const isOpen = expanded.has(key);
    const sessionTitle = task.session_id === null ? undefined : sessionsById.get(task.session_id)?.title;
    return (
      <CronTaskRow
        key={key}
        task={task}
        sessionTitle={sessionTitle}
        workspaceName={workspacesById.get(task.workspace_id)?.name}
        schedule={cronScheduleLabel(locale, task.cron, task.human_schedule, t)}
        pending={busyTaskId === task.id}
        expanded={isOpen}
        onToggleDetail={() => { toggleDetail(task); }}
        onEdit={() => { openEditor(task); }}
        onOpenSession={openSession}
        onPauseResume={(target, pause) => { pauseResumeMutation.mutate({ task: target, pause }); }}
        onRun={(target) => { runMutation.mutate(target); }}
        onDelete={(target) => { setPendingDelete(target); }}
      />
    );
  };
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

  const editorTask = editing?.task;
  const editingBusy = createMutation.isPending || updateMutation.isPending;
  const editorError = editing?.task === undefined
    ? (createMutation.isError ? t('cron.form.error.createFailed') : undefined)
    : (updateMutation.isError ? t('cron.form.error.saveFailed') : undefined);

  return (
    <div data-cron-page className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('cron.panel.title')} onToggleSidebar={onToggleSidebar}>
        <button
          type="button"
          data-cron-create
          onClick={() => { setEditing({ task: undefined }); }}
          className="h-8 rounded-md border border-hairline px-3 text-[13px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
        >
          {t('cron.panel.create')}
        </button>
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
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline px-4 py-2 lg:px-6">
        <WorkspaceScopeControl workspaces={workspaceOptions} value={scope} onChange={setScope} />
        {sessionScope !== undefined ? (
          <span data-cron-session-scope={sessionScope} className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-ink-faint">
            <span className="shrink-0">{t('cron.scope.session')}</span>
            <span className="min-w-0 max-w-56 truncate text-ink-soft" title={sessionScope}>
              {sessionsById.get(sessionScope)?.title ?? sessionScope}
            </span>
            <button
              type="button"
              data-cron-session-clear
              onClick={clearSessionScope}
              className="shrink-0 font-medium text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {t('cron.scope.sessionClear')}
            </button>
          </span>
        ) : null}
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
        ) : tasks.length === 0 && sessionScope !== undefined ? (
          <div data-cron-session-empty className="mx-auto max-w-[960px] py-10">
            <p className="text-[13px] text-ink-soft">{t('cron.scope.sessionEmpty')}</p>
            <button type="button" onClick={clearSessionScope} className="mt-1 text-[13px] font-medium text-ink underline underline-offset-2">
              {t('cron.scope.sessionClear')}
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
            <button
              type="button"
              data-cron-empty-create
              onClick={() => { setEditing({ task: undefined }); }}
              className="mt-1 h-8 rounded-md border border-hairline px-3 text-[12.5px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
            >
              {t('cron.panel.create')}
            </button>
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

      {editing !== null ? (
        <CronTaskEditor
          key={editorTask?.id ?? 'create'}
          mode={editorTask === undefined ? 'create' : 'edit'}
          task={editorTask === undefined ? undefined : {
            id: editorTask.id,
            session_id: editorTask.session_id,
            workspace_id: editorTask.workspace_id,
            cron: editorTask.cron,
            // No prompt is passed: the list row holds a truncated preview,
            // and the editor opens with the field empty and disabled, then
            // seeds it from its own detail read. Handing the preview down
            // would let a save write the truncation over the real prompt.
            recurring: editorTask.recurring,
            delivery_mode: editorTask.delivery_mode,
          }}
          sessions={sessions}
          workspaceOptions={workspaceOptions}
          sourceSessionId={editorTask?.session_id ?? undefined}
          preferredSessionId={sessionScope}
          busy={editingBusy}
          onSubmit={(input) => {
            if (editorTask === undefined) {
              createMutation.mutate(input);
              return;
            }
            const patch: UpdateCronTaskRequest = {
              cron: input.cron,
              prompt: input.prompt,
              recurring: input.recurring,
              session_id: input.session_id,
              // An untouched control sends no field, so the host keeps the
              // mode the task already has. Sending a value the form merely
              // displayed would rewrite a `queue` task the user never touched.
              delivery_mode: input.sendDeliveryMode ? input.delivery_mode : undefined,
            };
            updateMutation.mutate({ task: editorTask, patch });
          }}
          onClose={() => {
            if (!editingBusy) setEditing(null);
          }}
          {...(editorError === undefined ? {} : { error: editorError })}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('cron.delete.title')}
        body={pendingDelete === null
          ? undefined
          : t('cron.delete.body', { schedule: cronScheduleLabel(locale, pendingDelete.cron, pendingDelete.human_schedule, t) })}
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
