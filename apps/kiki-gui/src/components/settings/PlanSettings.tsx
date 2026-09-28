import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { writeSettings } from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '../../lib/client';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { useDirtyReporter } from '../dirtyGuard';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { mergeConfigEcho } from './configEcho';
import { useSavedTick } from './useSavedTick';

export function PlanSettings() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [defaultPlanMode, setDefaultPlanMode] = useState(false);
  const [planGate, setPlanGate] = useState<'free' | 'gated'>('free');
  const [planGateTimeoutS, setPlanGateTimeoutS] = useState('60');
  const [timeoutTouched, setTimeoutTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const syncFromConfig = useCallback((config: KikiConfigResponse | undefined) => {
    if (config === undefined) return;
    setDefaultPlanMode(config.default_plan_mode === true);
    setPlanGate(config.plan?.gate === 'gated' ? 'gated' : 'free');
    setPlanGateTimeoutS(String((config.plan?.enterApprovalTimeoutMs ?? 60_000) / 1000));
  }, []);

  const timeoutBaseline = String((configQuery.data?.plan?.enterApprovalTimeoutMs ?? 60_000) / 1000);
  const timeoutDirty = timeoutTouched && planGateTimeoutS !== timeoutBaseline;
  useDirtyReporter('plan-gate-timeout', timeoutDirty);
  useEffect(() => { if (!timeoutTouched) syncFromConfig(configQuery.data); }, [configQuery.data, syncFromConfig, timeoutTouched]);

  const saveEcho = (echoed: KikiConfigResponse): KikiConfigResponse => {
    const merged = mergeConfigEcho(
      queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data,
      echoed,
    );
    queryClient.setQueryData(['config'], merged);
    setDefaultPlanMode(merged.default_plan_mode === true);
    setPlanGate(merged.plan?.gate === 'gated' ? 'gated' : 'free');
    if (!timeoutTouched) setPlanGateTimeoutS(String((merged.plan?.enterApprovalTimeoutMs ?? 60_000) / 1000));
    return merged;
  };

  const applyDefaultPlanMode = async (enabled: boolean) => {
    setDefaultPlanMode(enabled);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_plan_mode: enabled });
      const merged = saveEcho(echoed);
      writeSettings({ defaultPlanMode: merged.default_plan_mode === true });
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncFromConfig(configQuery.data);
    } finally {
      setSaving(false);
    }
  };

  const applyPlanGate = async (gate: 'free' | 'gated') => {
    setPlanGate(gate);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ plan: { gate } });
      saveEcho(echoed);
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncFromConfig(configQuery.data);
    } finally {
      setSaving(false);
    }
  };

  const commitPlanGateTimeout = async () => {
    const ms = Math.round(Number(planGateTimeoutS) * 1000);
    if (!Number.isFinite(ms) || ms < 5000) {
      setFeedback({ tone: 'error', text: t('st.defaults.planGateTimeoutInvalid') });
      return;
    }
    if (!timeoutDirty) return;
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ plan: { enter_approval_timeout_ms: ms } });
      saveEcho(echoed);
      setTimeoutTouched(false);
      setPlanGateTimeoutS(String((echoed.plan?.enterApprovalTimeoutMs ?? ms) / 1000));
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-defaults" title={t('st.plan.title')}>
      <div data-plan-settings className="space-y-3">
        <Hint>{t('st.plan.hint')}</Hint>
        <fieldset disabled={saving || configQuery.isPending || configQuery.isError} className="space-y-3 disabled:opacity-60">
          <div className="space-y-1">
            <Toggle
              label={t('st.defaults.planMode')}
              checked={defaultPlanMode}
              disabled={saving}
              onChange={(checked) => void applyDefaultPlanMode(checked)}
            />
            <Hint>{t('st.defaults.planModeHint')}</Hint>
          </div>
          <div className="space-y-1">
            <Toggle
              label={t('st.defaults.planGate')}
              checked={planGate === 'gated'}
              disabled={saving}
              onChange={(checked) => void applyPlanGate(checked ? 'gated' : 'free')}
            />
            <Hint>{t('st.defaults.planGateHint')}</Hint>
          </div>
          <div className="space-y-1">
            <label htmlFor="plan-gate-timeout" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] font-medium text-ink-soft">
              <span>{t('st.defaults.planGateTimeout')}</span>
              <input
                id="plan-gate-timeout"
                type="number"
                min={5}
                step={1}
                disabled={saving || planGate !== 'gated'}
                className={`${SMALL_INPUT} py-1`}
                value={planGateTimeoutS}
                onChange={(event) => { setPlanGateTimeoutS(event.target.value); setTimeoutTouched(true); }}
              />
            </label>
            <Hint>{t('st.defaults.planGateTimeoutHint')}</Hint>
          </div>
        </fieldset>
        {(planGate === 'gated' || timeoutDirty) ? <div className="flex gap-2 border-t border-hairline pt-3">
          <button type="button" className={PRIMARY_BUTTON} disabled={!timeoutDirty || saving} onClick={() => void commitPlanGateTimeout()}>{t('common.save')}</button>
          <button type="button" className={SECONDARY_BUTTON} disabled={!timeoutDirty || saving} onClick={() => { setPlanGateTimeoutS(timeoutBaseline); setTimeoutTouched(false); setFeedback(null); }}>{t('st.advanced.discard')}</button>
        </div> : null}
        <SavedTick show={saved && !timeoutDirty && feedback?.tone !== 'error'} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
