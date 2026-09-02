import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { errorText } from '../../i18n/locale';
import { parseAdvancedServerConfig } from '../../lib/settings';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

/**
 * Raw JSON domains (redesign §8.3 / §10.3): permission, services,
 * loop_control, and background as one JSON document. Hooks left this editor
 * in batch 3 — they have their own card under Automation — so the initial
 * document no longer seeds a `hooks` key (the parser still accepts one for
 * pasted configs).
 */
export function AdvancedSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [advanced, setAdvanced] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined) return;
    setAdvanced(JSON.stringify({
      permission: config.permission ?? {},
      services: config.services ?? {},
      loop_control: config.loop_control ?? {},
      background: config.background ?? {},
    }, null, 2));
  }, [configQuery.data]);

  const save = async () => {
    let patch;
    try {
      patch = parseAdvancedServerConfig(advanced);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setAdvanced(JSON.stringify({
        permission: echoed.permission ?? {},
        services: echoed.services ?? {},
        loop_control: echoed.loop_control ?? {},
        background: echoed.background ?? {},
      }, null, 2));
      setFeedback({ tone: 'success', text: t('st.advanced.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-advanced" title={t('st.advanced.title')}>
      <div className="space-y-3">
        <Hint>{t('st.advanced.hint')}</Hint>
        <textarea className={`${INPUT} min-h-64 font-mono`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); }} aria-label={t('st.advanced.aria')} />
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.advanced.save')}</button>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
