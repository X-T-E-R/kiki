import { useEffect, useMemo, useState } from 'react';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import type { NamedAgentExecutorField } from '@kiki/protocol';
import type { NamedAgentProfile, ShippedAgentProfile } from '../../../lib/client';
import { formatCompactTokens } from '../../../lib/autoCompact';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Toggle, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { SearchableSelect } from '../../SearchableSelect';
import { sourceBadgeLabel } from '../../agent-panel/SourceBadge';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { CompactPointField } from '../CompactPointField';
import { FORM_SELECT_TRIGGER, SettingsDraftFooter, SettingsSegmented } from '../SettingsPrimitives';
import { ShippedProfileControls } from '../ShippedProfileControls';
import { DiagnosticsList } from './DiagnosticsList';
import type { ProfileDiagnostic } from './diagnostics';
import { engineChoices, engineLabel, useExecutorCatalog } from './engines';
import { ExecutorPromptField } from './ExecutorPromptField';
import type { ExecutorPromptDraft } from './executorPromptDraft';
import { AliasChips, EffortPicker, Field, ModelPicker, Section } from './fields';
import { ModelProfilesField } from './ModelProfilesField';
import {
  changedFields, draftFromProfile, draftProblems, EFFORTS, EMPTY_SPAWN_CONSTRAINTS, isExternalExecutor, kikiSubagentsApplicable, patchBody, spawnConstraintsSet,
  type ProfileDraft, type SpawnConstraintsDraft, type ToolFieldMode, type ToolFieldValue,
} from './profileDraft';
import { RawPanel } from './RawPanel';
import { SubagentsField } from './SubagentsField';
import { SUBAGENT_POLICY_CHOICES, subagentPolicyLabelKey, type SubagentPolicyChoice } from '../subagentPolicy';
import { useSavedTick } from '../useSavedTick';

type Mode = 'form' | 'raw';

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
    {field.mode === 'list' ? <textarea aria-label={label} data-tool-list={id} className={`${INPUT} min-h-16 font-mono text-[12px]`} value={field.text}
      disabled={disabled} placeholder={t('st.namedAgents.toolsPlaceholder')} onChange={(event) => onChange({ ...field, text: event.target.value })} /> : null}
  </Field>;
}

/**
 * The profile editor. The instructions body is the main surface (it is where
 * a profile's substance lives, often many KB); frontmatter sits in a rail
 * ordered by how often it is set: identity, then how it runs, then who it
 * delegates to, then per-model candidates, tools, and the rare fields under
 * Advanced. The raw file is a peer mode for everything the form does not
 * model, never a hidden fold.
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
  const [mode, setMode] = useState<Mode>('form');
  const [baseline, setBaseline] = useState(() => draftFromProfile(profile));
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const [rawReload, setRawReload] = useState(0);
  const changed = changedFields(baseline, draft);
  const dirty = changed.length > 0;
  const problems = draftProblems(draft);
  useEffect(() => {
    if (dirty) return;
    const next = draftFromProfile(profile);
    setBaseline(next); setDraft(next);
  }, [profile]);
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const catalog = useExecutorCatalog();
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
  const pinned = models.find((model) => model.id === draft.modelAlias.trim());
  const aliasMissing = (alias: string) => !external && alias !== '' && alias !== 'inherit' && models.length > 0 && !models.some((model) => model.id === alias);

  const accept = (updated: NamedAgentProfile) => {
    const next = draftFromProfile(updated);
    setBaseline(next); setDraft(next);
    onSaved(updated);
  };
  const save = async () => {
    if (!writable || !dirty || problems.length > 0 || profile.workspace_id === undefined) return;
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
  const engines = useMemo(() => engineChoices(profiles, catalog), [profiles, catalog]);
  const engineStatus = (id: string) => catalog.find((item) => item.id === id)?.status;
  const promptDeliveries = catalog.find((item) => item.id === draft.executor)?.capabilities?.prompt_deliveries;
  const promptDelivery = draft.executorPrompt?.per_engine?.[draft.executor]?.delivery ?? draft.executorPrompt?.delivery
    ?? (promptDeliveries?.includes('replace') && !promptDeliveries.includes('append') ? 'replace'
      : promptDeliveries?.includes('append') ? 'append' : 'preamble');
  const spawn = draft.spawnConstraints;
  const setSpawn = (patch: Partial<SpawnConstraintsDraft>) => set('spawnConstraints', { ...spawn, ...patch });
  const subagentSummary = draft.subagentsMode === 'unrestricted' ? t('st.profiles.subagentsAny')
    : draft.subagentsMode === 'none' ? t('st.profiles.subagentsNone') : draft.subagents.map((entry) => entry.name).join(', ');
  const advancedSet = [draft.serviceTier !== '', draft.autoCompact !== undefined, draft.denyModels.length > 0,
    draft.allowedEfforts.length > 0, draft.subagentPolicy !== 'inherit', profile.routes.length > 0,
    spawnConstraintsSet(draft.spawnConstraints)].filter(Boolean).length;

  // Desktop: the body stays in view (sticky, viewport-tall) while the rail scrolls past it.
  const promptPane = <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 lg:sticky lg:top-0 lg:h-[calc(100vh-12rem)] lg:self-start" data-profile-prompt>
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor="profile-prompt" className="text-[12px] font-medium text-ink-soft">{t('st.profiles.prompt')}</label>
      <span className="text-[11.5px] tabular-nums text-ink-faint">{t('st.profiles.promptSize', { lines: draft.prompt === '' ? 0 : draft.prompt.split('\n').length, chars: draft.prompt.length })}</span>
    </div>
    {writable ? <textarea id="profile-prompt" value={draft.prompt} disabled={saving} spellCheck={false}
      onChange={(event) => set('prompt', event.target.value)} placeholder={t('st.profiles.promptPlaceholder')}
      className="min-h-[22rem] flex-1 resize-none rounded-lg border border-hairline bg-paper px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-ink outline-none placeholder:text-ink-faint focus:border-selected-ink lg:min-h-0" />
      : <div id="profile-prompt" className="min-h-[16rem] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-paper px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-ink">{draft.prompt === '' ? <span className="font-sans text-ink-faint">{t('st.profiles.promptEmpty')}</span> : draft.prompt}</div>}
    {external ? <p data-prompt-delivery className="text-[11.5px] text-ink-faint">{fieldState('prompt')?.reason ?? t('st.profiles.promptDelivery', { engine })}</p> : null}
  </div>;

  const rail = <div className="min-w-0 space-y-4 lg:w-[22rem] lg:shrink-0" data-profile-rail>
    <Field label={t('st.namedAgents.description')} htmlFor="profile-description" dataField="description">
      <textarea id="profile-description" rows={2} className={`${INPUT} text-[13px] leading-snug`} value={draft.description} disabled={disabled}
        onChange={(event) => set('description', event.target.value)} />
    </Field>
    <Field label={t('st.namedAgents.whenToUse')} htmlFor="profile-when" hint={t('st.profiles.whenToUseHint')} dataField="whenToUse">
      <textarea id="profile-when" rows={3} className={`${INPUT} text-[13px] leading-snug`} value={draft.whenToUse} disabled={disabled}
        onChange={(event) => set('whenToUse', event.target.value)} />
    </Field>
    <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-3">
      <Field label={t('st.profiles.model')} htmlFor="profile-model" applicability={fieldState('pinned_model_alias')} engine={engine} dataField="model"
        hint={aliasMissing(draft.modelAlias.trim()) ? <span className="text-amber-ink">{t('st.profiles.aliasMissingTitle', { alias: draft.modelAlias.trim() })}</span>
          : external && fieldState('pinned_model_alias') === undefined ? t('st.profiles.modelExternal', { engine }) : undefined}>
        <ModelPicker id="profile-model" value={draft.modelAlias} models={external ? [] : models} allowInherit={!draft.main} disabled={disabled}
          missing={aliasMissing(draft.modelAlias.trim())} onChange={(value) => setDraft((current) => ({
            ...current, modelAlias: value,
            // A new model may not support the old effort; keep it only if it does.
            effort: value.trim() !== current.modelAlias.trim()
              && (models.find((model) => model.id === value)?.support_efforts?.includes(current.effort) !== true) ? '' : current.effort,
          }))} />
      </Field>
      <Field label={t('st.profiles.effort')} htmlFor="profile-effort" applicability={fieldState('thinking_effort')} engine={engine} dataField="effort">
        <EffortPicker id="profile-effort" value={draft.effort} supported={pinned?.support_efforts} disabled={disabled}
          onChange={(value) => set('effort', value)} />
      </Field>
    </div>
    <Field label={t('st.profiles.engine')} htmlFor="profile-engine" dataField="engine"
      hint={draft.main && external ? t('st.profiles.engineMainExternal')
        : external && engineStatus(draft.executor) === 'unavailable' ? <span className="text-amber-ink">{t('st.profiles.engineNotFound', { engine })}</span>
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
    <div data-profile-field="main" className="space-y-1">
      <Toggle layout="row" label={t('st.profiles.mainToggle')} checked={draft.main} disabled={disabled} onChange={(value) => set('main', value)} />
      <p className="text-[11.5px] leading-snug text-ink-faint">{t(draft.main ? 'st.profiles.mainOnHint' : 'st.profiles.mainOffHint')}</p>
    </div>
    {kikiSubagentsApplicable(draft) ? <div data-profile-field="allowKikiSubagents" className="space-y-1">
      <Toggle layout="row" label={t('st.profiles.kikiSubagents')} checked={draft.allowKikiSubagents} disabled={disabled}
        onChange={(value) => set('allowKikiSubagents', value)} />
      <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.profiles.kikiSubagentsHint', { engine })}</p>
      {draft.allowKikiSubagents && draft.executor === 'codex-app-server' ? <p data-kiki-subagents-codex className="text-[11.5px] leading-snug text-amber-ink">
        {t('st.profiles.kikiSubagentsCodex')}
      </p> : null}
    </div> : null}
    <div>
      <Section title={t('st.executorPrompt.title')} dataSection="executor-prompt" defaultOpen={external}
        count={executorPromptCount(draft.executorPrompt)}
        summary={external ? t(`st.executorPrompt.delivery.${promptDelivery}`) : undefined}>
        <ExecutorPromptField value={draft.executorPrompt} onChange={(next) => set('executorPrompt', next)} engineId={draft.executor}
          engineLabel={engine} catalog={catalog} profileBody={draft.prompt} disabled={disabled}
          profileName={profile.name} workspaceId={profile.workspace_id} previewEnabled={!dirty} />
      </Section>
      {external && ignoredFields.length > 0 ? <Section title={t('st.profiles.ignoredTitle', { engine })} dataSection="ignored-fields"
        count={ignoredFields.length}>
        <ul className="space-y-2">
          {ignoredFields.map(([key, field]) => <li key={key} data-ignored-field={key} className="min-w-0">
            <p className="flex min-w-0 items-baseline gap-2 text-[12.5px] text-ink-soft">
              <span className="font-medium">{t(`st.profiles.fieldName.${key}` as I18nKey)}</span>
              {profileSets(profile, key) ? <span className="text-[11px] text-ink-faint">· {t('st.profiles.fieldValueSet')}</span> : null}
            </p>
            <p className="text-[11.5px] leading-snug text-ink-faint">{field.reason ?? t('st.profiles.fieldIgnored', { engine })}</p>
          </li>)}
        </ul>
      </Section> : null}
      <Section title={t('st.profiles.subagents')} dataSection="subagents" defaultOpen={profile.subagents !== undefined && profile.subagents.length > 0}
        summary={subagentSummary}>
        <SubagentsField draft={draft} profiles={profiles} models={models} disabled={disabled} self={profile.name}
          onChange={(next) => setDraft((current) => ({ ...current, ...next }))} />
        {fieldState('subagents')?.state === 'ignored' ? <p className="text-[11.5px] text-ink-faint">{fieldState('subagents')?.reason ?? t('st.profiles.fieldIgnored', { engine })}</p> : null}
      </Section>
      <Section title={t('st.profiles.modelProfiles')} dataSection="model-profiles" count={draft.modelProfiles.length + draft.allowedModels.length}
        defaultOpen={draft.modelProfiles.length > 0 || draft.allowedModels.length > 0}>
        <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.profiles.modelProfilesHint')}</p>
        <ModelProfilesField values={draft.modelProfiles} models={models} disabled={disabled} onChange={(next) => set('modelProfiles', next)} />
        <Field label={t('st.profiles.allowedModels')} hint={t('st.profiles.allowedModelsHint')} dataField="allowedModels">
          <AliasChips id="allowed-models" values={draft.allowedModels} models={models} disabled={disabled} addLabel={t('st.profiles.addModel')}
            onChange={(next) => set('allowedModels', next)} />
        </Field>
      </Section>
      <Section title={t('st.profiles.tools')} dataSection="tools"
        count={Number(draft.tools.mode !== 'inherit') + Number(draft.disallowedTools.mode !== 'inherit')}>
        <ToolList id="tools" label={t('st.namedAgents.tools')} field={draft.tools} disabled={disabled} deny={false}
          applicability={fieldState('tools')} engine={engine} onChange={(next) => set('tools', next)} />
        <ToolList id="disallowedTools" label={t('st.namedAgents.disallowedTools')} field={draft.disallowedTools} disabled={disabled} deny
          applicability={fieldState('disallowed_tools')} engine={engine} onChange={(next) => set('disallowedTools', next)} />
      </Section>
      <Section title={t('st.profiles.advanced')} dataSection="advanced" count={advancedSet} summary={t('st.profiles.advancedSummary')}>
        <Field label={t('st.profiles.policy')} hint={t('st.profiles.policyHint')} dataField="subagentPolicy">
          <SettingsSegmented<SubagentPolicyChoice> ariaLabel={t('st.profiles.policy')} value={draft.subagentPolicy} disabled={disabled}
            dataAttr="data-policy-choice" onChange={(value) => set('subagentPolicy', value)}
            choices={SUBAGENT_POLICY_CHOICES.map((value) => ({ value, label: t(subagentPolicyLabelKey(value)) }))} />
        </Field>
        <Field label={t('st.profiles.allowedEfforts')} dataField="allowedEfforts">
          <div className="flex flex-wrap gap-1.5">
            {EFFORTS.map((level) => {
              const on = draft.allowedEfforts.includes(level);
              return <button key={level} type="button" aria-pressed={on} disabled={disabled}
                onClick={() => set('allowedEfforts', on ? draft.allowedEfforts.filter((value) => value !== level) : EFFORTS.filter((value) => value === level || draft.allowedEfforts.includes(value)))}
                className={`h-7 rounded-md border px-2 text-[12px] transition-colors ${on ? 'border-hairline-strong bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'border-hairline text-ink-soft hover:text-ink'}`}>{level}</button>;
            })}
          </div>
        </Field>
        <Field label={t('st.profiles.denyModels')} dataField="denyModels">
          <AliasChips id="deny-models" values={draft.denyModels} models={models} disabled={disabled} addLabel={t('st.profiles.addModel')}
            onChange={(next) => set('denyModels', next)} />
        </Field>
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
          <ModelPicker id={`route-${route.id}`} value={draft.routeAliases[route.id] ?? ''} models={models} allowInherit={false} disabled={disabled}
            onChange={(value) => set('routeAliases', { ...draft.routeAliases, [route.id]: value })} />
        </Field>)}
        <div data-profile-field="spawnConstraints" data-field-applicability={fieldState('spawn_constraints')?.state}
          className="space-y-3 rounded-lg border border-hairline px-3 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-ink-soft">{t('st.profiles.spawnTitle')}</p>
              <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.profiles.spawnHint')}</p>
            </div>
            {spawnConstraintsSet(spawn) ? <button type="button" data-spawn-clear disabled={disabled}
              onClick={() => set('spawnConstraints', EMPTY_SPAWN_CONSTRAINTS)}
              className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50">{t('st.profiles.spawnClear')}</button> : null}
          </div>
          <Field label={t('st.profiles.spawnAllowedModels')} dataField="spawnAllowedModels">
            <AliasChips id="spawn-allowed-models" values={spawn.allowedModels} models={models} disabled={disabled} addLabel={t('st.profiles.addModel')}
              onChange={(next) => setSpawn({ allowedModels: next })} />
          </Field>
          <Field label={t('st.profiles.spawnDenyModels')} dataField="spawnDenyModels">
            <AliasChips id="spawn-deny-models" values={spawn.denyModels} models={models} disabled={disabled} addLabel={t('st.profiles.addModel')}
              onChange={(next) => setSpawn({ denyModels: next })} />
          </Field>
          <Field label={t('st.profiles.spawnAllowedEfforts')} dataField="spawnAllowedEfforts">
            <div className="flex flex-wrap gap-1.5">
              {EFFORTS.map((level) => {
                const on = spawn.allowedEfforts.includes(level);
                return <button key={level} type="button" aria-pressed={on} disabled={disabled} data-spawn-effort={level}
                  onClick={() => setSpawn({ allowedEfforts: on ? spawn.allowedEfforts.filter((value) => value !== level) : EFFORTS.filter((value) => value === level || spawn.allowedEfforts.includes(value)) })}
                  className={`h-7 rounded-md border px-2 text-[12px] transition-colors ${on ? 'border-hairline-strong bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'border-hairline text-ink-soft hover:text-ink'}`}>{level}</button>;
              })}
            </div>
          </Field>
          <Field label={t('st.profiles.spawnDisallowedTools')} htmlFor="spawn-disallowed-tools" dataField="spawnDisallowedTools">
            <textarea id="spawn-disallowed-tools" className={`${INPUT} min-h-12 font-mono text-[12px]`} value={spawn.disallowedTools} disabled={disabled}
              placeholder={t('st.namedAgents.toolsPlaceholder')} onChange={(event) => setSpawn({ disallowedTools: event.target.value })} />
          </Field>
        </div>
        <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.profiles.rareFieldsHint')}</p>
      </Section>
    </div>
  </div>;

  return <div data-agent-detail={profile.name} data-profile-editor className="flex min-h-0 min-w-0 flex-col gap-4">
    <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <button type="button" onClick={onClose} data-agent-back aria-label={t('st.profiles.backToTeam')}
        className="-ml-1 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-[13px] text-ink-soft hover:text-ink">
        <span className="flex rotate-180"><Icon name="chevron" size={12} /></span>{t('st.profiles.team')}
      </button>
      <div className="min-w-0 flex-1 basis-[16rem]">
        <h3 className="flex flex-wrap items-baseline gap-x-2 font-display text-[20px] leading-tight text-ink">
          <span className="min-w-0 break-words">{profile.name}</span>
          <span className="font-sans text-[12.5px] font-normal text-ink-faint">
            {t(draft.main ? 'st.agentManager.main' : 'st.agentManager.subagent')} · {engine}
          </span>
        </h3>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-ink-faint">
          <span data-profile-origin>{sourceBadgeLabel(t, profile.source)}</span>
          {profile.source_file !== undefined ? <span className="min-w-0 truncate font-mono text-[11.5px]" title={profile.source_file}>· {profile.source_file}</span> : null}
          {!writable ? <span>· {t('st.agentManager.readOnlyShort')}</span> : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {shippedEntry !== undefined ? <ShippedProfileControls entry={shippedEntry} profile={profile}
          onRestored={() => { onSaved(profile); pingSaved(); }}
          onError={(error) => setFeedback({ tone: 'error', text: errorText(locale, error) })} /> : null}
        <Toggle label={t('st.namedAgents.enabled')} checked={!profile.disabled} disabled={toggleSaving}
          onChange={(enabled) => { void onToggleEnabled(enabled).catch((error: unknown) => setFeedback({ tone: 'error', text: errorText(locale, error) })); }} />
        <button type="button" className={SECONDARY_BUTTON} onClick={onDuplicate}>{t('st.profiles.duplicate')}</button>
        <button type="button" className={SECONDARY_BUTTON} disabled={newSessionBlocked} onClick={onNewSession}>{t('st.namedAgents.newSession')}</button>
      </div>
    </header>
    {!writable ? <p data-profile-readonly className="text-[12.5px] text-ink-soft">{t('st.profiles.readOnlyExplain')} <button type="button" onClick={onDuplicate}
      className="underline decoration-ink-faint underline-offset-2 hover:text-ink">{t('st.profiles.duplicateToEdit')}</button></p> : null}
    <DiagnosticsList diagnostics={diagnostics} onOpenWinner={onOpenWinner} />
    <div className="flex items-center justify-between gap-2">
      <SettingsSegmented<Mode> ariaLabel={t('st.profiles.editMode')} value={mode} dataAttr="data-profile-mode"
        onChange={(next) => setMode(next)}
        choices={[{ value: 'form', label: t('st.profiles.modeForm') }, { value: 'raw', label: t('st.profiles.modeRaw'), disabled: dirty && mode === 'form' }]} />
      {dirty && mode === 'form' ? <span className="text-[11.5px] text-ink-faint">{t('st.profiles.rawAfterSave')}</span> : null}
    </div>
    {mode === 'form' ? <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:items-stretch">
      {promptPane}
      {rail}
    </div> : <RawPanel profile={profile} writable={writable} reloadToken={rawReload} onSaved={accept} />}
    {writable && mode === 'form' ? <div className="sticky bottom-0 -mx-1 bg-canvas/95 px-1 backdrop-blur-sm">
      <SettingsDraftFooter saved={justSaved} id={`agent-detail:${profile.source}:${profile.source_file ?? ''}:${profile.name}`} dirty={dirty} saving={saving}
        saveDisabled={problems.length > 0} onSave={() => void save()} onDiscard={() => { setDraft(baseline); setFeedback(null); }}
        extra={problemText !== null && dirty ? <span role="alert" className="text-[12px] text-danger">{problemText}</span>
          : dirty ? <span className="text-[12px] text-ink-faint">{tp('st.profiles.changedCount', changed.length)}</span> : undefined} />
    </div> : null}
    <FeedbackLine feedback={feedback} />
  </div>;
}
