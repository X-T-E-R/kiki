/**
 * Execution pause/resume controls for the Live tab.
 *
 * Discoverability lives with the live inventory: the agents section heading
 * carries one "Pause all" action (the inventory is the full per-agent list,
 * not the visible page), and one row per session carries that session's own
 * pause/resume action. Paused sessions get an explicit resume below — the
 * overview that answers "what is safe to restart" after a normal restart.
 * Every control reads the single shared execution batch the panel runs; the
 * `execution.changed` event carries freshness and a slow poll is only the
 * reconnect fallback. Only a durably `paused` phase claims safety; `pausing`
 * reports settling work; `failed` keeps the server error and re-reads the
 * real state on the user's recovery click rather than resuming implicitly.
 */

import { useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  isExecutionActionError,
  liveInventorySessionIds,
  useExecutionPause,
  useExecutionResume,
  useExecutionResumeOne,
  type ExecutionControlState,
} from '../../lib/executionControls';
import type { LiveAgentSnapshot } from '../../lib/liveAgentGovernance';
import { pushToast } from '../../lib/toasts';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine } from '../controls';
import { Icon } from '../icons';

const ROW_BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-hairline px-2 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50';

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
  kind: 'pause' | 'resume',
  t: (key: I18nKey, params?: Record<string, string | number>) => string,
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
      : t('usage.execution.resumePartial', { resumed: done, total: error.total });
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
 * One session's pause/resume action + phase, bound to its own session id.
 * `state` comes from the batch read the panel already runs, so the row does
 * not open a second poller per session. Resume is strictly this session.
 */
export function SessionExecutionControl({ sessionId, state }: { readonly sessionId: string; readonly state: ExecutionControlState | undefined }) {
  const { t } = useI18n();
  const pause = useExecutionPause([sessionId]);
  const resume = useExecutionResumeOne(sessionId, state);
  const [confirming, setConfirming] = useState(false);

  if (state === undefined) return null;
  const phase = state.phase;
  const busy = pause.pending || resume.pending || phase === 'pausing' || phase === 'resuming';

  return (
    <span className="inline-flex shrink-0 flex-wrap items-center gap-2" data-execution-control={sessionId}>
      <PhaseChip state={state} />
      {phase === 'running' ? (
        <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => { setConfirming(true); }}>
          <Icon name="hold" size={12} />
          {t('usage.execution.pauseSession')}
        </button>
      ) : null}
      {phase === 'paused' ? (
        <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => { resume.reset(); resume.run(); }}>
          <Icon name="refresh" size={12} />
          {t('usage.execution.resumeSession')}
        </button>
      ) : null}
      {phase === 'failed' ? (
        <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => { resume.reset(); resume.run(); }}>
          {t('usage.execution.retryResume')}
        </button>
      ) : null}
      {phase === 'failed' && state.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: state.error }} />
      ) : null}
      {pause.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(pause.error, 'pause', t) }} />
      ) : null}
      {resume.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(resume.error, 'resume', t) }} />
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
    </span>
  );
}

/**
 * "Pause all" on the agents heading — one action over the full live inventory.
 * It reads the same shared batch (`states`) the panel runs; it does not open
 * a second batch of reads or observations.
 */
export function PauseAllExecutions({ snapshot, states }: {
  readonly snapshot: LiveAgentSnapshot;
  readonly states: Readonly<Record<string, ExecutionControlState | undefined>>;
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
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(pause.error, 'pause', t) }} />
      ) : null}
    </span>
  );
}

/**
 * Paused sessions with an explicit resume — the restart-safety overview. Each
 * row binds its own session id and resumes exactly that session: never every
 * paused session the overview knows about. Durably paused sessions are safe
 * to restart; failed ones keep the server error and re-read the real state on
 * the user's recovery click (the contract resumes only a durably `paused`
 * phase, so a failed row never resumes implicitly).
 */
export function PausedExecutionsPanel({ states }: { readonly states: Readonly<Record<string, ExecutionControlState | undefined>> }) {
  const { t } = useI18n();
  const entries = Object.entries(states)
    .filter((entry): entry is [string, ExecutionControlState] => entry[1] !== undefined && (entry[1].phase === 'paused' || entry[1].phase === 'failed'))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <div data-execution-paused-panel className="space-y-1.5" aria-label={t('usage.execution.phase.paused')}>
      {entries.map(([sessionId, state]) => (
        <PausedExecutionRow key={sessionId} sessionId={sessionId} state={state} />
      ))}
    </div>
  );
}

function PausedExecutionRow({ sessionId, state }: {
  readonly sessionId: string;
  readonly state: ExecutionControlState;
}) {
  const { t } = useI18n();
  // Strictly this session's resume: a click never touches another session.
  const resume = useExecutionResumeOne(sessionId, state);
  const settling = settlingCount(state);
  const isFailed = state.phase === 'failed';
  return (
    <div data-execution-paused={sessionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-ink/[0.03] px-3 py-2">
      <PhaseChip state={state} />
      <span className="min-w-0 truncate font-mono text-[12px] text-ink-soft" title={sessionId}>{sessionId}</span>
      {isFailed ? (
        <FeedbackLine feedback={{ tone: 'error', text: state.error ?? t('usage.execution.readFailed') }} />
      ) : (
        <span className="text-[12px] text-ink-faint">{t('usage.execution.pausedHint')}</span>
      )}
      {settling > 0 ? (
        <span className="text-[12px] text-ink-faint">{t('usage.execution.agentsSettling', { count: settling })}</span>
      ) : null}
      <button
        type="button"
        className={`ml-auto ${ROW_BUTTON}`}
        disabled={resume.pending}
        onClick={() => {
          if (isFailed) {
            // The contract resumes only a durably paused phase. A failed row's
            // recovery re-reads the real state so the next allowed action is
            // truthful; it never resumes implicitly.
            pushToast({ tone: 'error', text: state.error ?? t('usage.execution.readFailed') });
          }
          resume.reset();
          resume.run();
        }}
      >
        {isFailed ? t('usage.execution.retryResume') : t('usage.execution.resumeSession')}
      </button>
      {resume.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(resume.error, 'resume', t) }} />
      ) : null}
    </div>
  );
}
