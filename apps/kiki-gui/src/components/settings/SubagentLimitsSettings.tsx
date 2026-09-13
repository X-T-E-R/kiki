import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { subagentLimitsFromConfig } from '@kiki/session-core/settings/agentCapabilitiesSettings';
import { useConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { SavedTick } from '../controls';
import { INPUT, PRIMARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
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
  return <SectionCard id="st-card-subagent-limits" title={t('st.subagentLimits.title')}>
    <p className="text-xs text-ink-soft">{t('st.subagentLimits.hint')}</p>
    <fieldset disabled={saving || config.isPending || config.isError} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-xs">{t('st.subagentLimits.timeout')}<input className={`${INPUT} mt-1`} type="number" min="0" step="any" value={hours} onChange={(event) => { setHours(event.target.value); setDirty(true); }} /></label>
        <label className="block text-xs">{t('st.subagentLimits.direct')}<input className={`${INPUT} mt-1`} type="number" min="0" step="1" value={direct} onChange={(event) => { setDirect(event.target.value); setDirty(true); }} /></label>
        <label className="block text-xs">{t('st.subagentLimits.total')}<input className={`${INPUT} mt-1`} type="number" min="0" step="1" value={total} onChange={(event) => { setTotal(event.target.value); setDirty(true); }} /></label>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={PRIMARY_BUTTON} disabled={saving || config.isPending || config.isError || !dirty} onClick={() => { void save(); }}>{t('st.boardStorage.save')}</button>
        <SavedTick show={tick} />
      </div>
    </fieldset>
    {error || config.error ? <p role="alert" className="text-xs text-danger">{error ?? config.error?.message}</p> : null}
  </SectionCard>;
}
