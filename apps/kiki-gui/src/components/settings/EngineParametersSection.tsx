import { useI18n } from '../../i18n';
import { AgentRuntimeCard } from './AgentRuntimeSettings';
import { HandoffNoticesCard } from './CommunicationSection';
import { ResourceLimitsCard } from './EngineLimitSettings';
import { SessionResidencyCard } from './SessionResidencyCard';
import { SessionTitleEngineCard } from './SessionsSection';
import { SubagentAgentListFieldsCard } from './SubagentLimitsSettings';
import { TaskPolicyCard } from './TaskRuntimeSettings';

/**
 * Developer & labs › Engine parameters: the engine internals that leave the
 * everyday pages because a person never sees them while working (settings
 * conventions §3.5) — handoff notes, residency limits, timeouts, default
 * return fields. Effective values only, still editable, under the one line
 * that says when anyone needs them. Nothing is deleted on the way here: the
 * page that gives up a parameter moves its card into this list, and the card
 * keeps its `st-card-*` id, its save model and its test hooks, so old anchors
 * and search hits follow it (the search spec in `@kiki/session-core/settings`
 * names it under `developer` / tab `engine`).
 *
 * The cards are grouped by the page they came from, under that page's name,
 * so someone who remembers where a value used to be finds it again.
 */
export function EngineParametersSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-6" data-engine-parameters>
      <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.dev.engineParams.intro')}</p>
      <section className="space-y-6" data-engine-group="sessions" aria-label={t('st.section.sessions')}>
        <h2 className="text-[12px] font-medium text-ink-faint">{t('st.section.sessions')}</h2>
        <TaskPolicyCard />
        <SessionResidencyCard />
        <ResourceLimitsCard />
        <SessionTitleEngineCard />
      </section>
      <section className="space-y-6" data-engine-group="agents" aria-label={t('st.section.agents')}>
        <h2 className="text-[12px] font-medium text-ink-faint">{t('st.section.agents')}</h2>
        <HandoffNoticesCard />
        <SubagentAgentListFieldsCard />
        <AgentRuntimeCard />
      </section>
    </div>
  );
}
