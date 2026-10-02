/**
 * RequestGovernanceView — the /usage page's Live and Limits panels.
 *
 * Live reads like the cockpit: a fact strip (running / queued), the
 * per-dimension breakdown, and whoever is waiting, all in the page's card
 * language with mono tabular figures and hairline dividers. Limits is the
 * editor for the concurrency rules: each row summarizes a rule, the row opens
 * in place for edits, the switch pauses a rule without losing it, and every
 * write goes through the config save path so it persists and applies to the
 * next request. Session-dimension rows stay out of Live: without a title a
 * raw session id helps nobody.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RequestGovernanceSnapshot } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { pushToast } from '../lib/toasts';
import { useRequestGovernance } from '../lib/useRequestGovernance';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { FeedbackLine, Toggle } from './controls';
import { Icon } from './icons';
import { InlineEditor } from './InlineEditor';
import { AxisGroup, UsageCard } from './usage/usageShared';
import { DANGER_GHOST_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

type GovernanceRule = RequestGovernanceSnapshot['rules'][number];

const NOTICE_AMBER = 'rounded-lg border border-amber-rule/40 bg-amber-card px-3 py-2 text-[12.5px] leading-relaxed text-amber-ink';
const FIELD_INPUT = 'h-8 w-full rounded-md border border-hairline bg-paper px-2 font-mono text-[12.5px] text-ink tabular-nums outline-none transition-colors duration-[var(--kiki-motion-quick)] placeholder:text-ink-faint focus:border-selected-ink aria-[invalid=true]:border-danger';

/** Server messages arrive as `msg (code N)`; the editor's inline line drops the diagnostic tail. */
function editorErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s*\(code [^)]+\)\s*$/, '');
}

export function RequestGovernanceBadge({ compact = false }: { compact?: boolean }) {
  const { snapshot, stale } = useRequestGovernance();
  const { t } = useI18n();
  const title = snapshot === undefined
    ? t('usage.governance.unavailable')
    : `${t('usage.governance.badge', { active: snapshot.active, queued: snapshot.queued })}${stale ? ` · ${t('usage.governance.stale', { time: snapshot.asOf })}` : ''}`;
  return (
    <span
      data-request-governance-badge
      data-stale={stale || undefined}
      title={title}
      aria-label={title}
      className={compact
        ? 'absolute -right-2 -bottom-1 rounded bg-paper px-0.5 font-mono text-[9px] leading-3 text-ink-faint tabular-nums'
        : 'ml-auto shrink-0 font-mono text-[11px] text-ink-faint tabular-nums'}
    >
      {snapshot === undefined ? '—' : `${snapshot.active}${!compact && snapshot.queued > 0 ? ` · +${snapshot.queued}` : ''}`}
      {!compact && stale && snapshot !== undefined ? ' ◦' : ''}
    </span>
  );
}

export function RequestGovernanceView({ view }: { view: 'realtime' | 'limits' }) {
  const { snapshot, stale, loading } = useRequestGovernance();
  const { t } = useI18n();
  if (snapshot === undefined) {
    return (
      <p role="status" className="rounded-xl border border-hairline bg-panel px-4 py-12 text-center text-[13px] text-ink-faint">
        {t(loading ? 'usage.governance.loading' : 'usage.governance.unavailable')}
      </p>
    );
  }
  return view === 'realtime'
    ? <RealtimePanel snapshot={snapshot} stale={stale} />
    : <LimitsPanel snapshot={snapshot} stale={stale} />;
}

// ---------------------------------------------------------------------------
// Live — running and queued right now
// ---------------------------------------------------------------------------

function RealtimePanel({ snapshot, stale }: { snapshot: RequestGovernanceSnapshot; stale: boolean }) {
  const { t, time } = useI18n();
  const dimensions = snapshot.dimensions.filter((row) => row.dimension !== 'session');
  const dimensionLabel = (row: (typeof dimensions)[number]): string => {
    if (row.dimension === 'role') {
      return row.id === 'subagent' ? t('usage.governance.roleSubagent') : t('usage.governance.roleRoot');
    }
    return row.id;
  };
  return (
    <div className="space-y-4" data-request-governance>
      {stale ? (
        <p role="status" data-governance-stale className={NOTICE_AMBER}>
          {t('usage.governance.stale', { time: time.absoluteTime(snapshot.asOf) ?? snapshot.asOf })}
        </p>
      ) : null}
      <section className="rounded-xl border border-hairline bg-panel p-4 sm:p-5">
        <dl className="grid grid-cols-2 divide-x divide-hairline text-center">
          <div>
            <dt className="text-[11.5px] text-ink-faint">{t('usage.governance.running')}</dt>
            <dd data-governance-active className="font-mono text-[14px] text-ink tabular-nums">{snapshot.active}</dd>
          </div>
          <div>
            <dt className="text-[11.5px] text-ink-faint">{t('usage.governance.queued')}</dt>
            <dd data-governance-queued className="font-mono text-[14px] text-ink tabular-nums">{snapshot.queued}</dd>
          </div>
        </dl>
      </section>
      <UsageCard title={t('usage.governance.byDimension')}>
        {dimensions.length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">{t('usage.governance.idleNow')}</p>
        ) : (
          <div data-governance-dimensions>
            <div aria-hidden className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] px-2 pb-2 text-[11px] text-ink-faint">
              <span>{t('usage.governance.target')}</span>
              <span className="text-right">{t('usage.governance.running')}</span>
              <span className="text-right">{t('usage.governance.queued')}</span>
            </div>
            <ol className="divide-y divide-hairline border-t border-hairline">
              {dimensions.map((row) => (
                <li key={`${row.dimension}:${row.id}`} className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] items-baseline px-2 py-2">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 text-[11.5px] text-ink-faint">{t(`usage.governance.${row.dimension}` as I18nKey)}</span>
                    <span className="min-w-0 truncate font-mono text-[12.5px] text-ink" title={row.id}>{dimensionLabel(row)}</span>
                  </span>
                  <span className="text-right font-mono text-[12.5px] text-ink tabular-nums">{row.active}</span>
                  <span className="text-right font-mono text-[12.5px] text-ink-soft tabular-nums">{row.queued}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </UsageCard>
      {snapshot.waiting.length > 0 ? (
        <UsageCard title={t('usage.governance.waitingTitle')} data-governance-waiting="">
          <ol className="divide-y divide-hairline border-t border-hairline">
            {snapshot.waiting.map((row) => (
              <li key={row.attemptId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2 py-2 text-[12.5px]">
                <span className="min-w-0 truncate font-mono text-ink" title={row.modelId}>{row.modelId}</span>
                {row.blockingRules.length > 0 ? (
                  <span className="min-w-0 truncate text-ink-faint">{t('usage.governance.blockedBy', { rules: row.blockingRules.join(', ') })}</span>
                ) : null}
                <span className="ml-auto shrink-0 font-mono text-ink-soft tabular-nums">{time.formatDuration(row.waitedMs)}</span>
              </li>
            ))}
          </ol>
        </UsageCard>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Limits — the rule editor
// ---------------------------------------------------------------------------

/** Comma/space-separated text ↔ the rule's id list; empty means "all". */
function parseIdList(text: string): string[] | undefined {
  const items = [...new Set(text.split(/[,，、\s]+/).map((part) => part.trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
}

interface RuleDraft {
  readonly id: string;
  readonly scope: 'global' | 'each_session';
  readonly models: string;
  readonly providers: string;
  readonly subagentsOnly: boolean;
  readonly cap: string;
  readonly overflow: 'queue' | 'reject';
  readonly waitSeconds: string;
  /** Not a form field: the row switch owns it, and a save must not reset it. */
  readonly enabled: boolean;
}

function draftOf(rule: GovernanceRule): RuleDraft {
  return {
    id: rule.id,
    scope: rule.scope,
    models: rule.models?.join(', ') ?? '',
    providers: rule.providers?.join(', ') ?? '',
    subagentsOnly: rule.subagentsOnly,
    cap: rule.maxConcurrent === undefined ? '' : String(rule.maxConcurrent),
    overflow: rule.overflow,
    waitSeconds: rule.maxWaitMs === undefined ? '' : String(rule.maxWaitMs / 1000),
    enabled: rule.enabled,
  };
}

/** The first free `rule-N`, so a new rule starts valid and renameable. */
function freshDraft(rules: readonly GovernanceRule[]): RuleDraft {
  let index = rules.length + 1;
  while (rules.some((rule) => rule.id === `rule-${index}`)) index += 1;
  return { id: `rule-${index}`, scope: 'global', models: '', providers: '', subagentsOnly: false, cap: '2', overflow: 'queue', waitSeconds: '', enabled: true };
}

type DraftInvalid = 'name' | 'cap' | 'wait';

/** The rule a draft describes, or the field that makes it invalid. */
function ruleFromDraft(draft: RuleDraft, otherIds: ReadonlySet<string>): { rule: GovernanceRule } | { invalid: DraftInvalid } {
  const id = draft.id.trim();
  if (id === '' || otherIds.has(id)) return { invalid: 'name' };
  const capText = draft.cap.trim();
  const cap = capText === '' ? undefined : Number(capText);
  if (cap !== undefined && (!Number.isInteger(cap) || cap <= 0)) return { invalid: 'cap' };
  const waitText = draft.waitSeconds.trim();
  const waitSeconds = waitText === '' ? undefined : Number(waitText);
  if (waitSeconds !== undefined && (!Number.isFinite(waitSeconds) || waitSeconds <= 0)) return { invalid: 'wait' };
  return {
    rule: {
      id,
      resource: 'model_request',
      scope: draft.scope,
      models: parseIdList(draft.models),
      providers: parseIdList(draft.providers),
      subagentsOnly: draft.subagentsOnly,
      maxConcurrent: cap,
      overflow: draft.overflow,
      maxWaitMs: waitSeconds === undefined ? undefined : Math.round(waitSeconds * 1000),
      enabled: draft.enabled,
    },
  };
}

function ruleSummary(rule: GovernanceRule, t: (key: I18nKey, params?: Record<string, string | number>) => string): string {
  const parts = [
    rule.models !== undefined ? rule.models.join(', ') : undefined,
    rule.providers !== undefined ? rule.providers.join(', ') : undefined,
    rule.subagentsOnly ? t('usage.governance.children') : undefined,
  ].filter((part) => part !== undefined);
  const target = parts.length > 0 ? parts.join(' · ') : t('usage.governance.all');
  const cap = rule.maxConcurrent === undefined ? t('usage.governance.unlimited') : String(rule.maxConcurrent);
  const wait = rule.maxWaitMs === undefined ? undefined : t('usage.governance.summaryWait', { seconds: rule.maxWaitMs / 1000 });
  return [
    t(rule.scope === 'global' ? 'usage.governance.global' : 'usage.governance.eachSession'),
    target,
    `${t('usage.governance.cap')} ${cap}`,
    t(rule.overflow === 'queue' ? 'usage.governance.queue' : 'usage.governance.reject'),
    wait,
  ].filter((part) => part !== undefined).join(' · ');
}

function RuleEditor({ initial, otherIds, isNew, modelOptions, providerOptions, onSubmit, onCancel, onDelete }: {
  readonly initial: RuleDraft;
  readonly otherIds: ReadonlySet<string>;
  readonly isNew: boolean;
  readonly modelOptions: readonly string[];
  readonly providerOptions: readonly string[];
  readonly onSubmit: (rule: GovernanceRule) => Promise<void>;
  readonly onCancel: () => void;
  readonly onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState<DraftInvalid | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const patch = (part: Partial<RuleDraft>) => { setDraft((current) => ({ ...current, ...part })); };
  const submit = () => {
    const parsed = ruleFromDraft(draft, otherIds);
    if ('invalid' in parsed) {
      setInvalid(parsed.invalid);
      return;
    }
    setInvalid(null);
    setFailure(null);
    setSubmitting(true);
    void onSubmit(parsed.rule)
      .catch((error: unknown) => { setFailure(error); })
      .finally(() => { setSubmitting(false); });
  };
  return (
    <form
      data-governance-editor
      aria-label={isNew ? t('usage.governance.newRule') : t('usage.governance.editRule', { name: initial.id })}
      className="space-y-3"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.name')}</span>
          <input
            value={draft.id}
            spellCheck={false}
            placeholder={t('usage.governance.namePlaceholder')}
            aria-invalid={invalid === 'name'}
            onChange={(event) => { patch({ id: event.target.value }); }}
            className={FIELD_INPUT}
          />
        </label>
        <label className="block space-y-1">
          <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.cap')}</span>
          <input
            inputMode="numeric"
            value={draft.cap}
            placeholder={t('usage.governance.unlimited')}
            aria-invalid={invalid === 'cap'}
            onChange={(event) => { patch({ cap: event.target.value }); }}
            className={FIELD_INPUT}
          />
        </label>
        <AxisGroup
          label={t('usage.governance.scope')}
          dataAxis="governance-scope"
          options={['global', 'each_session'] as const}
          value={draft.scope}
          onChange={(scope) => { patch({ scope }); }}
          labelFor={(option) => t(option === 'global' ? 'usage.governance.global' : 'usage.governance.eachSession')}
        />
        <AxisGroup
          label={t('usage.governance.action')}
          dataAxis="governance-overflow"
          options={['queue', 'reject'] as const}
          value={draft.overflow}
          onChange={(overflow) => { patch({ overflow }); }}
          labelFor={(option) => t(option === 'queue' ? 'usage.governance.queue' : 'usage.governance.reject')}
        />
        <label className="block space-y-1">
          <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.models')}</span>
          <input
            value={draft.models}
            spellCheck={false}
            list="governance-model-options"
            placeholder={t('usage.governance.targetHint')}
            onChange={(event) => { patch({ models: event.target.value }); }}
            className={FIELD_INPUT}
          />
        </label>
        <label className="block space-y-1">
          <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.providers')}</span>
          <input
            value={draft.providers}
            spellCheck={false}
            list="governance-provider-options"
            placeholder={t('usage.governance.targetHint')}
            onChange={(event) => { patch({ providers: event.target.value }); }}
            className={FIELD_INPUT}
          />
        </label>
        <div className="flex min-h-8 items-center">
          <Toggle
            label={t('usage.governance.children')}
            checked={draft.subagentsOnly}
            onChange={(subagentsOnly) => { patch({ subagentsOnly }); }}
          />
        </div>
        <label className="block space-y-1">
          <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.waitBudget')}</span>
          <input
            inputMode="decimal"
            value={draft.waitSeconds}
            placeholder="300"
            aria-invalid={invalid === 'wait'}
            onChange={(event) => { patch({ waitSeconds: event.target.value }); }}
            className={FIELD_INPUT}
          />
        </label>
      </div>
      <datalist id="governance-model-options">
        {modelOptions.map((id) => <option key={id} value={id} />)}
      </datalist>
      <datalist id="governance-provider-options">
        {providerOptions.map((id) => <option key={id} value={id} />)}
      </datalist>
      {invalid !== null ? (
        <p role="alert" className="text-[12px] text-danger">
          {t(invalid === 'name' ? 'usage.governance.invalidName' : invalid === 'cap' ? 'usage.governance.invalidCap' : 'usage.governance.invalidWait')}
        </p>
      ) : null}
      {failure !== null ? <FeedbackLine feedback={{ tone: 'error', text: editorErrorText(failure) }} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={submitting} className={PRIMARY_BUTTON}>
          {submitting ? t('common.saving') : t('usage.governance.saveRule')}
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>{t('common.cancel')}</button>
        {onDelete !== undefined ? (
          <button
            type="button"
            data-governance-editor-delete
            className={`ml-auto ${DANGER_GHOST_BUTTON}`}
            onClick={onDelete}
          >
            {t('usage.governance.deleteRule')}
          </button>
        ) : null}
      </div>
    </form>
  );
}

function LimitsPanel({ snapshot, stale }: { snapshot: RequestGovernanceSnapshot; stale: boolean }) {
  const { t, tp, time } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const rules = snapshot.rules;
  /** The row whose editor is open, or 'new' while the add form is. */
  const [editorFor, setEditorFor] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GovernanceRule | null>(null);

  const modelOptions = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const providerOptions = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const modelIds = useMemo(() => (modelOptions.data?.items ?? []).map((item) => item.id), [modelOptions.data]);
  const providerIds = useMemo(() => (providerOptions.data?.items ?? []).map((item) => item.id), [providerOptions.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['request-governance'] });
  const writeError = (error: unknown) => {
    pushToast({ tone: 'error', text: t('usage.governance.saveFailed'), detail: error instanceof Error ? error.message : String(error) });
  };

  const toggle = useMutation({
    mutationFn: (next: { rule: GovernanceRule; enabled: boolean }) =>
      client.setRequestGovernanceRules(rules.map((rule) => (rule.id === next.rule.id ? { ...rule, enabled: next.enabled } : rule))),
    onSuccess: refresh,
    onError: (error: unknown) => { writeError(error); void refresh(); },
  });

  const remove = useMutation({
    mutationFn: (rule: GovernanceRule) => client.setRequestGovernanceRules(rules.filter((entry) => entry.id !== rule.id)),
    onSuccess: async () => {
      setPendingDelete(null);
      setEditorFor(null);
      await refresh();
    },
    onError: (error: unknown) => { setPendingDelete(null); writeError(error); void refresh(); },
  });

  const saveEdited = (originalId: string | null) => async (rule: GovernanceRule) => {
    const next = originalId === null
      ? [...rules, rule]
      : rules.map((entry) => (entry.id === originalId ? rule : entry));
    await client.setRequestGovernanceRules(next);
    setEditorFor(null);
    await refresh();
  };

  const list = (
    <section className="rounded-xl border border-hairline bg-panel p-4 sm:p-5" data-governance-rules>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-ink-faint">{tp('usage.governance.ruleCount', rules.length)}</p>
        <button
          type="button"
          data-governance-add
          disabled={editorFor !== null}
          onClick={() => { setEditorFor('new'); }}
          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
        >
          <Icon name="plus" size={12} />
          {t('usage.governance.addRule')}
        </button>
      </div>
      {editorFor === 'new' ? (
        <div className="mb-3 rounded-lg bg-ink/[0.03] p-3">
          <RuleEditor
            initial={freshDraft(rules)}
            otherIds={new Set(rules.map((rule) => rule.id))}
            isNew
            modelOptions={modelIds}
            providerOptions={providerIds}
            onSubmit={saveEdited(null)}
            onCancel={() => { setEditorFor(null); }}
          />
        </div>
      ) : null}
      <ol className="divide-y divide-hairline border-t border-hairline">
        {rules.map((rule) => {
          const open = editorFor === rule.id;
          const editorId = `governance-rule-editor-${rule.id}`;
          return (
            <li key={rule.id} data-governance-rule={rule.id}>
              <div className="flex items-center gap-2 px-2 py-2">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={editorId}
                  aria-label={t('usage.governance.editRule', { name: rule.id })}
                  onClick={() => { setEditorFor(open ? null : rule.id); }}
                  className="min-w-0 flex-1 rounded-md py-0.5 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`min-w-0 truncate font-mono text-[12.5px] ${rule.enabled ? 'text-ink' : 'text-ink-faint'}`}>{rule.id}</span>
                    {rule.enabled ? null : (
                      <span className="shrink-0 rounded-full border border-hairline px-1.5 text-[10.5px] text-ink-faint">{t('usage.governance.disabled')}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">{ruleSummary(rule, t)}</span>
                </button>
                <Toggle
                  layout="bare"
                  label={t('usage.governance.toggleRule', { name: rule.id })}
                  checked={rule.enabled}
                  disabled={toggle.isPending && toggle.variables?.rule.id === rule.id}
                  onChange={(enabled) => { toggle.mutate({ rule, enabled }); }}
                />
              </div>
              <InlineEditor open={open} id={editorId} lazy className="mb-3">
                <RuleEditor
                  initial={draftOf(rule)}
                  otherIds={new Set(rules.filter((entry) => entry.id !== rule.id).map((entry) => entry.id))}
                  isNew={false}
                  modelOptions={modelIds}
                  providerOptions={providerIds}
                  onSubmit={saveEdited(rule.id)}
                  onCancel={() => { setEditorFor(null); }}
                  onDelete={() => { setPendingDelete(rule); }}
                />
              </InlineEditor>
            </li>
          );
        })}
      </ol>
    </section>
  );

  return (
    <div className="space-y-4" data-request-governance>
      {stale ? (
        <p role="status" data-governance-stale className={NOTICE_AMBER}>
          {t('usage.governance.stale', { time: time.absoluteTime(snapshot.asOf) ?? snapshot.asOf })}
        </p>
      ) : null}
      {rules.length === 0 && editorFor !== 'new' ? (
        <section className="rounded-xl border border-hairline bg-panel px-4 py-12 text-center" data-governance-empty>
          <p className="text-[13px] font-medium text-ink">{t('usage.governance.emptyTitle')}</p>
          <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-faint">{t('usage.governance.emptyBody')}</p>
          <button type="button" data-governance-add className={`${PRIMARY_BUTTON} mt-4`} onClick={() => { setEditorFor('new'); }}>
            {t('usage.governance.addRule')}
          </button>
        </section>
      ) : list}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('usage.governance.deleteTitle')}
        body={pendingDelete === null ? undefined : t('usage.governance.deleteBody', { name: pendingDelete.id })}
        confirmLabel={t('usage.governance.deleteRule')}
        busy={remove.isPending}
        onConfirm={() => { if (pendingDelete !== null) remove.mutate(pendingDelete); }}
        onCancel={() => { setPendingDelete(null); }}
      />
    </div>
  );
}
