import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { parseAdvancedServerConfig } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { INPUT } from '../ui';
import { SettingsDraftFooter } from './SettingsPrimitives';
import type { KikiConfigResponse } from '../../lib/client';
import { SectionCard } from './SectionCard';
import { useSavedTick } from './useSavedTick';

/**
 * Developer → raw engine configuration: permission, loop_control, and
 * background as one JSON document. Hooks only enter through the Hooks leaf's
 * parseHooksJson, so a pasted `hooks` key is rejected as unsupported.
 */
export function AdvancedSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [advanced, setAdvanced] = useState('{}');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
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
      pingSaved();
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
          <textarea className={`${INPUT} min-h-64 font-mono`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); setDirty(true); setFeedback(null); }} aria-label={t('st.advanced.aria')} />
          <SettingsDraftFooter saved={justSaved} id="advanced-json" dirty={dirty} saving={saving} saveLabel={t('st.advanced.save')} onSave={() => void save()} onDiscard={discard} />
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>
  );
}
