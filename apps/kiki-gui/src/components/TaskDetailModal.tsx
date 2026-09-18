/**
 * TaskDetailModal — terminal-style drill-in for one background task.
 *
 * Opened from the right rail's task list. Shows the task's identity row
 * (status, kind, elapsed), the command when present, and a live output pane:
 * the tail refreshes by polling `GET tasks/{id}?with_output=true` (the wire
 * has no output stream — polling is the supported read), auto-follows the
 * bottom like a terminal, and pauses follow when the user scrolls up or hits
 * the pause toggle. Once the task settles, the footer carries the exit code
 * / stop reason the wire exposes.
 */

import { useEffect, useRef, useState } from 'react';

import type { Task } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { startVisiblePoll } from '../lib/visiblePoll';
import { useConnection } from '../state/connection';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from './Dialog';
import { useNow } from './RelativeTime';
import { SECONDARY_BUTTON } from './ui';

const POLL_INTERVAL_MS = 1500;
/** Pixels from the bottom that still count as "following" the output tail. */
const FOLLOW_SLOP_PX = 24;

function detailStatusTone(status: Task['status']): string {
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

function taskMs(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === '') return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function TaskDetailModal({
  sessionId,
  ownerAgentId,
  task,
  onClose,
  onCancelTask,
}: {
  sessionId: string;
  ownerAgentId?: string;
  /** Seed snapshot from the rail row; the modal keeps polling its own copy. */
  task: Task;
  onClose: () => void;
  onCancelTask: (taskId: string, ownerAgentId?: string) => void;
}) {
  const { client } = useConnection();
  const { t, time } = useI18n();
  const [live, setLive] = useState<Task>(task);
  const [follow, setFollow] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);
  const now = useNow();

  const terminal = live.status !== 'running';
  useEffect(() => {
    let stale = false;
    const refresh = async () => {
      const fresh = await client.getTask(sessionId, task.id, {
        with_output: true,
        agent_id: ownerAgentId,
      });
      if (!stale) setLive(fresh);
    };
    // Immediate fetch, then one final refetch when the task goes terminal (the
    // status flip re-runs this effect); continuous polling only while running.
    refresh().catch(() => undefined);
    if (terminal) return () => { stale = true; };
    const stop = startVisiblePoll({
      intervalMs: POLL_INTERVAL_MS,
      task: refresh,
      onError: () => undefined,
    });
    return () => {
      stale = true;
      stop();
    };
  }, [client, ownerAgentId, sessionId, task.id, terminal]);

  const output = live.output_preview ?? '';
  useEffect(() => {
    if (!follow) return;
    const pane = outputRef.current;
    if (pane !== null) pane.scrollTop = pane.scrollHeight;
  }, [output, follow]);

  const handleOutputScroll = () => {
    const pane = outputRef.current;
    if (pane === null) return;
    const atBottom =
      pane.scrollHeight - pane.scrollTop - pane.clientHeight <= FOLLOW_SLOP_PX;
    setFollow(atBottom);
  };

  const startedMs = taskMs(live.started_at ?? live.created_at);
  const finishedMs = taskMs(live.completed_at);
  const elapsedMs =
    startedMs === undefined
      ? undefined
      : Math.max(0, (terminal && finishedMs !== undefined ? finishedMs : now) - startedMs);

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('tasks.detail.title')}
      overlayId={`task-detail-${task.id}`}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.xl} flex max-h-[85vh] flex-col`}
    >
      <div className="flex items-center gap-2">
        <span
          data-task-detail-status={live.status}
          className={`shrink-0 rounded-full px-2 py-px text-[10.5px] font-medium ${detailStatusTone(live.status)}`}
        >
          {live.status === 'running' ? (
            <span aria-hidden className="status-dot-busy mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          ) : null}
          {t(`rail.taskStatus.${live.status}`)}
        </span>
        <span className="shrink-0 rounded-md border border-hairline px-1.5 py-px text-[10px] text-ink-faint">
          {t(`tasks.kind.${live.kind}`)}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink" title={live.description}>
          {live.description}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[12px] text-ink-faint transition-colors hover:bg-paper hover:text-ink"
        >
          ×
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-ink-faint">
        <span className="font-mono" title={live.id}>{live.id}</span>
        <span>
          {t('tasks.field.started')}: {time.relativeTime(live.started_at ?? live.created_at)}
        </span>
        <span data-task-detail-elapsed>
          {t('tasks.field.duration')}: {elapsedMs === undefined ? '—' : time.formatDuration(elapsedMs)}
        </span>
        {terminal && live.exit_code !== undefined ? (
          <span data-task-detail-exit-code>
            {t('tasks.detail.exitCode')}: {live.exit_code === null ? '—' : live.exit_code}
          </span>
        ) : null}
        {terminal && live.stop_reason !== undefined && live.stop_reason !== '' ? (
          <span data-task-detail-stop-reason className="min-w-0 truncate" title={live.stop_reason}>
            {t('tasks.detail.stopReason')}: {live.stop_reason}
          </span>
        ) : null}
      </div>

      {live.command !== undefined ? (
        <pre className="mt-3 shrink-0 overflow-x-auto rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-ink">
          {live.command}
        </pre>
      ) : null}

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-shell">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-1.5">
          <span className="font-mono text-[10.5px] tracking-wide text-shell-ink-soft select-none">
            {t('tasks.field.output')}
          </span>
          <button
            type="button"
            aria-pressed={!follow}
            data-task-detail-follow={follow ? 'on' : 'off'}
            onClick={() => { setFollow((value) => !value); }}
            className="ml-auto rounded-md border border-white/15 px-2 py-0.5 font-mono text-[10.5px] text-shell-ink transition-colors hover:border-accent hover:text-accent"
          >
            {follow ? t('tasks.detail.pauseScroll') : t('tasks.detail.resumeScroll')}
          </button>
        </div>
        <pre
          ref={outputRef}
          onScroll={handleOutputScroll}
          data-task-detail-output
          className="min-h-[160px] flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-shell-ink"
        >
          {output === '' ? (
            <span className="text-shell-ink-soft">{t('tasks.noOutput')}</span>
          ) : (
            output
          )}
        </pre>
      </div>

      <div className="mt-4 flex shrink-0 items-center justify-end gap-2.5">
        {live.status === 'running' ? (
          <button
            type="button"
            onClick={() => { onCancelTask(live.id, ownerAgentId); }}
            className="rounded-md border border-danger/40 bg-panel px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger/5"
          >
            {t('rail.stop')}
          </button>
        ) : null}
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t('common.close')}
        </button>
      </div>
    </Dialog>
  );
}
