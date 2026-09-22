import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  mergeNamedAgentProfiles,
  readSettings,
  subagentDefaultTargetFromConfig,
  subagentDefaultTargetPatch,
  writeSettings,
  type SubagentDefaultTarget,
  type SubagentPanelOpenMode,
} from '@kiki/session-core/settings';
import { subagentLimitsFromConfig } from '@kiki/session-core/settings/agentCapabilitiesSettings';
import { useI18n } from '../../i18n';
import { loadAgentProfileCatalog } from '../../lib/agentProfileCatalog';
import type { NamedAgentProfile } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { MsUnitInput } from '../ProviderFields';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { SECONDARY_BUTTON } from '../ui';
import { NamedAgentProfilesCard, SubagentGovernanceCard } from './AgentsSection';
import { ExperimentalSection } from './ExperimentalSection';
import { SectionCard } from './SectionCard';
import { SubagentToolDefaultsCard } from './SubagentToolDefaultsCard';

const STRICT_TARGET_VALUE = '__strict__';

/**
 * Default subagent target (redesign §5.1/§7): the server-wide
 * `[subagent].default_profile` as a selector — "require explicit" (strict) or
 * one loaded subagent profile. Only omitted targets resolve through it; the
 * engine default (`general`) applies while the key is unset. Saves on select,
 * like the other single-choice server settings.
 */
export function SubagentDefaultTargetCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  const profilesQuery = useQuery({
    queryKey: ['named-agent-profiles', 'global'],
    queryFn: () => loadAgentProfileCatalog(client, { mode: 'global' }),
    staleTime: 15_000,
  });

  const current: SubagentDefaultTarget | undefined = configQuery.data === undefined
    ? undefined
    : subagentDefaultTargetFromConfig(configQuery.data);
  const profiles = useMemo(
    () => mergeNamedAgentProfiles(profilesQuery.data?.items ?? []),
    [profilesQuery.data],
  );
  // Selectable targets: loaded, enabled subagent profiles. A configured value
  // that is missing or disabled stays visible so the combobox never lies about
  // what is saved. Names dedupe: the config value is a bare profile name, and
  // same-named rows (a built-in plus its overriding file) are one dispatch target.
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    return profiles
      .filter((profile) => !profile.main && !profile.disabled)
      .filter((profile) => {
        if (seen.has(profile.name)) return false;
        seen.add(profile.name);
        return true;
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }, [profiles]);
  const selectedProfile: NamedAgentProfile | undefined = current?.mode === 'profile'
    ? profiles.find((profile) => profile.name === current.name)
    : undefined;
  const selectValue = current === undefined
    ? ''
    : current.mode === 'strict'
      ? STRICT_TARGET_VALUE
      : current.name;
  const options = useMemo<readonly SearchableSelectOption[]>(() => {
    const profileOptions: SearchableSelectOption[] = candidates.map((profile) => ({
      value: profile.name,
      label: profile.name,
      description: profile.description ?? profile.when_to_use,
      hint: profile.pinned_model_alias,
      badges: [
        { label: profile.source },
        ...(profile.subagent_policy === undefined
          ? []
          : [{ label: t(`agentPanel.subagentPolicy.${profile.subagent_policy}`) }]),
      ],
    }));
    const values = new Set(profileOptions.map((option) => option.value));
    if (current?.mode === 'profile' && !values.has(current.name)) {
      profileOptions.push({
        value: current.name,
        label: current.name,
        description: selectedProfile?.disabled
          ? t('st.subagentDefault.disabledTarget', { name: current.name })
          : profilesQuery.data === undefined
            ? undefined
            : t('st.subagentDefault.unresolvable', { name: current.name }),
        badges: selectedProfile === undefined ? undefined : [{ label: selectedProfile.source }],
      });
    }
    return [
      {
        value: STRICT_TARGET_VALUE,
        label: t('st.subagentDefault.strict'),
        description: t('st.subagentDefault.strictHint'),
      },
      ...profileOptions,
    ];
  }, [candidates, current, profilesQuery.data, selectedProfile, t]);

  const applyTarget = async (value: string) => {
    const target: SubagentDefaultTarget = value === STRICT_TARGET_VALUE
      ? { mode: 'strict' }
      : { mode: 'profile', name: value };
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(subagentDefaultTargetPatch(target));
      queryClient.setQueryData(['config'], echoed);
      setFeedback({ tone: 'success', text: t('st.subagentDefault.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const summaryChips: string[] = [];
  if (selectedProfile !== undefined) {
    summaryChips.push(selectedProfile.source);
    summaryChips.push(selectedProfile.subagent_policy === undefined
      ? t('diagnostics.unknown')
      : t(`agentPanel.subagentPolicy.${selectedProfile.subagent_policy}`));
    if (selectedProfile.pinned_model_alias !== undefined && selectedProfile.pinned_model_alias !== '') {
      summaryChips.push(`${t('st.namedAgents.modelPin')} ${selectedProfile.pinned_model_alias}`);
    }
  }

  return (
    <SectionCard id="st-card-subagent-default-target" title={t('st.subagentDefault.title')}>
      <div className="space-y-3">
        <Hint>{t('st.subagentDefault.hint')}</Hint>
        <fieldset disabled={saving || configQuery.isPending} className="space-y-3 disabled:opacity-60">
          <div data-subagent-default-target data-value={selectValue}>
            <p className="text-[11px] font-medium text-ink-soft">{t('st.subagentDefault.label')}</p>
            <SearchableSelect
              id="subagent-default-profile-select"
              options={options}
              value={selectValue}
              onChange={(value) => { void applyTarget(value); }}
              ariaLabel={t('st.subagentDefault.label')}
              emptyText={t('st.namedAgents.loading')}
              buttonClassName="mt-1 flex w-full max-w-sm items-center justify-between gap-2 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-left text-[12px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint"
            />
          </div>
        </fieldset>
        {current?.mode === 'strict' ? (
          <Hint>{t('st.subagentDefault.strictHint')}</Hint>
        ) : null}
        {current?.mode === 'profile' && profilesQuery.data !== undefined && selectedProfile === undefined ? (
          <p data-subagent-default-status="unresolvable" className="text-[10.5px] text-danger">
            {t('st.subagentDefault.unresolvable', { name: current.name })}
          </p>
        ) : null}
        {selectedProfile !== undefined ? (
          <div className="space-y-1.5" data-subagent-default-status="resolved">
            <div className="flex flex-wrap gap-1.5">
              {summaryChips.map((chip) => (
                <span key={chip} className="rounded-full border border-hairline bg-panel px-1.5 py-px font-mono text-[9.5px] text-ink-faint">{chip}</span>
              ))}
            </div>
            {selectedProfile.disabled ? (
              <p data-subagent-default-status="disabled" className="text-[10.5px] text-danger">
                {t('st.subagentDefault.disabledTarget', { name: selectedProfile.name })}
              </p>
            ) : null}
            {selectedProfile.pinned_model_alias === undefined || selectedProfile.pinned_model_alias === '' ? (
              <Hint>{t('st.subagentDefault.noModelPin')}</Hint>
            ) : null}
          </div>
        ) : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

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
 * Subagents leaf (redesign §10.3): the default dispatch target, the profile
 * list (the `sub` bucket of the named-agent pipeline), delegation governance,
 * and the runtime timeout — everything subagent-shaped that used to be spread
 * across Agents and the sidecar card.
 */
export function SubagentsSection() {
  return (
    <div className="space-y-4">
      <SubagentToolDefaultsCard />
      <SubagentDefaultTargetCard />
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
