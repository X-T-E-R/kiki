import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { INPUT } from '../ui';
import { DecisionSourceSummary } from './DecisionSources';
import { SectionCard } from './SectionCard';
import { AdvancedDetails } from './fields';
import { SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const CATEGORIES = ['policy_compliance', 'no_secret_egress', 'no_irreversible_damage', 'no_outward_effect', 'prompt_injection_absent'] as const;
type Category = typeof CATEGORIES[number];
interface ReviewerDraft {
  timeoutMs: string;
  allowThreshold: string;
  denyThreshold: string;
  categories: Category[];
}
const DEFAULT_DRAFT: ReviewerDraft = {
  timeoutMs: '8000', allowThreshold: '0.9', denyThreshold: '0.9', categories: [...CATEGORIES],
};
type ReviewerEcho = NonNullable<NonNullable<Awaited<ReturnType<import('../../lib/client').KikiClient['getConfig']>>['permission']>['reviewer']>;
function reviewerFromConfig(reviewer: ReviewerEcho | undefined): ReviewerDraft {
  return {
    timeoutMs: String(reviewer?.timeoutMs ?? DEFAULT_DRAFT.timeoutMs),
    allowThreshold: String(reviewer?.allowThreshold ?? DEFAULT_DRAFT.allowThreshold),
    denyThreshold: String(reviewer?.denyThreshold ?? DEFAULT_DRAFT.denyThreshold),
    categories: reviewer?.categories !== undefined
      ? CATEGORIES.filter((category) => reviewer.categories.includes(category))
      : [...CATEGORIES],
  };
}
function valid(draft: ReviewerDraft): boolean {
  const timeout = Number(draft.timeoutMs);
  const allow = Number(draft.allowThreshold);
  const deny = Number(draft.denyThreshold);
  return Number.isInteger(timeout) && timeout >= 100 && timeout <= 30_000
    && allow >= 0.5 && allow <= 1 && deny >= 0.5 && deny <= 1
    && draft.categories.length > 0;
}

/**
 * How the approval reviewer behaves: how long to wait, how sure to be and
 * which checks run. Which service reviews is chosen once, in Models &
 * providers › Decision models, and shown here read-only; an older key the
 * reviewer still keeps for itself is moved from there too.
 */
export function ReviewerSettings() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const [baseline, setBaseline] = useState<ReviewerDraft>(DEFAULT_DRAFT);
  const [draft, setDraft] = useState<ReviewerDraft>(DEFAULT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const reviewer = configQuery.data?.permission?.reviewer;
  useEffect(() => {
    if (!configQuery.data || dirty) return;
    const next = reviewerFromConfig(configQuery.data.permission?.reviewer);
    setBaseline(next); setDraft(next);
  }, [configQuery.data, dirty]);
  const update = (patch: Partial<ReviewerDraft>) => { setDraft((current) => ({ ...current, ...patch })); setFeedback(null); };
  const save = async () => {
    if (!valid(draft) || !dirty) return;
    setSaving(true); setFeedback(null);
    try {
      // Tuning only: the source, backend and key are left as they are.
      const echoed = await client.patchConfig({
        permission: { reviewer: {
          timeout_ms: Number(draft.timeoutMs),
          allow_threshold: Number(draft.allowThreshold), deny_threshold: Number(draft.denyThreshold),
          categories: draft.categories,
        } },
      });
      queryClient.setQueryData(['config'], echoed);
      const next = reviewerFromConfig(echoed.permission?.reviewer);
      setBaseline(next); setDraft(next);
      pingSaved();
    } catch (error) { setFeedback({ tone: 'error', text: errorText(locale, error) }); }
    finally { setSaving(false); }
  };
  // Older settings still in effect while no source is saved.
  const legacyText = reviewer?.source !== undefined ? undefined
    : reviewer?.backend === 'jev' ? t('st.decision.preset.jev')
      : reviewer?.model !== undefined ? reviewer.model : undefined;
  return <SectionCard id="st-card-reviewer" title={t('st.reviewer.title')}>
    <div className="space-y-3" data-reviewer-settings>
      <Hint>{t('st.reviewer.hint')}</Hint>
      {/* Which service reviews, and every key it needs, live in Models &
          providers › Decision models; this card only shows the choice. */}
      <DecisionSourceSummary consumer="reviewer" source={reviewer?.source} status={reviewer?.source_status} legacy={legacyText} />
      <fieldset disabled={saving || configQuery.isLoading} className="space-y-4 disabled:opacity-60">
        <AdvancedDetails summary={t('st.advanced.disclosure')} data-reviewer-advanced className="space-y-4 text-[13px] text-ink">
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
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
        </AdvancedDetails>
      </fieldset>
      <SettingsDraftFooter saved={justSaved} id="permission-reviewer" dirty={dirty} saving={saving} saveDisabled={!valid(draft)}
        onSave={() => void save()} onDiscard={() => { setDraft(baseline); setFeedback(null); }} />
      {dirty && !valid(draft) ? <p role="alert" className="text-[12px] text-danger">{t('st.reviewer.invalid')}</p> : null}
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      <FeedbackLine feedback={feedback} />
    </div>
  </SectionCard>;
}
