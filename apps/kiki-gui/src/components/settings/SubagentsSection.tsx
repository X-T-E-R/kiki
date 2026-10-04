import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { I18nKey } from '@kiki/session-core/i18n';

import {
  agentProfileSourceLabelKey,
  mergeNamedAgentProfiles,
  readSettings,
  subagentDefaultTargetFromConfig,
  subagentDefaultTargetPatch,
  writeSettings,
  type SubagentDefaultTarget,
  type SubagentPanelOpenMode,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { loadAgentProfileCatalog } from '../../lib/agentProfileCatalog';
import type { NamedAgentProfile } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus } from '../controls';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { SubagentGovernanceCard } from './AgentsSection';
import { SettingField } from './fields';
import { SectionCard } from './SectionCard';
import { SETTINGS_SELECT_TRIGGER, SettingsSegmented } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';
import { dispatchFieldsOf } from './profileEditor/profileDraft';
import { SubagentToolSettingsCard } from './subagentTools/ToolSettingsCard';

const STRICT_TARGET_VALUE = '__strict__';

/** How this profile's own dispatch rights read as one short label. */
function dispatchSummaryKey(profile: NamedAgentProfile): I18nKey {
  const dispatch = dispatchFieldsOf(profile);
  if (dispatch.can_spawn_subagents === false) return 'st.profiles.dispatchCanSpawnOff';
  if (dispatch.allowed_subagents === undefined) return 'st.profiles.dispatchNotDeclared';
  return dispatch.allowed_subagents.length === 0 ? 'st.profiles.dispatchAllowedEmpty' : 'st.profiles.dispatchCanSpawnOn';
}

/**
 * Default subagent target (redesign §5.1/§7): the server-wide
 * `[subagent].default_profile` as a selector — "require explicit" (strict) or
 * one loaded subagent profile. Only omitted targets resolve through it; the
 * engine default (`general`) applies while the key is unset. Saves on select,
 * like the other single-choice server settings.
 */
export function SubagentDefaultTargetCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const saving = save.saving;
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
        { label: t(dispatchSummaryKey(profile)) },
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
    await save.run(async () => {
      const echoed = await client.patchConfig(subagentDefaultTargetPatch(target));
      queryClient.setQueryData(['config'], echoed);
    });
  };

  // Secondary text, not badges: the source, policy and model pin of the chosen
  // profile are one quiet line of facts under the selector.
  const summaryParts: string[] = [];
  if (selectedProfile !== undefined) {
    const sourceKey = agentProfileSourceLabelKey(selectedProfile.source);
    summaryParts.push(sourceKey === undefined ? selectedProfile.source : t(sourceKey));
    summaryParts.push(t(dispatchSummaryKey(selectedProfile)));
    if (selectedProfile.pinned_model_alias !== undefined && selectedProfile.pinned_model_alias !== '') {
      summaryParts.push(`${t('st.namedAgents.modelPin')} ${selectedProfile.pinned_model_alias}`);
    }
  }

  return (
    <SectionCard id="st-card-subagent-default-target" title={t('st.subagentDefault.title')}>
      <div className="space-y-3">
        <Hint>{t('st.subagentDefault.hint')}</Hint>
        <fieldset disabled={saving || configQuery.isPending} className="disabled:opacity-60">
          <div data-subagent-default-target data-value={selectValue}>
            <SettingField label={t('st.subagentDefault.label')} labelId="subagent-default-label">
              <SaveStatus saving={save.saving} saved={save.saved} />
              <SearchableSelect
                id="subagent-default-profile-select"
                options={options}
                value={selectValue}
                onChange={(value) => { void applyTarget(value); }}
                ariaLabel={t('st.subagentDefault.label')}
                emptyText={t('st.namedAgents.loading')}
                buttonClassName={`${SETTINGS_SELECT_TRIGGER} max-w-64`}
              />
            </SettingField>
          </div>
        </fieldset>
        {current?.mode === 'strict' ? (
          <Hint>{t('st.subagentDefault.strictHint')}</Hint>
        ) : null}
        {current?.mode === 'profile' && profilesQuery.data !== undefined && selectedProfile === undefined ? (
          <div data-subagent-default-status="unresolvable">
            <FeedbackLine feedback={{ tone: 'error', text: t('st.subagentDefault.unresolvable', { name: current.name }) }} />
          </div>
        ) : null}
        {selectedProfile !== undefined ? (
          <div className="space-y-1.5" data-subagent-default-status="resolved">
            <p data-subagent-default-summary className="text-[11.5px] text-ink-faint">{summaryParts.join(' · ')}</p>
            {selectedProfile.disabled ? (
              <div data-subagent-default-status="disabled">
                <FeedbackLine feedback={{ tone: 'error', text: t('st.subagentDefault.disabledTarget', { name: selectedProfile.name }) }} />
              </div>
            ) : null}
            {selectedProfile.pinned_model_alias === undefined || selectedProfile.pinned_model_alias === '' ? (
              <Hint>{t('st.subagentDefault.noModelPin')}</Hint>
            ) : null}
          </div>
        ) : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
        <FeedbackLine feedback={save.error} />
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
        <SettingField label={t('st.subagentOpenMode.label')} labelId="subagent-open-mode-label">
          <SettingsSegmented<SubagentPanelOpenMode>
            ariaLabelledBy="subagent-open-mode-label"
            dataAttr="data-open-mode-choice"
            value={currentMode}
            choices={(['tab', 'fullscreen'] as SubagentPanelOpenMode[]).map((mode) => ({
              value: mode,
              label: t(`st.subagentOpenMode.${mode}`),
            }))}
            onChange={updateMode}
          />
        </SettingField>
        <Hint>{t('st.subagentOpenMode.hint')}</Hint>
      </div>
    </SectionCard>
  );
}

/** Subagent defaults and governance; agent definitions live in the unified Agents list. */
export function SubagentsSection() {
  return (
    <div className="space-y-4">
      <SubagentDefaultTargetCard />
      <SubagentGovernanceCard />
      <SubagentOpenModeCard />
      <SubagentToolSettingsCard />
    </div>
  );
}
