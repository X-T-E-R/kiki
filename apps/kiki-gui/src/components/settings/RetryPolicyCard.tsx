import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import type { KikiConfigPatch, KikiConfigResponse } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField, SettingsBox } from './fields';
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

/** `[loop_control] max_attempts_per_step`, the value retry's budget wins over. */
function loopAttemptsFromConfig(config: KikiConfigResponse): string {
  const raw = (config.loop_control ?? {}) as Record<string, unknown>;
  return numberText(raw['maxAttemptsPerStep'] ?? raw['max_attempts_per_step']);
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

/** The unit sitting right of a number input, one shape everywhere. */
function Unit({ children }: { readonly children: string }) {
  return <span className="text-[12px] text-ink-faint">{children}</span>;
}

/**
 * Models → Defaults → Retry: the step-retry budget and ordered per-error
 * policies. This is the only attempts row on the tab — `[retry] max_attempts`
 * wins at runtime, and an empty box inherits whatever loop_control holds (the
 * placeholder shows that value). One draft for the whole list, because policy
 * order decides which one applies; saving replaces the retry domain.
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

  if (draft === null || configQuery.data === undefined) {
    return (
      <SectionCard id="st-card-retry" title={t('st.retry.title')}>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>}
      </SectionCard>
    );
  }

  const inheritedAttempts = loopAttemptsFromConfig(configQuery.data);

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
  // Draft inputs sit in a row's control slot at a fixed width; the match
  // pattern is the only one that reads long, so it keeps a wider box.
  const fieldClass = (key: string, width = 'w-20', align = 'text-right') =>
    `h-8 ${width} rounded-md border border-hairline bg-paper px-2 ${align} font-mono text-[12.5px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-selected-ink disabled:opacity-60 ${issue?.key === key ? 'border-danger' : ''}`;

  return (
    <SectionCard id="st-card-retry" title={t('st.retry.title')} effect="newSessions">
      <div className="space-y-4">
        <Hint>{t('st.retry.hint')}</Hint>
        <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
          <SettingsBox>
            <SettingField label={t('st.retry.maxAttempts')} htmlFor="retry-max-attempts"
              help={t('st.retry.maxAttemptsHelp')}>
              <div className="flex items-center gap-1.5">
                <input id="retry-max-attempts" className={fieldClass('max')} inputMode="numeric"
                  placeholder={inheritedAttempts === '' ? '5' : inheritedAttempts} value={draft.maxAttempts}
                  aria-invalid={issue?.key === 'max'}
                  onChange={(event) => { update({ ...draft, maxAttempts: event.target.value }); }} />
                <Unit>{t('st.retry.attemptsUnit')}</Unit>
              </div>
            </SettingField>
          </SettingsBox>
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
            <ol data-retry-policies className="divide-y divide-hairline rounded-lg border border-hairline [&>:empty]:hidden">
              {draft.policies.map((policy, index) => (
                <li key={policy.id} data-retry-policy={index} className="space-y-1 px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <Toggle layout="row" label={t('st.retry.policyEnabled')} checked={policy.retry}
                      onChange={(retry) => { updatePolicy(policy.id, { retry }); }} />
                    <div className="flex items-center gap-1">
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
                  </div>
                  <SettingField label={t('st.retry.match')} htmlFor={`retry-match-${policy.id}`}>
                    <input id={`retry-match-${policy.id}`} className={fieldClass(`match-${policy.id}`, 'w-full max-w-64', 'text-left')} value={policy.match}
                      placeholder="^provider\.rate_limit$" aria-invalid={issue?.key === `match-${policy.id}`}
                      onChange={(event) => { updatePolicy(policy.id, { match: event.target.value }); }} />
                  </SettingField>
                  <SettingField label={t('st.retry.policyAttempts')}>
                    <div className="flex items-center gap-1.5">
                      <input className={fieldClass(`attempts-${policy.id}`)} inputMode="numeric" value={policy.maxAttempts}
                        aria-label={t('st.retry.policyAttempts')} aria-invalid={issue?.key === `attempts-${policy.id}`}
                        onChange={(event) => { updatePolicy(policy.id, { maxAttempts: event.target.value }); }} />
                      <Unit>{t('st.retry.attemptsUnit')}</Unit>
                    </div>
                  </SettingField>
                  <SettingField label={t('st.retry.backoff')}>
                    <div className="flex items-center gap-1.5">
                      <input className={fieldClass(`backoff-${policy.id}`)} inputMode="numeric" value={policy.backoff}
                        aria-label={t('st.retry.backoff')} aria-invalid={issue?.key === `backoff-${policy.id}`}
                        onChange={(event) => { updatePolicy(policy.id, { backoff: event.target.value }); }} />
                      <Unit>{t('st.residency.msUnit')}</Unit>
                    </div>
                  </SettingField>
                  {[`match-${policy.id}`, `attempts-${policy.id}`, `backoff-${policy.id}`].map((key) => (issueFor(key) !== null
                    ? <p key={key} role="alert" className="text-[12px] text-danger">{issueFor(key)}</p>
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
