import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  setToolPolicy,
  toolPolicyDraftFromConfig,
  toolPolicyPatch,
  toolPolicyValue,
  type ToolPolicyDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import { SettingsDraftFooter, SettingsSelect } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

/**
 * Tool policy (Permissions leaf): per-tool enabled/disabled/inherited. The save goes through the narrow `toolPolicyPatch`
 * (`replace_domains: ['tools']`), so it can never roll back runtime or MCP
 * values edited on their own leaves.
 */
export function ToolPolicyCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ToolPolicyDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'profile' | 'allowlist'>('profile');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const toolsQuery = useQuery({ queryKey: ['tools'], queryFn: () => client.listTools(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      const next = toolPolicyDraftFromConfig(configQuery.data);
      setDraft(next);
      setMode(next.toolsEnabled.length > 0 ? 'allowlist' : 'profile');
    }
  }, [configQuery.data, dirty]);

  const toolNames = useMemo(() => {
    const names = new Set<string>([
      ...(toolsQuery.data?.tools.map((tool) => tool.name) ?? []),
      ...(draft?.toolsEnabled ?? []),
      ...(draft?.toolsDisabled ?? []),
    ]);
    return [...names].toSorted((a, b) => a.localeCompare(b));
  }, [draft?.toolsDisabled, draft?.toolsEnabled, toolsQuery.data?.tools]);

  const emptyAllowlist = mode === 'allowlist' && draft?.toolsEnabled.length === 0;
  const edit = (next: ToolPolicyDraft) => { setDraft(next); setDirty(true); setFeedback(null); };
  const save = async () => {
    if (draft === null || emptyAllowlist) return;
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(toolPolicyPatch(draft));
      queryClient.setQueryData(['config'], echoed);
      setDraft(toolPolicyDraftFromConfig(echoed));
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['tools'] });
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-tools" title={t('st.tools.title')}>
      <div className="space-y-3">
        <Hint>{t('st.tools.policyHint')}</Hint>
        {draft === null ? (
          configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
        ) : (
          <fieldset disabled={saving} className="min-w-0 space-y-3">
            <SettingField label={t('st.tools.mode')} help={t(mode === 'profile' ? 'st.tools.profileImpact' : 'st.tools.allowlistImpact')}>
              <SettingsSelect<typeof mode>
                dataAttr="data-tool-mode"
                ariaLabel={t('st.tools.mode')}
                value={mode}
                onChange={(next) => {
                  setMode(next);
                  edit({ ...draft, toolsEnabled: next === 'profile' ? [] : draft.toolsEnabled });
                }}
                choices={[
                  { value: 'profile', label: t('st.tools.followAgent') },
                  { value: 'allowlist', label: t('st.tools.allowlist') },
                ]}
              />
            </SettingField>
            {emptyAllowlist ? <FeedbackLine feedback={{ tone: 'error', text: t('st.tools.emptyAllowlist') }} /> : null}
            <input type="search" className={INPUT} aria-label={t('st.tools.search')} placeholder={t('st.tools.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="max-h-[28rem] overflow-y-auto">
              {toolNames.filter((name) => name.toLowerCase().includes(search.toLowerCase())).map((name) => {
                const descriptor = toolsQuery.data?.tools.find((tool) => tool.name === name);
                return (
                  <div key={name} className="grid gap-2 border-b border-hairline py-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                    <div className="min-w-0">
                      <p className="break-all text-[13px] font-medium text-ink">{name}</p>
                      <p className="text-[11px] text-ink-soft">{descriptor === undefined ? t('st.tools.configOnly') : t(descriptor.active ? 'st.tools.currentOn' : 'st.tools.currentOff')}</p>
                      {descriptor !== undefined ? <AdvancedDetails summary={t('st.tools.description')}><p>{descriptor.description}</p></AdvancedDetails> : null}
                    </div>
                    <SettingsSelect<'enabled' | 'disabled' | 'inherited'>
                      dataAttr="data-tool-policy"
                      ariaLabel={t('st.tools.policyAria', { name })}
                      value={toolPolicyValue(draft, name)}
                      onChange={(next) => edit(setToolPolicy(draft, name, next))}
                      choices={[
                        { value: 'inherited', label: t(mode === 'profile' ? 'st.tools.inherited' : 'st.tools.excluded') },
                        ...(mode === 'allowlist' ? [{ value: 'enabled' as const, label: t('st.tools.enabled') }] : []),
                        { value: 'disabled', label: t('st.tools.disabled') },
                      ]}
                    />
                  </div>
                );
              })}
            </div>
            {!toolNames.some((name) => name.toLowerCase().includes(search.toLowerCase())) && !toolsQuery.isLoading ? <Hint>{t('st.tools.noMatches')}</Hint> : null}
            {toolsQuery.isLoading ? <Hint>{t('st.tools.loading')}</Hint> : null}
            {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
            <SettingsDraftFooter saved={justSaved} id="tool-policy" dirty={dirty} saving={saving} saveDisabled={emptyAllowlist} saveLabel={t('st.tools.savePolicy')}
              onSave={() => void save()}
              onDiscard={() => { if (configQuery.data !== undefined) { const next = toolPolicyDraftFromConfig(configQuery.data); setDraft(next); setMode(next.toolsEnabled.length > 0 ? 'allowlist' : 'profile'); } setDirty(false); setFeedback(null); }} />
            <FeedbackLine feedback={feedback} />
          </fieldset>
        )}
      </div>
    </SectionCard>
  );
}

// The hooks editor moved to ./hooks/HooksSection (S4-B dual-shape editor);
// this file keeps the tool-policy card for the Permissions leaf.
