import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { errorText } from '../../i18n/locale';
import {
  parseHooksJson,
  setToolPolicy,
  toolPolicyDraftFromConfig,
  toolPolicyPatch,
  toolPolicyValue,
  type ToolPolicyDraft,
} from '../../lib/settings';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';

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
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const toolsQuery = useQuery({ queryKey: ['tools'], queryFn: () => client.listTools(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) setDraft(toolPolicyDraftFromConfig(configQuery.data));
  }, [configQuery.data]);

  const toolNames = useMemo(() => {
    const names = new Set<string>([
      ...(toolsQuery.data?.tools.map((tool) => tool.name) ?? []),
      ...(draft?.toolsEnabled ?? []),
      ...(draft?.toolsDisabled ?? []),
    ]);
    return [...names].toSorted((a, b) => a.localeCompare(b));
  }, [draft?.toolsDisabled, draft?.toolsEnabled, toolsQuery.data?.tools]);

  const save = async () => {
    if (draft === null) return;
    let patch;
    try {
      patch = toolPolicyPatch(draft);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setDraft(toolPolicyDraftFromConfig(echoed));
      // /api/v1/tools descriptors carry `active` computed from the saved
      // policy — drop the stale list, but leave mcp-servers alone (this save
      // never touches the mcp domain).
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
          <>
            {toolNames.map((name) => {
              const descriptor = toolsQuery.data?.tools.find((tool) => tool.name === name);
              return (
                <div key={name} className="grid gap-2 rounded-lg border border-hairline bg-paper px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-ink">{name}</p>
                    {descriptor !== undefined ? <p className="text-[11px] text-ink-soft">{descriptor.description}</p> : <Hint>{t('st.tools.configOnly')}</Hint>}
                  </div>
                  <select
                    className={SMALL_INPUT}
                    value={toolPolicyValue(draft, name)}
                    aria-label={t('st.tools.policyAria', { name })}
                    onChange={(event) => { setDraft(setToolPolicy(draft, name, event.target.value as 'enabled' | 'disabled' | 'inherited')); }}
                  >
                    <option value="inherited">{t('st.tools.inherited')}</option>
                    <option value="enabled">{t('st.tools.enabled')}</option>
                    <option value="disabled">{t('st.tools.disabled')}</option>
                  </select>
                </div>
              );
            })}
            {toolsQuery.isLoading ? <Hint>{t('st.tools.loading')}</Hint> : null}
            {toolsQuery.isError ? <InlineError error={toolsQuery.error} /> : null}
            <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('st.tools.savePolicy')}</button>
            <FeedbackLine feedback={feedback} />
          </>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * Hooks stay an advanced raw-JSON surface for now (redesign §8.3): one array
 * document, validated client-side, patched as the `hooks` domain.
 */
function HooksCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('[]');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) {
      setDraft(JSON.stringify(configQuery.data.hooks ?? [], null, 2));
    }
  }, [configQuery.data]);

  const save = async () => {
    let hooks: unknown[];
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
        <textarea
          className={`${INPUT} min-h-48 font-mono`}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); }}
          aria-label={t('st.hooks.aria')}
        />
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
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
      <HooksCard />
    </>
  );
}
