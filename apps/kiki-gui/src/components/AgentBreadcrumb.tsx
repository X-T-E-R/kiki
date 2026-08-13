/**
 * Session > Parent > Current breadcrumb for the agent detail header.
 */

import { memo } from 'react';

import { useI18n } from '../i18n';
import { MAIN_AGENT_ID, type AgentTreeNode } from '../state/agentTree';

export const AgentBreadcrumb = memo(function AgentBreadcrumb({
  crumbs,
  onOpenSession,
  onOpenAgent,
}: {
  crumbs: readonly AgentTreeNode[];
  onOpenSession: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <nav data-agent-breadcrumb aria-label={t('sv.sessionCrumb')} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-ink-faint">
        <li>
          <button
            type="button"
            onClick={onOpenSession}
            className="rounded px-0.5 text-ink-soft transition-colors hover:text-accent"
          >
            {t('sv.sessionCrumb')}
          </button>
        </li>
        {crumbs
          .filter((crumb) => crumb.agentId !== MAIN_AGENT_ID)
          .map((crumb, index, visible) => {
          const last = index === visible.length - 1;
          return (
            <li key={crumb.agentId} className="flex min-w-0 items-center gap-1">
              <span aria-hidden>/</span>
              {last ? (
                <span className="truncate font-medium text-ink" aria-current="page">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => { onOpenAgent(crumb.agentId); }}
                  className="truncate rounded px-0.5 text-ink-soft transition-colors hover:text-accent"
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
});
