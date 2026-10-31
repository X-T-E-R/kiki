/**
 * Execution pause/resume controls for the Live tab.
 *
 * Discoverability lives with the live inventory: the agents section heading
 * carries one "Pause all" action (the inventory is the full per-agent list,
 * not the visible page), and one row per session carries that session's own
 * pause/resume action. Paused sessions get an explicit resume below — the
 * overview that answers "what is safe to restart" after a normal restart.
 * Only a durably `paused` phase claims safety; `pausing` reports settling
 * work, `failed` keeps the server error with a retry, and nothing resumes
 * automatically.
 */

import { useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  liveInventorySessionIds,
  useExecutionPause,
  useExecutionResume,
  useSessionExecutions,
  type ExecutionControlState,
} from '../../lib/executionControls';
import type { LiveAgentSnapshot } from '../../lib/liveAgentGovernance';
import { pushToast } from '../../lib/toasts';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine } from '../controls';
import { Icon } from '../icons';

const ROW_BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-hairline px-2 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50';

function executionFailureText(
  error: unknown,
  t: (key: I18nKey, params?: Record<string, string | number>) => string,
): string {
  if (error instanceof Error && error.message === 'execution-unavailable') {
    return t('usage.execution.unavailable');
  }
  const shaped = error as { failures?: readonly unknown[]; succeeded?: readonly unknown[]; total?: number } | undefined;
  if (shaped?.failures !== undefined && shaped.failures.length > 0) {
    const first = shaped.failures[0];
    if (first instanceof Error && first.message === 'execution-unavailable') return t('usage.execution.unavailable');
    const resumed = shaped.succeeded?.length ?? 0;
    const total = shaped.total ?? shaped.failures.length;
    const detail = first instanceof Error ? first.message : String(first);
    return total > 1 ? `${t('usage.execution.resumePartial', { resumed, total })} — ${detail}` : detail;
  }
  return error instanceof Error ? error.message : String(error);
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
 * not open a second poller per session.
 */
export function SessionExecutionControl({ sessionId, state }: { readonly sessionId: string; readonly state: ExecutionControlState | undefined }) {
  const { t } = useI18n();
  const pause = useExecutionPause([sessionId]);
  const resume = useExecutionResume({ [sessionId]: state });
  const [confirming, setConfirming] = useState(false);

  if (state === undefined) return null;
  const phase = state.phase;
  const busy = pause.pending || resume.pending || phase === 'pausing' || phase === 'resuming';

  return (
    <span className="inline-flex shrink-0 items-center gap-2" data-execution-control={sessionId}>
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

/** "Pause all" on the agents heading — one action over the full live inventory. */
export function PauseAllExecutions({ snapshot }: { readonly snapshot: LiveAgentSnapshot }) {
  const { t } = useI18n();
  const sessionIds = liveInventorySessionIds(snapshot.agents);
  const { anyAvailable } = useSessionExecutions(sessionIds);
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
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(pause.error, t) }} />
      ) : null}
    </span>
  );
}

/**
 * Paused sessions with an explicit resume — the restart-safety overview. Each
 * row binds its own session id and real per-session state: durably paused
 * sessions are safe to restart; failed ones keep the server error and wait
 * for the user's retry. Sessions whose facade is unavailable stay absent.
 */
export function PausedExecutionsPanel({ states }: { readonly states: Readonly<Record<string, ExecutionControlState | undefined>> }) {
  const { t } = useI18n();
  const resume = useExecutionResume(states);
  const entries = Object.entries(states)
    .filter((entry): entry is [string, ExecutionControlState] => entry[1] !== undefined && (entry[1].phase === 'paused' || entry[1].phase === 'failed'))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <div data-execution-paused-panel className="space-y-1.5" aria-label={t('usage.execution.phase.paused')}>
      {entries.map(([sessionId, state]) => (
        <PausedExecutionRow key={sessionId} sessionId={sessionId} state={state} resumePending={resume.pending} onResume={() => { resume.reset(); resume.run(); }} />
      ))}
      {resume.error !== undefined ? (
        <FeedbackLine feedback={{ tone: 'error', text: executionFailureText(resume.error, t) }} />
      ) : null}
    </div>
  );
}

function PausedExecutionRow({ sessionId, state, resumePending, onResume }: {
  readonly sessionId: string;
  readonly state: ExecutionControlState;
  readonly resumePending: boolean;
  readonly onResume: () => void;
}) {
  const { t } = useI18n();
  const settling = settlingCount(state);
  return (
    <div data-execution-paused={sessionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-ink/[0.03] px-3 py-2">
      <PhaseChip state={state} />
      <span className="min-w-0 truncate font-mono text-[12px] text-ink-soft" title={sessionId}>{sessionId}</span>
      {state.phase === 'paused' ? (
        <span className="text-[12px] text-ink-faint">{t('usage.execution.pausedHint')}</span>
      ) : (
        <FeedbackLine feedback={{ tone: 'error', text: state.error ?? t('usage.execution.readFailed') }} />
      )}
      {settling > 0 ? (
        <span className="text-[12px] text-ink-faint">{t('usage.execution.agentsSettling', { count: settling })}</span>
      ) : null}
      <button
        type="button"
        className={`ml-auto ${ROW_BUTTON}`}
        disabled={resumePending}
        onClick={() => {
          if (state.phase === 'failed' && state.error !== undefined) {
            pushToast({ tone: 'error', text: state.error });
          }
          onResume();
        }}
      >
        {state.phase === 'failed' ? t('usage.execution.retryResume') : t('usage.execution.resumeSession')}
      </button>
    </div>
  );
}
