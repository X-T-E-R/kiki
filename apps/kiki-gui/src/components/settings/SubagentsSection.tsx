import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { readSettings, writeSettings, type SubagentPanelOpenMode } from '@kiki/session-core/settings';
import { subagentLimitsFromConfig } from '@kiki/session-core/settings/agentCapabilitiesSettings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Hint, InlineError } from '../controls';
import { MsUnitInput } from '../ProviderFields';
import { SECONDARY_BUTTON } from '../ui';
import { NamedAgentProfilesCard, SubagentGovernanceCard } from './AgentsSection';
import { ExperimentalSection } from './ExperimentalSection';
import { SectionCard } from './SectionCard';

function SubagentOpenModeCard() {
  const { t } = useI18n();
  const [settings, setSettings] = useState(readSettings);

  const updateMode = (mode: SubagentPanelOpenMode) => {
    setSettings((prev) => ({ ...prev, subagentPanelOpenMode: mode }));
    writeSettings({ subagentPanelOpenMode: mode });
  };

  const currentMode = settings.subagentPanelOpenMode ?? 'tab';

  return (
    <SectionCard id="st-card-subagent-open-mode" title={t('st.subagentOpenMode.title')}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span id="subagent-open-mode-label" className="text-[12.5px] font-medium text-ink">
            {t('st.subagentOpenMode.label')}
          </span>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="subagent-open-mode-label">
            {(['tab', 'fullscreen'] as SubagentPanelOpenMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                data-open-mode-choice={mode}
                aria-pressed={currentMode === mode}
                onClick={() => { updateMode(mode); }}
                className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                  currentMode === mode
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-hairline text-ink-soft hover:border-hairline-strong'
                }`}
              >
                {t(`st.subagentOpenMode.${mode}`)}
              </button>
            ))}
          </div>
        </div>
        <Hint>{t('st.subagentOpenMode.hint')}</Hint>
      </div>
    </SectionCard>
  );
}

/**
 * Subagent timeout — the read-only half of `[subagent].timeout_ms`. The
 * execution-limits card owns the only editor for that field (it also owns the
 * in-flight caps), so this card shows the effective server value and jumps
 * there instead of writing the same key a second time. The server resolves the
 * timeout from live config when a subagent is dispatched, so a saved value
 * applies to later dispatches and never retimes a running one — the same
 * sentence the limits card shows, instead of the old "needs a restart" claim.
 */
function SubagentTimeoutCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  const timeoutMs = configQuery.data === undefined
    ? undefined
    : subagentLimitsFromConfig(configQuery.data).timeoutMs;

  return (
    <SectionCard id="st-card-subagent-timeout" title={t('st.subagentTimeout.title')}>
      <div className="space-y-3">
        {timeoutMs === undefined ? null : (
          <MsUnitInput
            value={timeoutMs}
            onChange={() => undefined}
            disabled
            ariaLabel={t('st.sidecar.subagentTimeout')}
          />
        )}
        <Hint>{t('st.subagentTimeout.readOnly')}</Hint>
        <Hint>{t('st.subagentTimeout.effective')}</Hint>
        <Hint>{t('st.subagentTimeout.envBound')}</Hint>
        <button
          type="button"
          data-subagent-timeout-edit
          className={SECONDARY_BUTTON}
          onClick={() => { void navigate('/settings/subagents#st-card-subagent-limits'); }}
        >
          {`${t('st.subagentLimits.title')} →`}
        </button>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
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
      <SubagentOpenModeCard />
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
