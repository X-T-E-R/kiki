/**
 * The concurrency-rule editor: the list of request-governance rules with a
 * switch per rule, an inline form to add or change one, and delete with
 * Undo. It is a server setting ("from now on, at most N at once"), so it is
 * mountable wherever such defaults live; the Usage page's Live tab only
 * reports how many rules hold the queue and opens this on request.
 *
 * Contract: the caller hands in the rules the server last reported
 * (`RequestGovernanceSnapshot.rules`, read through `useRequestGovernance` or
 * any read of `GET request-governance`). Every write sends the whole list
 * through `client.setRequestGovernanceRules` (the config save path, so paused
 * rules stay paused and rules of the other resource kind survive) and then
 * invalidates `['request-governance']`, so any reader of that key re-reads.
 * The model and provider lists that feed the form's suggestions are read
 * only while the editor is mounted.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ModelCatalogItem, RequestGovernanceSnapshot } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { replaceConcurrencyResourceRules } from '../../lib/liveAgentGovernance';
import { pushToast, pushUndoToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Toggle } from '../controls';
import { InlineEditor } from '../InlineEditor';
import { ModelPicker } from '../ModelPicker';
import { LIST_TOOLS_MIN_ITEMS } from '../settings/list';
import { SettingsSelect } from '../settings/SettingsPrimitives';
import { DANGER_GHOST_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { AxisGroup, UsageSectionHeading } from './usageShared';

export type GovernanceRule = RequestGovernanceSnapshot['rules'][number];

export interface ConcurrencyRulesEditorProps {
  /** The rules as the server last reported them; the editor never reads them itself. */
  readonly rules: readonly GovernanceRule[];
  /**
   * Show the editor's own heading (title, rule count, "Add rule"). A host
   * that already titles the area, such as a settings card, passes false and
   * gets the add button on the resource filter row instead.
   */
  readonly showHeading?: boolean;
}

const FIELD_INPUT = 'h-8 w-full rounded-md border border-hairline bg-paper px-2 font-mono text-[12.5px] text-ink tabular-nums outline-none transition-colors duration-[var(--kiki-motion-quick)] placeholder:text-ink-faint focus:border-selected-ink aria-[invalid=true]:border-danger';

/** Server messages arrive as `msg (code N)`; the editor's inline line drops the diagnostic tail. */
function editorErrorText(error: unknown, t?: (key: I18nKey) => string): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('agent_ancestor_limit')) {
    if (t) {
      return `${t('usage.governance.ancestorLimitTitle')}: ${t('usage.governance.ancestorLimitMessage')}`;
    }
    return 'Parent agent is occupying the execution slot. Separate main and subagent rules or raise the limit.';
  }
  return text.replace(/\s*\(code [^)]+\)\s*$/, '');
}

/** The rule's resource, with the retired `live_agent` read as agent execution. */
function resourceOf(rule: GovernanceRule): 'model_request' | 'agent_execution' {
  return (rule.resource as string | undefined) === 'live_agent' ? 'agent_execution' : (rule.resource ?? 'model_request');
}

/** Comma/space-separated text ↔ the rule's id list; empty means "all". */
function parseIdList(text: string): string[] | undefined {
  const items = [...new Set(text.split(/[,，、\s]+/).map((part) => part.trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
}

type ExecutionRole = 'main' | 'subagent' | 'independent';
type RolePreset = 'all' | 'main_only' | 'subagent_only' | 'independent_only' | 'custom';
const ROLE_SEGMENT_OPTIONS = ['all', 'main_only', 'subagent_only', 'independent_only'] as const;

/** Zero roles is every agent. Two or more stay a custom selection, not All. */
function rolePresetFor(roles: readonly ExecutionRole[]): RolePreset {
  if (roles.length === 0) return 'all';
  if (roles.length > 1) return 'custom';
  if (roles[0] === 'main') return 'main_only';
  if (roles[0] === 'subagent') return 'subagent_only';
  return 'independent_only';
}

interface RuleDraft {
  readonly id: string;
  readonly resource: 'model_request' | 'agent_execution' | 'live_agent';
  readonly scope: 'global' | 'each_session';
  readonly models: readonly string[];
  readonly providers: string;
  readonly executors: string;
  readonly profiles: string;
  readonly roles: readonly ExecutionRole[];
  readonly roleScope: RolePreset;
  readonly subagentsOnly: boolean;
  readonly cap: string;
  readonly overflow: 'queue' | 'reject';
  readonly waitSeconds: string;
  /** Not a form field: the row switch owns it, and a save must not reset it. */
  readonly enabled: boolean;
}

function draftOf(rule: GovernanceRule): RuleDraft {
  const resource = (rule.resource as any) === 'live_agent' ? 'agent_execution' : (rule.resource ?? 'model_request');
  const roles: ExecutionRole[] = rule.roles ? [...rule.roles] : [];
  if (roles.length === 0) {
    const legacyScope = (rule as { role_scope?: string }).role_scope;
    if (legacyScope === 'main_only') roles.push('main');
    else if (legacyScope === 'subagent_only' || rule.subagentsOnly) roles.push('subagent');
    else if (legacyScope === 'independent_only') roles.push('independent');
  }
  return {
    id: rule.id,
    resource,
    scope: rule.scope,
    models: rule.models ? [...rule.models] : [],
    providers: rule.providers?.join(', ') ?? '',
    executors: rule.executors?.join(', ') ?? '',
    profiles: rule.profiles?.join(', ') ?? '',
    roles,
    roleScope: rolePresetFor(roles),
    subagentsOnly: Boolean(rule.subagentsOnly),
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
  return {
    id: `rule-${index}`,
    resource: 'model_request',
    scope: 'global',
    models: [],
    providers: '',
    executors: '',
    profiles: '',
    roles: [],
    roleScope: 'all',
    subagentsOnly: false,
    cap: '2',
    overflow: 'queue',
    waitSeconds: '',
    enabled: true,
  };
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

  const models = [...new Set(draft.models.map((entry) => entry.trim()).filter(Boolean))];
  const ruleModels = models.length > 0 ? models : undefined;

  if (draft.resource === 'agent_execution' || draft.resource === 'live_agent') {
    const roles = draft.roles.length > 0 ? [...draft.roles] : undefined;
    return {
      rule: {
        id,
        resource: 'agent_execution',
        scope: draft.scope,
        executors: parseIdList(draft.executors),
        profiles: parseIdList(draft.profiles),
        models: ruleModels,
        ...(roles !== undefined ? { roles } : {}),
        subagentsOnly: roles?.length === 1 && roles[0] === 'subagent',
        maxConcurrent: cap,
        overflow: draft.overflow,
        maxWaitMs: waitSeconds === undefined ? undefined : Math.round(waitSeconds * 1000),
        enabled: draft.enabled,
      },
    };
  }

  return {
    rule: {
      id,
      resource: 'model_request',
      scope: draft.scope,
      models: ruleModels,
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
  const isAgent = rule.resource === 'agent_execution' || (rule.resource as any) === 'live_agent';

  let target: string;
  if (isAgent) {
    const parts = [
      rule.executors !== undefined ? rule.executors.join(', ') : undefined,
      rule.profiles !== undefined ? rule.profiles.join(', ') : undefined,
      rule.models !== undefined ? rule.models.join(', ') : undefined,
      rule.roles !== undefined ? rule.roles.join(', ') : (
        (rule as any).role_scope === 'main_only' ? t('usage.governance.roleScopeMain') :
        ((rule as any).role_scope === 'subagent_only' || rule.subagentsOnly) ? t('usage.governance.roleScopeSub') :
        (rule as any).role_scope === 'independent_only' ? t('usage.governance.roleScopeIndependent') : undefined
      ),
    ].filter((part) => part !== undefined);
    target = parts.length > 0 ? parts.join(' · ') : t('usage.governance.all');
  } else {
    const parts = [
      rule.models !== undefined ? rule.models.join(', ') : undefined,
      rule.providers !== undefined ? rule.providers.join(', ') : undefined,
      rule.subagentsOnly ? t('usage.governance.children') : undefined,
    ].filter((part) => part !== undefined);
    target = parts.length > 0 ? parts.join(' · ') : t('usage.governance.all');
  }

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

function RuleEditor({ initial, otherIds, isNew, models, providerOptions, onSubmit, onCancel, onDelete }: {
  readonly initial: RuleDraft;
  readonly otherIds: ReadonlySet<string>;
  readonly isNew: boolean;
  readonly models: readonly ModelCatalogItem[];
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
  const rolePreset = rolePresetFor(draft.roles);
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
          label={t('usage.governance.resource')}
          dataAxis="governance-resource"
          options={['model_request', 'agent_execution'] as const}
          value={draft.resource === 'live_agent' ? 'agent_execution' : draft.resource}
          onChange={(resource) => { patch({ resource }); }}
          labelFor={(option) => t(option === 'model_request' ? 'usage.governance.resourceModelRequest' : 'usage.governance.resourceAgentExecution')}
        />
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

        {(draft.resource === 'agent_execution' || draft.resource === 'live_agent') ? (
          <>
            <label className="block space-y-1">
              <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.executors')}</span>
              <input
                value={draft.executors}
                spellCheck={false}
                data-governance-executors-input
                list="governance-executor-options"
                placeholder={t('usage.governance.targetHint')}
                onChange={(event) => { patch({ executors: event.target.value }); }}
                className={FIELD_INPUT}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.profiles')}</span>
              <input
                value={draft.profiles}
                spellCheck={false}
                data-governance-profiles-input
                placeholder={t('usage.governance.targetHint')}
                onChange={(event) => { patch({ profiles: event.target.value }); }}
                className={FIELD_INPUT}
              />
            </label>
            <div className="block space-y-1">
              <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.models')}</span>
              <ModelPicker
                multiple
                id={`governance-models-${initial.id}`}
                models={models}
                values={draft.models}
                onChange={(nextModels) => { patch({ models: nextModels }); }}
                emptyText={t('usage.governance.all')}
                ariaLabel={t('usage.governance.models')}
                buttonClassName={`${FIELD_INPUT} flex items-center justify-between gap-2 text-left`}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2" data-governance-role-preset={rolePreset}>
              <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.roles')}</span>
              <div className="flex flex-wrap items-center gap-2">
                <AxisGroup
                  label={t('usage.governance.roleScope')}
                  dataAxis="governance-role-scope"
                  options={ROLE_SEGMENT_OPTIONS}
                  value={(rolePreset === 'custom' ? 'custom' : rolePreset) as typeof ROLE_SEGMENT_OPTIONS[number]}
                  onChange={(scope) => {
                    if (scope === 'all') {
                      patch({ roleScope: 'all', roles: [] });
                    } else if (scope === 'main_only') {
                      patch({ roleScope: 'main_only', roles: ['main'] });
                    } else if (scope === 'subagent_only') {
                      patch({ roleScope: 'subagent_only', roles: ['subagent'] });
                    } else if (scope === 'independent_only') {
                      patch({ roleScope: 'independent_only', roles: ['independent'] });
                    }
                  }}
                  labelFor={(option) => {
                    if (option === 'main_only') return t('usage.governance.roleScopeMain');
                    if (option === 'subagent_only') return t('usage.governance.roleScopeSub');
                    if (option === 'independent_only') return t('usage.governance.roleScopeIndependent');
                    return t('usage.governance.roleScopeAll');
                  }}
                />
                {rolePreset === 'custom' ? (
                  <span data-governance-role-selection className="text-[12px] text-ink">
                    {draft.roles.map((role) => t(role === 'main'
                      ? 'usage.governance.mainAgents'
                      : role === 'subagent'
                        ? 'usage.governance.subagents'
                        : 'usage.governance.independentAgents')).join(', ')}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                {(['main', 'subagent', 'independent'] as const).map((roleKey) => (
                  <label key={roleKey} className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-ink">
                    <input
                      type="checkbox"
                      data-governance-role-checkbox={roleKey}
                      checked={draft.roles.includes(roleKey)}
                      onChange={(e) => {
                        const nextRoles = e.target.checked
                          ? [...draft.roles.filter((r) => r !== roleKey), roleKey]
                          : draft.roles.filter((r) => r !== roleKey);
                        patch({ roles: nextRoles, roleScope: rolePresetFor(nextRoles) });
                      }}
                      className="rounded border-hairline text-accent"
                    />
                    <span>
                      {roleKey === 'main'
                        ? t('usage.governance.roleScopeMain')
                        : roleKey === 'subagent'
                          ? t('usage.governance.roleScopeSub')
                          : t('usage.governance.roleScopeIndependent')}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="block space-y-1">
              <span className="block text-[11.5px] text-ink-soft">{t('usage.governance.models')}</span>
              <ModelPicker
                multiple
                id={`governance-models-${initial.id}`}
                models={models}
                values={draft.models}
                onChange={(nextModels) => { patch({ models: nextModels }); }}
                emptyText={t('usage.governance.all')}
                ariaLabel={t('usage.governance.models')}
                buttonClassName={`${FIELD_INPUT} flex items-center justify-between gap-2 text-left`}
              />
            </div>
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
          </>
        )}

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
      <datalist id="governance-executor-options">
        <option value="kiki" />
        <option value="acp" />
        <option value="claude-code" />
        <option value="codex" />
      </datalist>
      <datalist id="governance-provider-options">
        {providerOptions.map((id) => <option key={id} value={id} />)}
      </datalist>
      {invalid !== null ? (
        <p role="alert" className="text-[12px] text-danger">
          {t(invalid === 'name' ? 'usage.governance.invalidName' : invalid === 'cap' ? 'usage.governance.invalidCap' : 'usage.governance.invalidWait')}
        </p>
      ) : null}
      {failure !== null ? <FeedbackLine feedback={{ tone: 'error', text: editorErrorText(failure, t) }} /> : null}
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

export function ConcurrencyRulesEditor({ rules, showHeading = true }: ConcurrencyRulesEditorProps) {
  const { t, tp } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  /** The row whose editor is open, or 'new' while the add form is. */
  const [editorFor, setEditorFor] = useState<string | null>(null);
  const [resourceFilter, setResourceFilter] = useState<'all' | 'model_request' | 'agent_execution'>('all');

  const modelOptions = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const providerOptions = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const catalogModels = modelOptions.data?.items ?? [];
  const providerIds = useMemo(() => (providerOptions.data?.items ?? []).map((item) => item.id), [providerOptions.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['request-governance'] });
  const writeError = (error: unknown) => {
    const errorStr = error instanceof Error ? error.message : String(error);
    const isAncestorLimit = errorStr.includes('agent_ancestor_limit') || (error as any)?.details?.action === 'separate_main_subagent_rules_or_raise_limit';
    const text = isAncestorLimit ? t('usage.governance.ancestorLimitTitle') : t('usage.governance.saveFailed');
    const detail = isAncestorLimit ? t('usage.governance.ancestorLimitMessage') : errorStr;
    pushToast({ tone: 'error', text, detail });
  };

  const toggle = useMutation({
    mutationFn: (next: { rule: GovernanceRule; enabled: boolean }) =>
      client.setRequestGovernanceRules(rules.map((rule) => (rule.id === next.rule.id ? { ...rule, enabled: next.enabled } : rule))),
    onSuccess: refresh,
    onError: (error: unknown) => { writeError(error); void refresh(); },
  });

  const remove = useMutation({
    mutationFn: (rule: GovernanceRule) => {
      const rawResource = (rule.resource as any) === 'live_agent' ? 'agent_execution' : (rule.resource ?? 'model_request');
      const resourceRules = rules
        .filter((r) => ((r.resource as any) === 'live_agent' ? 'agent_execution' : (r.resource ?? 'model_request')) === rawResource && r.id !== rule.id);
      const next = replaceConcurrencyResourceRules(
        rules.map((r) => ({ ...r, resource: ((r.resource as any) === 'live_agent' ? 'agent_execution' : (r.resource ?? 'model_request')) as any })),
        rawResource as any,
        resourceRules as any,
      );
      return client.setRequestGovernanceRules(next as any);
    },
    // Deleting a rule is reversible: the full list before the delete is kept
    // and written back by the toast's Undo, so there is no confirm step.
    onMutate: () => rules,
    onSuccess: async (_echo, rule, previous) => {
      setEditorFor(null);
      await refresh();
      pushUndoToast({
        text: t('usage.governance.deleted', { name: rule.id }),
        undoFailedText: t('toast.undoFailed'),
        undo: async () => { await client.setRequestGovernanceRules(previous); await refresh(); },
      });
    },
    onError: (error: unknown) => { writeError(error); void refresh(); },
  });

  const saveEdited = (originalId: string | null) => async (rule: GovernanceRule) => {
    const rawResource = (rule.resource as any) === 'live_agent' ? 'agent_execution' : (rule.resource ?? 'model_request');
    const updatedRule = { ...rule, resource: rawResource };
    const resourceRules = rules
      .filter((r) => ((r.resource as any) === 'live_agent' ? 'agent_execution' : (r.resource ?? 'model_request')) === rawResource);
    const updatedResourceRules = originalId === null
      ? [...resourceRules, updatedRule]
      : resourceRules.map((r) => (r.id === originalId ? updatedRule : r));

    const next = replaceConcurrencyResourceRules(
      rules.map((r) => ({ ...r, resource: ((r.resource as any) === 'live_agent' ? 'agent_execution' : (r.resource ?? 'model_request')) as any })),
      rawResource as any,
      updatedResourceRules as any,
    );
    await client.setRequestGovernanceRules(next as any);
    setEditorFor(null);
    await refresh();
  };

  // The resource filter is a list tool: it earns its place only on a long
  // list that holds both kinds of rule (settings conventions §3).
  const showFilter = rules.length >= LIST_TOOLS_MIN_ITEMS
    && rules.some((rule) => resourceOf(rule) === 'model_request')
    && rules.some((rule) => resourceOf(rule) === 'agent_execution');
  const filteredRules = showFilter
    ? rules.filter((rule) => resourceFilter === 'all' || resourceOf(rule) === resourceFilter)
    : rules;

  const addButton = (
    <button
      type="button"
      data-governance-add
      disabled={editorFor !== null}
      onClick={() => { setEditorFor('new'); }}
      className={SECONDARY_BUTTON}
    >
      {t('usage.governance.addRule')}
    </button>
  );

  return (
    <section data-governance-rules>
      {showHeading ? (
        <UsageSectionHeading
          title={t('usage.governance.limitsTitle')}
          help={tp('usage.governance.ruleCount', rules.length)}
          actions={addButton}
        />
      ) : null}
      {showFilter || !showHeading ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          {showFilter ? (
            <span className="flex items-center gap-2">
              <span className="shrink-0 text-[13px] text-ink">{t('usage.governance.resource')}</span>
              <SettingsSelect<'all' | 'model_request' | 'agent_execution'>
                ariaLabel={t('usage.governance.resource')}
                dataAttr="data-axis-select"
                value={resourceFilter}
                onChange={(next) => { setResourceFilter(next); }}
                choices={[
                  { value: 'all', label: t('usage.governance.allRules') },
                  { value: 'model_request', label: t('usage.governance.resourceModelRequest') },
                  { value: 'agent_execution', label: t('usage.governance.resourceAgentExecution') },
                ]}
              />
            </span>
          ) : null}
          {showHeading ? null : <span className="ml-auto">{addButton}</span>}
        </div>
      ) : null}
      {filteredRules.length === 0 && editorFor !== 'new' ? (
        <div data-governance-empty className="py-3">
          <p className="text-[12.5px] text-ink-soft">{t('usage.governance.emptyTitle')}</p>
          <p className="mt-1 max-w-md text-[12px] leading-relaxed text-ink-faint">{t('usage.governance.emptyBody')}</p>
        </div>
      ) : null}
      {editorFor === 'new' ? (
        <div className="mb-3 rounded-lg bg-ink/[0.03] p-3">
          <RuleEditor
            initial={freshDraft(rules)}
            otherIds={new Set(rules.map((rule) => rule.id))}
            isNew
            models={catalogModels}
            providerOptions={providerIds}
            onSubmit={saveEdited(null)}
            onCancel={() => { setEditorFor(null); }}
          />
        </div>
      ) : null}
      <ol className={`divide-y divide-hairline ${filteredRules.length > 0 ? 'border-t border-hairline' : ''}`}>
        {filteredRules.map((rule) => {
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
                  models={catalogModels}
                  providerOptions={providerIds}
                  onSubmit={saveEdited(rule.id)}
                  onCancel={() => { setEditorFor(null); }}
                  onDelete={() => { remove.mutate(rule); }}
                />
              </InlineEditor>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
