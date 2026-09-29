import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { subagentLimitsFromConfig } from '@kiki/session-core/settings/agentCapabilitiesSettings';
import { useConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { FeedbackLine, Hint } from '../controls';
import { SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

export function SubagentLimitsSettings() {
  const { client } = useConnection();
  const { t } = useI18n();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig() });
  const [hours, setHours] = useState('2');
  const [direct, setDirect] = useState('16');
  const [total, setTotal] = useState('0');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [tick, ping] = useSavedTick();
  useEffect(() => {
    if (config.data === undefined || dirty) return;
    const value = subagentLimitsFromConfig(config.data);
    setHours(String(value.timeoutMs / 3_600_000)); setDirect(String(value.maxDirectChildren)); setTotal(String(value.maxTotalSubagents));
  }, [config.data, dirty]);
  const save = async () => {
    const timeoutMs = Math.round(Number(hours) * 3_600_000);
    const maxDirect = Number(direct), maxTotal = Number(total);
    if ([hours, direct, total].some((value) => value.trim() === '') || ![timeoutMs, maxDirect, maxTotal].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      setError(t('st.subagentLimits.invalid')); return;
    }
    setSaving(true); setError(undefined);
    try {
      const body = { subagent: { timeout_ms: timeoutMs, max_direct_children: maxDirect, max_total_subagents: maxTotal } };
      cache.setQueryData(['config'], await client.patchConfig(body));
      await cache.invalidateQueries({ queryKey: ['agentCapabilities'] });
      setDirty(false); ping();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const discard = () => {
    if (config.data !== undefined) {
      const value = subagentLimitsFromConfig(config.data);
      setHours(String(value.timeoutMs / 3_600_000)); setDirect(String(value.maxDirectChildren)); setTotal(String(value.maxTotalSubagents));
    }
    setDirty(false); setError(undefined);
  };
  const field = (id: string, label: string, help: string, value: string, set: (next: string) => void, step: string) => (
    <SettingField label={label} htmlFor={id} help={help}>
      <input id={id} className={`${SMALL_INPUT} h-8 w-24 text-right tabular-nums`} type="number" min="0" step={step} value={value}
        onChange={(event) => { set(event.target.value); setDirty(true); }} />
    </SettingField>
  );
  return <SectionCard id="st-card-subagent-limits" title={t('st.subagentLimits.title')}>
    <Hint>{t('st.subagentLimits.lead')}</Hint>
    <fieldset disabled={saving || config.isPending || config.isError} className="mt-2 space-y-1">
      {field('subagent-limit-hours', t('st.subagentLimits.timeoutShort'), t('st.subagentLimits.timeoutHelp'), hours, setHours, 'any')}
      {field('subagent-limit-direct', t('st.subagentLimits.directShort'), t('st.subagentLimits.directHelp'), direct, setDirect, '1')}
      {field('subagent-limit-total', t('st.subagentLimits.totalShort'), t('st.subagentLimits.totalHelp'), total, setTotal, '1')}
    </fieldset>
    <SettingsDraftFooter id="subagent-limits" dirty={dirty} saving={saving} saved={tick}
      saveLabel={t('st.boardStorage.save')} saveDisabled={config.isPending || config.isError}
      onSave={() => { void save(); }} onDiscard={discard} />
    {error || config.error ? <FeedbackLine feedback={{ tone: 'error', text: error ?? config.error?.message ?? '' }} /> : null}
  </SectionCard>;
}
