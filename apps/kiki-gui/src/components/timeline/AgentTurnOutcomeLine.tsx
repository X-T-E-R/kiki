import type { AgentTurnOutcome } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';

export function AgentTurnOutcomeLine({ outcome }: { outcome: AgentTurnOutcome | undefined }) {
  const { t } = useI18n();
  if (outcome === undefined) return null;
  const retry = outcome.lastRetry;
  const detail = outcome.error ?? (retry === undefined ? undefined : t('transcript.lastRetryFailed', {
    cause: retry.errorName,
    error: retry.errorMessage,
    attempt: String(retry.failedAttempt),
    max: String(retry.maxAttempts),
  }));
  const text = `${t(outcome.state === 'failed' ? 'subagent.lastTurnFailed' : 'subagent.lastTurnCancelled')}${detail === undefined ? '' : ` · ${detail}`}`;
  return <span data-agent-turn-outcome={outcome.state} title={text} className="mt-0.5 block truncate text-[12px] text-amber-ink">{text}</span>;
}
