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
 *
 * Layout: a capped flex column where the identity row and the action footer
 * are fixed, and ONE scroll region between them holds the command and the
 * output. The command is a disclosure — a pasted script can run to thousands
 * of lines, and rendering it inline used to push the output pane out of the
 * panel entirely. Collapsed, it is clamped to a few lines with the full text
 * still in the DOM (so it selects and copies verbatim); expanded, the scroll
 * region reaches its last line. The output keeps its own tail-following
 * scroll, so a long command never hides the live output.
 */

import { useEffect, useRef, useState } from 'react';

import type { Task } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { DisclosureChevron, Icon } from './icons';
import { startVisiblePoll } from '../lib/visiblePoll';
import { copyTextToClipboard } from '../lib/clipboard';
import { useConnection } from '../state/connection';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from './Dialog';
import { useNow } from './RelativeTime';
import { SECONDARY_BUTTON } from './ui';

const POLL_INTERVAL_MS = 1500;
/** Pixels from the bottom that still count as "following" the output tail. */
const FOLLOW_SLOP_PX = 24;
/** Clamp height for a collapsed command: the head of a script, never the wall. */
const COMMAND_CLAMP_CLASS = 'max-h-[5.25rem]';

function detailStatusTone(status: Task['status']): string {
  switch (status) {
    case 'running':
      return 'bg-ink/[0.05] text-ink-soft';
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

/**
 * The task's command, verbatim, as a disclosure.
 *
 * A command arrives as one opaque string: a 15-line PowerShell paste, or a
 * single 4 KB base64 token with nowhere to wrap. The full text is always in the
 * DOM and always selectable, so a copy is exact in both states; only the
 * visible height is bounded. Overflow is measured rather than guessed by
 * length, so an ordinary `pnpm test` shows no affordance at all.
 */
function TaskCommand({ command }: { readonly command: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const element = preRef.current;
    if (element === null || expanded) return;
    const measure = () => { setOverflowing(element.scrollHeight > element.clientHeight + 1); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [command, expanded]);

  const copy = () => {
    void copyTextToClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1500);
    });
  };
  // The fade only belongs on a clamp that actually clips something.
  const clamped = !expanded && overflowing;

  return (
    <section className="mt-3" aria-label={t('tasks.field.command')}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12px] font-medium text-ink-soft">{t('tasks.field.command')}</span>
        {overflowing || expanded ? (
          <button
            type="button"
            data-task-detail-command-toggle
            aria-expanded={expanded}
            aria-controls="task-detail-command"
            onClick={() => { setExpanded((value) => !value); }}
            className="flex min-h-7 items-center gap-1 rounded-md px-1 text-[12px] text-ink-faint transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            {expanded ? t('transcript.showLess') : t('transcript.showMore')}
            <DisclosureChevron open={expanded} />
          </button>
        ) : null}
        <button
          type="button"
          data-task-detail-copy-command
          aria-label={t('tasks.detail.copyCommand')}
          onClick={copy}
          className="ml-auto flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <Icon name="notes" size={12} />
          <span>{copied ? t('st.engines.copied') : t('tasks.detail.copyCommand')}</span>
        </button>
      </div>
      {/* `relative` + the wrapper's own clip: the mask sits over the last row so
          a clamped command ends on a faded edge instead of a sliced glyph. */}
      <div className="relative">
        <pre
          ref={preRef}
          id="task-detail-command"
          data-task-detail-command
          // Collapsed, the clamp hides the overflow; expanded, the box takes the
          // command's natural height and the panel's scroll region carries it, so
          // the command never becomes a second scroll trap inside a scroll region.
          className={`rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-ink ${expanded ? '' : `${COMMAND_CLAMP_CLASS} overflow-hidden`}`}
        >
          {command}
        </pre>
        {clamped ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-lg bg-gradient-to-t from-paper to-paper/0"
          />
        ) : null}
      </div>
    </section>
  );
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
      // `overflow-hidden` on the panel plus one scrolling child: the identity
      // row and the actions stay pinned, the middle reaches everything else.
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.xl} flex max-h-[min(85dvh,60rem)] flex-col overflow-hidden`}
    >
      <div data-task-detail-header className="flex shrink-0 items-center gap-2">
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-ink-faint">
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

      {/* The only scroll region: command and output travel together, so a long
          command scrolls away instead of pushing the output out of the panel. */}
      <div data-task-detail-scroll className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {live.command !== undefined ? <TaskCommand command={live.command} /> : null}

        <div className="mt-3 flex flex-col overflow-hidden rounded-lg bg-shell">
          <div className="flex shrink-0 items-center gap-2 border-b border-shell-hairline px-3 py-1.5">
            <span className="font-mono text-[10.5px] tracking-wide text-shell-ink-soft select-none">
              {t('tasks.field.output')}
            </span>
            <button
              type="button"
              aria-pressed={!follow}
              data-task-detail-follow={follow ? 'on' : 'off'}
              onClick={() => { setFollow((value) => !value); }}
              className="ml-auto flex min-h-7 items-center rounded-md border border-shell-hairline px-2 py-0.5 font-mono text-[10.5px] text-shell-ink transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {follow ? t('tasks.detail.pauseScroll') : t('tasks.detail.resumeScroll')}
            </button>
          </div>
          {/* min-h-0 lets this flex child shrink below its content; the inner
              floor keeps a short run readable when the command eats the panel.
              It scrolls its own tail, which is what the follow toggle drives. */}
          <pre
            ref={outputRef}
            onScroll={handleOutputScroll}
            data-task-detail-output
            className="min-h-[7rem] max-h-[26rem] min-w-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-shell-ink"
          >
            {output === '' ? (
              <span className="text-shell-ink-soft">{t('tasks.noOutput')}</span>
            ) : (
              output
            )}
          </pre>
        </div>
      </div>

      <div data-task-detail-footer className="mt-4 flex shrink-0 items-center justify-end gap-2">
        {live.status === 'running' ? (
          <button
            type="button"
            onClick={() => { onCancelTask(live.id, ownerAgentId); }}
            className="flex min-h-8 items-center rounded-md border border-danger/40 bg-panel px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger/5 focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            {t('rail.stop')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className={`${SECONDARY_BUTTON} flex min-h-8 items-center focus-visible:outline-2 focus-visible:outline-selected-ink`}
        >
          {t('common.close')}
        </button>
      </div>
    </Dialog>
  );
}
