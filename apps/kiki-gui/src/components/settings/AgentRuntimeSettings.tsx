import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  agentIdentitySparsePatch,
  markRestartRequired,
  runtimeConfigDraftFromConfig,
  type RuntimeConfigDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { invalidateAgentProfileCatalogs } from '../../lib/agentProfileCatalog';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

type AgentIdentityDraft = Pick<
  RuntimeConfigDraft,
  | 'identityName'
  | 'identitySlug'
  | 'advertiseAsKimiCode'
  | 'extraAgentDirs'
  | 'disabledNamedProfiles'
>;

/**
 * Stable per-row keys: the entry id is minted when the row is added (or when
 * the baseline values load) and never derived from the edited text, so every
 * keystroke keeps the same input node and caret position.
 */
interface StringListEntry {
  readonly id: string;
  readonly value: string;
}

let stringListEntrySeq = 0;
function nextStringListId(): string {
  stringListEntrySeq += 1;
  return `entry-${stringListEntrySeq}`;
}

function toStringListEntries(values: readonly string[]): StringListEntry[] {
  return values.map((value) => ({ id: nextStringListId(), value }));
}

function stringListValues(entries: readonly StringListEntry[]): string[] {
  return entries.map((entry) => entry.value);
}

function stringListsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function StringListEditor({ label, values, onChange, placeholder }: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const { t } = useI18n();
  // The entries are seeded from the incoming values, then owned locally: the
  // editor re-seeds only when the value list identity changes from outside
  // (a save echo or a fresh baseline), never on the user's own edits.
  const [entries, setEntries] = useState<StringListEntry[]>(() => toStringListEntries(values));
  const lastValuesRef = useRef(values);
  if (values !== lastValuesRef.current) {
    lastValuesRef.current = values;
    if (values.length !== entries.length || values.some((value, index) => value !== entries[index]?.value)) {
      setEntries(toStringListEntries(values));
    }
  }
  const update = (next: StringListEntry[]) => {
    const nextValues = stringListValues(next);
    lastValuesRef.current = nextValues;
    setEntries(next);
    onChange(nextValues);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-ink-soft">{label}</span>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { update([...entries, { id: nextStringListId(), value: '' }]); }}>
          {t('st.agentIdentity.addEntry')}
        </button>
      </div>
      {entries.map((entry, index) => (
        <div key={entry.id} className="flex gap-2">
          <input
            className={`${INPUT} font-mono`}
            value={entry.value}
            placeholder={placeholder}
            aria-label={`${label} ${index + 1}`}
            onChange={(event) => {
              update(entries.map((candidate) => candidate === entry ? { ...candidate, value: event.target.value } : candidate));
            }}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON}
            aria-label={t('st.agentIdentity.removeEntry', { n: index + 1 })}
            onClick={() => { update(entries.filter((candidate) => candidate !== entry)); }}
          >
            ×
          </button>
        </div>
      ))}
      {entries.length === 0 ? <Hint>{t('st.agentIdentity.listEmpty')}</Hint> : null}
    </div>
  );
}

/**
 * Identity and agent-profile loading (runtime split): the server-facing
 * identity plus the profile sources loaded at startup sit next to the main
 * agent profiles they govern. Name/slug edits need a server restart.
 *
 * Field-level dirty tracking selects the domains to replace; saving identity
 * alone never writes the profile switches' server-wide disable list.
 */
export function AgentRuntimeCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AgentIdentityDraft | null>(null);
  const [saved, setSaved] = useState<AgentIdentityDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const lastConfig = useRef<typeof configQuery.data>(undefined);

  useEffect(() => {
    if (configQuery.data === undefined || configQuery.data === lastConfig.current || saving) return;
    lastConfig.current = configQuery.data;
    const projected = runtimeConfigDraftFromConfig(configQuery.data);
    const next = {
      identityName: projected.identityName,
      identitySlug: projected.identitySlug,
      advertiseAsKimiCode: projected.advertiseAsKimiCode,
      extraAgentDirs: projected.extraAgentDirs,
      disabledNamedProfiles: projected.disabledNamedProfiles,
    };
    setDraft(draft === null || saved === null ? next : {
      identityName: draft.identityName === saved.identityName ? next.identityName : draft.identityName,
      identitySlug: draft.identitySlug === saved.identitySlug ? next.identitySlug : draft.identitySlug,
      advertiseAsKimiCode: draft.advertiseAsKimiCode === saved.advertiseAsKimiCode ? next.advertiseAsKimiCode : draft.advertiseAsKimiCode,
      extraAgentDirs: stringListsEqual(draft.extraAgentDirs, saved.extraAgentDirs) ? next.extraAgentDirs : draft.extraAgentDirs,
      disabledNamedProfiles: stringListsEqual(draft.disabledNamedProfiles, saved.disabledNamedProfiles) ? next.disabledNamedProfiles : draft.disabledNamedProfiles,
    });
    setSaved(next);
  }, [configQuery.data, draft, saved, saving]);

  if (draft === null || saved === null) {
    return (
      <SectionCard id="st-card-agent-runtime" title={t('st.agentIdentity.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const updateDraft = (next: AgentIdentityDraft) => {
    setDraft(next);
  };

  const touched = {
    identityName: draft.identityName !== saved.identityName,
    identitySlug: draft.identitySlug !== saved.identitySlug,
    advertiseAsKimiCode: draft.advertiseAsKimiCode !== saved.advertiseAsKimiCode,
    extraAgentDirs: !stringListsEqual(draft.extraAgentDirs, saved.extraAgentDirs),
    disabledNamedProfiles: !stringListsEqual(draft.disabledNamedProfiles, saved.disabledNamedProfiles),
  };
  const dirty = Object.values(touched).some(Boolean);

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const identityChanged = touched.identityName || touched.identitySlug || touched.advertiseAsKimiCode;
      const echoed = await client.patchConfig(agentIdentitySparsePatch(draft, touched));
      queryClient.setQueryData(['config'], echoed);
      await invalidateAgentProfileCatalogs(queryClient);
      const projected = runtimeConfigDraftFromConfig(echoed);
      const next = {
        identityName: projected.identityName,
        identitySlug: projected.identitySlug,
        advertiseAsKimiCode: projected.advertiseAsKimiCode,
        extraAgentDirs: projected.extraAgentDirs,
        disabledNamedProfiles: projected.disabledNamedProfiles,
      };
      setDraft(next);
      setSaved(next);
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
          <div className="space-y-1.5 rounded-md border border-hairline bg-paper px-3 py-2.5">
            <Toggle
              label={t('st.agentIdentity.advertiseAsKimiCode')}
              checked={draft.advertiseAsKimiCode}
              onChange={(advertiseAsKimiCode) => { updateDraft({ ...draft, advertiseAsKimiCode }); }}
            />
            <Hint>{t('st.agentIdentity.advertiseAsKimiCodeHint')}</Hint>
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
