import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  HOOK_EVENTS,
  type SettingsHook,
  parseHooksJson,
  setToolPolicy,
  toolPolicyDraftFromConfig,
  toolPolicyPatch,
  toolPolicyValue,
  type ToolPolicyDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT, DANGER_GHOST_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { ExperimentalSection } from './ExperimentalSection';

/**
 * Tool policy (redesign §8.3): per-tool enabled/disabled/inherited, split out
 * of the runtime editor. The save goes through the narrow `toolPolicyPatch`
 * (`replace_domains: ['tools']`), so it can never roll back runtime or MCP
 * values edited on their own leaves.
 */
function ToolPolicyCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ToolPolicyDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'profile' | 'allowlist'>('profile');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
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
      setFeedback({ tone: 'success', text: t('st.runtime.saved') });
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
            <label className="grid gap-1 text-[13px] text-ink">
              {t('st.tools.mode')}
              <select className={INPUT} aria-label={t('st.tools.mode')} value={mode} onChange={(event) => {
                const next = event.target.value as typeof mode;
                setMode(next);
                edit({ ...draft, toolsEnabled: next === 'profile' ? [] : draft.toolsEnabled });
              }}>
                <option value="profile">{t('st.tools.followAgent')}</option>
                <option value="allowlist">{t('st.tools.allowlist')}</option>
              </select>
            </label>
            <Hint>{t(mode === 'profile' ? 'st.tools.profileImpact' : 'st.tools.allowlistImpact')}</Hint>
            {emptyAllowlist ? <p role="alert" className="text-[12px] text-ink">{t('st.tools.emptyAllowlist')}</p> : null}
            <input type="search" className={INPUT} aria-label={t('st.tools.search')} placeholder={t('st.tools.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="max-h-[28rem] overflow-y-auto">
              {toolNames.filter((name) => name.toLowerCase().includes(search.toLowerCase())).map((name) => {
                const descriptor = toolsQuery.data?.tools.find((tool) => tool.name === name);
                return (
                  <div key={name} className="grid gap-2 border-b border-hairline py-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                    <div className="min-w-0">
                      <p className="break-all text-[13px] font-medium text-ink">{name}</p>
                      <p className="text-[11px] text-ink-soft">{descriptor === undefined ? t('st.tools.configOnly') : t(descriptor.active ? 'st.tools.currentOn' : 'st.tools.currentOff')}</p>
                      {descriptor !== undefined ? <details className="text-[11px] text-ink-soft"><summary className="cursor-pointer">{t('st.tools.description')}</summary>{descriptor.description}</details> : null}
                    </div>
                    <select className={SMALL_INPUT} value={toolPolicyValue(draft, name)} aria-label={t('st.tools.policyAria', { name })}
                      onChange={(event) => edit(setToolPolicy(draft, name, event.target.value as 'enabled' | 'disabled' | 'inherited'))}>
                      <option value="inherited">{t(mode === 'profile' ? 'st.tools.inherited' : 'st.tools.excluded')}</option>
                      {mode === 'allowlist' ? <option value="enabled">{t('st.tools.enabled')}</option> : null}
                      <option value="disabled">{t('st.tools.disabled')}</option>
                    </select>
                  </div>
                );
              })}
            </div>
            {!toolNames.some((name) => name.toLowerCase().includes(search.toLowerCase())) && !toolsQuery.isLoading ? <Hint>{t('st.tools.noMatches')}</Hint> : null}
            {toolsQuery.isLoading ? <Hint>{t('st.tools.loading')}</Hint> : null}
            {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={PRIMARY_BUTTON} disabled={!dirty || emptyAllowlist} onClick={() => void save()}>{saving ? t('common.saving') : t('st.tools.savePolicy')}</button>
              {dirty ? <span role="status" className="text-[12px] text-ink-soft">{t('st.tools.unsaved')}</span> : null}
            </div>
            <FeedbackLine feedback={feedback} />
          </fieldset>
        )}
      </div>
    </SectionCard>
  );
}

function HooksCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('[]');
  const [rules, setRules] = useState<SettingsHook[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      const json = JSON.stringify(configQuery.data.hooks ?? [], null, 2);
      setDraft(json);
      try { setRules(parseHooksJson(json)); } catch { setAdvanced(true); }
    }
  }, [configQuery.data, dirty]);

  const edit = (next: SettingsHook[]) => {
    setRules(next);
    setDraft(JSON.stringify(next, null, 2));
    setDirty(true);
    setFeedback(null);
  };
  const update = (index: number, patch: Partial<SettingsHook>) => edit(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  const switchEditor = () => {
    if (advanced) {
      try { setRules(parseHooksJson(draft)); } catch (error) {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
        return;
      }
    }
    setAdvanced(!advanced);
    setFeedback(null);
  };
  const save = async () => {
    let hooks: SettingsHook[];
    try {
      hooks = parseHooksJson(draft);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ hooks });
      queryClient.setQueryData(['config'], echoed);
      setDraft(JSON.stringify(echoed.hooks ?? [], null, 2));
      setDirty(false);
      setFeedback({ tone: 'success', text: t('st.hooks.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-hooks" title={t('st.hooks.title')}>
      <div className="space-y-3">
        <Hint>{t('st.hooks.hint')}</Hint>
        {configQuery.isLoading ? <Hint>{t('st.runtime.loading')}</Hint> : null}
        <fieldset disabled={saving || configQuery.data === undefined} className="min-w-0 space-y-3">
          <div className="flex justify-end">
            <button type="button" className="text-[12px] font-medium text-accent hover:underline" onClick={switchEditor}>{t(advanced ? 'st.hooks.form' : 'st.hooks.advanced')}</button>
          </div>
          {advanced ? (
            <textarea className={`${INPUT} min-h-48 font-mono`} value={draft} onChange={(event) => { setDraft(event.target.value); setDirty(true); setFeedback(null); }} aria-label={t('st.hooks.aria')} />
          ) : (
            <>
              {rules.length === 0 ? <Hint>{t('st.hooks.empty')}</Hint> : null}
              {rules.map((rule, index) => (
                <fieldset key={index} className="min-w-0 space-y-2 border-b border-hairline pb-4">
                  <legend className="text-[13px] font-medium text-ink">{t('st.hooks.rule', { rule: index + 1 })}</legend>
                  <label className="grid gap-1 text-[12px] text-ink">{t('st.hooks.event')}
                    <select className={INPUT} aria-label={t('st.hooks.event')} value={rule.event} onChange={(event) => update(index, { event: event.target.value as SettingsHook['event'] })}>
                      {HOOK_EVENTS.map((event) => <option key={event} value={event}>{t(`st.hooks.event.${event}`)}</option>)}
                    </select>
                  </label>
                  <label className="grid gap-1 text-[12px] text-ink">{t('st.hooks.command')}
                    <textarea className={`${INPUT} min-h-16 font-mono`} value={rule.command} onChange={(event) => update(index, { command: event.target.value })} />
                  </label>
                  <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem]">
                    <label className="grid gap-1 text-[12px] text-ink">{t('st.hooks.matcher')}
                      <input className={INPUT} value={rule.matcher ?? ''} onChange={(event) => update(index, { matcher: event.target.value || undefined })} />
                    </label>
                    <label className="grid gap-1 text-[12px] text-ink">{t('st.hooks.timeout')}
                      <input type="number" min={1} max={600} step={1} placeholder="30" className={INPUT} value={rule.timeout ?? ''} onChange={(event) => update(index, { timeout: event.target.value === '' ? undefined : Number(event.target.value) })} />
                    </label>
                  </div>
                  <Hint>{t('st.hooks.matchHint')}</Hint>
                  <button type="button" className={DANGER_GHOST_BUTTON} aria-label={t('st.hooks.removeRule', { rule: index + 1 })} onClick={() => edit(rules.filter((_, i) => i !== index))}>{t('st.hooks.remove')}</button>
                </fieldset>
              ))}
              <button type="button" className={SECONDARY_BUTTON} onClick={() => edit([...rules, { event: 'PreToolUse', command: '' }])}>{t('st.hooks.add')}</button>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={PRIMARY_BUTTON} disabled={!dirty} onClick={() => void save()}>{saving ? t('common.saving') : t('st.hooks.save')}</button>
            {dirty ? <span role="status" className="text-[12px] text-ink-soft">{t('st.tools.unsaved')}</span> : null}
          </div>
        </fieldset>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

export function AutomationSection() {
  return (
    <>
      <ToolPolicyCard />
      <ExperimentalSection featureIds={['tool-select', 'task_wait']} cardId="st-card-tool-experiments" titleKey="st.experimental.toolsTitle" />
      <HooksCard />
    </>
  );
}
