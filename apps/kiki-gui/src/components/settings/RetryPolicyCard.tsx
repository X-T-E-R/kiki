import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import type { KikiConfigPatch, KikiConfigResponse } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { FORM_LABEL, SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

interface PolicyDraft {
  readonly id: number;
  match: string;
  maxAttempts: string;
  backoff: string;
  retry: boolean;
}

interface RetryDraft {
  maxAttempts: string;
  policies: PolicyDraft[];
}

let policySeq = 0;

function numberText(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}

/** The config echo keeps retry's inner keys camelCase or snake_case depending on the path. */
function draftFromConfig(config: KikiConfigResponse): RetryDraft {
  const raw = (config.retry ?? {}) as Record<string, unknown>;
  const policies = Array.isArray(raw['policies']) ? raw['policies'] as Record<string, unknown>[] : [];
  return {
    maxAttempts: numberText(raw['maxAttempts'] ?? raw['max_attempts']),
    policies: policies.map((policy) => ({
      id: ++policySeq,
      match: typeof policy['match'] === 'string' ? policy['match'] : '',
      maxAttempts: numberText(policy['maxAttempts'] ?? policy['max_attempts']),
      backoff: numberText(policy['backoff']),
      retry: policy['retry'] !== false,
    })),
  };
}

type Issue = { readonly key: string; readonly text: string };

/** Builds the full-domain replacement, or the first field that blocks it. */
function retryPatch(draft: RetryDraft, t: ReturnType<typeof useI18n>['t']): { patch?: KikiConfigPatch; issue?: Issue } {
  const count = (text: string, min: number, key: string): number | undefined | Issue => {
    if (text.trim() === '') return undefined;
    const value = Number(text.trim());
    if (!Number.isInteger(value) || value < min) return { key, text: t(min === 0 ? 'st.retry.issueBackoff' : 'st.retry.issueAttempts') };
    return value;
  };
  const isIssue = (value: unknown): value is Issue => typeof value === 'object' && value !== null;
  const top = count(draft.maxAttempts, 1, 'max');
  if (isIssue(top)) return { issue: top };
  const policies = [];
  for (const policy of draft.policies) {
    const match = policy.match.trim();
    if (match === '') return { issue: { key: `match-${policy.id}`, text: t('st.retry.issueMatch') } };
    try { new RegExp(match); } catch { return { issue: { key: `match-${policy.id}`, text: t('st.retry.issuePattern') } }; }
    const attempts = count(policy.maxAttempts, 1, `attempts-${policy.id}`);
    if (isIssue(attempts)) return { issue: attempts };
    const backoff = count(policy.backoff, 0, `backoff-${policy.id}`);
    if (isIssue(backoff)) return { issue: backoff };
    policies.push({
      match,
      ...(attempts === undefined ? {} : { max_attempts: attempts }),
      ...(backoff === undefined ? {} : { backoff }),
      retry: policy.retry,
    });
  }
  return {
    patch: {
      retry: {
        ...(top === undefined ? {} : { max_attempts: top }),
        ...(policies.length === 0 ? {} : { policies }),
      },
      replace_domains: ['retry'],
    },
  };
}

/**
 * Developer → Retry: the step-retry budget and ordered per-error policies.
 * One draft for the whole list, because policy order decides which one
 * applies; saving replaces the retry domain.
 */
export function RetryPolicyCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const [draft, setDraft] = useState<RetryDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const focusId = useRef<number | null>(null);

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) setDraft(draftFromConfig(configQuery.data));
  }, [configQuery.data, dirty]);

  useEffect(() => {
    if (focusId.current === null) return;
    document.getElementById(`retry-match-${focusId.current}`)?.focus();
    focusId.current = null;
  });

  if (draft === null) {
    return (
      <SectionCard id="st-card-retry" title={t('st.retry.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const update = (next: RetryDraft) => { setDraft(next); setDirty(true); setIssue(null); };
  const updatePolicy = (id: number, patch: Partial<PolicyDraft>) => {
    update({ ...draft, policies: draft.policies.map((policy) => (policy.id === id ? { ...policy, ...patch } : policy)) });
  };
  const move = (index: number, delta: number) => {
    const policies = [...draft.policies];
    const [entry] = policies.splice(index, 1);
    policies.splice(index + delta, 0, entry!);
    update({ ...draft, policies });
  };

  const save = async () => {
    const built = retryPatch(draft, t);
    if (built.patch === undefined) { setIssue(built.issue ?? null); return; }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(built.patch);
      queryClient.setQueryData(['config'], echoed);
      setDraft(draftFromConfig(echoed));
      setDirty(false);
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const issueFor = (key: string) => (issue?.key === key ? issue.text : null);
  const fieldClass = (key: string) => `${INPUT} mt-1 font-mono font-normal ${issue?.key === key ? 'border-danger' : ''}`;

  return (
    <SectionCard id="st-card-retry" title={t('st.retry.title')} effect="newSessions">
      <div className="space-y-4">
        <Hint>{t('st.retry.hint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
          <label className={`${FORM_LABEL} block max-w-[12rem]`}>
            {t('st.retry.maxAttempts')}
            <input className={fieldClass('max')} inputMode="numeric" placeholder="5" value={draft.maxAttempts}
              aria-invalid={issue?.key === 'max'}
              onChange={(event) => { update({ ...draft, maxAttempts: event.target.value }); }} />
          </label>
          {issueFor('max') !== null ? <p role="alert" className="text-[12px] text-danger">{issueFor('max')}</p> : null}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className={FORM_LABEL}>{t('st.retry.policies')}</span>
              <button type="button" className={SECONDARY_BUTTON}
                onClick={() => {
                  const id = ++policySeq;
                  focusId.current = id;
                  update({ ...draft, policies: [...draft.policies, { id, match: '', maxAttempts: '', backoff: '', retry: true }] });
                }}>
                {t('st.retry.addPolicy')}
              </button>
            </div>
            {draft.policies.length === 0 ? <Hint>{t('st.retry.empty')}</Hint> : null}
            <ol className="space-y-2" data-retry-policies>
              {draft.policies.map((policy, index) => (
                <li key={policy.id} data-retry-policy={index} className="grid gap-2 border-t border-hairline pt-2 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,2fr)_6rem_7rem_auto_auto] sm:items-end">
                  <label className={FORM_LABEL}>
                    {t('st.retry.match')}
                    <input id={`retry-match-${policy.id}`} className={fieldClass(`match-${policy.id}`)} value={policy.match}
                      placeholder="^provider\.rate_limit$" aria-invalid={issue?.key === `match-${policy.id}`}
                      onChange={(event) => { updatePolicy(policy.id, { match: event.target.value }); }} />
                  </label>
                  <label className={FORM_LABEL}>
                    {t('st.retry.policyAttempts')}
                    <input className={fieldClass(`attempts-${policy.id}`)} inputMode="numeric" value={policy.maxAttempts}
                      aria-invalid={issue?.key === `attempts-${policy.id}`}
                      onChange={(event) => { updatePolicy(policy.id, { maxAttempts: event.target.value }); }} />
                  </label>
                  <label className={FORM_LABEL}>
                    {t('st.retry.backoff')}
                    <input className={fieldClass(`backoff-${policy.id}`)} inputMode="numeric" value={policy.backoff}
                      aria-invalid={issue?.key === `backoff-${policy.id}`}
                      onChange={(event) => { updatePolicy(policy.id, { backoff: event.target.value }); }} />
                  </label>
                  <div className="flex h-8 items-center">
                    <Toggle label={t('st.retry.retry')} checked={policy.retry}
                      onChange={(retry) => { updatePolicy(policy.id, { retry }); }} />
                  </div>
                  <div className="flex h-8 items-center gap-1">
                    <button type="button" className={SECONDARY_BUTTON} disabled={index === 0}
                      aria-label={t('st.retry.moveUp', { n: index + 1 })} onClick={() => { move(index, -1); }}>
                      <Icon name="arrowUp" size={14} />
                    </button>
                    <button type="button" className={SECONDARY_BUTTON} disabled={index === draft.policies.length - 1}
                      aria-label={t('st.retry.moveDown', { n: index + 1 })} onClick={() => { move(index, 1); }}>
                      <Icon name="arrowDown" size={14} />
                    </button>
                    <button type="button" className={SECONDARY_BUTTON}
                      aria-label={t('st.retry.removePolicy', { n: index + 1 })}
                      onClick={() => { update({ ...draft, policies: draft.policies.filter((entry) => entry.id !== policy.id) }); }}>
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                  {[`match-${policy.id}`, `attempts-${policy.id}`, `backoff-${policy.id}`].map((key) => (issueFor(key) !== null
                    ? <p key={key} role="alert" className="text-[12px] text-danger sm:col-span-5">{issueFor(key)}</p>
                    : null))}
                </li>
              ))}
            </ol>
          </div>
        </fieldset>
        <SettingsDraftFooter saved={justSaved} id="retry" dirty={dirty} saving={saving} onSave={() => void save()}
          onDiscard={() => { if (configQuery.data !== undefined) setDraft(draftFromConfig(configQuery.data)); setDirty(false); setIssue(null); setFeedback(null); }} />
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
