import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { parseAdvancedServerConfig } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import type { KikiConfigResponse } from '../../lib/client';
import { CommunicationSettingsCard, ResourceLimitsCard } from './EngineLimitSettings';
import { ExperimentalSection } from './ExperimentalSection';
import { SectionCard } from './SectionCard';

/**
 * Raw JSON domains (redesign §8.3 / §10.3): permission, loop_control, and
 * background as one JSON document. Hooks left this editor
 * in batch 3 — they only enter through the Automation leaf's parseHooksJson —
 * so a pasted `hooks` key is rejected as an unsupported field.
 */
export function AdvancedSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [advanced, setAdvanced] = useState('{}');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  const textFromConfig = (config: KikiConfigResponse) => JSON.stringify({
    permission: config.permission ?? {},
    loop_control: config.loop_control ?? {},
    background: config.background ?? {},
  }, null, 2);

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined || dirty) return;
    setAdvanced(textFromConfig(config));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- textFromConfig is a stable pure formatter
  }, [configQuery.data, dirty]);

  const discard = () => {
    if (configQuery.data !== undefined) setAdvanced(textFromConfig(configQuery.data));
    setDirty(false);
    setFeedback(null);
  };

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
      setAdvanced(textFromConfig(echoed));
      setDirty(false);
      setFeedback({ tone: 'success', text: t('st.advanced.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SectionCard id="st-card-advanced" title={t('st.advanced.title')}>
        <div className="space-y-3">
          <Hint>{t('st.advanced.hint')}</Hint>
          <textarea className={`${INPUT} min-h-64 font-mono`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); setDirty(true); setFeedback(null); }} aria-label={t('st.advanced.aria')} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={PRIMARY_BUTTON} disabled={saving || !dirty} onClick={() => void save()}>{saving ? t('common.saving') : t('st.advanced.save')}</button>
            <button type="button" className={SECONDARY_BUTTON} disabled={saving || !dirty} onClick={discard}>{t('st.advanced.discard')}</button>
            {dirty ? <span className="text-[11px] font-medium text-amber-ink">{t('st.tools.unsaved')}</span> : null}
          </div>
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>
      <CommunicationSettingsCard />
      <ResourceLimitsCard />
      <ExperimentalSection
        featureIds={['search_worker', 'persistence_minidb_readmodel']}
        includeUnknown
        cardId="st-card-performance-storage"
        titleKey="st.advanced.performanceTitle"
        collapsible
      />
    </>
  );
}
