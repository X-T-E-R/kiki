import { useId, useState } from 'react';

import type { AgentTurnOutcome } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { DisclosureChevron } from '../icons';
import { CopyButton } from './ContentCopyButton';

const LINK = 'inline-flex min-h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 font-medium text-ink-soft underline-offset-2 transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink';

export function AgentTurnOutcomeLine({ outcome }: { outcome: AgentTurnOutcome | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  if (outcome === undefined) return null;
  const retry = outcome.lastRetry;
  const detail = outcome.error ?? (retry === undefined ? undefined : t('transcript.lastRetryFailed', {
    cause: retry.errorName,
    error: retry.errorMessage,
    attempt: String(retry.failedAttempt),
    max: String(retry.maxAttempts),
  }));
  const label = t(outcome.state === 'failed' ? 'subagent.lastTurnFailed' : 'subagent.lastTurnCancelled');
  const text = `${label}${detail === undefined ? '' : ` · ${detail}`}`;
  const detailsText = outcome.errorDetails ?? outcome.error;
  const canExpand = outcome.state === 'failed' && detailsText !== undefined;
  const title = outcome.errorDetails !== undefined ? `${label}\n${outcome.errorDetails}` : text;
  return (
    <div data-agent-turn-outcome={outcome.state} title={title} className="mt-0.5 min-w-0 text-[12px] text-amber-ink">
      <span className="flex min-w-0 flex-wrap items-center gap-x-1">
        <span className="min-w-0 truncate">{text}</span>
        {canExpand ? (
          <>
            <span aria-hidden className="text-ink-faint">·</span>
            <button
              type="button"
              data-agent-turn-outcome-toggle
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => { setOpen((value) => !value); }}
              className={LINK}
            >
              {t('transcript.promptOutcome.details')}
              <DisclosureChevron open={open} />
            </button>
          </>
        ) : null}
      </span>
      {canExpand && open ? (
        <div className="mt-1 flex max-w-full items-start gap-1 rounded-md bg-ink/[0.04] px-3 py-1 text-ink-soft">
          <p
            id={detailsId}
            data-agent-turn-outcome-details
            className={`min-w-0 flex-1 ${detailsText.includes('\n') ? 'text-left' : 'text-right'} font-mono text-[12px] break-words whitespace-pre-wrap`}
          >
            {detailsText}
          </p>
          <CopyButton text={detailsText} label={t('transcript.promptOutcome.details')} />
        </div>
      ) : null}
    </div>
  );
}
