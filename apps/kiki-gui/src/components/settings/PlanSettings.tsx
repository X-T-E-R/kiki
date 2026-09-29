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
import { DependentField, SettingField } from './fields';
import { SettingsDraftFooter } from './SettingsPrimitives';
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

  const gated = planGate === 'gated';
  return (
    <SectionCard id="st-card-defaults" title={t('st.plan.title')} effect="newSessions">
      <div data-plan-settings className="space-y-1">
        <fieldset disabled={saving || configQuery.isPending || configQuery.isError} className="min-w-0 space-y-1 disabled:opacity-60">
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.defaults.planMode')}
              checked={defaultPlanMode}
              disabled={saving}
              onChange={(checked) => void applyDefaultPlanMode(checked)}
            />
            <Hint>{t('st.defaults.planModeHint')}</Hint>
          </div>
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.defaults.planGate')}
              checked={gated}
              disabled={saving}
              onChange={(checked) => void applyPlanGate(checked ? 'gated' : 'free')}
            />
            <Hint>{t('st.defaults.planGateHint')}</Hint>
          </div>
          {/* The timeout only means something while approval is required. */}
          <DependentField when={gated || timeoutDirty}>
            <SettingField label={t('st.defaults.planGateTimeout')} htmlFor="plan-gate-timeout" help={t('st.defaults.planGateTimeoutHint')}>
              <input
                id="plan-gate-timeout"
                type="number"
                min={5}
                step={1}
                disabled={saving || !gated}
                className={`${SMALL_INPUT} w-24 tabular-nums`}
                value={planGateTimeoutS}
                onChange={(event) => { setPlanGateTimeoutS(event.target.value); setTimeoutTouched(true); }}
                onKeyDown={(event) => { if (event.key === 'Enter') void commitPlanGateTimeout(); }}
              />
            </SettingField>
            <SettingsDraftFooter id="plan-gate-timeout" dirty={timeoutDirty} saving={saving}
              onSave={() => void commitPlanGateTimeout()}
              onDiscard={() => { setPlanGateTimeoutS(timeoutBaseline); setTimeoutTouched(false); setFeedback(null); }} />
          </DependentField>
        </fieldset>
        <SavedTick show={saved && !timeoutDirty && feedback?.tone !== 'error'} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
