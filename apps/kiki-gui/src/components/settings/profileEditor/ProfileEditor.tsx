import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { ModelCatalogItem, NamedAgentExecutorField } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import type { NamedAgentProfile, ShippedAgentProfile } from '../../../lib/client';
import { formatCompactTokens } from '../../../lib/autoCompact';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Toggle, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { DetailBack } from '../../overlays/DetailSplit';
import { SearchableSelect } from '../../SearchableSelect';
import { useGuardedNavigate } from '../../dirtyGuard';
import { sourceBadgeLabel } from '../../agent-panel/SourceBadge';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { CompactPointField } from '../CompactPointField';
import { FORM_SELECT_TRIGGER, SettingsDraftFooter, SettingsSegmented } from '../SettingsPrimitives';
import { ShippedProfileControls } from '../ShippedProfileControls';
import { DiagnosticsList } from './DiagnosticsList';
import type { ProfileDiagnostic } from './diagnostics';
import { engineChoices, engineDisplayOf, engineLabel, engineOverridesOf, useExecutorCatalog } from './engines';
import { ExecutorPromptField } from './ExecutorPromptField';
import { KikiContextField } from './KikiContextField';
import type { ExecutorPromptDraft } from './executorPromptDraft';
import { EffortPicker, Field, ModelPicker, Section } from './fields';
import { ModelProfilesField } from './ModelProfilesField';
import { ModelMenuField } from './ModelMenuField';
import { EffortCell, ModelCell, RuleMatrix } from './ModelRules';
import { modelMenuDraftPatch, useModelMenuPreview } from './useModelMenuPreview';
import {
  changedFields, draftFromProfile, draftProblems, EMPTY_SPAWN_CONSTRAINTS, isExternalExecutor, kikiSubagentsApplicable, patchBody, spawnConstraintsSet,
  type ProfileDraft, type SpawnConstraintsDraft, type ToolFieldMode, type ToolFieldValue,
} from './profileDraft';
import { RawPanel } from './RawPanel';
import { SubagentsField } from './SubagentsField';
import { RecipeOptionsField } from '../RecipeOptionsField';
import { useSavedTick } from '../useSavedTick';
import { PromptIdentityEditor, PromptOverridesContentEditor } from '../PromptIdentityEditor';
import { promptIdentityProblem, promptOverridesBody, promptOverridesProblem } from '../promptIdentityDraft';

/**
 * The editor's tabs, each answering one question a person has about an agent:
 * who it is, how it runs, whom it may send work to, what it may touch, and
 * the rest. The raw file is the last tab, a second view of the same object.
 */
type Tab = 'identity' | 'run' | 'dispatch' | 'tools' | 'advanced' | 'raw';
const FORM_TABS: readonly Exclude<Tab, 'raw'>[] = ['identity', 'run', 'dispatch', 'tools', 'advanced'];
const TAB_LABEL: Record<Tab, I18nKey> = {
  identity: 'st.profiles.tab.identity', run: 'st.profiles.tab.run', dispatch: 'st.profiles.tab.dispatch',
  tools: 'st.profiles.tab.tools', advanced: 'st.profiles.tab.advanced', raw: 'st.profiles.tab.raw',
};
/** Which tab owns each draft field, so a tab can show that it holds unsaved edits. */
const FIELD_TAB: Record<keyof ProfileDraft, Exclude<Tab, 'raw'>> = {
  description: 'identity', whenToUse: 'identity', prompt: 'identity', main: 'identity',
  executor: 'run', allowKikiSubagents: 'run', kikiContext: 'run', modelAlias: 'run', effort: 'run', recipeOptions: 'run',
  restrictModelsToMenu: 'run', preferredModels: 'run', discouragedModels: 'run', preferredEfforts: 'run',
  allowedModels: 'run', denyModels: 'run', allowedEfforts: 'run', modelProfiles: 'run', executorPrompt: 'run',
  subagentPolicy: 'dispatch', spawnConstraints: 'dispatch',
  tools: 'tools', disallowedTools: 'tools',
  promptOverrides: 'advanced', serviceTier: 'advanced', autoCompact: 'advanced', routeAliases: 'advanced',
};

const TOOL_MODES: readonly ToolFieldMode[] = ['inherit', 'empty', 'list'];

/** `executor_fields` keys the "not used by this engine" fold can name (st.profiles.fieldName.*). */
const IGNORABLE_FIELDS = ['pinned_model_alias', 'thinking_effort', 'tools', 'disallowed_tools', 'service_tier',
  'request_params', 'context_budget', 'auto_compact', 'max_completion_tokens'] as const;

/** Whether the profile file writes this field (a value the engine will not use). */
function profileSets(profile: NamedAgentProfile, key: (typeof IGNORABLE_FIELDS)[number]): boolean {
  return profile[key] !== undefined;
}

function executorPromptCount(value: ExecutorPromptDraft | null): number {
  if (value === null) return 0;
  return Number(value.delivery !== undefined) + (value.include?.length ?? 0) + Number(value.body !== undefined)
    + Number(value.append !== undefined) + Object.keys(value.per_engine ?? {}).length;
}

function ToolList({ id, label, field, onChange, disabled, deny, applicability, engine }: {
  id: string; label: string; field: ToolFieldValue; onChange: (next: ToolFieldValue) => void; disabled: boolean; deny: boolean;
  applicability?: NamedAgentExecutorField;
  engine: string;
}) {
  const { t } = useI18n();
  const labels: Record<ToolFieldMode, I18nKey> = deny
    ? { inherit: 'st.namedAgents.toolsModeInherit', empty: 'st.namedAgents.disallowedToolsModeNone', list: 'st.namedAgents.disallowedToolsModeDeny' }
    : { inherit: 'st.namedAgents.toolsModeInherit', empty: 'st.namedAgents.toolsModeDenyAll', list: 'st.namedAgents.toolsModeList' };
  return <Field label={label} applicability={applicability} engine={engine} dataField={id}>
    <SettingsSegmented<ToolFieldMode> ariaLabel={label} value={field.mode} disabled={disabled} dataAttr={`data-tool-mode-${id.toLowerCase()}`}
      onChange={(mode) => onChange({ ...field, mode })} choices={TOOL_MODES.map((mode) => ({ value: mode, label: t(labels[mode]) }))} />
    {field.mode === 'list' ? <textarea aria-label={label} data-tool-list={id} className={`${INPUT} min-h-20 font-mono text-[12px]`} value={field.text}
      disabled={disabled} placeholder={t('st.namedAgents.toolsPlaceholder')} onChange={(event) => onChange({ ...field, text: event.target.value })} /> : null}
  </Field>;
}

/** A titled block inside a tab: one heading, generous space, no explanatory paragraph. */
function Block({ title, children, dataBlock, action }: { title: string; children: ReactNode; dataBlock: string; action?: ReactNode }) {
  return <section data-profile-block={dataBlock} className="min-w-0 space-y-3">
    <div className="flex min-h-7 items-center justify-between gap-2">
      <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
      {action}
    </div>
    {children}
  </section>;
}

/**
 * The profile editor sheet. Tabs follow the questions a person asks of an
 * agent rather than the order of the frontmatter; model rules are drawn as two
 * cards (the agent itself, and the agents it sends out), each a small matrix
 * of only-these / suggested / never over the existing fields. Save, discard
 * and the PATCH stay exactly what they were.
 */
export function ProfileEditor({ profile, writable, profiles, models, diagnostics, shippedEntry, onSaved, onClose, onOpenWinner,
  onToggleEnabled, toggleSaving, onNewSession, newSessionBlocked, onDuplicate }: {
  profile: NamedAgentProfile;
  writable: boolean;
  profiles: readonly NamedAgentProfile[];
  models: readonly ModelCatalogItem[];
  diagnostics: readonly ProfileDiagnostic[];
  shippedEntry?: ShippedAgentProfile;
  onSaved: (updated: NamedAgentProfile) => void;
  onClose: () => void;
  onOpenWinner?: () => void;
  onToggleEnabled: (enabled: boolean) => Promise<void>;
  toggleSaving: boolean;
  onNewSession: () => void;
  newSessionBlocked: boolean;
  onDuplicate: () => void;
}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const [tab, setTab] = useState<Tab>('identity');
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const [baseline, setBaseline] = useState(() => draftFromProfile(profile));
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const [rawReload, setRawReload] = useState(0);
  const changed = changedFields(baseline, draft);
  const dirty = changed.length > 0;
  const dirtyTabs = new Set(changed.map((key) => FIELD_TAB[key]));
  const problems = draftProblems(draft);
  const menuPreview = useModelMenuPreview(profile, modelMenuDraftPatch(patchBody(profile, baseline, draft), profile), draft.restrictModelsToMenu);
  useEffect(() => {
    if (dirty) return;
    const next = draftFromProfile(profile);
    setBaseline(next); setDraft(next);
  }, [profile]);
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const catalog = useExecutorCatalog();
  const engineConfig = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000, retry: false });
  const engineOverrides = engineOverridesOf(engineConfig.data);
  const engineDisplay = engineDisplayOf(engineConfig.data);
  const external = isExternalExecutor(draft.executor);
  const engine = engineLabel(draft.executor, t('st.profiles.engineNative'), catalog);
  // Reserved applicability data applies only to the saved engine; an unsaved
  // engine change has no server answer yet.
  const fieldState = (key: string) => draft.executor === baseline.executor ? profile.executor_fields?.[key] : undefined;
  // Every field the saved engine ignores, including ones the form does not
  // model (request params, budgets): listed with the server's reason, never hidden.
  const ignoredFields = IGNORABLE_FIELDS.flatMap((key) => {
    const field = fieldState(key);
    return field?.state === 'ignored' ? [[key, field] as const] : [];
  });
  const profileModels = external ? [] : models;
  const pinned = profileModels.find((model) => model.id === draft.modelAlias.trim());
  const aliasMissing = (alias: string) => !external && alias !== '' && alias !== 'inherit' && models.length > 0 && !models.some((model) => model.id === alias);

  const accept = (updated: NamedAgentProfile) => {
    const next = draftFromProfile(updated);
    setBaseline(next); setDraft(next);
    onSaved(updated);
  };
  const save = async () => {
    if (!writable || !dirty || problems.length > 0 || !menuPreview.ready || profile.workspace_id === undefined) return;
    setSaving(true); setFeedback(null);
    try {
      const updated = await client.updateNamedAgentProfile(profile.name, patchBody(profile, baseline, draft));
      accept(updated);
      setRawReload((value) => value + 1);
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setSaving(false); }
  };
  const disabled = !writable || saving;
  const problemText = problems.length === 0 ? null : t(`st.profiles.problem.${problems[0]}` as I18nKey);
  const engines = useMemo(() => engineChoices(profiles, catalog, {
    overrides: engineOverrides,
    display: engineDisplay,
    retain: [baseline.executor, draft.executor],
  }), [profiles, catalog, engineOverrides, engineDisplay, baseline.executor, draft.executor]);
  const engineStatus = (id: string) => catalog.find((item) => item.id === id)?.status;
  const promptDeliveries = catalog.find((item) => item.id === draft.executor)?.capabilities?.prompt_deliveries;
  const promptDelivery = draft.executorPrompt?.per_engine?.[draft.executor]?.delivery ?? draft.executorPrompt?.delivery
    ?? (promptDeliveries?.includes('replace') && !promptDeliveries.includes('append') ? 'replace'
      : promptDeliveries?.includes('append') ? 'append' : 'preamble');
  const spawn = draft.spawnConstraints;
  const setSpawn = (patch: Partial<SpawnConstraintsDraft>) => set('spawnConstraints', { ...spawn, ...patch });
  const kikiContextOn = [...(draft.allowKikiSubagents ? [t('st.kikiContext.short.subagents')] : []),
    ...(draft.kikiContext ?? []).map((group) => t(`st.kikiContext.short.${group}` as I18nKey))];
  const kikiContextSummary = kikiContextOn.length === 0 ? t('st.kikiContext.summaryOff') : kikiContextOn.join(' · ');
  // The raw file is a second view of the saved file: open it only from a clean form.
  const rawLocked = dirty && tab !== 'raw';
  const tabs: readonly Tab[] = [...FORM_TABS, 'raw'];
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const enabled = tabs.filter((item) => item !== 'raw' || !rawLocked);
    const at = enabled.indexOf(tab);
    const next = event.key === 'ArrowRight' ? enabled[(at + 1) % enabled.length]
      : event.key === 'ArrowLeft' ? enabled[(at - 1 + enabled.length) % enabled.length]
        : event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };

  const identityPanel = <div className="grid min-w-0 gap-8 @3xl:grid-cols-[minmax(0,1fr)_20rem]">
    <div className="flex min-w-0 flex-col gap-1.5" data-profile-prompt>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor="profile-prompt" className="text-[12px] font-medium text-ink-soft">{t('st.profiles.prompt')}</label>
        <span className="text-[11.5px] tabular-nums text-ink-faint">{t('st.profiles.promptSize', { lines: draft.prompt === '' ? 0 : draft.prompt.split('\n').length, chars: draft.prompt.length })}</span>
      </div>
      {writable ? <textarea id="profile-prompt" value={draft.prompt} disabled={saving} spellCheck={false}
        onChange={(event) => set('prompt', event.target.value)} placeholder={t('st.profiles.promptPlaceholder')}
        className="min-h-[24rem] resize-y rounded-lg border border-hairline bg-paper px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-ink outline-none placeholder:text-ink-faint focus:border-selected-ink lg:h-[calc(100vh-22rem)]" />
        : <div id="profile-prompt" className="min-h-[16rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-paper px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-ink lg:max-h-[calc(100vh-22rem)]">{draft.prompt === '' ? <span className="font-sans text-ink-faint">{t('st.profiles.promptEmpty')}</span> : draft.prompt}</div>}
      {external ? <p data-prompt-delivery className="text-[11.5px] text-ink-faint">{fieldState('prompt')?.reason ?? t('st.profiles.promptDelivery', { engine })}</p> : null}
    </div>
    <div className="min-w-0 space-y-5">
      <Field label={t('st.namedAgents.description')} htmlFor="profile-description" dataField="description">
        <textarea id="profile-description" rows={2} className={`${INPUT} text-[13px] leading-snug`} value={draft.description} disabled={disabled}
          onChange={(event) => set('description', event.target.value)} />
      </Field>
      <Field label={t('st.namedAgents.whenToUse')} htmlFor="profile-when" dataField="whenToUse">
        <textarea id="profile-when" rows={4} className={`${INPUT} text-[13px] leading-snug`} value={draft.whenToUse} disabled={disabled}
          placeholder={t('st.profiles.whenToUsePlaceholder')} onChange={(event) => set('whenToUse', event.target.value)} />
      </Field>
      <div data-profile-field="main" className="space-y-1 pt-4">
        <Toggle layout="row" label={t('st.profiles.mainToggle')} checked={draft.main} disabled={disabled} onChange={(value) => set('main', value)} />
        <p className="text-[11.5px] leading-snug text-ink-faint">{t(draft.main ? 'st.profiles.mainOnHint' : 'st.profiles.mainOffHint')}</p>
      </div>
    </div>
  </div>;

  const selfRules = <RuleMatrix dataRules="self" title={t('st.profiles.rulesSelf')} rows={[
    { id: 'models', label: t('st.profiles.model'), cells: {
      allow: <div data-profile-field="allowedModels"><ModelCell id="allowed-models" any values={draft.allowedModels} models={profileModels} disabled={disabled} onChange={(next) => set('allowedModels', next)} /></div>,
      prefer: <div data-profile-field="preferredModels"><ModelCell id="preferred-models" values={draft.preferredModels} models={profileModels} disabled={disabled} onChange={(next) => set('preferredModels', next)} /></div>,
      avoid: <div data-profile-field="discouragedModels"><ModelCell id="discouraged-models" values={draft.discouragedModels} models={profileModels} disabled={disabled} onChange={(next) => set('discouragedModels', next)} /></div>,
      block: <div data-profile-field="denyModels"><ModelCell id="deny-models" values={draft.denyModels} models={profileModels} disabled={disabled} onChange={(next) => set('denyModels', next)} /></div>,
    } },
    { id: 'efforts', label: t('st.profiles.effort'), cells: {
      allow: <div data-profile-field="allowedEfforts"><EffortCell label={`${t('st.profiles.effort')} · ${t('st.profiles.ruleAllow')}`} values={draft.allowedEfforts} disabled={disabled} dataAttr="data-allowed-effort" onChange={(next) => set('allowedEfforts', next)} /></div>,
      prefer: <div data-profile-field="preferredEfforts"><EffortCell ordered label={`${t('st.profiles.effort')} · ${t('st.profiles.rulePrefer')}`} values={draft.preferredEfforts} disabled={disabled} dataAttr="data-preferred-effort" onChange={(next) => set('preferredEfforts', next)} /></div>,
    } },
  ]} />;

  const runPanel = <div className="min-w-0 space-y-10">
    <Block title={t('st.profiles.blockRuns')} dataBlock="runs">
      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_9rem]">
        <Field label={t('st.profiles.engine')} htmlFor="profile-engine" dataField="engine"
          hint={external && engineStatus(draft.executor) === 'unavailable' ? <span className="text-amber-ink">{t('st.profiles.engineNotFound', { engine })}</span>
            : external && draft.executor !== baseline.executor ? <span data-engine-fields-pending>{t('st.profiles.fieldsAfterSave', { engine })}</span>
              : undefined}>
          <SearchableSelect id="profile-engine" value={draft.executor} disabled={disabled} hideFilter allowCustomValue
            options={engines.map((id) => {
              const status = engineStatus(id);
              const version = catalog.find((item) => item.id === id)?.version;
              return {
                value: id, label: engineLabel(id, t('st.profiles.engineNative'), catalog),
                hint: id === '' ? undefined : [id, version, status === 'unavailable' ? t('st.profiles.engineNotInstalled') : undefined].filter(Boolean).join(' · '),
              };
            })}
            ariaLabel={t('st.profiles.engine')} buttonClassName={FORM_SELECT_TRIGGER} onChange={(value) => set('executor', value)} />
        </Field>
        <Field label={t('st.profiles.model')} htmlFor="profile-model" applicability={fieldState('pinned_model_alias')} engine={engine} dataField="model"
          hint={aliasMissing(draft.modelAlias.trim()) ? <span className="text-amber-ink">{t('st.profiles.aliasMissingTitle', { alias: draft.modelAlias.trim() })}</span> : undefined}>
          <ModelPicker id="profile-model" value={draft.modelAlias} models={profileModels} allowInherit={!draft.main} disabled={disabled}
            missing={aliasMissing(draft.modelAlias.trim())} onChange={(value) => setDraft((current) => ({
              ...current, modelAlias: value,
              // A new model may not support the old effort; keep it only if it does.
              effort: !external && value.trim() !== current.modelAlias.trim()
                && (profileModels.find((model) => model.id === value)?.support_efforts?.includes(current.effort) !== true) ? '' : current.effort,
            }))} />
        </Field>
        <Field label={t('st.profiles.effort')} htmlFor="profile-effort" applicability={fieldState('thinking_effort')} engine={engine} dataField="effort">
          <EffortPicker id="profile-effort" value={draft.effort} supported={pinned?.support_efforts} disabled={disabled}
            onChange={(value) => set('effort', value)} />
        </Field>
      </div>
      <RecipeOptionsField recipe={profile.recipe} sourceFile={profile.source_file} values={draft.recipeOptions}
        disabled={disabled || external} onChange={(values) => set('recipeOptions', values)} />
      {external && ignoredFields.length > 0 ? <details data-profile-section="ignored-fields" className="text-[12px]">
        <summary className="cursor-pointer select-none text-ink-soft hover:text-ink">{t('st.profiles.ignoredTitle', { engine })} · {ignoredFields.length}</summary>
        <ul className="mt-2 space-y-2 pl-3">
          {ignoredFields.map(([key, field]) => <li key={key} data-ignored-field={key} className="min-w-0">
            <p className="flex min-w-0 items-baseline gap-2 text-[12.5px] text-ink-soft">
              <span className="font-medium">{t(`st.profiles.fieldName.${key}` as I18nKey)}</span>
              {profileSets(profile, key) ? <span className="text-[11px] text-ink-faint">· {t('st.profiles.fieldValueSet')}</span> : null}
            </p>
            <p className="text-[11.5px] leading-snug text-ink-faint">{field.reason ?? t('st.profiles.fieldIgnored', { engine })}</p>
          </li>)}
        </ul>
      </details> : null}
    </Block>
    {selfRules}
    <Block title={t('st.profiles.modelProfiles')} dataBlock="candidates">
      <div data-profile-section="model-profiles" className="min-w-0 space-y-3">
        <ModelProfilesField values={draft.modelProfiles} models={profileModels} disabled={disabled} onChange={(next) => set('modelProfiles', next)} />
        <ModelMenuField checked={draft.restrictModelsToMenu} baselineChecked={baseline.restrictModelsToMenu} disabled={disabled}
          onChange={(value) => set('restrictModelsToMenu', value)} preview={menuPreview.value}
          pending={menuPreview.pending} error={menuPreview.error} onRetry={menuPreview.retry} />
      </div>
    </Block>
    {external ? <div className="min-w-0 space-y-1">
      {kikiSubagentsApplicable(draft) ? <Section title={t('st.kikiContext.title')} dataSection="kiki-context" defaultOpen
        count={Number(draft.allowKikiSubagents) + (draft.kikiContext?.length ?? 0)} summary={kikiContextSummary}>
        <KikiContextField draft={draft} baseline={baseline} engine={engine} disabled={disabled}
          onChange={(next) => setDraft((current) => ({ ...current, ...next }))} />
      </Section> : null}
      <Section title={t('st.executorPrompt.title')} dataSection="executor-prompt" defaultOpen
        count={executorPromptCount(draft.executorPrompt)} summary={t(`st.executorPrompt.delivery.${promptDelivery}`)}>
        <ExecutorPromptField value={draft.executorPrompt} onChange={(next) => set('executorPrompt', next)} engineId={draft.executor}
          engineLabel={engine} catalog={catalog} profileBody={draft.prompt} disabled={disabled}
          profileName={profile.name} workspaceId={profile.workspace_id} previewEnabled={!dirty} />
      </Section>
    </div> : null}
  </div>;

  const spawnRules = <RuleMatrix dataRules="spawn" title={t('st.profiles.rulesSpawn')}
    action={spawnConstraintsSet(spawn) ? <button type="button" data-spawn-clear disabled={disabled}
      onClick={() => set('spawnConstraints', EMPTY_SPAWN_CONSTRAINTS)}
      className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50">{t('st.profiles.spawnClear')}</button> : undefined}
    rows={[
      { id: 'models', label: t('st.profiles.model'), cells: {
        allow: <div data-profile-field="spawnAllowedModels"><ModelCell id="spawn-allowed-models" any values={spawn.allowedModels} models={profileModels} disabled={disabled} onChange={(next) => setSpawn({ allowedModels: next })} /></div>,
        block: <div data-profile-field="spawnDenyModels"><ModelCell id="spawn-deny-models" values={spawn.denyModels} models={profileModels} disabled={disabled} onChange={(next) => setSpawn({ denyModels: next })} /></div>,
      } },
      { id: 'efforts', label: t('st.profiles.effort'), cells: {
        allow: <div data-profile-field="spawnAllowedEfforts"><EffortCell label={`${t('st.profiles.rulesSpawn')} · ${t('st.profiles.effort')}`} values={spawn.allowedEfforts} disabled={disabled} dataAttr="data-spawn-effort" onChange={(next) => setSpawn({ allowedEfforts: next })} /></div>,
      } },
      { id: 'tools', label: t('st.profiles.tools'), cells: {
        block: <div data-profile-field="spawnDisallowedTools"><textarea id="spawn-disallowed-tools" aria-label={`${t('st.profiles.rulesSpawn')} · ${t('st.profiles.ruleBlock')} · ${t('st.profiles.tools')}`}
          className={`${INPUT} min-h-9 font-mono text-[12px]`} rows={1} value={spawn.disallowedTools} disabled={disabled}
          placeholder={t('st.namedAgents.toolsPlaceholder')} onChange={(event) => setSpawn({ disallowedTools: event.target.value })} /></div>,
      } },
    ]} />;

  const dispatchPanel = <div className="min-w-0 space-y-10" data-profile-section="subagents" data-field-applicability={fieldState('spawn_constraints')?.state}>
    <SubagentsField draft={draft} profiles={profiles} models={models} disabled={disabled} self={profile.name}
      onChange={(next) => setDraft((current) => ({ ...current, ...next }))} />
    {fieldState('subagents')?.state === 'ignored' ? <p className="text-[11.5px] text-ink-faint">{fieldState('subagents')?.reason ?? t('st.profiles.fieldIgnored', { engine })}</p> : null}
    {draft.subagentPolicy.canSpawnSubagents === false ? null : spawnRules}
  </div>;

  const toolsPanel = <div className="grid min-w-0 max-w-[48rem] gap-8" data-profile-section="tools">
    <ToolList id="tools" label={t('st.namedAgents.tools')} field={draft.tools} disabled={disabled} deny={false}
      applicability={fieldState('tools')} engine={engine} onChange={(next) => set('tools', next)} />
    <ToolList id="disallowedTools" label={t('st.namedAgents.disallowedTools')} field={draft.disallowedTools} disabled={disabled} deny
      applicability={fieldState('disallowed_tools')} engine={engine} onChange={(next) => set('disallowedTools', next)} />
    {!draft.main ? <button type="button" data-profile-inspect-tools
      onClick={() => { void navigate(`/settings/agents?tab=dispatch&object=${encodeURIComponent(profile.name)}#st-card-subagent-tool-defaults`); }}
      className="inline-flex w-fit items-center gap-1 text-[12px] text-ink-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-ink">
      {t('st.profiles.inspectToolPermissions')}<Icon name="arrowRight" size={12} />
    </button> : null}
  </div>;

  const advancedPanel = <div className="grid min-w-0 gap-10 @3xl:grid-cols-2" data-profile-section="advanced">
    <div className="min-w-0 space-y-6">
      <Field label={t('st.namedAgents.serviceTier')} applicability={fieldState('service_tier')} engine={engine} dataField="serviceTier">
        <SettingsSegmented<ProfileDraft['serviceTier']> ariaLabel={t('st.namedAgents.serviceTier')} value={draft.serviceTier} disabled={disabled}
          onChange={(value) => set('serviceTier', value)}
          choices={[{ value: '', label: t('st.profiles.unsetShort') }, ...(['auto', 'default', 'flex', 'priority'] as const).map((value) => ({ value, label: value }))]} />
      </Field>
      <div data-profile-auto-compact>
        <CompactPointField dataAttribute="profile" label={t('st.compact.profileLabel')} value={draft.autoCompact}
          onChange={(value) => set('autoCompact', value)} windowTokens={pinned?.max_context_size}
          placeholder={t('st.compact.profilePlaceholder')}
          hint={profile.context_budget !== undefined
            ? t('st.compact.profileHintBudget', { tokens: formatCompactTokens(profile.context_budget) })
            : t('st.compact.profileHint')} />
      </div>
      {profile.routes.map((route) => <Field key={route.id} label={t('st.namedAgents.routeModel', { route: route.id })} dataField={`route-${route.id}`}>
        <ModelPicker id={`route-${route.id}`} value={draft.routeAliases[route.id] ?? ''} models={profileModels} allowInherit={false} disabled={disabled}
          onChange={(value) => set('routeAliases', { ...draft.routeAliases, [route.id]: value })} />
      </Field>)}
    </div>
    <div className="min-w-0 space-y-2" data-profile-section="prompt-overrides">
      <h4 className="text-[13px] font-semibold text-ink">{t('st.promptIdentity.fieldsTitle')}</h4>
      <PromptIdentityEditor value={draft.promptOverrides} disabled={disabled} onChange={(next) => set('promptOverrides', next)}>
        {(content, onChange, label) => <PromptOverridesContentEditor value={content} onChange={onChange} label={label} />}
      </PromptIdentityEditor>
      {(() => {
        const problem = promptIdentityProblem(draft.promptOverrides, promptOverridesBody, promptOverridesProblem);
        return problem === undefined ? null : <p role="alert" className="text-[12px] text-danger">{t(`st.promptIdentity.problem.${problem}`)}</p>;
      })()}
    </div>
  </div>;

  const panels: Record<Exclude<Tab, 'raw'>, ReactNode> = {
    identity: identityPanel, run: runPanel, dispatch: dispatchPanel, tools: toolsPanel, advanced: advancedPanel,
  };

  return <div data-agent-detail={profile.name} data-profile-editor className="flex min-h-0 min-w-0 flex-col gap-5">
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="basis-full md:hidden">
        <DetailBack label={t('st.profiles.team')} onClick={onClose} data={{ 'data-agent-back': '' }} />
      </div>
      <div className="min-w-0 flex-1 basis-[16rem]">
        <h3 data-detail-heading tabIndex={-1} className="flex flex-wrap items-center gap-x-2 gap-y-1 font-display text-[20px] leading-tight text-ink outline-none">
          <span className="min-w-0 break-words">{profile.name}</span>
          <span className="rounded-[4px] bg-ink/[0.05] px-1.5 font-sans text-[11.5px] font-normal leading-[18px] text-ink-soft">
            {t(draft.main ? 'st.agentManager.main' : 'st.agentManager.subagent')}</span>
          {external ? <span className="rounded-[4px] border border-hairline px-1.5 font-sans text-[11.5px] font-normal leading-[16px] text-ink-soft">{engine}</span> : null}
        </h3>
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-ink-faint">
          <span data-profile-origin>{profile.source === 'workspace' ? t('st.profiles.tagProject') : sourceBadgeLabel(t, profile.source)}</span>
          {profile.source_file !== undefined ? <span className="min-w-0 truncate font-mono text-[11.5px]" title={profile.source_file}>· {profile.source_file}</span> : null}
          {!writable ? <span>· {t('st.agentManager.readOnlyShort')}</span> : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {shippedEntry !== undefined ? <ShippedProfileControls entry={shippedEntry} profile={profile}
          onRestored={() => { onSaved(profile); pingSaved(); }}
          onError={(error) => setFeedback({ tone: 'error', text: errorText(locale, error) })} /> : null}
        <Toggle layout="bare" label={t('st.namedAgents.enabled')} checked={!profile.disabled} disabled={toggleSaving}
          onChange={(enabled) => { void onToggleEnabled(enabled).catch((error: unknown) => setFeedback({ tone: 'error', text: errorText(locale, error) })); }} />
        <button type="button" className={SECONDARY_BUTTON} onClick={onDuplicate}>{t('st.profiles.duplicate')}</button>
        <button type="button" className={SECONDARY_BUTTON} disabled={newSessionBlocked} onClick={onNewSession}>{t('st.namedAgents.newSession')}</button>
        <button type="button" onClick={onClose} aria-label={t('st.profiles.backToTeam')} title={t('st.profiles.backToTeam')} data-detail-close
          className="hidden h-8 w-8 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink md:flex">
          <Icon name="close" size={14} />
        </button>
      </div>
    </header>
    {!writable ? <p data-profile-readonly className="text-[12.5px] text-ink-soft">{t('st.profiles.readOnlyExplain')} <button type="button" onClick={onDuplicate}
      className="underline decoration-ink-faint underline-offset-2 hover:text-ink">{t('st.profiles.duplicateToEdit')}</button></p> : null}
    <DiagnosticsList diagnostics={diagnostics} onOpenWinner={onOpenWinner} />
    <div role="tablist" aria-label={t('st.profiles.editMode')} data-profile-tabs
      className="sticky top-[calc(-1*var(--settings-scroll-pt,0px))] z-10 -mx-1 flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-hairline bg-canvas px-1">
      {tabs.map((item) => {
        const active = item === tab;
        const locked = item === 'raw' && rawLocked;
        return <button key={item} type="button" role="tab" id={`profile-tab-${item}`} aria-selected={active}
          aria-controls={`profile-panel-${item}`} tabIndex={active ? 0 : -1} disabled={locked}
          title={locked ? t('st.profiles.rawAfterSave') : undefined}
          ref={(node) => { if (node === null) tabRefs.current.delete(item); else tabRefs.current.set(item, node); }}
          data-profile-tab={item} data-profile-mode={item === 'raw' ? 'raw' : item === 'identity' ? 'form' : undefined}
          onClick={() => setTab(item)} onKeyDown={onTabKey}
          className={`-mb-px inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:text-ink-faint/70 ${item === 'raw' ? 'ml-auto' : ''} ${
            active ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}>
          {t(TAB_LABEL[item])}
          {item !== 'raw' && dirtyTabs.has(item) ? <span data-profile-tab-dirty aria-label={t('st.profiles.tabUnsaved')} className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        </button>;
      })}
    </div>
    {FORM_TABS.map((item) => <div key={item} role="tabpanel" id={`profile-panel-${item}`} aria-labelledby={`profile-tab-${item}`}
      hidden={tab !== item} data-profile-panel={item} className="min-w-0 pb-2">
      {panels[item]}
    </div>)}
    {tab === 'raw' ? <div role="tabpanel" id="profile-panel-raw" aria-labelledby="profile-tab-raw" data-profile-panel="raw">
      <RawPanel profile={profile} writable={writable} reloadToken={rawReload} onSaved={accept} />
    </div> : null}
    {writable && tab !== 'raw' ? <div className="sticky bottom-[calc(-1*var(--settings-scroll-pb,0px))] z-10 -mx-1 mt-auto border-t border-transparent bg-canvas/95 px-1 backdrop-blur-sm has-[[data-settings-draft]:not([hidden])]:border-hairline has-[[data-settings-draft]:not([hidden])]:pb-3">
      <SettingsDraftFooter saved={justSaved} id={`agent-detail:${profile.source}:${profile.source_file ?? ''}:${profile.name}`} dirty={dirty} saving={saving}
        saveDisabled={problems.length > 0 || !menuPreview.ready} onSave={() => void save()} onDiscard={() => { setDraft(baseline); setFeedback(null); }}
        extra={problemText !== null && dirty ? <span role="alert" className="text-[12px] text-danger">{problemText}</span>
          : dirty && (menuPreview.value?.removed?.length ?? 0) > 0 ? <span data-menu-save-warning role="status" className="max-w-[36rem] break-words text-[12px] font-medium text-amber-ink">{t('st.profiles.menuRemoved', { models: menuPreview.value!.removed!.join(', ') })}</span>
            : dirty ? <span className="text-[12px] text-ink-faint">{tp('st.profiles.changedCount', changed.length)}</span> : undefined} />
    </div> : null}
    <FeedbackLine feedback={feedback} />
  </div>;
}
