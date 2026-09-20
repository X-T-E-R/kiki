import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  agentIdentityPatch,
  markRestartRequired,
  runtimeConfigDraftFromConfig,
  type RuntimeConfigDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

type AgentIdentityDraft = Pick<
  RuntimeConfigDraft,
  'identityName' | 'identitySlug' | 'extraAgentDirs' | 'disabledNamedProfiles'
>;

function StringListEditor({ label, values, onChange, placeholder }: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-ink-soft">{label}</span>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { onChange([...values, '']); }}>
          {t('st.agentIdentity.addEntry')}
        </button>
      </div>
      {values.map((value, index) => (
        <div key={`${index}:${value}`} className="flex gap-2">
          <input
            className={`${INPUT} font-mono`}
            value={value}
            placeholder={placeholder}
            aria-label={`${label} ${index + 1}`}
            onChange={(event) => {
              onChange(values.map((entry, candidate) => candidate === index ? event.target.value : entry));
            }}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON}
            aria-label={t('st.agentIdentity.removeEntry', { n: index + 1 })}
            onClick={() => { onChange(values.filter((_, candidate) => candidate !== index)); }}
          >
            ×
          </button>
        </div>
      ))}
      {values.length === 0 ? <Hint>{t('st.agentIdentity.listEmpty')}</Hint> : null}
    </div>
  );
}

/**
 * Identity and agent-profile loading (runtime split): the server-facing
 * identity plus the profile sources loaded at startup sit next to the main
 * agent profiles they govern. Name/slug edits need a server restart.
 */
export function AgentRuntimeCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AgentIdentityDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      const projected = runtimeConfigDraftFromConfig(configQuery.data);
      setDraft({
        identityName: projected.identityName,
        identitySlug: projected.identitySlug,
        extraAgentDirs: projected.extraAgentDirs,
        disabledNamedProfiles: projected.disabledNamedProfiles,
      });
    }
  }, [configQuery.data, dirty]);

  if (draft === null) {
    return (
      <SectionCard id="st-card-agent-runtime" title={t('st.agentIdentity.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const updateDraft = (next: AgentIdentityDraft) => {
    setDraft(next);
    setDirty(true);
  };

  const save = async () => {
    const identityChanged = draft.identityName.trim() !== (configQuery.data?.identity?.name ?? '')
      || draft.identitySlug.trim() !== (configQuery.data?.identity?.slug ?? '');
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(agentIdentityPatch(draft));
      queryClient.setQueryData(['config'], echoed);
      const projected = runtimeConfigDraftFromConfig(echoed);
      setDraft({
        identityName: projected.identityName,
        identitySlug: projected.identitySlug,
        extraAgentDirs: projected.extraAgentDirs,
        disabledNamedProfiles: projected.disabledNamedProfiles,
      });
      setDirty(false);
      if (identityChanged) markRestartRequired(['identity']);
      setFeedback({ tone: 'success', text: t('st.agentIdentity.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-agent-runtime" title={t('st.agentIdentity.title')}>
      <div className="space-y-4">
        <Hint>{t('st.agentIdentity.hint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] font-medium text-ink-soft">{t('st.agentIdentity.identityName')}
              <input className={`${INPUT} mt-1`} value={draft.identityName} onChange={(event) => { updateDraft({ ...draft, identityName: event.target.value }); }} />
            </label>
            <label className="text-[11px] font-medium text-ink-soft">{t('st.agentIdentity.identitySlug')}
              <input className={`${INPUT} mt-1 font-mono`} value={draft.identitySlug} onChange={(event) => { updateDraft({ ...draft, identitySlug: event.target.value }); }} />
            </label>
          </div>
          <StringListEditor label={t('st.agentIdentity.extraAgentDirs')} values={draft.extraAgentDirs} placeholder="C:\agents" onChange={(extraAgentDirs) => { updateDraft({ ...draft, extraAgentDirs }); }} />
          <StringListEditor label={t('st.agentIdentity.disabledProfiles')} values={draft.disabledNamedProfiles} placeholder="profile-name" onChange={(disabledNamedProfiles) => { updateDraft({ ...draft, disabledNamedProfiles }); }} />
        </fieldset>
        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
          <button type="button" className={PRIMARY_BUTTON} disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
          {dirty ? <span className="text-[11px] font-medium text-amber-ink">{t('st.tools.unsaved')}</span> : null}
        </div>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
