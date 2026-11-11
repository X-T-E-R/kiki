/**
 * The one mark a promoted thread carries: where it came from. A quiet link
 * beside the title that reopens the subagent in its original session;
 * ordinary sessions render nothing.
 */

import type { Session } from '@kiki/protocol';
import { useNavigate } from 'react-router-dom';

import { useI18n } from '../i18n';
import { Icon } from './icons';

export function promotedFromPath(origin: NonNullable<Session['promoted_from']>): string {
  return `/s/${origin.session_id}/agent/${encodeURIComponent(origin.agent_id)}`;
}

export function PromotedFromMark({
  origin,
  className = '',
}: {
  origin: Session['promoted_from'];
  className?: string;
}) {
  if (origin === undefined) return null;
  return <PromotedFromLink origin={origin} className={className} />;
}

function PromotedFromLink({
  origin,
  className,
}: {
  origin: NonNullable<Session['promoted_from']>;
  className: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const agent = origin.agent_name ?? origin.profile ?? origin.agent_id;
  const tooltip = t('agent.promotedFromTitle', { agent });
  return (
    <button
      type="button"
      data-promoted-from={origin.agent_id}
      title={tooltip}
      aria-label={tooltip}
      onClick={() => { void navigate(promotedFromPath(origin)); }}
      className={`inline-flex min-w-0 items-center gap-1 rounded text-[12px] leading-4 text-ink-faint transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${className}`}
    >
      <Icon name="arrowUpRight" size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{t('agent.promotedFrom', { agent })}</span>
    </button>
  );
}
