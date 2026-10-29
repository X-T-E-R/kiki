import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { providerIdSchema, type DecisionSource, type MoveReviewerKeyResult } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { DECISION_CONNECTION_ADD_ROUTE } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { DecisionSourceSummary } from './DecisionSources';
import { SectionCard } from './SectionCard';
import { AdvancedDetails } from './fields';
import { FieldIssue, SettingsDraftFooter } from './SettingsPrimitives';
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
 * which checks run. Which service reviews is chosen once, in Who decides,
 * and shown here read-only. A key the reviewer still keeps for itself (older
 * settings) is echoed as such and can be moved into a connection.
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
  const legacyJev = reviewer?.source === undefined && reviewer?.backend === 'jev';
  const keySource = reviewer?.apiKeySource ?? (reviewer?.hasApiKey === true ? 'kiki' : 'none');
  const legacyText = reviewer?.source !== undefined ? undefined
    : legacyJev ? t('st.decision.preset.jev')
      : reviewer?.model !== undefined ? reviewer.model : undefined;
  return <SectionCard id="st-card-reviewer" title={t('st.reviewer.title')}>
    <div className="space-y-3" data-reviewer-settings>
      <Hint>{t('st.reviewer.hint')}</Hint>
      <DecisionSourceSummary consumer="reviewer" source={reviewer?.source} status={reviewer?.source_status} legacy={legacyText} />
      {/* While an older key is still saved for the reviewer, moving it stays
          offered, whatever the source says by now: a move that stopped half
          way, a reload or a later change must not strand that key. */}
      {keySource === 'kiki' ? <LegacyJevKey source={reviewer?.source} onMoved={(id) => { setFeedback({ tone: 'success', text: t('st.reviewer.moveDone', { id }) }); }} />
        : legacyJev ? <LegacyJevEnv keyEnv={reviewer?.apiKeyEnv} /> : null}
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

/** A Jev key from the environment needs no move: a Jev connection reads the same variable. */
function LegacyJevEnv({ keyEnv }: { readonly keyEnv?: string }) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  return (
    <div data-reviewer-legacy="env" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-2 border-amber-rule pl-3">
      <p className="max-w-[62ch] text-[12px] leading-snug text-ink-soft">{t('st.reviewer.legacyEnv', { name: keyEnv ?? 'TYPESAFE_API_KEY' })}</p>
      <button type="button" data-reviewer-add-jev className={SECONDARY_BUTTON}
        onClick={() => { void navigate(DECISION_CONNECTION_ADD_ROUTE); }}>{t('st.reviewer.addJev')}</button>
    </div>
  );
}

/**
 * A TypeSafe key still saved in the reviewer's own settings. The server moves
 * it (the browser never holds it) into a connection and points the reviewer
 * there. Shown for as long as that key is saved, so a move that stopped part
 * way can be finished after a refresh or a reload; nothing retries on its own.
 * The connection the reviewer already points at may be named again (it may
 * hold the moved key); otherwise a free ID is needed, and the server keeps a
 * connection that holds a different key as it is.
 */
function LegacyJevKey({ source, onMoved }: {
  readonly source: DecisionSource | undefined;
  /** A finished move clears the key, and with it this block; the card keeps the word. */
  readonly onMoved: (id: string) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const taken = new Set((providersQuery.data?.items ?? []).map((item) => item.id));
  const [partial, setPartial] = useState<MoveReviewerKeyResult | null>(null);
  const pointed = source?.kind === 'connection' && taken.has(source.connection) ? source.connection : undefined;
  const reusable = partial?.connection ?? pointed;
  const [id, setId] = useState('');
  const [touched, setTouched] = useState(false);
  const [moving, setMoving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Until the person types, the field follows the facts: the connection the
  // reviewer points at, or the first free `typesafe` ID.
  useEffect(() => {
    if (touched || !providersQuery.isSuccess) return;
    if (reusable !== undefined) { setId(reusable); return; }
    if (!taken.has('typesafe')) { setId('typesafe'); return; }
    for (let n = 2; ; n++) if (!taken.has(`typesafe-${n}`)) { setId(`typesafe-${n}`); break; }
  }, [providersQuery.isSuccess, providersQuery.data, reusable, touched]); // eslint-disable-line react-hooks/exhaustive-deps

  const trimmed = id.trim();
  const idIssue = trimmed === '' || trimmed === reusable ? null
    : !providerIdSchema.safeParse(trimmed).success ? t('st.decision.idInvalid')
      : taken.has(trimmed) ? t('st.decision.idTaken') : null;
  const move = async () => {
    if (moving || trimmed === '' || idIssue !== null) return;
    setMoving(true); setFeedback(null);
    try {
      const result = await client.moveReviewerKey(trimmed);
      // One request per click. The server keeps newer settings when it meets
      // them, so the cards re-read and say what is true now.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['config'] }),
        queryClient.invalidateQueries({ queryKey: ['providers'] }),
      ]);
      setTouched(false);
      if (result.state === 'complete') {
        setPartial(null);
        onMoved(result.connection);
      } else {
        setPartial(result);
        setFeedback({ tone: 'error', text: t('st.reviewer.movePartial') });
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.reviewer.moveFailed', { detail: errorText(locale, error) }) });
    } finally { setMoving(false); }
  };
  return (
    <div data-reviewer-legacy="key" data-reviewer-move={partial?.state ?? 'idle'} className="space-y-2 border-l-2 border-amber-rule pl-3">
      <p className="max-w-[62ch] text-[12px] leading-snug text-ink-soft">
        {source === undefined ? t('st.reviewer.legacyKey') : t('st.reviewer.legacyKeyLeft')}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="block text-[12px] text-ink-soft">{t('st.reviewer.moveId')}</span>
          <input data-reviewer-move-id className={`${INPUT} w-48 font-mono`} value={id}
            disabled={moving} spellCheck={false} autoComplete="off" aria-invalid={idIssue !== null}
            aria-describedby={idIssue === null ? undefined : 'reviewer-move-id-issue'}
            onChange={(event) => { setId(event.target.value); setTouched(true); setFeedback(null); }} />
        </label>
        <button type="button" data-reviewer-move-key className={SECONDARY_BUTTON}
          disabled={moving || trimmed === '' || idIssue !== null || !providersQuery.isSuccess} onClick={() => void move()}>
          {moving ? t('st.reviewer.moving') : partial !== null ? t('common.retry') : t('st.reviewer.moveKey')}
        </button>
      </div>
      <FieldIssue id="reviewer-move-id-issue" text={idIssue} />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
