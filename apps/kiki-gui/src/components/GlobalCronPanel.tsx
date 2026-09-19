/**
 * GlobalCronPanel — the cross-workspace scheduled-task panel (`GET /api/cron`).
 *
 * Mirrors the GlobalTaskBoard mounting pattern: always rendered by the app
 * shell, its launcher portals into the session rail (`[data-session-rail]`)
 * as a second full-width bar directly under the task-board entry, and the
 * panel itself is a Dialog. Pages without a rail get no entry, by design.
 *
 * Row actions ride the per-task routes (`:pause` / `:resume` / `:run` /
 * DELETE); the list's `session_id` always travels back as the disambiguating
 * query so a shared id never trips 40001. Pause/resume patch the row from the
 * returned task and invalidate, so the server's paused-last ordering settles
 * on the same pass. Delete goes through a ConfirmDialog; while it is open the
 * panel's close request (Esc/backdrop) cancels the confirm instead of
 * closing the panel, because Dialog's capture-phase Esc listener is
 * registered first and would otherwise swallow the confirm's own Esc.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session, Workspace } from '@kiki/protocol';
import { ErrorCode } from '@kiki/protocol';
import type { To } from 'react-router-dom';

import type { I18nKey, I18nParams } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { ApiError, type CronTask } from '../lib/client';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog, DIALOG_PANEL_SIZES } from './Dialog';
import { useNow } from './RelativeTime';
import { DANGER_GHOST_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

const CRON_TASKS_QUERY_KEY = ['cron-tasks'] as const;

export interface GlobalCronPanelProps {
  readonly sessions: readonly Session[];
  readonly workspaceOptions: readonly Workspace[];
  readonly onNavigate: (target: To) => void;
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
  'shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold';

function StatusChip({ task }: { readonly task: CronTask }) {
  const { t } = useI18n();
  if (task.paused) {
    return (
      <span data-cron-status="paused" className={`${CHIP_BASE} border-hairline bg-paper text-ink-faint`}>
        {t('cron.status.paused')}
      </span>
    );
  }
  return (
    <span data-cron-status="running" className={`${CHIP_BASE} border-success/25 bg-success/10 text-success`}>
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
      className={`rounded-xl border border-hairline bg-panel p-3.5 shadow-xs transition-opacity ${pending ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusChip task={task} />
            <span className={`${CHIP_BASE} border-hairline bg-paper text-ink-faint`}>
              {task.recurring ? t('cron.kind.recurring') : t('cron.kind.oneShot')}
            </span>
            {task.stale ? (
              <span
                data-cron-status="stale"
                className={`${CHIP_BASE} border-amber-rule/40 bg-amber-card text-amber-ink`}
              >
                {t('cron.status.stale')}
              </span>
            ) : null}
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
              {task.human_schedule}
            </span>
          </div>
          <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-ink-soft">
            {task.prompt_preview}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
            <span className="font-mono">{task.cron}</span>
            {sessionId !== null ? (
              sessionTitle !== undefined ? (
                <button
                  type="button"
                  data-cron-session={sessionId}
                  onClick={() => { onOpenSession(sessionId); }}
                  className="max-w-48 truncate font-medium text-ink-soft transition-colors hover:text-accent hover:underline"
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
            {workspaceName !== undefined ? (
              <span className="max-w-40 truncate" title={task.workspace_id}>{workspaceName}</span>
            ) : (
              <span className="max-w-40 truncate font-mono" title={task.workspace_id}>
                {task.workspace_id}
              </span>
            )}
            <span>
              {t('cron.lastFire')}: <LastFire at={task.last_fired_at} />
            </span>
          </div>
        </div>
        <div className="flex grow flex-col items-end gap-2">
          {task.next_fire_at !== null ? (
            <div className="text-right text-[11px] text-ink-faint">
              {t('cron.nextFire')} <NextFire at={task.next_fire_at} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              data-cron-action="run"
              disabled={pending}
              onClick={() => { onRun(task); }}
              className={PRIMARY_BUTTON}
            >
              {t('cron.action.run')}
            </button>
            <button
              type="button"
              data-cron-action={task.paused ? 'resume' : 'pause'}
              disabled={pending}
              onClick={() => { onPauseResume(task, !task.paused); }}
              className={SECONDARY_BUTTON}
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
      </div>
    </li>
  );
}

interface CronPanelBodyProps {
  readonly sessions: readonly Session[];
  readonly workspaceOptions: readonly Workspace[];
  readonly onNavigate: (target: To) => void;
  readonly onCloseRequest: () => void;
  readonly registerCloseGuard: (guard: () => boolean) => void;
}

function CronPanelBody({
  sessions,
  workspaceOptions,
  onNavigate,
  onCloseRequest,
  registerCloseGuard,
}: CronPanelBodyProps) {
  const { client } = useConnection();
  const { t, tp } = useI18n();
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<CronTask | null>(null);

  const tasksQuery = useQuery({
    queryKey: CRON_TASKS_QUERY_KEY,
    queryFn: () => client.listCronTasks().then((response) => response.items),
  });

  // While the delete confirm is up, the panel's Esc/backdrop close cancels the
  // confirm instead of closing the panel (Dialog's Esc listener wins the
  // capture race, so the confirm routes through the panel's close request).
  useEffect(() => {
    registerCloseGuard(() => {
      if (pendingDelete === null) return false;
      setPendingDelete(null);
      return true;
    });
  }, [pendingDelete, registerCloseGuard]);

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
      queryClient.setQueryData<readonly CronTask[]>(CRON_TASKS_QUERY_KEY, (old) =>
        old?.map((entry) => (entry.id === result.task.id && entry.workspace_id === result.task.workspace_id
          ? result.task
          : entry)),
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
      queryClient.setQueryData<readonly CronTask[]>(CRON_TASKS_QUERY_KEY, (old) =>
        old?.filter((entry) => !(entry.id === task.id && entry.workspace_id === task.workspace_id)),
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
      onCloseRequest();
    },
    [onNavigate, onCloseRequest],
  );

  const tasks = tasksQuery.data ?? [];

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-panel px-5 py-3.5">
        <h2 className="font-display text-[19px] font-semibold leading-none text-ink">
          {t('cron.panel.title')}
        </h2>
        {tasksQuery.data !== undefined ? (
          <span className="font-mono text-[11px] text-ink-faint">{tp('cron.panel.count', tasks.length)}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-cron-refresh
            disabled={tasksQuery.isFetching}
            onClick={() => { void tasksQuery.refetch(); }}
            className="rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('cron.panel.refresh')}
          </button>
          <button
            type="button"
            onClick={onCloseRequest}
            className="rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent"
          >
            {t('common.close')}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5" data-cron-panel-body>
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
          <ul className="space-y-3" data-cron-list>
            {tasks.map((task) => (
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
            ))}
          </ul>
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
    </>
  );
}

export function GlobalCronPanel({ sessions, workspaceOptions, onNavigate }: GlobalCronPanelProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [railTarget, setRailTarget] = useState<HTMLElement | null>(null);
  // Set by the panel body: returns true when it consumed the close request
  // (cancelling the delete confirm instead of closing the panel).
  const closeGuardRef = useRef<() => boolean>(() => false);

  // Same rail mount discovery as the task board launcher.
  useEffect(() => {
    const update = () => {
      setRailTarget(document.querySelector<HTMLElement>('[data-session-rail]'));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, []);

  const close = useCallback(() => {
    if (closeGuardRef.current()) return;
    setOpen(false);
  }, []);

  const registerCloseGuard = useCallback((guard: () => boolean) => {
    closeGuardRef.current = guard;
  }, []);

  const launcher = (
    <button
      type="button"
      data-session-cron-panel
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t('cron.panel.title')}
      onClick={() => { setOpen(true); }}
      className="app-rail__cron-launcher flex min-h-12 shrink-0 items-center justify-between gap-2 border-t border-hairline bg-panel px-4 py-2 text-left text-[12px] font-medium text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent"
    >
      <span>{t('cron.panel.title')}</span>
      <span aria-hidden className="text-[16px] leading-none">↗</span>
    </button>
  );

  return (
    <>
      {railTarget ? createPortal(launcher, railTarget) : null}
      {open ? (
        <Dialog
          onClose={close}
          ariaLabel={t('cron.panel.title')}
          overlayId="global-cron-panel"
          panelClassName={`anim-enter flex h-[min(85vh,720px)] w-full ${DIALOG_PANEL_SIZES.xl} flex-col overflow-hidden rounded-2xl border border-hairline bg-paper p-0 shadow-[0_16px_48px_-16px_rgba(28,25,23,0.35)]`}
        >
          <CronPanelBody
            sessions={sessions}
            workspaceOptions={workspaceOptions}
            onNavigate={onNavigate}
            onCloseRequest={close}
            registerCloseGuard={registerCloseGuard}
          />
        </Dialog>
      ) : null}
    </>
  );
}
