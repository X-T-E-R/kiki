import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { errorText } from '../../i18n/locale';
import { markRestartRequired } from '../../lib/settings';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { useRestartRequirement } from '../RestartBanner';
import { PRIMARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

/**
 * Data & diagnostics (redesign §10.3): today only the telemetry switch, split
 * out of the old skills card because it writes a different concern (and
 * requires a restart) than skill discovery. Migration/home compatibility
 * stays in General.
 */
export function DataSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [telemetry, setTelemetry] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const restart = useRestartRequirement();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setTelemetry(configQuery.data.telemetry !== false);
  }, [configQuery.data]);

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ telemetry });
      queryClient.setQueryData(['config'], echoed);
      setTelemetry(echoed.telemetry !== false);
      const previousTelemetry = configQuery.data?.telemetry !== false;
      if (telemetry !== previousTelemetry) {
        markRestartRequired(['telemetry']);
        setFeedback({ tone: 'success', text: t('st.caps.savedRestart') });
      } else {
        setFeedback({ tone: 'success', text: t('st.caps.saved') });
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      id="st-card-telemetry"
      title={t('st.telemetry.title')}
      badge={restart.fields.includes('telemetry') ? 'restart' : undefined}
    >
      <div className="space-y-3">
        <fieldset disabled={saving} className="space-y-1.5 disabled:opacity-60">
          <Toggle label={t('st.caps.telemetry')} checked={telemetry} onChange={setTelemetry} />
          <Hint>{t('st.caps.telemetryHint')}</Hint>
        </fieldset>
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.caps.save')}</button>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
