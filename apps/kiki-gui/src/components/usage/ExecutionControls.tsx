/**
 * Execution pause/resume controls for the Live tab.
 *
 * Discoverability lives with the live inventory: the agents section heading
 * carries one "Pause all" action (the inventory is the full per-agent list,
 * not the visible page), and one session list below the breakdown carries
 * each session's own pause/resume action. Sessions read by name — the cached
 * title, or a localized fallback with a short id — while every action still
 * targets the real session id. Several sessions fold behind one disclosure;
 * the folded list keeps every row that needs the user (pausing, paused,
 * failed, or an action in flight or failed) in view, so a paused session keeps
 * its explicit resume after a restart.
 * Every control reads the same execution batch. The `execution.changed`
 * event carries freshness and a slow poll covers reconnects. `pausing` offers
 * cancellation; `failed` shows the server error and lets the user read again.
 */

import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { shortThreadId } from '@kiki/session-core/composer';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  isExecutionActionError,
  liveInventorySessionIds,
  useExecutionCancelPauseOne,
  useExecutionPause,
  useExecutionResumeOne,
  type ExecutionControlState,
} from '../../lib/executionControls';
import type { LiveAgentSnapshot } from '../../lib/liveAgentGovernance';
import type { SessionNameEntry } from '../../lib/threadTitles';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine } from '../controls';
import { DisclosureChevron, Icon } from '../icons';

const ROW_BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-hairline px-2 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50';

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

/** How a session reads in the Live tab: never the bare id as the name. */
export interface SessionLabel {
  /** The title, or the localized untitled / unknown fallback. */
  readonly text: string;
  readonly shortId: string;
  /** False for a fallback, which needs its short id to stay distinguishable. */
  readonly titled: boolean;
}

export function sessionLabelOf(sessionId: string, entry: SessionNameEntry, t: Translate): SessionLabel {
  const shortId = shortThreadId(sessionId);
  if (entry.title !== undefined) return { text: entry.title, shortId, titled: true };
  return { text: t(entry.known ? 'sidebar.untitled' : 'usage.governance.session'), shortId, titled: false };
}

/** The one-line form for table cells and messages. */
export function sessionLabelText(label: SessionLabel): string {
  return label.titled ? label.text : `${label.text} ${label.shortId}`;
}

function detailOf(error: unknown): string {
  if (error instanceof Error && error.message === 'execution-unavailable') return '';
  return error instanceof Error ? error.message : String(error);
}

/**
 * One action's failure in the reader's terms: which session, what the server
 * said, and — for a batch — how far it got. Pause and resume keep their own
 * verbs; a single-session failure reports that session's own error.
 */
function executionFailureText(
  error: unknown,
  kind: 'pause' | 'resume' | 'cancelPause',
  t: Translate,
  tScoped?: { sessionTitle?: (id: string) => string | undefined },
): string {
  if (error instanceof Error && error.message === 'execution-unavailable') {
    return t('usage.execution.unavailable');
  }
  if (isExecutionActionError(error)) {
    const first = error.failures[0];
    if (first !== undefined && first.error instanceof Error && first.error.message === 'execution-unavailable') {
      return t('usage.execution.unavailable');
    }
    const firstDetail = first === undefined ? '' : detailOf(first.error);
    if (error.total === 1) {
      return firstDetail;
    }
    const done = error.succeeded.length;
    const verb = kind === 'pause'
      ? t('usage.execution.pausePartial', { paused: done, total: error.total })
      : kind === 'resume'
        ? t('usage.execution.resumePartial', { resumed: done, total: error.total })
        : t('usage.execution.cancelPausePartial', { canceled: done, total: error.total });
    const named = first === undefined ? '' : (tScoped?.sessionTitle?.(first.sessionId) ?? first.sessionId);
    return `${verb} — ${named}: ${firstDetail}`;
  }
  return detailOf(error);
}

function settlingCount(state: ExecutionControlState): number {
  return state.agents.filter((agent) => agent.state === 'settling').length;
}

function PhaseChip({ state }: { readonly state: ExecutionControlState }) {
  const { t } = useI18n();
  if (state.phase === 'running') return null;
  const label = t(`usage.execution.phase.${state.phase}` as I18nKey);
  const tone = state.phase === 'paused'
    ? 'border-selected-ink/35 text-selected-ink'
    : state.phase === 'failed'
      ? 'border-danger/40 text-danger'
      : 'border-hairline text-ink-faint';
  return (
    <span data-execution-phase={state.phase} className={`shrink-0 rounded-full border px-1.5 text-[10.5px] leading-4 ${tone}`}>
      {label}
    </span>
  );
}

/**
 * "Pause all" on the agents heading — one action over the full live inventory.
 * It reads the same shared batch (`states`) the panel runs; it does not open
 * a second batch of reads or observations. A folded session list never
 * narrows it.
 */
export function PauseAllExecutions({ snapshot, states, labelOf }: {
  readonly snapshot: LiveAgentSnapshot;
  readonly states: Readonly<Record<string, ExecutionControlState | undefined>>;
  readonly labelOf: (sessionId: string) => SessionLabel;
}) {
  const { t } = useI18n();
  const sessionIds = liveInventorySessionIds(snapshot.agents);
  const anyAvailable = sessionIds.some((sessionId) => states[sessionId] !== undefined);
  const pause = useExecutionPause(sessionIds);
  const [confirming, setConfirming] = useState(false);
  if (sessionIds.length === 0 || !anyAvailable) return null;
  return (
    <span className="inline-flex items-center gap-2" data-execution-pause-all>
      <button type="button" className={ROW_BUTTON} disabled={pause.pending} onClick={() => { setConfirming(true); }}>
        <Icon name="hold" size={12} />
        {t('usage.execution.pauseAll')}
      </button>
      <ConfirmDialog
        open={confirming}
        title={t('usage.execution.pauseAllConfirmTitle')}
        body={t('usage.execution.pauseAllConfirmBody')}
        confirmLabel={t('usage.execution.pauseConfirmAction')}
        tone="default"
        busy={pause.pending}
        onCancel={() => { setConfirming(false); }}
        onConfirm={() => { setConfirming(false); pause.reset(); pause.run(); }}
      />
      {pause.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(pause.error, 'pause', t, { sessionTitle: (id) => sessionLabelText(labelOf(id)) }) }} />
      ) : null}
    </span>
  );
}

/**
 * The Live tab's sessions: every live-inventory session with an execution
 * state, then every other session the batch reports held or failed (a session
 * paused before a restart has left the inventory but still needs its resume).
 * One session shows directly; several fold behind a disclosure that starts
 * closed, and the folded list still shows each row that needs the user. With
 * no running row left to fold, the disclosure becomes a plain heading, and a
 * phase hint every row shares reads once under it.
 */
export function ExecutionSessionList({ liveSessionIds, states, onRetryRead, labelOf }: {
  readonly liveSessionIds: readonly string[];
  readonly states: Readonly<Record<string, ExecutionControlState | undefined>>;
  readonly onRetryRead: () => void;
  readonly labelOf: (sessionId: string) => SessionLabel;
}) {
  const { t } = useI18n();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const live = new Set(liveSessionIds);
  const held = Object.entries(states)
    .filter((entry): entry is [string, ExecutionControlState] => entry[1] !== undefined && entry[1].phase !== 'running' && !live.has(entry[0]))
    .map(([sessionId]) => sessionId)
    .sort((a, b) => a.localeCompare(b));
  const rows = [...liveSessionIds.filter((sessionId) => states[sessionId] !== undefined), ...held];
  if (rows.length === 0) return null;
  const phases = rows.map((sessionId) => states[sessionId]!.phase);
  // Only running rows ever fold away; with none left the disclosure would be a no-op.
  const foldable = rows.length > 1 && phases.includes('running');
  const collapsed = foldable && !expanded;
  const heading = t('usage.execution.sessionsCount', { count: rows.length });
  // When every row is held the same way, the phase hint reads once for the list.
  const sharedPhase = rows.length > 1 && (phases.every((phase) => phase === 'paused') || phases.every((phase) => phase === 'pausing'))
    ? phases[0] as 'paused' | 'pausing'
    : undefined;
  return (
    <div data-execution-sessions data-collapsed={collapsed || undefined} className="mt-3 border-t border-hairline pt-2">
      {foldable ? (
        <button
          type="button"
          data-execution-sessions-toggle
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => { setExpanded((open) => !open); }}
          className="-ml-1 inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-[11.5px] font-medium text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
        >
          <DisclosureChevron open={expanded} className="text-current" />
          {heading}
        </button>
      ) : (
        <h3 className="flex h-7 items-center text-[11.5px] font-medium text-ink-faint">{heading}</h3>
      )}
      {sharedPhase !== undefined ? (
        <p data-execution-shared-hint={sharedPhase} className="pb-1 text-[11.5px] leading-4 text-ink-faint">
          {t(sharedPhase === 'paused' ? 'usage.execution.pausedHint' : 'usage.execution.pausingHint')}
        </p>
      ) : null}
      <ol id={listId} aria-label={heading}>
        {rows.map((sessionId) => (
          <ExecutionSessionRow
            key={sessionId}
            sessionId={sessionId}
            state={states[sessionId]!}
            label={labelOf(sessionId)}
            collapsed={collapsed}
            phaseHintShared={sharedPhase !== undefined}
            onRetryRead={onRetryRead}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * One session: its name (opens the session), phase and its own action, bound
 * to its own session id. `state` comes from the batch read the panel already
 * runs, so the row does not open a second poller per session. Resume is
 * strictly this session. A folded row stays mounted, so an action in flight
 * keeps its state and surfaces its result.
 */
function ExecutionSessionRow({ sessionId, state, label, collapsed, phaseHintShared, onRetryRead }: {
  readonly sessionId: string;
  readonly state: ExecutionControlState;
  readonly label: SessionLabel;
  readonly collapsed: boolean;
  /** The list already states this row's phase hint once for every row. */
  readonly phaseHintShared: boolean;
  readonly onRetryRead: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const pause = useExecutionPause([sessionId]);
  const cancelPause = useExecutionCancelPauseOne(sessionId, state);
  const resume = useExecutionResumeOne(sessionId, state);
  const [confirming, setConfirming] = useState(false);
  const phase = state.phase;
  const busy = pause.pending || cancelPause.pending || resume.pending || phase === 'pausing' || phase === 'resuming';
  const needsUser = phase !== 'running' || confirming || pause.pending || cancelPause.pending || resume.pending
    || pause.error !== undefined || cancelPause.error !== undefined || resume.error !== undefined;
  const settling = settlingCount(state);
  const name = sessionLabelText(label);
  const note = phaseHintShared
    ? undefined
    : phase === 'paused'
      ? t('usage.execution.pausedHint')
      : phase === 'pausing'
        ? t('usage.execution.pausingHint')
        : undefined;
  const settlingNote = settling > 0 ? t('usage.execution.agentsSettling', { count: settling }) : undefined;
  const noteText = [note, settlingNote].filter((part) => part !== undefined).join(' · ');

  return (
    <li
      data-execution-session={sessionId}
      data-execution-paused={phase === 'paused' || phase === 'failed' ? sessionId : undefined}
      hidden={collapsed && !needsUser}
      className="py-1"
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-execution-session-open
          title={`${name}\n${sessionId}`}
          onClick={() => void navigate(`/s/${sessionId}`)}
          className="group flex min-h-7 min-w-0 flex-1 items-baseline gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
        >
          <span className={`min-w-0 truncate text-[13px] underline-offset-2 group-hover:underline sm:max-w-[40rem] ${label.titled ? 'text-ink' : 'text-ink-soft'}`}>{label.text}</span>
          <span className={`shrink-0 font-mono text-[11px] text-ink-faint tabular-nums ${label.titled ? 'hidden sm:inline' : ''}`}>{label.shortId}</span>
        </button>
        <span className="flex shrink-0 items-center gap-2" data-execution-control={sessionId}>
          <PhaseChip state={state} />
          {phase === 'running' ? (
            <button type="button" data-execution-action="pause" className={ROW_BUTTON} disabled={busy} onClick={() => { setConfirming(true); }}>
              <Icon name="hold" size={12} />
              {t('usage.execution.pauseSession')}
            </button>
          ) : null}
          {phase === 'pausing' && state.pauseOperationId !== undefined ? (
            <button
              type="button"
              data-execution-action="cancel-pause"
              data-execution-pending={cancelPause.pending || undefined}
              className={ROW_BUTTON}
              disabled={cancelPause.pending || pause.pending || resume.pending}
              onClick={() => { cancelPause.run(); }}
            >
              <Icon name="close" size={12} />
              {t('usage.execution.cancelPause')}
            </button>
          ) : null}
          {phase === 'paused' ? (
            <button type="button" data-execution-action="resume" className={ROW_BUTTON} disabled={busy} onClick={() => { resume.reset(); resume.run(); }}>
              <Icon name="refresh" size={12} />
              {t('usage.execution.resumeSession')}
            </button>
          ) : null}
          {phase === 'failed' ? (
            // The contract resumes only a durably paused phase. A failed row's
            // recovery re-reads the real state from the server, so the next action
            // the row offers is truthful — never an implicit resume.
            <button type="button" data-execution-action="retry-read" className={ROW_BUTTON} disabled={busy} onClick={() => { onRetryRead(); }}>
              {t('usage.execution.retryRead')}
            </button>
          ) : null}
        </span>
      </div>
      {noteText !== '' ? (
        <p className="pb-0.5 text-[11.5px] leading-4 text-ink-faint">{noteText}</p>
      ) : null}
      {phase === 'failed' ? (
        <FeedbackLine feedback={{ tone: 'error', text: state.error ?? t('usage.execution.readFailed') }} />
      ) : null}
      {pause.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(pause.error, 'pause', t) }} />
      ) : null}
      {resume.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(resume.error, 'resume', t) }} />
      ) : null}
      {cancelPause.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(cancelPause.error, 'cancelPause', t) }} />
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t('usage.execution.pauseConfirmTitle')}
        body={t('usage.execution.pauseConfirmBody')}
        confirmLabel={t('usage.execution.pauseConfirmAction')}
        tone="default"
        busy={pause.pending}
        onCancel={() => { setConfirming(false); }}
        onConfirm={() => { setConfirming(false); pause.reset(); pause.run(); }}
      />
    </li>
  );
}
