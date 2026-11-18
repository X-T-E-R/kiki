/**
 * Origin provenance link for a forked session (`session.forked_from`).
 *
 * Sibling to `PromotedFromMark`: sits quietly beside the session title so the
 * reader always sees which session and turn this conversation diverged from,
 * and can jump back in one click.
 */

import { memo } from 'react';
import { useNavigate } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import type { ForkOriginSummary } from './forkLineageModel';

export const ForkProvenanceMark = memo(function ForkProvenanceMark({
  origin,
  className = '',
}: {
  origin: ForkOriginSummary | undefined;
  className?: string;
}) {
  if (origin === undefined) return null;
  return <ForkProvenanceLink origin={origin} className={className} />;
});

function ForkProvenanceLink({
  origin,
  className,
}: {
  origin: ForkOriginSummary;
  className: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();

  const fromLabel = t('fork.provenanceFrom', { title: origin.title });
  const tooltip =
    origin.turnIndex !== undefined
      ? `${t('fork.provenanceFromTurn', { title: origin.title, turn: origin.turnIndex + 1 })} — ${t('fork.provenanceTitle', { title: origin.title })}`
      : t('fork.provenanceTitle', { title: origin.title });

  return (
    <button
      type="button"
      data-forked-from={origin.sessionId}
      title={tooltip}
      aria-label={tooltip}
      onClick={() => {
        void navigate(`/s/${origin.sessionId}`);
      }}
      className={`inline-flex min-w-0 items-center gap-1 rounded text-[12px] leading-4 text-ink-faint tabular-nums transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${className}`}
    >
      <Icon name="branch" size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{fromLabel}</span>
      {origin.turnIndex !== undefined ? (
        <span className="shrink-0">{` · #${origin.turnIndex + 1}`}</span>
      ) : null}
    </button>
  );
}
