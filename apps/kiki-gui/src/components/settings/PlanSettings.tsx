import { useQuery, useQueryClient } from '@tanstack/react-query';

import { writeSettings } from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '../../lib/client';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError, SaveStatus, Toggle } from '../controls';
import { SectionCard } from './SectionCard';
import { DependentField, SettingField, SettingsBox } from './fields';
import { CommitInput } from './SettingsPrimitives';
import { mergeConfigEcho } from './configEcho';
import { useInstantSave } from './useInstantSave';

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_S = 5;

/**
 * One instant write to the plan settings. Controls show the server's value,
 * so a failed write leaves them where they were.
 */
function usePlanConfig() {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  const config = configQuery.data;
  const patch = (body: Parameters<typeof client.patchConfig>[0]) => save.run(async () => {
    const echoed = await client.patchConfig(body);
    const merged = mergeConfigEcho(queryClient.getQueryData<KikiConfigResponse>(['config']) ?? config, echoed);
    queryClient.setQueryData(['config'], merged);
    return merged;
  });
  const locked = save.saving || configQuery.isPending || configQuery.isError;
  return { config, configQuery, save, patch, locked, queryClient };
}

/**
 * Sessions › New conversations: whether a new conversation starts by planning.
 * Saved the moment it flips. Whether leaving plan mode waits for you is an
 * approval rule, so that switch lives on Permissions (`PlanGateFields`).
 */
export function PlanSettings() {
  const { t } = useI18n();
  const { config, configQuery, save, patch, locked, queryClient } = usePlanConfig();
  const defaultPlanMode = config?.default_plan_mode === true;

  const applyDefaultPlanMode = async (enabled: boolean) => {
    if (await patch({ default_plan_mode: enabled })) {
      const merged = queryClient.getQueryData<KikiConfigResponse>(['config']);
      writeSettings({ defaultPlanMode: merged?.default_plan_mode === true });
    }
  };

  return (
    <SectionCard id="st-card-defaults" title={t('st.sessions.card.newSessions')} effect="newSessions">
      <div data-plan-settings className="space-y-2">
        <SettingsBox>
          {/* The help keeps the longer sentence on purpose: whether the plan
              waits for your confirmation depends on the permission mode and
              the approval gate, so "you confirm before files change" is not
              always true. */}
          <SettingField label={t('st.sessions.plan.label')} help={t('st.defaults.planModeHint')}>
            <Toggle layout="bare" label={t('st.sessions.plan.label')} checked={defaultPlanMode} disabled={locked}
              onChange={(checked) => void applyDefaultPlanMode(checked)} />
          </SettingField>
        </SettingsBox>
        <SaveStatus saving={save.saving} saved={save.saved} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={save.error} />
      </div>
    </SectionCard>
  );
}

/**
 * Permissions › Approval: whether entering or leaving plan mode waits for
 * your approval, and how long an unanswered request waits. It moved here from
 * the Sessions page because it is an approval rule. Every control saves
 * itself — the switch on change, the timeout on blur or Enter — with the same
 * `[plan]` patch as before.
 */
export function PlanGateFields() {
  const { t } = useI18n();
  const { config, configQuery, save, patch, locked } = usePlanConfig();
  const gated = config?.plan?.gate === 'gated';
  const timeoutSeconds = String((config?.plan?.enterApprovalTimeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);

  const timeoutIssue = (text: string): string | null => {
    const seconds = Number(text);
    return text !== '' && Number.isFinite(seconds) && seconds >= MIN_TIMEOUT_S ? null : t('st.defaults.planGateTimeoutInvalid');
  };

  // `contents`: the rows join the surrounding card's SettingsBox, so they get
  // its padding and dividing lines like the rows above them.
  return (
    <div data-plan-gate className="contents">
      <SettingField label={t('st.defaults.planGate')} help={t('st.defaults.planGateHint')}>
        <SaveStatus saving={save.saving} saved={save.saved} />
        <Toggle layout="bare" label={t('st.defaults.planGate')} checked={gated} disabled={locked}
          onChange={(checked) => void patch({ plan: { gate: checked ? 'gated' : 'free' } })} />
      </SettingField>
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
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      <FeedbackLine feedback={save.error} />
    </div>
  );
}
