import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  SUBAGENT_DEFAULT_ALLOWED_TOOL_NAMES,
  SUBAGENT_MAIN_ONLY_TOOL_NAMES,
  SUBAGENT_OPT_IN_TOOL_NAMES,
  isSubagentToolAllowed,
} from '@kiki/agent-profiles/subagentToolPolicy';
import { isToolActive } from '@kiki/agent-profiles/toolPolicy';
import { mergeNamedAgentProfiles } from '@kiki/session-core/settings';
import { subagentToolsDraftFromConfig, subagentToolsPatch } from '@kiki/session-core/settings/subagentToolsSettings';
import { useI18n } from '../../i18n';
import { loadAgentProfileCatalog } from '../../lib/agentProfileCatalog';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { useDirtyReporter } from '../dirtyGuard';

/** Edits server board opt-ins independently of the subagent profile and run settings. */
export function SubagentToolDefaultsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [profileName, setProfileName] = useState('');
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
  const saved = subagentToolsDraftFromConfig(configQuery.data).serverAllowedTools;
  const serverAllowed = draft ?? saved;
  const dirty = draft !== null && (
    draft.length !== saved.length || draft.some((name) => !saved.includes(name))
  );
  useDirtyReporter('subagent-tool-defaults', dirty);

  const profiles = useMemo(() => {
    const merged = mergeNamedAgentProfiles(profilesQuery.data?.items ?? []);
    return [...new Map(merged
      .filter((profile) => !profile.main && !profile.disabled)
      .map((profile) => [profile.name, profile])).values()]
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }, [profilesQuery.data]);
  const selectedProfile = profiles.find((profile) => profile.name === profileName);
  const profileTools = selectedProfile?.tools;
  const profilePolicy = {
    tools: profileTools?.length === 1 && profileTools[0] === '*' ? undefined : profileTools,
    disallowedTools: selectedProfile?.disallowed_tools,
  };
  const external = selectedProfile?.executor !== undefined && selectedProfile.executor !== 'native';
  const profileAllows = (name: string) => isToolActive(profilePolicy, name);
  const configuredAllows = (name: string) => profileAllows(name) && isSubagentToolAllowed({
    allowedTools: serverAllowed,
    explicitProfileTools: profileTools,
  }, name);
  const explicitProfileAllows = (name: string) => isSubagentToolAllowed({ explicitProfileTools: profileTools }, name);
  const configuredOverrides = serverAllowed.filter((name) => (SUBAGENT_OPT_IN_TOOL_NAMES as readonly string[]).includes(name));

  const setAllowed = (name: string, allowed: boolean) => {
    setDraft(allowed ? [...new Set([...serverAllowed, name])] : serverAllowed.filter((tool) => tool !== name));
    setFeedback(null);
  };
  const persist = async (allowedTools: string[], reset = false) => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(subagentToolsPatch(allowedTools));
      queryClient.setQueryData(['config'], echoed);
      setDraft(null);
      setFeedback({ tone: 'success', text: t(reset ? 'st.subagentTools.resetDone' : 'st.subagentTools.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-subagent-tool-defaults" title={t('st.subagentTools.title')}>
      <div className="space-y-3">
        <Hint>{t('st.subagentTools.hint')}</Hint>
        <fieldset disabled={saving || configQuery.data === undefined || configQuery.isError} className="min-w-0 space-y-3 disabled:opacity-60">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wide text-ink-faint">
                  <th className="py-1.5 pr-3 font-medium">{t('st.subagentTools.colTool')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('st.subagentTools.colDefault')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('st.subagentTools.colServer')}</th>
                  {selectedProfile !== undefined ? <th className="py-1.5 font-medium">{t('st.subagentTools.colProfile')}</th> : null}
                </tr>
              </thead>
              <tbody data-subagent-tool-defaults>
                {SUBAGENT_OPT_IN_TOOL_NAMES.map((name) => (
                  <tr key={name} data-tool-row={name} className="border-t border-hairline">
                    <td className="py-2 pr-3 font-mono text-[11.5px] text-ink">{name}</td>
                    <td className="py-2 pr-3 text-ink-soft">{t('st.subagentTools.defaultOptIn')}</td>
                    <td className="py-2 pr-3">
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" data-server-allow={name} checked={serverAllowed.includes(name)}
                          aria-label={t('st.subagentTools.allowAria', { name })}
                          onChange={(event) => setAllowed(name, event.target.checked)} />
                        <span className="text-[11px] text-ink-soft">
                          {t(serverAllowed.includes(name) ? 'st.subagentTools.serverAllowed' : 'st.subagentTools.serverDefaultDisabled')}
                        </span>
                      </label>
                    </td>
                    {selectedProfile !== undefined ? (
                      <td className="py-2 text-[11px]">
                        {external ? <span className="text-ink-soft">{t('st.subagentTools.profileExternal')}</span> : (
                          <>
                            <div className={configuredAllows(name) ? 'text-ink' : 'text-ink-soft'}>
                              {t(configuredAllows(name) ? 'st.subagentTools.previewAllowed' : 'st.subagentTools.previewBlocked')}
                            </div>
                            <div className="text-ink-faint">
                              {t(!profileAllows(name) ? 'st.subagentTools.profileDenied'
                                : explicitProfileAllows(name) ? 'st.subagentTools.profileAllowed' : 'st.subagentTools.profileUnset')}
                            </div>
                          </>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
                <tr className="border-t border-hairline" data-tool-row="__default_allowed__">
                  <td className="max-w-60 py-2 pr-3 font-mono text-[11.5px] text-ink">{SUBAGENT_DEFAULT_ALLOWED_TOOL_NAMES.join(', ')}</td>
                  <td className="py-2 pr-3 text-ink-soft">{t('st.subagentTools.defaultAllowed')}</td>
                  <td className="py-2 text-[11px] text-ink-soft" colSpan={selectedProfile !== undefined ? 2 : 1}>{t('st.subagentTools.defaultAllowedHint')}</td>
                </tr>
                <tr className="border-t border-hairline" data-tool-row="__main_only__">
                  <td className="max-w-60 py-2 pr-3 font-mono text-[11.5px] text-ink">{SUBAGENT_MAIN_ONLY_TOOL_NAMES.join(', ')}</td>
                  <td className="py-2 pr-3 text-ink-soft">{t('st.subagentTools.defaultMainOnly')}</td>
                  <td className="py-2 text-[11px] text-ink-soft" colSpan={selectedProfile !== undefined ? 2 : 1}>{t('st.subagentTools.mainOnlyHint')}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <Hint>{t('st.subagentTools.mcpHint')}</Hint>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={PRIMARY_BUTTON} disabled={!dirty} data-subagent-tools-save onClick={() => void persist(serverAllowed)}>
              {saving ? t('common.saving') : t('st.subagentTools.save')}
            </button>
            <button type="button" className={SECONDARY_BUTTON} disabled={serverAllowed.length === 0 && saved.length === 0} data-subagent-tools-reset onClick={() => void persist([], true)}>
              {t('st.subagentTools.reset')}
            </button>
            {dirty ? <span role="status" className="text-[12px] text-ink-soft">{t('st.subagentTools.unsaved')}</span> : null}
          </div>
        </fieldset>
        <fieldset disabled={saving || profilesQuery.isPending} className="min-w-0 space-y-2">
          <label className="grid max-w-sm gap-1 text-[12px] text-ink">
            {t('st.subagentTools.profileLabel')}
            <select className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[12px] text-ink focus:border-accent"
              data-subagent-tools-profile-select value={profileName} aria-label={t('st.subagentTools.profileLabel')}
              onChange={(event) => setProfileName(event.target.value)}>
              <option value="">{t('st.subagentTools.profileNone')}</option>
              {profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
            </select>
          </label>
          {selectedProfile !== undefined ? (
            <div className="space-y-1" data-subagent-tools-profile-status="resolved">
              <p className="text-[11px] text-ink-soft">{t('st.subagentTools.profileSource', { source: selectedProfile.source })}</p>
              <Hint>{profileTools === undefined ? t('st.subagentTools.profileNoTools') : t('st.subagentTools.toolsList', { tools: profileTools.join(', ') || '[]' })}</Hint>
              <Hint>{selectedProfile.disallowed_tools?.length
                ? t('st.subagentTools.denyList', { tools: selectedProfile.disallowed_tools.join(', ') }) : t('st.subagentTools.profileNoDeny')}</Hint>
              <Hint>{t('st.subagentTools.profileEditorHint')}</Hint>
            </div>
          ) : null}
        </fieldset>
        <Hint>{t('st.subagentTools.runtimeHint')}</Hint>
        <Hint>{t('st.subagentTools.executorHint')}</Hint>
        {configuredOverrides.length > 0 ? <p className="text-[11px] text-ink-soft" data-subagent-tools-server-override>{t('st.subagentTools.serverOverrideList', { tools: configuredOverrides.join(', ') })}</p> : null}
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
