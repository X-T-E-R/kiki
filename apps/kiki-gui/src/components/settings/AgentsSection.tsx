import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  disabledProfilePatch,
  mergeNamedAgentProfiles,
  namedAgentNewSessionBlocked,
  namedAgentOverrideRelations,
  namedAgentSessionHref,
  partitionNamedAgentProfiles,
  shippedEntryForProfile,
  subagentGovernanceFromConfig,
  subagentGovernancePatch,
  summarizeNamedAgentLease,
  summarizeNamedAgentModelProfile,
  workspaceChipDisplay,
  type NamedAgentLeaseDetailLabel,
  type NamedAgentOverrideRelation,
  type SubagentGovernanceDraft,
} from '@kiki/session-core/settings';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import type { NamedAgentSubagentLease } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import { agentProfileCatalogQueryKey, invalidateAgentProfileCatalogs, loadAgentProfileCatalog } from '../../lib/agentProfileCatalog';
import { AgentCapabilitiesPanel } from '../AgentCapabilitiesPanel';
import type {
  ListNamedAgentProfilesResponse,
  NamedAgentProfile,
  ShippedAgentProfile,
} from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { AgentProfileEditorDialog } from './AgentProfileEditorDialog';
import { AgentRuntimeCard } from './AgentRuntimeSettings';
import { ExperimentalSection } from './ExperimentalSection';
import { PromptConfigCard } from './PromptConfigCard';
import { ShippedProfileControls } from './ShippedProfileControls';
import { SubagentLimitsSettings } from './SubagentLimitsSettings';

const LEASE_DETAIL_LABEL_KEYS: Record<NamedAgentLeaseDetailLabel, I18nKey> = {
  description: 'st.namedAgents.description',
  whenToUse: 'st.namedAgents.whenToUse',
  contextBudget: 'st.namedAgents.contextBudget',
  maxCompletionTokens: 'st.namedAgents.maxCompletionTokens',
  serviceTier: 'st.namedAgents.serviceTier',
  delegationNotice: 'st.namedAgents.delegationNotice',
  promptMode: 'st.namedAgents.promptMode',
  allowedModels: 'st.namedAgents.allowedModels',
  deniedModels: 'st.namedAgents.deniedModels',
  allowedEfforts: 'st.namedAgents.allowedEfforts',
  tools: 'st.namedAgents.tools',
  disallowedTools: 'st.namedAgents.disallowedTools',
  subagents: 'st.namedAgents.subagentLease',
  prompt: 'st.namedAgents.prompt',
  requestParams: 'st.namedAgents.requestParams',
  modelProfile: 'st.namedAgents.modelProfile',
  leaseSource: 'st.namedAgents.leaseSource',
};

const EMPTY_SUBAGENT_GOVERNANCE: SubagentGovernanceDraft = { denyModels: '' };

export function SubagentGovernanceCard() {
  return <><SubagentLimitsSettings /><SubagentModelGovernanceCard /></>;
}

function SubagentModelGovernanceCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SubagentGovernanceDraft>(EMPTY_SUBAGENT_GOVERNANCE);
  const [savedDraft, setSavedDraft] = useState<SubagentGovernanceDraft>(EMPTY_SUBAGENT_GOVERNANCE);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    if (configQuery.data !== undefined) {
      const next = subagentGovernanceFromConfig(configQuery.data);
      setDraft(next);
      setSavedDraft(next);
    }
  }, [configQuery.data]);

  const dirty = draft.denyModels !== savedDraft.denyModels;

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(subagentGovernancePatch(draft));
      queryClient.setQueryData(['config'], echoed);
      await invalidateAgentProfileCatalogs(queryClient);
      const next = subagentGovernanceFromConfig(echoed);
      setDraft(next);
      setSavedDraft(next);
      setFeedback({ tone: 'success', text: t('st.subagents.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-subagents" title={t('st.subagents.title')}>
      <div className="space-y-4">
        <Hint>{t('st.subagents.hint')}</Hint>
        <fieldset disabled={configQuery.isLoading || saving} className="space-y-4 disabled:opacity-60">
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.subagents.denyModels')}
            <textarea
              className={`${INPUT} mt-1 min-h-24 font-mono`}
              value={draft.denyModels}
              placeholder={t('st.subagents.denyPlaceholder')}
              onChange={(event) => { setDraft((current) => ({ ...current, denyModels: event.target.value })); }}
            />
          </label>
        </fieldset>
        <button type="button" className={PRIMARY_BUTTON} disabled={configQuery.isLoading || saving || !dirty} onClick={() => void save()}>{saving ? t('common.saving') : t('st.subagents.save')}</button>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
function NamedAgentProfileRow({
  profile,
  workspaceFallbackId,
  overrideRelation,
  onUpdated,
  onToggleEnabled,
  toggleSaving,
  effective,
  shippedEntry,
  onShippedChanged,
}: {
  effective: boolean;
  profile: NamedAgentProfile;
  workspaceFallbackId?: string;
  overrideRelation?: NamedAgentOverrideRelation;
  onUpdated: (profile: NamedAgentProfile) => void;
  onToggleEnabled: (profile: NamedAgentProfile, enabled: boolean) => Promise<void>;
  toggleSaving: boolean;
  shippedEntry?: ShippedAgentProfile;
  onShippedChanged?: () => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const writable =
    profile.workspace_id !== undefined &&
    profile.source_file !== undefined &&
    (profile.source === 'user' || profile.source === 'workspace' || profile.source === 'extra');
  // The default main binding survives discovery disable lists.
  const defaultMain = effective && profile.name === 'agent' && profile.main === true;
  const toggleTitle = defaultMain ? t('st.namedAgents.defaultToggleHint')
    : profile.source === 'builtin' ? t('st.namedAgents.builtinToggleHint')
    : t('st.namedAgents.namedToggleHint');
  const workspaceIds = profile.workspace_ids ?? (profile.workspace_id === undefined ? [] : [profile.workspace_id]);
  const workspaceChips = workspaceChipDisplay(workspaceIds);
  const sessionHref = namedAgentSessionHref(profile, workspaceFallbackId);
  // A disabled main profile keeps its new-session button (main sessions
  // still run it); a disabled subagent profile loses it. A shadowed file
  // profile loses it too: a session under its name would silently run the
  // same-named built-in instead.
  const shadowed = overrideRelation?.kind === 'shadowed';
  const newSessionBlocked = !effective || namedAgentNewSessionBlocked(profile, overrideRelation);
  const newSessionTitle = shadowed
    ? t('st.namedAgents.newSessionShadowed')
    : newSessionBlocked
      ? t('st.namedAgents.newSessionDisabled')
      : profile.disabled
        ? t('st.namedAgents.newSessionDisabledMain')
        : t('st.namedAgents.newSession');
  // Read-only projections the structured editor cannot write (the PATCH
  // schema does not open them): surface them in the summary and point at the
  // raw file instead of silently hiding them.
  const constraints = profile.spawn_constraints;
  const spawnSummary = constraints === undefined ? '' : [
    constraints.allowed_models === undefined ? null : `${t('st.namedAgents.allowedModels')} ${constraints.allowed_models.join(', ')}`,
    constraints.deny_models === undefined ? null : `${t('st.namedAgents.deniedModels')} ${constraints.deny_models.join(', ')}`,
    constraints.allowed_efforts === undefined ? null : `${t('st.namedAgents.allowedEfforts')} ${constraints.allowed_efforts.join(', ')}`,
    constraints.disallowed_tools === undefined ? null : `${t('st.namedAgents.disallowedTools')} ${constraints.disallowed_tools.join(', ')}`,
  ].filter((segment) => segment !== null).join(' · ');
  const contextBudget = profile.context_budget !== undefined && profile.context_budget > 0
    ? profile.context_budget
    : undefined;
  const maxCompletionTokens = profile.max_completion_tokens !== undefined && profile.max_completion_tokens > 0
    ? profile.max_completion_tokens
    : undefined;
  const hasProfileBudget = contextBudget !== undefined
    || maxCompletionTokens !== undefined
    || (profile.request_params !== undefined && Object.keys(profile.request_params).length > 0);
  const hasProjection =
    hasProfileBudget
    || (profile.model_profiles?.length ?? 0) > 0
    || spawnSummary !== ''
    || (profile.subagents?.length ?? 0) > 0;
  const [editorOpen, setEditorOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawSaving, setRawSaving] = useState(false);
  const [rawText, setRawText] = useState('');
  const toggleRaw = async () => {
    if (rawOpen) {
      setRawOpen(false);
      return;
    }
    if (profile.source_file === undefined) return;
    setRawOpen(true);
    setRawLoading(true);
    setFeedback(null);
    try {
      setRawText(await client.readHostFile(profile.source_file));
    } catch (error) {
      setRawOpen(false);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRawLoading(false);
    }
  };
  const saveRaw = async () => {
    if (!writable || profile.workspace_id === undefined) return;
    setRawSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.updateNamedAgentProfile(profile.name, {
        scope: profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra',
        workspace_id: profile.workspace_id,
        source_file: profile.source_file,
        raw_text: rawText,
      });
      onUpdated(echoed);
      setFeedback({ tone: 'success', text: t('st.namedAgents.rawSaved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRawSaving(false);
    }
  };

  const overriddenBy = overrideRelation?.kind === 'overridden' ? overrideRelation : undefined;
  const overrideState =
    overrideRelation?.kind === 'overrides_builtin'
      ? 'overrides'
      : overrideRelation?.kind === 'shadowed'
        ? 'shadowed'
        : undefined;

  // First-glance summary (read mode only): the pinned model/effort and spawn
  // constraints ride as chips, and the callable-subagent list — the row's
  // first-class answer to "what can this agent dispatch?" — surfaces without
  // opening the technical-details fold.
  const summaryChips: string[] = [];
  if (profile.pinned_model_alias !== undefined && profile.pinned_model_alias !== '') {
    summaryChips.push(`${t('st.namedAgents.modelPin')} ${profile.pinned_model_alias}`);
  }
  if (profile.thinking_effort !== undefined && profile.thinking_effort !== '') {
    summaryChips.push(`${t('st.namedAgents.defaultModelThinkingEffort')} ${profile.thinking_effort}`);
  }
  if (constraints !== undefined) {
    if (constraints.allowed_models !== undefined && constraints.allowed_models.length > 0) {
      summaryChips.push(`${t('st.namedAgents.allowedModels')} ${constraints.allowed_models.join(', ')}`);
    }
    if (constraints.allowed_efforts !== undefined && constraints.allowed_efforts.length > 0) {
      summaryChips.push(`${t('st.namedAgents.allowedEfforts')} ${constraints.allowed_efforts.join(', ')}`);
    }
    if (constraints.disallowed_tools !== undefined && constraints.disallowed_tools.length > 0) {
      summaryChips.push(`${t('st.namedAgents.disallowedTools')} ${constraints.disallowed_tools.join(', ')}`);
    }
  }
  const stringSubagents = (profile.subagents ?? []).filter((lease): lease is string => typeof lease === 'string');
  const leaseSubagents = (profile.subagents ?? []).filter((lease): lease is NamedAgentSubagentLease => typeof lease !== 'string');
  const subagentPolicyLabel = profile.subagent_policy === undefined
    ? t('diagnostics.unknown')
    : t(`agentPanel.subagentPolicy.${profile.subagent_policy}` as I18nKey);
  const subagentChipClass = 'rounded-full border border-hairline bg-panel px-1.5 py-px font-mono text-[9.5px] text-ink-faint';

  // A built-in shadowed by an overriding same-name file profile collapses to
  // a single muted line — rendering it as a normal enabled row would suggest
  // two live profiles where only the file actually runs.
  if (overriddenBy !== undefined) {
    return (
      <div
        data-agent-profile={profile.name}
        data-agent-source={profile.source}
        data-override-state="overridden"
        className="rounded-lg border border-hairline bg-panel px-3 py-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[12.5px] text-ink-faint">{profile.name}</p>
          <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint">
            {profile.source}
          </span>
          <span
            data-subagent-policy={profile.subagent_policy ?? 'unknown'}
            className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint"
          >
            {subagentPolicyLabel}
          </span>
          <span className="min-w-0 truncate text-[10.5px] text-ink-faint" title={overriddenBy.file}>
            {t('st.namedAgents.overriddenByFile', { file: overriddenBy.file })}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-agent-profile={profile.name}
      data-agent-source={profile.source}
      data-override-state={overrideState}
      data-default-agent={defaultMain ? 'true' : undefined}
      className={`rounded-lg border bg-paper px-3 py-2 transition-opacity ${defaultMain ? 'border-accent/50 ring-1 ring-accent/10' : 'border-hairline'} ${profile.disabled && !defaultMain ? 'opacity-60' : ''}`}
    >
      {defaultMain ? <div className="mb-3 border-b border-accent/20 pb-2">
        <p className="text-[12px] font-semibold text-accent">{t('st.mainAgents.defaultTitle')}</p>
        <Hint>{t('st.mainAgents.defaultHint')}</Hint>
      </div> : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[12.5px] font-medium text-ink">
            {profile.name}
            {profile.disabled ? (
              <span className="ml-2 rounded-full border border-hairline bg-panel px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-ink-faint">
                {t('st.namedAgents.disabledBadge')}
              </span>
            ) : null}
          </p>
          {profile.disabled && defaultMain ? (
            <p className="mt-0.5 text-[10.5px] text-ink-faint">{t('st.namedAgents.disabledMainHint')}</p>
          ) : null}
          {profile.description !== undefined ? <p className="text-[11.5px] text-ink-soft">{profile.description}</p> : null}
          {overrideRelation?.kind === 'overrides_builtin' ? (
            <p className="mt-0.5 text-[10.5px] text-ink-faint">{t('st.namedAgents.overridesBuiltin')}</p>
          ) : null}
          {overrideRelation?.kind === 'shadowed' ? (
            <p className="mt-0.5 text-[10.5px] text-danger">{t('st.namedAgents.shadowedByBuiltin')}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* The toggle writes the server-level disable list, which is keyed by
              profile name alone — so it covers this profile in every workspace.
              Say so next to the switch instead of hiding it in a tooltip. */}
          <div className="flex items-center gap-1.5" title={toggleTitle}>
            <Toggle
              label={t('st.namedAgents.enabled')}
              checked={!profile.disabled}
              disabled={toggleSaving}
              onChange={(enabled) => {
                setFeedback(null);
                void onToggleEnabled(profile, enabled).catch((error: unknown) => {
                  setFeedback({ tone: 'error', text: errorText(locale, error) });
                });
              }}
            />
            <span
              data-toggle-scope="server"
              className="shrink-0 rounded-full border border-hairline bg-panel px-1.5 py-px font-mono text-[9.5px] text-ink-faint"
            >
              {t('st.namedAgents.namedToggleScope')}
            </span>
          </div>
          <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint">
            {profile.source}{writable ? '' : ` · ${t('st.namedAgents.readOnly')}`}
          </span>
          <span
            data-subagent-policy={profile.subagent_policy ?? 'unknown'}
            className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[9.5px] text-ink-faint"
          >
            {subagentPolicyLabel}
          </span>
          {shippedEntry !== undefined ? (
            <ShippedProfileControls
              entry={shippedEntry}
              profile={profile}
              onRestored={() => {
                onShippedChanged?.();
                setFeedback({ tone: 'success', text: t('st.shipped.restored') });
              }}
              onError={(error) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); }}
            />
          ) : null}
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={newSessionBlocked}
            title={newSessionTitle}
            data-new-session-href={sessionHref}
            onClick={() => void navigate(sessionHref)}
          >
            {t('st.namedAgents.newSession')}
          </button>
          {writable ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setFeedback(null); setEditorOpen(true); }}>
              {t('st.namedAgents.edit')}
            </button>
          ) : null}
        </div>
      </div>
      {profile.source !== 'builtin' ? (
        <p data-toggle-scope-hint className="mt-1 text-[10.5px] text-ink-faint">
          {t('st.namedAgents.namedToggleHint')}
        </p>
      ) : null}
      {editorOpen ? (
        <AgentProfileEditorDialog
          profile={profile}
          onClose={() => { setEditorOpen(false); }}
          onSaved={(updated) => {
            onUpdated(updated);
            setFeedback({ tone: 'success', text: t('st.namedAgents.saved') });
          }}
        />
      ) : null}
      <>
          {summaryChips.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {summaryChips.map((chip) => (
                <span key={chip} className={subagentChipClass}>{chip}</span>
              ))}
            </div>
          ) : null}
          {stringSubagents.length > 0 || leaseSubagents.length > 0 ? (
            <div className="mt-1.5 space-y-1">
              <p className="text-[10.5px] font-medium text-ink-soft">{t('st.namedAgents.availableSubagents')}</p>
              {stringSubagents.length > 0 ? (
                <p className="flex flex-wrap gap-1.5">
                  {stringSubagents.map((name) => (
                    <span key={name} className={subagentChipClass}>{name}</span>
                  ))}
                </p>
              ) : null}
              {leaseSubagents.map((lease, index) => {
                const leaseSummary = summarizeNamedAgentLease(lease);
                return (
                  <p key={`${lease.name}:${index}`} className="flex flex-wrap items-center gap-1.5 break-all font-mono text-[10.5px] text-ink-soft">
                    <span>{leaseSummary.headline}</span>
                    {leaseSummary.scoped ? (
                      <span className="rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-accent">
                        {t('st.namedAgents.scopedBadge')}
                      </span>
                    ) : null}
                    {leaseSummary.status !== undefined ? (
                      <span className={leaseSummary.status === 'unavailable' ? 'text-danger' : 'text-success'}>
                        {t(leaseSummary.status === 'unavailable' ? 'st.namedAgents.leaseUnavailable' : 'st.namedAgents.leaseReady')}
                      </span>
                    ) : null}
                    {leaseSummary.diagnostic !== undefined ? (
                      <span className="text-danger">{leaseSummary.diagnostic}</span>
                    ) : null}
                  </p>
                );
              })}
            </div>
          ) : null}
          <details className="mt-2 rounded-lg border border-hairline bg-panel px-2.5 py-1.5" data-technical-details>
            <summary className="cursor-pointer select-none text-[10.5px] font-medium text-ink-faint hover:text-ink-soft">
              {t('st.namedAgents.technicalDetails')}
            </summary>
            <div className="mt-2 space-y-1 break-all font-mono text-[10px] text-ink-faint">
            <p>{t('st.namedAgents.sourceFile')}: {profile.source_file ?? t('st.namedAgents.builtin')}</p>
            {workspaceChips.shown.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1">
                {workspaceChips.shown.map((id) => (
                  <span key={id} title={id} className="max-w-40 truncate rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[9.5px] text-ink-faint">
                    {id}
                  </span>
                ))}
                {workspaceChips.extra > 0 ? (
                  <span
                    title={workspaceIds.join(', ')}
                    className="rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[9.5px] text-ink-faint"
                  >
                    +{workspaceChips.extra} {t('st.namedAgents.workspaces')}
                  </span>
                ) : null}
              </p>
            ) : null}
            {profile.when_to_use !== undefined ? <p>{t('st.namedAgents.whenToUse')}: {profile.when_to_use}</p> : null}
            {profile.pinned_model_alias !== undefined ? <p>{t('st.namedAgents.modelPin')}: {profile.pinned_model_alias}</p> : null}
            {profile.thinking_effort !== undefined ? <p>{t('st.namedAgents.defaultModelThinkingEffort')}: {profile.thinking_effort}</p> : null}
            {profile.service_tier !== undefined ? <p>{t('st.namedAgents.serviceTier')}: {profile.service_tier}</p> : null}
            {hasProfileBudget ? (
              <>
                <p>{t('st.namedAgents.contextBudget')}: {contextBudget ?? t('st.namedAgents.unspecified')}</p>
                <p>{t('st.namedAgents.maxCompletionTokens')}: {maxCompletionTokens ?? t('st.namedAgents.unspecified')}</p>
                <p>{t('st.namedAgents.requestParams')}: {profile.request_params === undefined || Object.keys(profile.request_params).length === 0 ? t('st.namedAgents.unspecified') : JSON.stringify(profile.request_params)}</p>
              </>
            ) : null}
            {profile.routes.map((route) => (
              <p key={route.id}>
                {t('st.namedAgents.route')}: {route.id}
                {route.model_alias === undefined ? '' : ` → ${route.model_alias}`}
                {' · '}{route.source_file}
              </p>
            ))}
            {profile.model_profiles?.map((entry) => {
              const modelProfile = summarizeNamedAgentModelProfile(entry);
              return (
                <div key={entry.alias} className="space-y-1">
                  <p>{t('st.namedAgents.modelProfile')}: {modelProfile.headline}</p>
                  {modelProfile.details.map((detail, detailIndex) => (
                    <p key={`${detail.label}:${detailIndex}`} className="pl-3">
                      {t(LEASE_DETAIL_LABEL_KEYS[detail.label])}: {detail.value}
                    </p>
                  ))}
                </div>
              );
            })}
            {spawnSummary !== '' ? <p>{t('st.namedAgents.spawnConstraints')}: {spawnSummary}</p> : null}
            <p data-technical-subagent-policy>
              {t('agentPanel.subagentPolicy')}: {subagentPolicyLabel}
            </p>
            {profile.subagents?.map((lease, index) => {
              if (typeof lease === 'string') {
                return <p key={lease}>{t('st.namedAgents.subagentLease')}: {lease}</p>;
              }
              const leaseSummary = summarizeNamedAgentLease(lease);
              return (
                <div key={`${lease.name}:${index}`} className="space-y-1">
                  <p>
                    {t('st.namedAgents.subagentLease')}:
                    {leaseSummary.scoped ? (
                      <span className="mx-1 rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-accent">
                        {t('st.namedAgents.scopedBadge')}
                      </span>
                    ) : null}
                    {' '}{leaseSummary.headline}
                  </p>
                  {leaseSummary.status !== undefined ? (
                    <p className={`pl-3${leaseSummary.status === 'unavailable' ? ' text-danger' : ''}`}>
                      {t('st.namedAgents.leaseStatus')}: {t(leaseSummary.status === 'unavailable' ? 'st.namedAgents.leaseUnavailable' : 'st.namedAgents.leaseReady')}
                    </p>
                  ) : null}
                  {leaseSummary.diagnostic !== undefined ? (
                    <p className="pl-3 text-danger">{leaseSummary.diagnostic}</p>
                  ) : null}
                  {leaseSummary.details.map((detail, detailIndex) => (
                    <p key={`${detail.label}:${detailIndex}`} className="pl-3">
                      {t(LEASE_DETAIL_LABEL_KEYS[detail.label])}: {detail.value}
                    </p>
                  ))}
                </div>
              );
            })}
            </div>
            {hasProjection ? <Hint>{t('st.namedAgents.projectionHint')}</Hint> : null}
          </details>
        </>
      {profile.source_file !== undefined ? (
        <div className="mt-3 border-t border-hairline pt-3">
          <button type="button" className={SECONDARY_BUTTON} onClick={() => void toggleRaw()}>
            {rawOpen ? t('st.namedAgents.hideRaw') : writable ? t('st.namedAgents.editRaw') : t('st.namedAgents.viewRaw')}
          </button>
          {rawOpen ? (
            <div className="mt-2 space-y-2">
              {rawLoading ? <Hint>{t('st.namedAgents.rawLoading')}</Hint> : (
                <textarea
                  className={`${INPUT} min-h-64 font-mono text-[11px]`}
                  value={rawText}
                  readOnly={!writable}
                  onChange={(event) => { setRawText(event.target.value); }}
                />
              )}
              {writable && !rawLoading ? (
                <button type="button" className={PRIMARY_BUTTON} disabled={rawSaving} onClick={() => void saveRaw()}>
                  {rawSaving ? t('common.saving') : t('st.namedAgents.saveRaw')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {effective && profile.main === true && workspaceFallbackId !== undefined ? (
        <div className="mt-3 border-t border-hairline pt-2">
          <AgentCapabilitiesPanel query={{ workspace_id: workspaceFallbackId, profile: profile.name }} />
        </div>
      ) : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

/**
 * One named-profile card per bucket (redesign §10.3): `main` stays on the
 * Agents leaf, `sub` moves to the Subagents leaf. Both buckets share the
 * query/merge/override pipeline — only the wrapping card and row set differ.
 */
export function NamedAgentProfilesCard({ bucket }: { bucket: 'main' | 'sub' }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [toggleSaving, setToggleSaving] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const selectedWorkspaceId = workspaceId ?? sortWorkspacesByRecency(workspacesQuery.data?.items ?? [])[0]?.id;
  const profilesQueryKey = ['named-agent-profiles', selectedWorkspaceId ?? 'global'];
  const profilesQuery = useQuery({
    queryKey: profilesQueryKey,
    queryFn: () => loadAgentProfileCatalog(client, selectedWorkspaceId === undefined
      ? { mode: 'global' } : { mode: 'workspace', workspaceId: selectedWorkspaceId }),
    enabled: !workspacesQuery.isPending,
    staleTime: 15_000,
  });
  const effectiveMode = selectedWorkspaceId === undefined ? { mode: 'disabled' as const }
    : { mode: 'workspace' as const, workspaceId: selectedWorkspaceId, effective: true };
  const effectiveQuery = useQuery({
    queryKey: agentProfileCatalogQueryKey(effectiveMode),
    queryFn: () => loadAgentProfileCatalog(client, effectiveMode),
    enabled: selectedWorkspaceId !== undefined,
    staleTime: 15_000,
  });
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  // Shipped-template management state (built-in origin, modification status,
  // restore). Additive: on servers without the routes the query fails and the
  // rows render exactly like ordinary file profiles.
  const shippedQuery = useQuery({
    queryKey: ['shipped-agent-profiles'],
    queryFn: () => client.listShippedAgentProfiles(),
    staleTime: 15_000,
    retry: false,
  });
  const [shippedFeedback, setShippedFeedback] = useState<Feedback>(null);
  const shippedEntries = shippedQuery.data?.items ?? [];
  const onShippedChanged = () => {
    void queryClient.invalidateQueries({ queryKey: ['shipped-agent-profiles'] });
    void invalidateAgentProfileCatalogs(queryClient);
  };
  const updateEcho = (updated: NamedAgentProfile) => {
    queryClient.setQueryData<ListNamedAgentProfilesResponse>(
      profilesQueryKey,
      (current) => current === undefined
        ? { items: [updated], complete: true }
        : {
            items: current.items.map((profile) =>
              profile.name === updated.name &&
              profile.source === updated.source &&
              profile.source_file === updated.source_file
                ? updated
                : profile,
            ),
            complete: current.complete,
          },
    );
    if (shippedEntryForProfile(updated, shippedEntries)?.managed === true) {
      void queryClient.invalidateQueries({ queryKey: ['shipped-agent-profiles'] });
    }
    void invalidateAgentProfileCatalogs(queryClient);
  };
  const toggleEnabled = async (profile: NamedAgentProfile, enabled: boolean) => {
    setToggleSaving(profile.name);
    try {
      const echoed = await client.patchConfig(disabledProfilePatch(configQuery.data ?? {}, profile, enabled));
      queryClient.setQueryData(['config'], echoed);
      await invalidateAgentProfileCatalogs(queryClient);

    } finally {
      setToggleSaving(null);
    }
  };
  // Merged view: one row per name+source+file across workspaces. Idempotent
  // over servers that already return the merged /agents payload.
  const profiles = useMemo(
    () => mergeNamedAgentProfiles(profilesQuery.data?.items ?? []),
    [profilesQuery.data],
  );
  // The global list has no `?effective=true` resolution (that endpoint needs a
  // workspace), so effectiveness follows the managed built-in copies: the
  // materialized originals of the shipped templates are the profiles that run
  // under their own name.
  const isEffective = (profile: NamedAgentProfile) => selectedWorkspaceId === undefined
    ? shippedEntryForProfile(profile, shippedEntries) !== undefined && !profile.disabled
    : effectiveQuery.data?.items.some((item) => item.name === profile.name
      && item.source === profile.source && item.source_file === profile.source_file) === true;
  const workspaceSelector = (workspacesQuery.data?.items.length ?? 0) > 0 ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <label className="flex items-center gap-2 text-[11px] font-medium text-ink-soft">{t('new.workspace')}
        <select className={SMALL_INPUT} value={selectedWorkspaceId ?? ''}
          onChange={(event) => { setWorkspaceId(event.target.value); }}>
          {workspacesQuery.data?.items.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name ?? workspace.root}</option>
          ))}
        </select>
      </label>
      <Hint>{t('st.namedAgents.workspaceHint')}</Hint>
    </div>
  ) : null;
  // `main === true` lands in the main-agent card; everything else is a
  // subagent profile. Enabled toggle and edit affordances are identical.
  const buckets = useMemo(() => partitionNamedAgentProfiles(profiles), [profiles]);
  const overrideRelations = useMemo(() => {
    const winners = effectiveQuery.data?.items ?? [];
    const relations = new Map(namedAgentOverrideRelations(profiles.filter((profile) =>
      profile.source === 'builtin' || winners.some((winner) => winner.name === profile.name
        && winner.source === profile.source && winner.source_file === profile.source_file)
    )));
    for (const profile of profiles) {
      if (profile.source !== 'builtin' && profile.override !== true
        && winners.some((winner) => winner.name === profile.name && winner.source === 'builtin')) {
        relations.set(profile, { kind: 'shadowed', builtinName: profile.name });
      }
    }
    return relations;
  }, [profiles, effectiveQuery.data]);

  const renderRow = (profile: NamedAgentProfile, index: number) => (
    <NamedAgentProfileRow
      key={`${profile.name}:${profile.source}:${profile.source_file ?? profile.workspace_id ?? ''}:${index}`}
      profile={profile}
      workspaceFallbackId={selectedWorkspaceId}
      effective={isEffective(profile)}
      overrideRelation={overrideRelations.get(profile)}
      onUpdated={updateEcho}
      onToggleEnabled={toggleEnabled}
      toggleSaving={toggleSaving !== null || configQuery.isLoading}
      shippedEntry={shippedEntryForProfile(profile, shippedEntries)}
      onShippedChanged={onShippedChanged}
    />
  );

  // Managed copies the user deleted stay restorable (tombstone); they have no
  // catalog row, so they render as compact restore rows at the end of the
  // bucket their template belongs to.
  const removedRows = shippedEntries
    .filter((entry) => entry.managed && entry.status === 'removed' && entry.main === (bucket === 'main'))
    .map((entry) => (
      <div
        key={`shipped-removed:${entry.template_id}`}
        data-shipped-removed={entry.template_id}
        className="rounded-lg border border-hairline bg-panel px-3 py-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-[12.5px] text-ink-faint">{entry.template_id}</p>
            {entry.description !== undefined ? <p className="text-[11.5px] text-ink-soft">{entry.description}</p> : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ShippedProfileControls
              entry={entry}
              onRestored={() => {
                onShippedChanged();
                setShippedFeedback({ tone: 'success', text: t('st.shipped.restored') });
              }}
              onError={(error) => { setShippedFeedback({ tone: 'error', text: errorText(locale, error) }); }}
            />
          </div>
        </div>
      </div>
    ));

  if (bucket === 'sub') {
    return (
      <SectionCard id="st-card-subagent-profiles" title={t('st.subagentProfiles.title')}>
        <div className="space-y-3">
          {workspaceSelector}
          {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
          <div className="space-y-2">
            {buckets.sub.map(renderRow)}
            {removedRows}
            {profilesQuery.data !== undefined && buckets.sub.length === 0 ? <Hint>{t('st.subagentProfiles.empty')}</Hint> : null}
          </div>
          <FeedbackLine feedback={shippedFeedback} />
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard id="st-card-main-agents" title={t('st.mainAgents.title')}>
      <div className="space-y-3">
        {workspaceSelector}
        <Hint>{t('st.namedAgents.editHint')}</Hint>
        {workspacesQuery.isError ? <InlineError error={workspacesQuery.error} /> : null}
        {effectiveQuery.isError ? <InlineError error={effectiveQuery.error} /> : null}
        <div className="space-y-2">
          {buckets.main.toSorted((a, b) => Number(b.name === 'agent' && isEffective(b)) - Number(a.name === 'agent' && isEffective(a))).map(renderRow)}
          {removedRows}
          {profilesQuery.data !== undefined && buckets.main.length === 0 ? <Hint>{t('st.mainAgents.empty')}</Hint> : null}
          {profilesQuery.isLoading ? <Hint>{t('st.namedAgents.loading')}</Hint> : null}
          {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        </div>
        <FeedbackLine feedback={shippedFeedback} />
      </div>
    </SectionCard>
  );
}

export function AgentsSection() {
  return (
    <div className="space-y-4">
      <NamedAgentProfilesCard bucket="main" />
      <AgentRuntimeCard />
      <PromptConfigCard />
      <ExperimentalSection
        featureIds={['agent-profile-routes']}
        cardId="st-card-agent-profile-routes"
        titleKey="st.experimental.agentRoutes"
      />
    </div>
  );
}
