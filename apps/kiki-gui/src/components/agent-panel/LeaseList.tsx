import { memo } from 'react';
import type { AgentProfileSourceDiagnosticCode, NamedAgentSubagentLease } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import {
  NAMED_AGENT_LEASE_DETAIL_LABEL_KEYS,
  summarizeNamedAgentLease,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';

const AGENT_PROFILE_DIAGNOSTIC_KEYS: Readonly<Record<AgentProfileSourceDiagnosticCode, I18nKey>> = {
  'agent_profile_source.invalid_path': 'agentProfileDiagnostic.agent_profile_source.invalid_path',
  'agent_profile_source.path_escape': 'agentProfileDiagnostic.agent_profile_source.path_escape',
  'agent_profile_source.symlink_escape': 'agentProfileDiagnostic.agent_profile_source.symlink_escape',
  'agent_profile_source.not_private': 'agentProfileDiagnostic.agent_profile_source.not_private',
  'agent_profile_source.unavailable': 'agentProfileDiagnostic.agent_profile_source.unavailable',
  'agent_profile_source.invalid_profile': 'agentProfileDiagnostic.agent_profile_source.invalid_profile',
  'agent_profile_source.cycle': 'agentProfileDiagnostic.agent_profile_source.cycle',
  'agent_profile_source.depth_exceeded': 'agentProfileDiagnostic.agent_profile_source.depth_exceeded',
};

export interface SubagentLeaseListProps {
  readonly items: readonly (string | NamedAgentSubagentLease)[];
  readonly variant: 'cards' | 'compact' | 'details';
  readonly onOpen?: (name: string) => void;
}

export const SubagentLeaseList = memo(function SubagentLeaseList({
  items,
  variant,
  onOpen,
}: SubagentLeaseListProps) {
  const { t } = useI18n();
  const diagnosticText = (lease: NamedAgentSubagentLease, fallback: string | undefined) => {
    const key = lease.diagnostic_code === undefined
      ? undefined
      : AGENT_PROFILE_DIAGNOSTIC_KEYS[lease.diagnostic_code];
    return key === undefined ? fallback : t(key);
  };

  if (items.length === 0) return null;

  // Detail panel cards variant (ProfileDetailSections)
  if (variant === 'cards') {
    return (
      <div className="space-y-1">
        {items.map((item, idx) => {
          if (typeof item === 'string') {
            const chipClass =
              'inline-block rounded bg-paper border border-hairline px-1.5 py-0.5 text-[9.5px] text-ink mr-1';
            return onOpen ? (
              <button
                key={item}
                type="button"
                onClick={() => onOpen(item)}
                className={`${chipClass} hover:border-hairline-strong hover:text-accent cursor-pointer transition-colors`}
                title={t('agentPanel.viewDetails')}
              >
                {item}
              </button>
            ) : (
              <span key={item} className={chipClass}>
                {item}
              </span>
            );
          }

          const summary = summarizeNamedAgentLease(item);
          const diagnostic = diagnosticText(item, summary.diagnostic);
          const cardContent = (
            <>
              <div className="font-medium text-ink flex items-center gap-1.5">
                {summary.scoped ? (
                  <span className="rounded bg-accent-soft px-1 text-[8.5px] text-accent uppercase font-bold">
                    {t('st.namedAgents.scopedBadge')}
                  </span>
                ) : null}
                <span>{summary.headline}</span>
              </div>
              {diagnostic !== undefined ? (
                <div className="text-danger text-[9px] mt-0.5">{diagnostic}</div>
              ) : null}
              {summary.details.map((d, i) => (
                <div key={i} className="text-ink-soft pl-2">
                  <span className="text-ink-faint">{t(NAMED_AGENT_LEASE_DETAIL_LABEL_KEYS[d.label])}: </span>
                  {d.value}
                </div>
              ))}
            </>
          );

          return onOpen ? (
            <button
              key={`${item.name}:${idx}`}
              type="button"
              onClick={() => onOpen(item.name)}
              className="w-full text-left rounded border border-hairline bg-paper/60 p-2 font-mono text-[10px] hover:border-hairline-strong hover:bg-paper/80 cursor-pointer transition-colors block"
              title={t('agentPanel.viewDetails')}
            >
              {cardContent}
            </button>
          ) : (
            <div
              key={`${item.name}:${idx}`}
              className="rounded border border-hairline bg-paper/60 p-2 font-mono text-[10px]"
            >
              {cardContent}
            </div>
          );
        })}
      </div>
    );
  }

  // Settings summary variant (first-glance chips + lines)
  if (variant === 'compact') {
    const stringSubagents = items.filter((lease): lease is string => typeof lease === 'string');
    const leaseSubagents = items.filter((lease): lease is NamedAgentSubagentLease => typeof lease !== 'string');
    const subagentChipClass =
      'rounded-full border border-hairline bg-panel px-1.5 py-px font-mono text-[9.5px] text-ink-faint';

    return (
      <div className="mt-1.5 space-y-1">
        <p className="text-[10.5px] font-medium text-ink-soft">{t('st.namedAgents.availableSubagents')}</p>
        {stringSubagents.length > 0 ? (
          <p className="flex flex-wrap gap-1.5">
            {stringSubagents.map((name) => (
              <span key={name} className={subagentChipClass}>
                {name}
              </span>
            ))}
          </p>
        ) : null}
        {leaseSubagents.map((lease, index) => {
          const leaseSummary = summarizeNamedAgentLease(lease);
          const diagnostic = diagnosticText(lease, leaseSummary.diagnostic);
          return (
            <p
              key={`${lease.name}:${index}`}
              className="flex flex-wrap items-center gap-1.5 break-words font-mono text-[10.5px] text-ink-soft"
            >
              <span>{leaseSummary.headline}</span>
              {leaseSummary.scoped ? (
                <span className="rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-accent">
                  {t('st.namedAgents.scopedBadge')}
                </span>
              ) : null}
              {leaseSummary.status !== undefined ? (
                <span className={leaseSummary.status === 'unavailable' ? 'text-danger' : 'text-success'}>
                  {t(
                    leaseSummary.status === 'unavailable'
                      ? 'st.namedAgents.leaseUnavailable'
                      : 'st.namedAgents.leaseReady',
                  )}
                </span>
              ) : null}
              {diagnostic !== undefined ? (
                <span className="text-danger">{diagnostic}</span>
              ) : null}
            </p>
          );
        })}
      </div>
    );
  }

  // Settings technical details variant
  return (
    <>
      {items.map((lease, index) => {
        if (typeof lease === 'string') {
          return (
            <p key={lease}>
              {t('st.namedAgents.subagentLease')}: {lease}
            </p>
          );
        }
        const leaseSummary = summarizeNamedAgentLease(lease);
        const diagnostic = diagnosticText(lease, leaseSummary.diagnostic);
        return (
          <div key={`${lease.name}:${index}`} className="space-y-1">
            <p>
              {t('st.namedAgents.subagentLease')}:
              {leaseSummary.scoped ? (
                <span className="mx-1 rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-accent">
                  {t('st.namedAgents.scopedBadge')}
                </span>
              ) : null}{' '}
              {leaseSummary.headline}
            </p>
            {leaseSummary.status !== undefined ? (
              <p className={`pl-3${leaseSummary.status === 'unavailable' ? ' text-danger' : ''}`}>
                {t('st.namedAgents.leaseStatus')}:{' '}
                {t(
                  leaseSummary.status === 'unavailable'
                    ? 'st.namedAgents.leaseUnavailable'
                    : 'st.namedAgents.leaseReady',
                )}
              </p>
            ) : null}
            {diagnostic !== undefined ? (
              <p className="pl-3 text-danger">{diagnostic}</p>
            ) : null}
            {leaseSummary.details.map((detail, detailIndex) => (
              <p key={`${detail.label}:${detailIndex}`} className="pl-3">
                <span className="text-ink-faint">{t(NAMED_AGENT_LEASE_DETAIL_LABEL_KEYS[detail.label])}: </span>
                {detail.value}
              </p>
            ))}
          </div>
        );
      })}
    </>
  );
});
