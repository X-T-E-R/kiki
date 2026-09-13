import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, issueText } from '@kiki/session-core/i18n';
import {
  markRestartRequired,
  serverFileSettingsFromConfig,
  serverFileSettingsPatch,
  validateDesktopConfigDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { MsUnitInput } from '../ProviderFields';
import { useRestartRequirement } from '../RestartBanner';
import { PRIMARY_BUTTON } from '../ui';
import { NamedAgentProfilesCard, SubagentGovernanceCard } from './AgentsSection';
import { ExperimentalSection } from './ExperimentalSection';
import { SectionCard } from './SectionCard';

/**
 * Subagent timeout (from the dissolved sidecar card, redesign §10.3): a
 * server-config-file value that needs a restart to take effect. The save
 * reuses the sidecar's diff-patch helper so untouched server-file domains
 * (agents.enabled, model catalog refresh) are never resent.
 */
function SubagentTimeoutCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [config, setConfig] = useState(() => serverFileSettingsFromConfig({ providers: {} }));
  const [savedConfig, setSavedConfig] = useState(config);
  const restart = useRestartRequirement();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (configQuery.data !== undefined) {
      const next = serverFileSettingsFromConfig(configQuery.data);
      setConfig(next);
      setSavedConfig(next);
    }
  }, [configQuery.data]);

  const dirty = config.subagent.timeoutMs !== savedConfig.subagent.timeoutMs;

  const save = async () => {
    const validation = validateDesktopConfigDraft({
      subagentTimeoutMs: config.subagent.timeoutMs,
      modelCatalogRefreshIntervalMs: config.modelCatalog.refreshIntervalMs,
    });
    if (validation !== null) {
      setFeedback({ tone: 'error', text: issueText(locale, validation) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(serverFileSettingsPatch(config, savedConfig));
      queryClient.setQueryData(['config'], echoed);
      const next = serverFileSettingsFromConfig(echoed);
      setConfig(next);
      setSavedConfig(next);
      markRestartRequired(['subagent']);
      setFeedback({ tone: 'success', text: t('st.sidecar.savedEcho') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-subagent-timeout" title={t('st.subagentTimeout.title')} badge={restart.required ? 'restart' : undefined}>
      <div className="space-y-4">
        <fieldset disabled={configQuery.isLoading || saving} className="space-y-4 disabled:opacity-60">
          {/* No visible label: the card title already names the field ("子代理
              超时"), so a repeated caption read as a duplicate. The input keeps
              its aria-label for screen readers. */}
          <label className="block text-[11px] font-medium text-ink-soft">
            <MsUnitInput
              value={config.subagent.timeoutMs}
              onChange={(timeoutMs) => { setConfig({ ...config, subagent: { ...config.subagent, timeoutMs } }); }}
              ariaLabel={t('st.sidecar.subagentTimeout')}
            />
          </label>
        </fieldset>
        <Hint>{t('st.subagentTimeout.hint')}</Hint>
        <button type="button" className={PRIMARY_BUTTON} disabled={configQuery.isLoading || saving || !dirty} onClick={() => void save()}>{saving ? t('st.sidecar.saving') : t('st.sidecar.save')}</button>
        {restart.required ? <Hint>{t('st.sidecar.pendingFields', { fields: restart.fields.join(', ') })}</Hint> : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * Subagents leaf (redesign §10.3): profile list (the `sub` bucket of the
 * named-agent pipeline), delegation governance, and the runtime timeout —
 * everything subagent-shaped that used to be spread across Agents and the
 * sidecar card.
 */
export function SubagentsSection() {
  return (
    <div className="space-y-4">
      <NamedAgentProfilesCard bucket="sub" />
      <SubagentGovernanceCard />
      <ExperimentalSection
        featureIds={['subagent_release_idle']}
        cardId="st-card-subagent-release-idle"
        titleKey="st.experimental.subagentIdle"
      />
      <SubagentTimeoutCard />
    </div>
  );
}
