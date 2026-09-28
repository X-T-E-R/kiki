import { memo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { SessionViewState } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Markdown } from '../Markdown';
import { isCapabilityUnsupportedError } from './mapCapabilities';
import { InspectorChevron } from './InspectorSection';
import { errorToText } from '@kiki/session-core/util';

export const AgentPlanSection = memo(function AgentPlanSection({
  sessionId,
  agentId,
  loaded,
  resyncing,
  planMode,
}: {
  readonly sessionId: string;
  readonly agentId: string;
  readonly loaded: boolean;
  readonly resyncing: boolean;
  readonly planMode?: SessionViewState['planMode'];
}) {
  const { klient } = useConnection();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(true);
  const query = useQuery({
    queryKey: ['agentPlan', sessionId, agentId, planMode],
    queryFn: () => klient.session(sessionId).agent(agentId).getPlan(),
    enabled: loaded && !resyncing,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const toggle = () => {
    if (collapsed) void query.refetch();
    setCollapsed((value) => !value);
  };

  if (query.isPending) {
    return null;
  }
  // No plan service on this server/agent: nothing to show, not an error.
  if (query.isError && isCapabilityUnsupportedError(query.error)) return null;
  if (query.isError) {
    // A quiet, recoverable line — the plan is secondary to the agent's work.
    return (
      <div data-agent-plan-error role="alert" className="flex min-h-8 flex-wrap items-center gap-x-1.5 text-[12px] text-ink-soft">
        <span>{t('agentPanel.planLoadFailed')}</span>
        <span className="text-ink-faint">· {errorToText(query.error, t('common.unknownError'))}</span>
        <button type="button" onClick={() => { void query.refetch(); }} className="font-medium text-ink transition-colors hover:text-accent">
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (query.data === null || query.data === undefined) return null;

  return (
    <section data-agent-plan>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className="group -ml-1.5 flex h-8 w-[calc(100%+0.375rem)] items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <span className="text-[12px] font-medium text-ink-soft transition-colors group-hover:text-ink">{t('inspector.plan')}</span>
        <InspectorChevron open={!collapsed} />
      </button>
      {!collapsed ? (
        <div className="mt-1 max-h-64 overflow-y-auto overscroll-y-contain rounded-lg bg-ink/[0.03] px-3 py-2 text-[13px] leading-relaxed text-ink">
          <Markdown text={query.data.content} />
        </div>
      ) : null}
    </section>
  );
});
