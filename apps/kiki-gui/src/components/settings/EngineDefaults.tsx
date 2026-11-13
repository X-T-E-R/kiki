/**
 * EngineDefaults — what this engine gets from Kiki when the user runs it
 * without a Kiki profile.
 *
 * This is the one place a bare harness stops being bare, and it is deliberately
 * per engine rather than per session: a user who wants Claude Code to see
 * Kiki's memory tools says so once, and every Claude Code session gets it. A
 * session that disagrees says so in its own execution overrides.
 *
 * The three "unset" forms stay distinct, because they mean different things:
 * an absent field inherits the engine's own default, an explicit `[]` or
 * `false` turns the capability off, and clearing a written field returns it to
 * inheriting. The written shape is stated under the controls so the file never
 * changes by surprise.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ExecutorAutoContinuationPolicy, ExecutorCatalogItem, ExecutorInstanceChoice } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { FeedbackLine, Toggle, type Feedback } from '../controls';
import { hookSupport, kikiDelegationTools, kikiGroupTools } from '../harness/kikiContext';
import { useConnection } from '../../state/connection';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { DisclosureChevron } from '../icons';
import { ExecutorScheduleControl, scheduleChoiceFromDraft, scheduleChoiceValue } from '../harness/ExecutorScheduleControl';
import { harnessQuotaQueryKey, readCachedHarnessQuota } from '../../lib/providerQuota';
import { EXECUTORS_QUERY_KEY, useExecutorCatalog } from './profileEditor/engines';
import { KIKI_CONTEXT_ORDER } from './profileEditor/profileDraft';
import { CONTEXT_BLOCKS, DELIVERIES, type ExecutorPromptDelivery } from './profileEditor/executorPromptDraft';
import { SettingsSelect } from './SettingsPrimitives';

/** One engine's `agent_executor_overrides.<id>.defaults` as the editor holds it. */
export interface EngineDefaultsDraft {
  readonly modelAlias: string;
  readonly thinkingEffort: string;
  readonly permissionMode: '' | 'manual' | 'auto' | 'review' | 'yolo';
  readonly kikiContext: readonly string[] | undefined;
  readonly allowKikiSubagents: boolean | undefined;
  readonly injectKikiMcp: boolean | undefined;
  readonly promptDelivery: '' | ExecutorPromptDelivery;
  readonly promptInclude: readonly string[] | undefined;
  readonly promptBody: string;
  readonly promptAppend: string;
  readonly executorInstance: string;
  readonly autoContinuationPolicy: '' | ExecutorAutoContinuationPolicy;
}

export const EMPTY_ENGINE_DEFAULTS: EngineDefaultsDraft = {
  modelAlias: '',
  thinkingEffort: '',
  permissionMode: '',
  kikiContext: undefined,
  allowKikiSubagents: undefined,
  injectKikiMcp: undefined,
  promptDelivery: '',
  promptInclude: undefined,
  promptBody: '',
  promptAppend: '',
  executorInstance: '',
  autoContinuationPolicy: '',
};

/** The raw `defaults` value as the config response carries it. */
type SavedDefaults = Record<string, unknown> | null | undefined;

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boolField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function listField(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
}

function permissionField(value: unknown): '' | 'manual' | 'auto' | 'review' | 'yolo' {
  return value === 'manual' || value === 'auto' || value === 'review' || value === 'yolo' ? value : '';
}

function autoContinuationField(value: unknown): '' | ExecutorAutoContinuationPolicy {
  return value === 'prefer_current' || value === 'prefer_quota' ? value : '';
}

function promptField(value: unknown): SavedDefaults {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function engineDefaultsDraftFrom(saved: SavedDefaults): EngineDefaultsDraft {
  if (saved === undefined || saved === null) return EMPTY_ENGINE_DEFAULTS;
  const prompt = promptField(saved['executor_prompt']);
  return {
    modelAlias: stringField(saved['model_alias']),
    thinkingEffort: stringField(saved['thinking_effort']),
    permissionMode: permissionField(saved['permission_mode']),
    kikiContext: listField(saved['kiki_context']),
    allowKikiSubagents: boolField(saved['allow_kiki_subagents']),
    injectKikiMcp: boolField(saved['inject_kiki_mcp']),
    // A delivery is optional on the wire: writing only `include` must not
    // invent one, and an unwritten delivery stays unwritten.
    promptDelivery: prompt?.['delivery'] === 'append' || prompt?.['delivery'] === 'replace' || prompt?.['delivery'] === 'preamble'
      ? prompt['delivery']
      : '',
    promptInclude: listField(prompt?.['include']),
    promptBody: stringField(prompt?.['body']),
    promptAppend: stringField(prompt?.['append']),
    executorInstance: scheduleChoiceValue(saved['executor_instance'] as ExecutorInstanceChoice | undefined),
    autoContinuationPolicy: autoContinuationField(saved['auto_continuation_policy']),
  };
}

/**
 * The PATCH value. Every field the user left alone is sent as `null`, which is
 * how a config key is removed — so this narrows the saved block to exactly the
 * choices shown, and an untouched field goes back to inheriting.
 */
export function engineDefaultsPatch(draft: EngineDefaultsDraft): Record<string, unknown> | null {
  const prompt: Record<string, unknown> = {
    delivery: draft.promptDelivery === '' ? null : draft.promptDelivery,
    include: draft.promptInclude === undefined ? null : [...draft.promptInclude],
    body: draft.promptBody === '' ? null : draft.promptBody,
    append: draft.promptAppend === '' ? null : draft.promptAppend,
  };
  const promptEmpty = Object.values(prompt).every((value) => value === null);
  const defaults: Record<string, unknown> = {
    model_alias: draft.modelAlias.trim() === '' ? null : draft.modelAlias.trim(),
    thinking_effort: draft.thinkingEffort.trim() === '' ? null : draft.thinkingEffort.trim(),
    permission_mode: draft.permissionMode === '' ? null : draft.permissionMode,
    kiki_context: draft.kikiContext === undefined ? null : [...draft.kikiContext],
    allow_kiki_subagents: draft.allowKikiSubagents === undefined ? null : draft.allowKikiSubagents,
    inject_kiki_mcp: draft.injectKikiMcp === undefined ? null : draft.injectKikiMcp,
    executor_prompt: promptEmpty ? null : prompt,
    executor_instance: draft.executorInstance === '' ? null : scheduleChoiceFromDraft(draft.executorInstance) || null,
    auto_continuation_policy: draft.autoContinuationPolicy === '' ? null : draft.autoContinuationPolicy,
  };
  return Object.values(defaults).every((value) => value === null) ? null : defaults;
}

/**
 * Flip one Kiki-context group. Turning the last one off returns to the
 * baseline's empty form so a group switched on and off again leaves an absent
 * field absent; a list that had groups goes to an explicit `[]`.
 */
function toggleGroup(
  current: readonly string[] | undefined,
  group: string,
  on: boolean,
  baseline: readonly string[] | undefined,
): readonly string[] | undefined {
  const next = KIKI_CONTEXT_ORDER.filter((entry) => [...(current ?? []).filter((item) => item !== group), ...(on ? [group] : [])].includes(entry));
  if (next.length > 0) return next;
  return baseline === undefined || baseline.length === 0 ? baseline : [];
}

function Field({ label, htmlFor, hint, children }: {
  label: string; htmlFor?: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-ink-soft">{label}</label>
      {children}
      {hint !== undefined ? <p className="text-[11.5px] leading-snug text-ink-faint">{hint}</p> : null}
    </div>
  );
}

/** One group: what it hands the engine, and the tools behind it. */
function GroupRow({ group, engineLabel, on, disabled, onChange }: {
  group: string; engineLabel: string; on: boolean; disabled: boolean; onChange: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const tools = kikiGroupTools(group as never);
  return (
    <li data-engine-default-group={group} data-on={on ? 'true' : 'false'} className="space-y-1">
      <Toggle layout="row" label={t(`st.kikiContext.group.${group}` as I18nKey)} checked={on} disabled={disabled} onChange={onChange} />
      <p className="text-[11.5px] leading-snug text-ink-faint">{t(`st.kikiContext.hint.${group}` as I18nKey, { engine: engineLabel })}</p>
      {tools.length > 0 ? <p className="break-words font-mono text-[11px] leading-snug text-ink-faint">{tools.join(' · ')}</p> : null}
    </li>
  );
}

/**
 * The per-engine default block, collapsed by default because most users run a
 * harness as it is. Launch settings (`bin_path`, `args`, …) stay in their own
 * block above; this one is about what Kiki adds to a run.
 */
export function EngineDefaults({ item, saved, quotaSource = '', instances = [], onSaved }: {
  item: ExecutorCatalogItem;
  saved: SavedDefaults;
  quotaSource?: string;
  instances?: readonly ExecutorCatalogItem[];
  onSaved: () => Promise<void>;
}) {
  const { client, scopeId, meta } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<EngineDefaultsDraft>(() => engineDefaultsDraftFrom(saved));
  const [quotaDraft, setQuotaDraft] = useState(quotaSource);
  const [prevQuotaSource, setPrevQuotaSource] = useState(quotaSource);
  if (prevQuotaSource !== quotaSource) {
    setPrevQuotaSource(quotaSource);
    setQuotaDraft(quotaSource);
  }
  const [saving, setSaving] = useState(false);
  const quotaQuery = useQuery({
    queryKey: harnessQuotaQueryKey(scopeId, meta?.server_id),
    queryFn: ({ signal }) => readCachedHarnessQuota(client.klient?.rest?.harnessQuota, signal),
    enabled: client.klient?.rest?.harnessQuota !== undefined,
    staleTime: 60_000,
    retry: false,
  });
  const quotaSources = (quotaQuery.data?.sources ?? []).filter((source) => source.engineIds.includes(item.id));
  const catalog = useExecutorCatalog();
  const scheduleCatalog = catalog.some((entry) => entry.id === item.id) ? catalog : [item, ...instances, ...catalog];
  const [feedback, setFeedback] = useState<Feedback>(null);
  const engineLabel = item.label;
  const set = <K extends keyof EngineDefaultsDraft>(key: K, value: EngineDefaultsDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const dirty = quotaDraft !== quotaSource || JSON.stringify(engineDefaultsPatch(draft)) !== JSON.stringify(engineDefaultsPatch(engineDefaultsDraftFrom(saved)));
  const support = hookSupport(item.id);
  const groups = draft.kikiContext ?? [];
  const on = (group: string) => groups.includes(group);
  const hooksOn = on('hooks');
  const delegationTools = kikiDelegationTools();

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await client.patchConfig({
        agent_executor_overrides: {
          [item.id]: { defaults: engineDefaultsPatch(draft), quota_source: quotaDraft === '' ? null : quotaDraft },
        },
      });
      await queryClient.invalidateQueries({ queryKey: EXECUTORS_QUERY_KEY });
      await onSaved();
      setFeedback({ tone: 'success', text: t('st.engines.defaults.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <details data-engine-defaults className="pt-3 [&[open]]:space-y-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-ink-soft [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={false} className="text-ink-faint" />
        {t('st.engines.defaults.title')}
      </summary>
      <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.defaults.hint', { engine: engineLabel })}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('st.engines.schedule.label')} htmlFor={`${item.id}-default-instance`} hint={t('st.engines.schedule.hint')}>
          <ExecutorScheduleControl id={`${item.id}-default-instance`} executorId={item.id} catalog={scheduleCatalog}
            value={scheduleChoiceFromDraft(draft.executorInstance) || undefined} disabled={saving}
            onChange={(next) => { set('executorInstance', next === '' ? '' : scheduleChoiceValue(next)); }} />
        </Field>
        <Field label={t('st.engines.quotaSource')} htmlFor={`${item.id}-quota-source`} hint={t('st.engines.quotaSourceHint')}>
          <SettingsSelect id={`${item.id}-quota-source`} variant="form" className="min-w-0 text-[12px]"
            ariaLabel={t('st.engines.quotaSource')} triggerData={{ 'data-engine-quota-source': '' }}
            value={quotaDraft} disabled={saving} onChange={setQuotaDraft}
            choices={[
              { value: '', label: t('st.engines.quotaSource.none') },
              ...(quotaDraft !== '' && !quotaSources.some((source) => source.id === quotaDraft) ? [{ value: quotaDraft, label: quotaDraft }] : []),
              ...quotaSources.map((source) => ({ value: source.id, label: source.label })),
            ]} />
        </Field>
        <Field label={t('st.engines.autoContinuation.label')} htmlFor={`${item.id}-auto-continuation`} hint={t('st.engines.autoContinuation.hint')}>
          <SettingsSelect id={`${item.id}-auto-continuation`} variant="form" className="min-w-0 text-[12px]"
            ariaLabel={t('st.engines.autoContinuation.label')} triggerData={{ 'data-engine-default': 'auto_continuation_policy' }}
            value={draft.autoContinuationPolicy} disabled={saving}
            onChange={(next) => { set('autoContinuationPolicy', next); }}
            choices={[
              { value: '', label: t('st.engines.defaults.inheritPlaceholder') },
              { value: 'prefer_current', label: t('st.engines.autoContinuation.prefer_current') },
              { value: 'prefer_quota', label: t('st.engines.autoContinuation.prefer_quota') },
            ]} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('st.engines.defaults.modelAlias')} htmlFor={`${item.id}-default-model`}
          hint={t('st.engines.defaults.modelAliasHint')}>
          <input id={`${item.id}-default-model`} data-engine-default="model_alias" spellCheck={false} disabled={saving}
            className={`${INPUT} min-w-0 font-mono text-[11.5px]`} value={draft.modelAlias}
            placeholder={t('st.engines.defaults.modelAliasPlaceholder')}
            onChange={(event) => { set('modelAlias', event.target.value); }} />
        </Field>
        <Field label={t('st.engines.defaults.thinkingEffort')} htmlFor={`${item.id}-default-effort`}>
          <input id={`${item.id}-default-effort`} data-engine-default="thinking_effort" spellCheck={false} disabled={saving}
            className={`${INPUT} min-w-0 font-mono text-[11.5px]`} value={draft.thinkingEffort}
            placeholder={t('st.engines.defaults.inheritPlaceholder')}
            onChange={(event) => { set('thinkingEffort', event.target.value); }} />
        </Field>
        <Field label={t('st.engines.defaults.permissionMode')} htmlFor={`${item.id}-default-permission`}>
          <SettingsSelect id={`${item.id}-default-permission`} variant="form" className="min-w-0 text-[12px]"
            ariaLabel={t('st.engines.defaults.permissionMode')} triggerData={{ 'data-engine-default': 'permission_mode' }}
            value={draft.permissionMode} disabled={saving}
            onChange={(next) => { set('permissionMode', next); }}
            choices={[
              { value: '', label: t('st.engines.defaults.inheritPlaceholder') },
              { value: 'manual', label: t('composer.perm.manual') },
              { value: 'auto', label: t('composer.perm.auto') },
              { value: 'review', label: t('composer.perm.review') },
              { value: 'yolo', label: t('composer.perm.yolo') },
            ]} />
        </Field>
      </div>
      <div className="space-y-2 pt-3">
        <p className="text-[12px] font-medium text-ink-soft">{t('st.kikiContext.title')}</p>
        <ul className="space-y-2.5">
          <li data-engine-default-group="subagents" className="space-y-1">
            <Toggle layout="row" label={t('st.profiles.kikiSubagents')} checked={draft.allowKikiSubagents === true} disabled={saving}
              onChange={(next) => { set('allowKikiSubagents', next); }} />
            <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.profiles.kikiSubagentsHint', { engine: engineLabel })}</p>
            <p className="break-words font-mono text-[11px] leading-snug text-ink-faint">{delegationTools.slice(0, 3).join(' · ')} · …</p>
          </li>
          {KIKI_CONTEXT_ORDER.filter((group) => group !== 'hooks').map((group) => (
            <GroupRow key={group} group={group} engineLabel={engineLabel} on={on(group)} disabled={saving}
              onChange={(next) => { set('kikiContext', toggleGroup(draft.kikiContext, group, next, engineDefaultsDraftFrom(saved).kikiContext)); }} />
          ))}
          <li data-engine-default-group="hooks" className="space-y-1 border-t border-hairline pt-2">
            <Toggle layout="row" label={t('st.kikiContext.group.hooks')} checked={hooksOn} disabled={saving}
              onChange={(next) => { set('kikiContext', toggleGroup(draft.kikiContext, 'hooks', next, engineDefaultsDraftFrom(saved).kikiContext)); }} />
            <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.kikiContext.hint.hooks', { engine: engineLabel })}</p>
            <p data-engine-default-hook-support={support.level} className="flex flex-wrap items-baseline gap-x-1.5 text-[11.5px] leading-snug">
              <span className="text-ink-soft">{engineLabel}</span>
              <span className={support.level === 'supported' ? 'font-medium text-ink' : support.level === 'untested' ? 'font-medium text-amber-ink' : 'text-ink-faint'}>
                {t(`st.kikiContext.support.${support.level}` as I18nKey)}
              </span>
            </p>
          </li>
        </ul>
      </div>
      <div className="space-y-2 pt-3">
        <p className="text-[12px] font-medium text-ink-soft">{t('st.executorPrompt.title')}</p>
        <Field label={t('st.executorPrompt.delivery')} htmlFor={`${item.id}-default-delivery`}>
          <SettingsSelect id={`${item.id}-default-delivery`} variant="form" className="min-w-0 text-[12px]"
            ariaLabel={t('st.executorPrompt.delivery')} triggerData={{ 'data-engine-default': 'executor_prompt.delivery' }}
            value={draft.promptDelivery} disabled={saving}
            onChange={(next) => { set('promptDelivery', next); }}
            choices={[
              { value: '', label: t('st.engines.defaults.inheritPlaceholder') },
              ...DELIVERIES.map((delivery) => ({ value: delivery, label: t(`st.executorPrompt.delivery.${delivery}`) })),
            ]} />
        </Field>
        <fieldset className="min-w-0 space-y-2">
          <legend className="mb-1 text-[12px] font-medium text-ink-soft">{t('st.executorPrompt.include')}</legend>
          <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
            {CONTEXT_BLOCKS.map((id) => (
              <label key={id} data-engine-default-include={id}
                className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 text-[12.5px] text-ink hover:bg-ink/[0.03] ${saving ? 'cursor-not-allowed opacity-60' : ''}`}>
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--color-selected-ink)]" disabled={saving}
                  checked={(draft.promptInclude ?? []).includes(id)}
                  onChange={(event) => {
                    const current = draft.promptInclude ?? [];
                    set('promptInclude', event.target.checked
                      ? CONTEXT_BLOCKS.filter((entry) => [...current, id].includes(entry))
                      : current.filter((entry) => entry !== id));
                  }} />
                <span className="min-w-0 truncate">{t(`st.executorPrompt.block.${id}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('st.executorPrompt.body')} htmlFor={`${item.id}-default-prompt-body`} hint={t('st.executorPrompt.bodyHint')}>
          <textarea id={`${item.id}-default-prompt-body`} data-engine-default="executor_prompt.body" rows={3} spellCheck={false} disabled={saving}
            className={`${INPUT} min-h-16 font-mono text-[12px] leading-[1.6]`} value={draft.promptBody}
            onChange={(event) => { set('promptBody', event.target.value); }} />
        </Field>
        <Field label={t('st.executorPrompt.append')} htmlFor={`${item.id}-default-prompt-append`} hint={t('st.executorPrompt.appendHint')}>
          <textarea id={`${item.id}-default-prompt-append`} data-engine-default="executor_prompt.append" rows={2} spellCheck={false} disabled={saving}
            className={`${INPUT} min-h-14 font-mono text-[12px] leading-[1.6]`} value={draft.promptAppend}
            onChange={(event) => { set('promptAppend', event.target.value); }} />
        </Field>
      </div>
      <div
        data-engine-defaults-shape={draft.kikiContext === undefined ? 'absent' : draft.kikiContext.length === 0 ? 'empty' : 'list'}
        className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pt-2.5">
        <p className="min-w-0 text-[11.5px] leading-snug text-ink-faint">
          <span className="font-mono text-[11px] text-ink-soft">kiki_context</span>{' '}
          {draft.kikiContext === undefined ? t('st.kikiContext.fieldAbsent')
            : draft.kikiContext.length === 0 ? t('st.kikiContext.fieldEmpty')
              : tp('st.kikiContext.fieldList', draft.kikiContext.length)}
        </p>
        {draft.kikiContext !== undefined ? (
          <button type="button" data-engine-defaults-clear-context disabled={saving}
            onClick={() => { set('kikiContext', undefined); }}
            className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50">
            {t('st.kikiContext.clear')}
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-engine-defaults-save className={SECONDARY_BUTTON} disabled={saving || !dirty} aria-busy={saving}
          onClick={() => { void save(); }}>
          {saving ? t('st.engines.override.saving') : t('st.engines.defaults.save')}
        </button>
        <span className="text-[12px] text-ink-faint">{t('st.engines.defaults.applyNote')}</span>
      </div>
      <FeedbackLine feedback={feedback} />
    </details>
  );
}
