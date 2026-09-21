import { memo } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';
import { agentProfileSourceLabelKey } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';

/**
 * Format a profile source identifier into a user-facing label.
 * Known source IDs ('builtin', 'user', 'workspace', 'custom', etc.) map to
 * localized strings; unknown IDs (e.g. file paths on older servers) remain raw.
 */
export function sourceBadgeLabel(t: (key: I18nKey) => string, source: string): string {
  const key = agentProfileSourceLabelKey(source);
  return key === undefined ? source : t(key);
}

export interface SourceBadgeProps {
  readonly source?: string;
  readonly variant?: 'accent' | 'muted';
  readonly suffix?: string;
  readonly className?: string;
}

export const SourceBadge = memo(function SourceBadge({
  source,
  variant = 'accent',
  suffix,
  className = '',
}: SourceBadgeProps) {
  const { t } = useI18n();

  if (source === undefined || source === '') return null;

  const label = sourceBadgeLabel(t, source);
  const variantClass =
    variant === 'accent'
      ? 'rounded bg-accent-soft px-1.5 py-0.2 font-mono text-[9.5px] font-medium text-accent uppercase'
      : 'rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint';

  return (
    <span data-profile-source-badge={source} className={`${variantClass} ${className}`}>
      {label}
      {suffix ?? ''}
    </span>
  );
});
