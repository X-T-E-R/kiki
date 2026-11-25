import { memo } from 'react';

import type { TurnReplyGap, TurnTailInfo } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { RelativeTime } from '../RelativeTime';

function formatLatencySeconds(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, '') : String(Math.round(seconds));
}

function formatTokensPerSecond(rate: number): string {
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1).replace(/\.0$/, '');
}

export interface TurnFootnoteProps {
  readonly tail: TurnTailInfo;
  readonly gap?: TurnReplyGap;
  readonly revealOnHover?: boolean;
  readonly includeTime?: boolean;
  readonly onRetryGap?: () => void;
  readonly retryDisabled?: boolean;
  readonly className?: string;
}

export const TurnFootnote = memo(function TurnFootnote({
  tail,
  gap,
  revealOnHover = false,
  includeTime = true,
  onRetryGap,
  retryDisabled = false,
  className = '',
}: TurnFootnoteProps) {
  const { t, time } = useI18n();
  const facts: string[] = [];
  if (tail.durationMs !== undefined && tail.durationMs > 0) {
    facts.push(t('transcript.ranFor', { duration: time.formatDuration(tail.durationMs) }));
  }
  if (tail.ttftMs !== undefined && tail.ttftMs > 0) {
    facts.push(t('transcript.ttft', { seconds: formatLatencySeconds(tail.ttftMs) }));
  }
  if (tail.tokensPerSecond !== undefined && tail.tokensPerSecond > 0) {
    facts.push(t('transcript.tokensPerSecond', { rate: formatTokensPerSecond(tail.tokensPerSecond) }));
  }

  const hasTime = includeTime && tail.endedAt !== '';
  if (!hasTime && facts.length === 0 && gap === undefined) return null;

  const revealClass = revealOnHover
    ? 'opacity-0 transition-opacity duration-[var(--kiki-motion-quick)] group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 pointer-coarse:opacity-100 focus-within:opacity-100'
    : '';

  return (
    <div
      data-turn-footnote
      data-turn-tail
      data-turn-tail-state={tail.state}
      data-turn-footnote-turn={tail.turnId}
      role={gap !== undefined ? 'status' : undefined}
      aria-live={gap !== undefined ? 'polite' : undefined}
      className={`anim-enter flex min-h-7 min-w-0 items-center gap-3 py-1 ${revealClass} ${className}`.trimEnd()}
    >
      <span aria-hidden data-turn-tail-rule="left" className="h-px min-w-0 flex-1 bg-hairline" />
      <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-center font-sans text-[12px] leading-[16px] font-normal tabular-nums text-ink-faint">
        {gap !== undefined ? (
          <>
            <span data-turn-tail-gap={gap.work} className="text-ink-soft">
              {t('transcript.noReply')}
            </span>
            <span aria-hidden>·</span>
            <span data-turn-tail-gap-work>
              {t(
                gap.work === 'running'
                  ? 'transcript.noReplyBackground'
                  : gap.work === 'idle'
                    ? 'transcript.noReplyIdle'
                    : 'transcript.noReplyUnknown',
              )}
            </span>
            {hasTime || facts.length > 0 ? <span aria-hidden>·</span> : null}
          </>
        ) : null}
        <span title={time.absoluteTime(tail.endedAt)}>
          {hasTime ? <RelativeTime at={tail.endedAt} /> : null}
          {facts.length > 0 ? `${hasTime ? ' · ' : ''}${facts.join(' · ')}` : null}
        </span>
        {gap !== undefined && gap.work === 'idle' && onRetryGap !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              data-turn-tail-gap-retry=""
              onClick={onRetryGap}
              disabled={retryDisabled}
              title={t('transcript.promptOutcome.retryTitle')}
              className="inline-flex min-h-7 min-w-7 cursor-pointer items-center rounded-[6px] px-1.5 text-[12px] leading-[16px] font-normal text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-55 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              {t('transcript.promptOutcome.retry')}
            </button>
          </>
        ) : null}
      </div>
      <span aria-hidden data-turn-tail-rule="right" className="h-px min-w-0 flex-1 bg-hairline" />
    </div>
  );
});
