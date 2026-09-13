import { useI18n } from '../../i18n';
import { SectionCard } from './SectionCard';

export function AgentTaskSettings({ boardContent }: { boardContent?: React.ReactNode }) {
  const { t } = useI18n();
  return <>
    <SectionCard id="st-card-agent-todo" title={t('st.agentTodo.title')}>
      <p className="text-xs text-ink-soft">{t('st.agentTodo.hint')}</p>
    </SectionCard>
    <SectionCard id="st-card-agent-board" title={t('st.agentBoard.title')}>
      <div data-board-settings-slot>{boardContent ?? <p className="text-xs text-ink-soft">{t('st.agentBoard.hint')}</p>}</div>
    </SectionCard>
  </>;
}
