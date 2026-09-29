/**
 * Prompts that did not complete, told the quiet way.
 *
 * A failed or aborted prompt is a fact about ONE message, so it sits under
 * that message's bubble as a faint status line (with a way to send it again
 * and, when the turn left one, the reason) instead of a red divider across
 * the timeline. Failure is neutral here: nothing waits on the reader, and a
 * provider hiccup days ago is not an error they have to handle now.
 *
 * Prompts whose messages are still in unloaded history pages cannot hang on a
 * bubble. They collapse into one neutral row at the top of the window that
 * counts them and opens to a short list; each entry jumps to its message
 * through the timeline locator, which pages the history in.
 */

import { createContext, useContext, useId, useState } from 'react';

import type { NoticeBlock, PromptOutcome } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { DisclosureChevron } from '../icons';
import { RelativeTime } from '../RelativeTime';

const LINK = 'min-h-6 rounded-sm px-1 font-medium text-ink-soft underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:no-underline disabled:opacity-60';

function outcomeLabelKey(outcome: PromptOutcome) {
  if (outcome.status === 'aborted') return 'transcript.promptOutcome.aborted' as const;
  return outcome.delivered ? 'transcript.promptOutcome.replyFailed' as const : 'transcript.promptOutcome.failed' as const;
}

/**
 * What the timeline can do with a settled prompt. Provided once by the
 * Transcript instead of threaded through every row's memo comparator; absent
 * (read-only and subagent timelines) the lines render without actions.
 */
export interface PromptOutcomeActions {
  /** Put the message back in the composer. */
  readonly onRetry?: (text: string) => void;
  /** Scroll to the message through the timeline locator. */
  readonly onLocate?: (userMessageId: string) => void;
  readonly disabled?: boolean;
}

export const PromptOutcomeActionsContext = createContext<PromptOutcomeActions>({});

export function usePromptOutcomeActions(): PromptOutcomeActions {
  return useContext(PromptOutcomeActionsContext);
}

/** The status line under a user bubble whose prompt failed or was aborted. */
export function PromptOutcomeLine({
  outcome,
  onRetry,
  retryDisabled = false,
}: {
  outcome: PromptOutcome;
  /** Present when the message can be sent again from here. */
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const failed = outcome.status === 'failed';
  return (
    <div data-prompt-outcome={outcome.status} className="mt-1 mr-1 flex max-w-[80%] flex-col items-end">
      <span className="flex flex-wrap items-center justify-end gap-x-1 text-[12px] text-ink-faint">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-[1px] bg-ink-faint/70" />
        <span className="text-ink-soft">{t(outcomeLabelKey(outcome))}</span>
        {outcome.at !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <RelativeTime at={outcome.at} />
          </>
        ) : null}
        {failed ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => { setOpen((value) => !value); }}
              className={`${LINK} inline-flex items-center gap-0.5`}
            >
              {t('transcript.promptOutcome.details')}
              <DisclosureChevron open={open} />
            </button>
          </>
        ) : null}
        {onRetry !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              data-prompt-outcome-retry
              onClick={onRetry}
              disabled={retryDisabled}
              title={t('transcript.promptOutcome.retryTitle')}
              className={LINK}
            >
              {t('transcript.promptOutcome.retry')}
            </button>
          </>
        ) : null}
      </span>
      {failed && open ? (
        <p
          id={detailsId}
          data-prompt-outcome-details
          className="mt-1 max-w-full rounded-md bg-ink/[0.04] px-2.5 py-1 text-right font-mono text-[12px] break-words whitespace-pre-wrap text-ink-soft"
        >
          {outcome.error ?? t('transcript.promptOutcome.noDetails')}
        </p>
      ) : null}
    </div>
  );
}

/** `notice-prompt-outcomes-earlier`: prompts settled in history pages not loaded yet. */
export function EarlierPromptOutcomesRow({ block }: { block: NoticeBlock }) {
  const { t } = useI18n();
  const { onLocate } = usePromptOutcomeActions();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const outcomes = block.earlierPromptOutcomes ?? [];
  if (outcomes.length === 0) return null;
  const label = block.i18n !== undefined ? t(block.i18n.key, block.i18n.params) : block.text;
  return (
    <div data-prompt-failed-run className="anim-enter">
      <div className="flex items-center gap-3 py-1">
        <span className="h-px flex-1 bg-hairline" />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => { setOpen((value) => !value); }}
          className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-sm px-1 text-[12px] text-ink-faint transition-colors duration-150 hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-accent"
        >
          {label}
          <DisclosureChevron open={open} />
        </button>
        <span className="h-px flex-1 bg-hairline" />
      </div>
      {open ? (
        <ul id={listId} className="mx-auto mt-0.5 mb-1 flex w-full max-w-[34rem] flex-col gap-0.5">
          {outcomes.map((outcome) => (
            <li key={outcome.promptId} data-prompt-failed-entry={outcome.status} className="flex min-h-6 items-baseline gap-2 text-[12px]">
              <span className="w-12 shrink-0 text-ink-faint">
                {t(outcome.status === 'aborted' ? 'transcript.promptOutcome.aborted' : 'transcript.promptOutcome.failed')}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-soft" title={outcome.text}>{outcome.text ?? '—'}</span>
              {outcome.at !== undefined ? (
                <span className="shrink-0 tabular-nums text-ink-faint"><RelativeTime at={outcome.at} /></span>
              ) : null}
              {onLocate !== undefined && outcome.userMessageId !== undefined ? (
                <button type="button" onClick={() => { onLocate(outcome.userMessageId!); }} className={`${LINK} shrink-0 text-[12px]`}>
                  {t('transcript.promptOutcome.locate')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
