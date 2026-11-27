import { createContext, useContext, useId, useState } from 'react';

import type { NoticeBlock, PromptOutcome } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { lazyComponent } from '../../lib/lazyComponent';
import { DisclosureChevron } from '../icons';
import { RelativeTime } from '../RelativeTime';
import type { TimelineErrorAction } from './TimelineErrorCallout';

const TimelineErrorCallout = lazyComponent(() =>
  import('./TimelineErrorCallout').then((m) => m.TimelineErrorCallout),
);

if (import.meta.env.MODE === 'test') {
  await TimelineErrorCallout.preload();
}

const LINK =
  'inline-flex min-h-7 min-w-7 cursor-pointer items-center rounded-[6px] px-1.5 font-normal text-ink-soft underline-offset-2 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-default disabled:no-underline disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:min-w-11';

function outcomeLabelKey(outcome: PromptOutcome) {
  if (outcome.status === 'aborted') return 'transcript.promptOutcome.aborted' as const;
  if (outcome.status === 'blocked') return 'transcript.promptOutcome.blocked' as const;
  return outcome.delivered ? 'transcript.promptOutcome.replyFailed' as const : 'transcript.promptOutcome.failed' as const;
}

export interface PromptOutcomeActions {
  readonly onRetry?: (text: string) => void;
  readonly onLocate?: (userMessageId: string) => void;
  readonly disabled?: boolean;
}

export const PromptOutcomeActionsContext = createContext<PromptOutcomeActions>({});

export function usePromptOutcomeActions(): PromptOutcomeActions {
  return useContext(PromptOutcomeActionsContext);
}

export function PromptOutcomeLine({
  outcome,
  onRetry,
  retryDisabled = false,
  retryLoading = false,
  superseded = false,
}: {
  outcome: PromptOutcome;
  onRetry?: () => void;
  retryDisabled?: boolean;
  retryLoading?: boolean;
  superseded?: boolean;
}) {
  const { t } = useI18n();
  const failed = outcome.status === 'failed';
  const blocked = outcome.status === 'blocked';

  if (failed || blocked) {
    const actions: TimelineErrorAction[] = [];
    if (onRetry !== undefined) {
      actions.push({
        id: 'retry',
        label: retryLoading ? t('transcript.content.loading') : t('transcript.promptOutcome.retry'),
        onClick: onRetry,
        disabled: retryDisabled || retryLoading,
        busy: retryLoading,
        keepWhenSuperseded: !outcome.delivered,
        title: t(retryLoading ? 'transcript.content.loading' : 'transcript.promptOutcome.retryTitle'),
        dataAttr: 'data-prompt-outcome-retry',
      });
    }
    const noDetailsFallback = t(
      blocked ? 'transcript.promptOutcome.noBlockedDetails' : 'transcript.promptOutcome.noDetails',
    );
    return (
      <div data-prompt-outcome={outcome.status} className="mt-1.5 w-full max-w-[min(100%,40rem)] self-end">
        <TimelineErrorCallout
          incidentId={`prompt-outcome-${outcome.status}-${outcome.at ?? 'local'}`}
          severity={blocked ? 'warn' : 'error'}
          title={t(outcomeLabelKey(outcome))}
          message={outcome.error ?? outcome.errorDetails ?? noDetailsFallback}
          errorDetails={outcome.errorDetails}
          createdAt={outcome.at}
          superseded={superseded}
          actions={actions}
        />
      </div>
    );
  }

  return (
    <div data-prompt-outcome={outcome.status} className="mt-1 mr-1 flex max-w-[80%] flex-col items-end">
      <span className="flex flex-wrap items-center justify-end gap-x-1.5 text-[12px] leading-[16px] font-normal text-ink-faint">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-[1px] bg-ink-faint" />
        <span className="text-ink-soft">{t(outcomeLabelKey(outcome))}</span>
        {outcome.at !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <RelativeTime at={outcome.at} />
          </>
        ) : null}
        {onRetry !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              data-prompt-outcome-retry
              onClick={onRetry}
              disabled={retryDisabled || retryLoading}
              aria-busy={retryLoading || undefined}
              title={t(retryLoading ? 'transcript.content.loading' : 'transcript.promptOutcome.retryTitle')}
              className={LINK}
            >
              {retryLoading ? t('transcript.content.loading') : t('transcript.promptOutcome.retry')}
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function EarlierPromptOutcomesRow({ block }: { block: NoticeBlock }) {
  const { t } = useI18n();
  const { onLocate } = usePromptOutcomeActions();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const outcomes = block.earlierPromptOutcomes ?? [];
  if (outcomes.length === 0) return null;
  const label = block.i18n !== undefined ? t(block.i18n.key, block.i18n.params) : block.text;
  return (
    <div data-prompt-failed-run className="anim-enter py-0.5">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => { setOpen((value) => !value); }}
          className="inline-flex min-h-7 min-w-7 cursor-pointer items-center gap-1 rounded-[6px] px-1.5 text-[12px] leading-[16px] font-normal text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          <span>{label}</span>
          <DisclosureChevron open={open} />
        </button>
      </div>
      {open ? (
        <ul id={listId} className="mt-1 mb-1 flex w-full max-w-[34rem] flex-col gap-0.5 pl-1.5">
          {outcomes.map((outcome) => (
            <li key={outcome.promptId} data-prompt-failed-entry={outcome.status} className="flex min-h-7 items-baseline gap-2 text-[12px] leading-[16px] font-normal">
              <span className="w-12 shrink-0 text-ink-faint">
                {t(
                  outcome.status === 'aborted'
                    ? 'transcript.promptOutcome.aborted'
                    : outcome.status === 'blocked'
                      ? 'transcript.promptOutcome.blocked'
                      : 'transcript.promptOutcome.failed',
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-soft" title={outcome.text}>{outcome.text ?? '—'}</span>
              {outcome.at !== undefined ? (
                <span className="shrink-0 tabular-nums text-ink-faint"><RelativeTime at={outcome.at} /></span>
              ) : null}
              {onLocate !== undefined && outcome.userMessageId !== undefined ? (
                <button type="button" onClick={() => { onLocate(outcome.userMessageId!); }} className={`${LINK} shrink-0 text-[12px] leading-[16px]`}>
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
