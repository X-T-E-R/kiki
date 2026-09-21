import { memo } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import type { CapabilityState } from './types';

/** i18n label key per capability state — the single mapping every surface
 * (sidebar rows, detail drawer, diagnostics) resolves state labels through. */
export const CAPABILITY_STATE_LABEL_KEYS: Readonly<Record<CapabilityState, I18nKey>> = {
  enabled: 'agentPanel.capability.enabled',
  'approval-required': 'agentPanel.capability.approvalRequired',
  disabled: 'agentPanel.capability.disabled',
  disconnected: 'agentPanel.capability.disconnected',
  unknown: 'agentPanel.capability.unknown',
};

const STATE_BADGE_CLASS: Readonly<Record<CapabilityState, string>> = {
  enabled: 'bg-success/15 text-success border border-success/30',
  'approval-required': 'bg-amber-card text-amber-ink border border-amber-rule/40',
  disabled: 'bg-paper text-ink-faint border border-hairline',
  disconnected: 'bg-danger/10 text-danger border border-danger/30',
  unknown: 'bg-paper text-ink-faint border border-hairline',
};

export const CapabilityStateBadge = memo(function CapabilityStateBadge({
  state,
  title,
  className = '',
}: {
  readonly state: CapabilityState;
  readonly title?: string;
  readonly className?: string;
}) {
  const { t } = useI18n();
  return (
    <span
      data-capability-state={state}
      title={title}
      className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] ${STATE_BADGE_CLASS[state]} ${className}`}
    >
      {t(CAPABILITY_STATE_LABEL_KEYS[state])}
    </span>
  );
});
