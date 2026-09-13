import { memo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { SessionViewState } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Markdown } from '../Markdown';

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
    return <p data-agent-plan-status role="status" className="text-[11px] text-ink-faint">{t('diagnostics.loading')}</p>;
  }
  if (query.isError) {
    return (
      <div data-agent-plan-error role="alert" className="space-y-1 text-[11px] text-danger">
        <p>{t('diagnostics.error')} · {query.error.message}</p>
        <button type="button" onClick={() => { void query.refetch(); }} className="text-accent hover:text-accent-deep">
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (query.data === null || query.data === undefined) return null;

  return (
    <section data-agent-plan className="border-y border-hairline py-2.5">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className="flex w-full items-center gap-1.5 text-left text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase transition-colors hover:text-ink"
      >
        <span aria-hidden className={`text-[8px] transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}>▶</span>
        <span>{t('agentPanel.currentPlan')}</span>
      </button>
      {!collapsed ? (
        <div className="mt-2 max-h-64 overflow-y-auto overscroll-y-contain pr-1 text-[12px] leading-relaxed text-ink">
          <Markdown text={query.data.content} />
        </div>
      ) : null}
    </section>
  );
});
