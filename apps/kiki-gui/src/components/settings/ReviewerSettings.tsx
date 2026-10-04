import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { SearchableSelect } from '../SearchableSelect';
import { INPUT } from '../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';
import { SectionCard } from './SectionCard';
import { SETTINGS_SELECT_TRIGGER, SettingsDraftFooter, SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const CATEGORIES = ['policy_compliance', 'no_secret_egress', 'no_irreversible_damage', 'no_outward_effect', 'prompt_injection_absent'] as const;
type Category = typeof CATEGORIES[number];
interface ReviewerDraft {
  backend: 'model' | 'jev';
  model: string;
  timeoutMs: string;
  allowThreshold: string;
  denyThreshold: string;
  categories: Category[];
  apiKey: SecretDraft;
}
const DEFAULT_DRAFT: ReviewerDraft = {
  backend: 'model', model: '', timeoutMs: '8000',
  allowThreshold: '0.9', denyThreshold: '0.9', categories: [...CATEGORIES], apiKey: KEEP_SECRET,
};
function reviewerFromConfig(permission: Awaited<ReturnType<import('../../lib/client').KikiClient['getConfig']>>['permission']): ReviewerDraft {
  const reviewer = permission?.reviewer;
  return {
    backend: reviewer?.backend === 'jev' ? 'jev' : 'model',
    model: reviewer?.model ?? '',
    timeoutMs: String(reviewer?.timeoutMs ?? DEFAULT_DRAFT.timeoutMs),
    allowThreshold: String(reviewer?.allowThreshold ?? DEFAULT_DRAFT.allowThreshold),
    denyThreshold: String(reviewer?.denyThreshold ?? DEFAULT_DRAFT.denyThreshold),
    categories: reviewer?.categories !== undefined
      ? CATEGORIES.filter((category) => reviewer.categories.includes(category))
      : [...CATEGORIES],
    apiKey: KEEP_SECRET,
  };
}
function valid(draft: ReviewerDraft): boolean {
  const timeout = Number(draft.timeoutMs);
  const allow = Number(draft.allowThreshold);
  const deny = Number(draft.denyThreshold);
  return (draft.backend !== 'model' || draft.model.trim() !== '')
    && Number.isInteger(timeout) && timeout >= 100 && timeout <= 30_000
    && allow >= 0.5 && allow <= 1 && deny >= 0.5 && deny <= 1
    && draft.categories.length > 0;
}

/**
 * Server-wide reviewer configuration. Choosing Jev is the consent to send the
 * reviewer input to TypeSafe. The API echoes only the key's source; the value
 * is fetched through the reveal route when the user asks to see it.
 */
export function ReviewerSettings() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const [baseline, setBaseline] = useState<ReviewerDraft>(DEFAULT_DRAFT);
  const [draft, setDraft] = useState<ReviewerDraft>(DEFAULT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const reviewerEcho = configQuery.data?.permission?.reviewer;
  const keySource = reviewerEcho?.apiKeySource ?? (reviewerEcho?.hasApiKey === true ? 'kiki' : 'none');
  useEffect(() => {
    if (!configQuery.data || dirty) return;
    const next = reviewerFromConfig(configQuery.data.permission);
    setBaseline(next); setDraft(next);
  }, [configQuery.data, dirty]);
  const revealKey = useCallback(async () => (await client.revealSecret({ kind: 'reviewer_api_key' })).value, [client]);
  const modelOptions = useMemo(() => buildCatalogModelOptions(modelsQuery.data?.items ?? [], t), [modelsQuery.data, t]);
  const update = (patch: Partial<ReviewerDraft>) => { setDraft((current) => ({ ...current, ...patch })); setFeedback(null); };
  const save = async () => {
    if (!valid(draft) || !dirty) return;
    setSaving(true); setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        permission: { reviewer: {
          backend: draft.backend, model: draft.model.trim() || undefined,
          api_key: draft.apiKey.mode === 'clear' ? null
            : draft.apiKey.mode === 'set' && draft.apiKey.value.trim() !== '' ? draft.apiKey.value.trim() : undefined,
          timeout_ms: Number(draft.timeoutMs),
          allow_threshold: Number(draft.allowThreshold), deny_threshold: Number(draft.denyThreshold),
          categories: draft.categories,
        } },
      });
      queryClient.setQueryData(['config'], echoed);
      const next = reviewerFromConfig(echoed.permission);
      setBaseline(next); setDraft(next);
      pingSaved();
    } catch (error) { setFeedback({ tone: 'error', text: errorText(locale, error) }); }
    finally { setSaving(false); }
  };
  return <SectionCard id="st-card-reviewer" title={t('st.reviewer.title')}>
    <div className="space-y-3" data-reviewer-settings>
      <Hint>{t('st.reviewer.hint')}</Hint>
      <fieldset disabled={saving || configQuery.isLoading} className="space-y-4 disabled:opacity-60">
        <div className="space-y-1.5" data-reviewer-backend>
          <span id="reviewer-backend-label" className="block text-[13px] font-medium text-ink">{t('st.reviewer.backend')}</span>
          <SettingsSegmented<ReviewerDraft['backend']> ariaLabelledBy="reviewer-backend-label" dataAttr="data-reviewer-backend-choice"
            value={draft.backend} onChange={(backend) => update({ backend })}
            choices={[{ value: 'model', label: t('st.reviewer.modelBackend') }, { value: 'jev', label: t('st.reviewer.jevBackend') }]} />
        </div>
        {draft.backend === 'model' ? <div className="space-y-1.5">
          <label htmlFor="reviewer-model" className="block text-[13px] font-medium text-ink">{t('st.reviewer.model')}</label>
          <SearchableSelect id="reviewer-model" value={draft.model} options={modelOptions}
            allowCustomValue ariaLabel={t('st.reviewer.model')} emptyText={t('st.reviewer.modelEmpty')}
            buttonClassName={`${SETTINGS_SELECT_TRIGGER} min-w-56`}
            onChange={(model) => update({ model })} />
        </div> : <div className="max-w-xl border-l-2 border-hairline pl-3" data-reviewer-jev>
          <SecretField id="reviewer-api-key" label={t('st.reviewer.key')} source={keySource}
            envName={reviewerEcho?.apiKeyEnv} draft={draft.apiKey} onChange={(apiKey) => update({ apiKey })}
            reveal={keySource === 'none' ? undefined : revealKey} hint={t('st.reviewer.keyHint')} />
        </div>}
        <div className="grid gap-3 sm:grid-cols-3">
          {(['timeoutMs', 'allowThreshold', 'denyThreshold'] as const).map((key) => <label key={key} className="block space-y-1.5">
            <span className="block text-[13px] font-medium text-ink">{t(`st.reviewer.${key}` as I18nKey)}</span>
            <input type="number" className={`${INPUT} text-[13px] tabular-nums`} value={draft[key]}
              min={key === 'timeoutMs' ? 100 : 0.5} max={key === 'timeoutMs' ? 30_000 : 1}
              step={key === 'timeoutMs' ? 100 : 0.01}
              onChange={(event) => update({ [key]: event.target.value })} /></label>)}
        </div>
        <fieldset className="space-y-1"><legend className="mb-1.5 text-[13px] font-medium text-ink">{t('st.reviewer.categories')}</legend>
          {CATEGORIES.map((category) => <label key={category} className="flex min-h-7 cursor-pointer items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-selected-ink)]" checked={draft.categories.includes(category)} onChange={(event) => update({
              categories: event.target.checked ? [...draft.categories, category] : draft.categories.filter((item) => item !== category),
            })} />{t(`st.reviewer.category.${category}` as I18nKey)}</label>)}
        </fieldset>
      </fieldset>
      <SettingsDraftFooter saved={justSaved} id="permission-reviewer" dirty={dirty} saving={saving} saveDisabled={!valid(draft)}
        onSave={() => void save()} onDiscard={() => { setDraft(baseline); setFeedback(null); }} />
      {dirty && !valid(draft) ? <p role="alert" className="text-[12px] text-danger">{t('st.reviewer.invalid')}</p> : null}
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      <FeedbackLine feedback={feedback} />
    </div>
  </SectionCard>;
}
