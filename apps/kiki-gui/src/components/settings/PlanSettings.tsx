import { useQuery, useQueryClient } from '@tanstack/react-query';

import { writeSettings } from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '../../lib/client';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus, Toggle } from '../controls';
import { SectionCard } from './SectionCard';
import { DependentField, SettingField } from './fields';
import { CommitInput } from './SettingsPrimitives';
import { mergeConfigEcho } from './configEcho';
import { useInstantSave } from './useInstantSave';

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_S = 5;

/**
 * Plan defaults for new sessions. Every control saves itself: the switches on
 * change, the timeout on blur or Enter, with one status line for the card.
 */
export function PlanSettings() {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const config = configQuery.data;
  const defaultPlanMode = config?.default_plan_mode === true;
  const gated = config?.plan?.gate === 'gated';
  const timeoutSeconds = String((config?.plan?.enterApprovalTimeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);

  // Controls show the server's value, so a failed write leaves them where they were.
  const patch = (body: Parameters<typeof client.patchConfig>[0]) => save.run(async () => {
    const echoed = await client.patchConfig(body);
    const merged = mergeConfigEcho(queryClient.getQueryData<KikiConfigResponse>(['config']) ?? config, echoed);
    queryClient.setQueryData(['config'], merged);
    return merged;
  });

  const applyDefaultPlanMode = async (enabled: boolean) => {
    if (await patch({ default_plan_mode: enabled })) {
      const merged = queryClient.getQueryData<KikiConfigResponse>(['config']);
      writeSettings({ defaultPlanMode: merged?.default_plan_mode === true });
    }
  };

  const timeoutIssue = (text: string): string | null => {
    const seconds = Number(text);
    return text !== '' && Number.isFinite(seconds) && seconds >= MIN_TIMEOUT_S ? null : t('st.defaults.planGateTimeoutInvalid');
  };

  const locked = save.saving || configQuery.isPending || configQuery.isError;
  return (
    <SectionCard id="st-card-defaults" title={t('st.plan.title')} effect="newSessions">
      <div data-plan-settings className="space-y-1">
        <fieldset disabled={locked} className="min-w-0 space-y-1 disabled:opacity-60">
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.defaults.planMode')}
              checked={defaultPlanMode}
              disabled={locked}
              onChange={(checked) => void applyDefaultPlanMode(checked)}
            />
            <Hint>{t('st.defaults.planModeHint')}</Hint>
          </div>
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.defaults.planGate')}
              checked={gated}
              disabled={locked}
              onChange={(checked) => void patch({ plan: { gate: checked ? 'gated' : 'free' } })}
            />
            <Hint>{t('st.defaults.planGateHint')}</Hint>
          </div>
          {/* The timeout only means something while approval is required. */}
          <DependentField when={gated}>
            <SettingField label={t('st.defaults.planGateTimeout')} htmlFor="plan-gate-timeout" help={t('st.defaults.planGateTimeoutHint')}>
              <CommitInput
                id="plan-gate-timeout"
                className="w-24 text-right"
                inputMode="numeric"
                disabled={locked}
                value={timeoutSeconds}
                validate={timeoutIssue}
                onCommit={(text) => { void patch({ plan: { enter_approval_timeout_ms: Math.round(Number(text) * 1000) } }); }}
              />
            </SettingField>
          </DependentField>
        </fieldset>
        <SaveStatus saving={save.saving} saved={save.saved} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={save.error} />
      </div>
    </SectionCard>
  );
}
