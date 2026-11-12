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
import { SettingField } from './fields';
import { SettingHelp } from './SettingHelp';
import { SettingsDraftFooter, SettingsSelect, TEXT_BUTTON } from './SettingsPrimitives';
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
  const [adjusting, setAdjusting] = useState(false);
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
      ...(draft?.toolsRestored ?? []),
    ]);
    return [...names].toSorted((a, b) => a.localeCompare(b));
  }, [draft?.toolsDisabled, draft?.toolsEnabled, draft?.toolsRestored, toolsQuery.data?.tools]);

  const emptyAllowlist = mode === 'allowlist' && draft?.toolsEnabled.length === 0;
  const hasPerToolOverrides = draft !== null && (
    draft.toolsEnabled.length > 0
    || draft.toolsDisabled.length > 0
    || (draft.toolsRestored?.length ?? 0) > 0
  );
  const showAllFollowSummary = draft !== null
    && mode === 'profile'
    && !hasPerToolOverrides
    && !dirty
    && !adjusting;

  const filteredTools = useMemo(
    () => toolNames.filter((name) => name.toLowerCase().includes(search.toLowerCase())),
    [search, toolNames],
  );
  const descriptorsByName = useMemo(
    () => new Map((toolsQuery.data?.tools ?? []).map((tool) => [tool.name, tool])),
    [toolsQuery.data?.tools],
  );
  const availableTools = useMemo(
    () => filteredTools.filter((name) => descriptorsByName.get(name)?.active !== false),
    [descriptorsByName, filteredTools],
  );
  const unavailableTools = useMemo(
    () => filteredTools.filter((name) => descriptorsByName.get(name)?.active === false),
    [descriptorsByName, filteredTools],
  );

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

  const renderToolRow = (name: string) => {
    const descriptor = descriptorsByName.get(name);
    return (
      <div key={name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-hairline py-2">
        <div className="min-w-0" data-tool-row={name}>
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="break-all text-[13px] font-medium text-ink">{name}</p>
            {descriptor !== undefined && descriptor.description.trim() !== '' ? (
              <SettingHelp>{descriptor.description}</SettingHelp>
            ) : null}
          </div>
          {descriptor === undefined ? (
            <p data-tool-state="config-only" className="text-[11px] text-ink-faint">
              {t('st.tools.configOnly')}
            </p>
          ) : null}
        </div>
        <SettingsSelect<'enabled' | 'disabled' | 'inherited'>
          dataAttr="data-tool-policy"
          ariaLabel={t('st.tools.policyAria', { name })}
          value={draft === null ? 'inherited' : toolPolicyValue(draft, name)}
          onChange={(next) => { if (draft !== null) edit(setToolPolicy(draft, name, next, mode)); }}
          choices={[
            { value: 'inherited', label: t(mode === 'profile' ? 'st.tools.inherited' : 'st.tools.excluded') },
            ...(mode === 'allowlist' || descriptor?.active === false || draft?.toolsRestored?.includes(name) === true
              ? [{ value: 'enabled' as const, label: t('st.tools.enabled') }]
              : []),
            { value: 'disabled', label: t('st.tools.disabled') },
          ]}
        />
      </div>
    );
  };

  return (
    <SectionCard id="st-card-tools" title={t('st.tools.title')}>
      <div className="space-y-3">
        {draft === null ? (
          configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
        ) : showAllFollowSummary ? (
          <div data-tools-all-follow className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <p className="text-[13px] leading-5 text-ink">{t('st.permissions.tools.allFollow')}</p>
            <button
              type="button"
              data-tools-adjust
              className={`min-h-7 shrink-0 pointer-coarse:min-h-10 ${TEXT_BUTTON}`}
              onClick={() => { setAdjusting(true); }}
            >
              {t('st.permissions.tools.adjust')}
            </button>
          </div>
        ) : (
          <>
            <Hint>{t('st.tools.policyHint')}</Hint>
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
                {availableTools.map(renderToolRow)}
                {unavailableTools.length > 0 ? (
                  <div className={availableTools.length > 0 ? 'pt-3' : undefined}>
                    <p data-tools-unavailable-heading className="border-b border-hairline pb-1.5 text-[12px] font-medium text-ink-soft">
                      {t('st.permissions.tools.unavailable', { count: unavailableTools.length })}
                    </p>
                    {unavailableTools.map(renderToolRow)}
                  </div>
                ) : null}
              </div>
              {filteredTools.length === 0 && !toolsQuery.isLoading ? <Hint>{t('st.tools.noMatches')}</Hint> : null}
              {toolsQuery.isLoading ? <Hint>{t('st.tools.loading')}</Hint> : null}
              {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
              <SettingsDraftFooter saved={justSaved} id="tool-policy" dirty={dirty} saving={saving} saveDisabled={emptyAllowlist} saveLabel={t('st.tools.savePolicy')}
                onSave={() => void save()}
                onDiscard={() => { if (configQuery.data !== undefined) { const next = toolPolicyDraftFromConfig(configQuery.data); setDraft(next); setMode(next.toolsEnabled.length > 0 ? 'allowlist' : 'profile'); } setDirty(false); setFeedback(null); }} />
              <FeedbackLine feedback={feedback} />
            </fieldset>
          </>
        )}
      </div>
    </SectionCard>
  );
}

// The hooks editor moved to ./hooks/HooksSection (S4-B dual-shape editor);
// this file keeps the tool-policy card for the Permissions leaf.
