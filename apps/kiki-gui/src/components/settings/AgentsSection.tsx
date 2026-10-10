import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
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
  workspaceChipDisplay,
  type NamedAgentOverrideRelation,
  type SubagentGovernanceDraft,
} from '@kiki/session-core/settings';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import { useI18n } from '../../i18n';
import { agentProfileCatalogQueryKey, invalidateAgentProfileCatalogs, loadAgentProfileCatalog } from '../../lib/agentProfileCatalog';
import { AgentCapabilitiesPanel } from '../AgentCapabilitiesPanel';
import { DiskDefinitionSummary } from '../agent-panel/DiskDefinitionSummary';
import { SubagentLeaseList } from '../agent-panel/LeaseList';
import { RawFileCollapse } from '../agent-panel/RawFileCollapse';
import { SourceBadge } from '../agent-panel/SourceBadge';
import { ToolChipList } from '../agent-panel/ToolChipList';
import type {
  ListNamedAgentProfilesResponse,
  NamedAgentProfile,
  ShippedAgentProfile,
} from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingsDraftFooter, SettingsSelect } from './SettingsPrimitives';
import { AgentProfileEditorDialog } from './AgentProfileEditorDialog';
import { AgentRuntimeCard } from './AgentRuntimeSettings';
import { PromptConfigCard } from './PromptConfigCard';
import { ShippedProfileControls } from './ShippedProfileControls';
import { SubagentLimitsSettings } from './SubagentLimitsSettings';
import { useSavedTick } from './useSavedTick';
import { AliasChips } from './profileEditor/fields';
import { dispatchFieldsOf } from './profileEditor/profileDraft';

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
  const [justSaved, pingSaved] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const denyList = useMemo(
    () => draft.denyModels.split(/\r?\n/).map((m) => m.trim()).filter(Boolean),
    [draft.denyModels],
  );

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
      pingSaved();
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
          <div>
            <span className="block text-[11px] font-medium text-ink-soft mb-1.5">{t('st.subagents.denyModels')}</span>
            <AliasChips
              id="subagent-deny-models"
              values={denyList}
              models={modelsQuery.data?.items ?? []}
              disabled={configQuery.isLoading || saving}
              addLabel={t('st.profiles.addModel')}
              onChange={(next) => { setDraft((current) => ({ ...current, denyModels: next.join('\n') })); }}
            />
          </div>
        </fieldset>
        <SettingsDraftFooter saved={justSaved} id="subagent-model-governance" dirty={dirty} saving={saving || configQuery.isLoading}
          saveLabel={t('st.subagents.save')} onSave={() => void save()}
          onDiscard={() => { setDraft(savedDraft); setFeedback(null); }} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
export function NamedAgentProfileRow({
  profile,
  workspaceFallbackId,
  overrideRelation,
  onUpdated,
  onToggleEnabled,
  toggleSaving,
  effective,
  shippedEntry,
  onShippedChanged,
  onRawDirtyChange,
  showEditor = true,
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
  onRawDirtyChange?: (dirty: boolean) => void;
  showEditor?: boolean;
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
  const hasProjection =
    profile.context_budget !== undefined ||
    profile.max_completion_tokens !== undefined ||
    (profile.request_params !== undefined && Object.keys(profile.request_params).length > 0) ||
    (profile.model_profiles?.length ?? 0) > 0 ||
    constraints !== undefined;
  const [editorOpen, setEditorOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [rowSaved, pingRowSaved] = useSavedTick();
  const saveRaw = async (rawText: string) => {
    if (!writable || profile.workspace_id === undefined) return;
    setFeedback(null);
    const echoed = await client.updateNamedAgentProfile(profile.name, {
      scope: profile.source === 'workspace' ? 'project' : profile.source === 'user' ? 'user' : 'extra',
      workspace_id: profile.workspace_id,
      source_file: profile.source_file,
      raw_text: rawText,
    });
    onUpdated(echoed);
    pingRowSaved();
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
  // The one switch and the preset list, as this row states them: a profile
  // that declared neither is not described as restricted.
  const dispatch = dispatchFieldsOf(profile);
  const subagentDispatch = dispatch.can_spawn_subagents === false
    ? { key: 'leaf', label: t('st.profiles.dispatchCanSpawnOff') }
    : dispatch.allowed_subagents === undefined
      ? { key: 'undeclared', label: t('st.profiles.dispatchNotDeclared') }
      : { key: 'presets', label: dispatch.allowed_subagents.length === 0
          ? t('st.profiles.dispatchAllowedEmpty')
          : dispatch.allowed_subagents.map((entry) => typeof entry === 'string' ? entry : entry.name).join(', ') };
  const subagentLeases = dispatch.allowed_subagents ?? [];

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
          <SourceBadge source={profile.source} variant="muted" />
          <span
            data-subagent-policy={subagentDispatch.key}
            className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-faint"
          >
            {subagentDispatch.label}
          </span>
          <span className="min-w-0 truncate text-[12px] text-ink-faint" title={overriddenBy.file}>
            {t('st.namedAgents.overriddenByFile', { file: overriddenBy.file })}
          </span>
        </div>
      </div>
    );
  }

  // Embedded in the unified detail pane (showEditor=false) the row drops its
  // own frame: the pane is already the surface, so a card here nests cards.
  const embedded = !showEditor;
  return (
    <div
      data-agent-profile={profile.name}
      data-agent-source={profile.source}
      data-override-state={overrideState}
      data-default-agent={defaultMain ? 'true' : undefined}
      className={`${embedded ? '' : `rounded-lg border bg-paper px-3 py-2 ${defaultMain ? 'border-hairline-strong' : 'border-hairline'}`} transition-opacity ${profile.disabled && !defaultMain ? 'opacity-60' : ''}`}
    >
      {defaultMain ? <div className="mb-3 border-b border-hairline pb-2">
        <p className="text-[12px] font-medium text-ink">{t('st.mainAgents.defaultTitle')}</p>
        <Hint>{t('st.mainAgents.defaultHint')}</Hint>
      </div> : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[12.5px] font-medium text-ink">
            {profile.name}
            {profile.disabled ? (
              <span className="ml-2 rounded-full border border-hairline bg-panel px-1.5 py-px align-middle text-[11px] font-medium text-ink-faint">
                {t('st.namedAgents.disabledBadge')}
              </span>
            ) : null}
          </p>
          {profile.disabled && defaultMain ? (
            <p className="mt-0.5 text-[12px] text-ink-faint">{t('st.namedAgents.disabledMainHint')}</p>
          ) : null}
          {profile.description !== undefined ? <p className="text-[11.5px] text-ink-soft">{profile.description}</p> : null}
          {overrideRelation?.kind === 'overrides_builtin' ? (
            <p className="mt-0.5 text-[12px] text-ink-faint">{t('st.namedAgents.overridesBuiltin')}</p>
          ) : null}
          {overrideRelation?.kind === 'shadowed' ? (
            <p className="mt-0.5 text-[12px] text-danger">{t('st.namedAgents.shadowedByBuiltin')}</p>
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
              className={embedded ? 'sr-only' : 'shrink-0 rounded-full border border-hairline bg-panel px-1.5 py-px font-mono text-[11px] text-ink-faint'}
            >
              {t('st.namedAgents.namedToggleScope')}
            </span>
          </div>
          {embedded ? null : <SourceBadge
            source={profile.source}
            variant="muted"
            suffix={writable ? undefined : ` · ${t('st.namedAgents.readOnly')}`}
          />}
          {embedded && subagentDispatch.key === 'undeclared' ? null : <span
            data-subagent-policy={subagentDispatch.key}
            className={embedded ? 'rounded-[4px] bg-hairline/60 px-1.5 py-px text-[12px] text-ink-faint' : 'rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-faint'}
          >
            {subagentDispatch.label}
          </span>}
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
            onClick={() => navigate(sessionHref)}
          >
            {t('st.namedAgents.newSession')}
          </button>
          {writable && showEditor ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setFeedback(null); setEditorOpen(true); }}>
              {t('st.namedAgents.edit')}
            </button>
          ) : null}
        </div>
      </div>
      {profile.source !== 'builtin' ? (
        <p data-toggle-scope-hint className="mt-1 text-[12px] text-ink-faint">
          {t('st.namedAgents.namedToggleHint')}
        </p>
      ) : null}
      {editorOpen ? (
        <AgentProfileEditorDialog
          profile={profile}
          onClose={() => { setEditorOpen(false); }}
          onSaved={(updated) => {
            onUpdated(updated);
            setFeedback(null);
            pingRowSaved();
          }}
        />
      ) : null}
      <>
          {summaryChips.length > 0 ? (
            <div className="mt-1.5">
              <ToolChipList
                variant="chips"
                items={summaryChips.map((chip) => ({ key: chip, name: chip }))}
              />
            </div>
          ) : null}
          {subagentLeases.length > 0 ? (
            <SubagentLeaseList items={subagentLeases} variant="compact" />
          ) : null}
          <details className="mt-2 border-t border-hairline pt-2" data-technical-details>
            <summary className="cursor-pointer select-none text-[12px] font-medium text-ink-faint hover:text-ink-soft">
              {t('st.namedAgents.technicalDetails')}
            </summary>
            <div className="mt-2 space-y-1 break-all font-mono text-[11px] text-ink-faint">
            <p>{t('st.namedAgents.sourceFile')}: {profile.source_file ?? t('st.namedAgents.builtin')}</p>
            {workspaceChips.shown.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1">
                {workspaceChips.shown.map((id) => (
                  <span key={id} title={id} className="max-w-40 truncate rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[11px] text-ink-faint">
                    {id}
                  </span>
                ))}
                {workspaceChips.extra > 0 ? (
                  <span
                    title={workspaceIds.join(', ')}
                    className="rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[11px] text-ink-faint"
                  >
                    +{workspaceChips.extra} {t('st.namedAgents.workspaces')}
                  </span>
                ) : null}
              </p>
            ) : null}
            <DiskDefinitionSummary
              definition={profile}
              className="space-y-1 break-all font-mono text-[11px] text-ink-faint"
              showDescription={false}
              showTools
              showModelProfiles
              showSpawnConstraints
              budgetFallbackLabel={t('st.namedAgents.unspecified')}
            />
            {profile.routes.map((route) => (
              <p key={route.id}>
                {t('st.namedAgents.route')}: {route.id}
                {route.model_alias === undefined ? '' : ` → ${route.model_alias}`}
                {' · '}{route.source_file}
              </p>
            ))}
            <p data-technical-subagent-policy>
              {t('st.profiles.dispatchTitle')}: {subagentDispatch.label}
            </p>
            {subagentLeases.length > 0 ? (
              <SubagentLeaseList items={subagentLeases} variant="details" />
            ) : null}
            </div>
            {hasProjection ? <Hint>{t('st.namedAgents.projectionHint')}</Hint> : null}
          </details>
        </>
      <RawFileCollapse
        sourceFile={profile.source_file}
        editable
        writable={writable}
        onSave={saveRaw}
        onDirtyChange={onRawDirtyChange}
      />
      {effective && profile.main === true && workspaceFallbackId !== undefined ? (
        <div className="mt-3 border-t border-hairline pt-2">
          <AgentCapabilitiesPanel query={{ workspace_id: workspaceFallbackId, profile: profile.name }} />
        </div>
      ) : null}
      {rowSaved ? <div className="pt-2"><SavedTick show /></div> : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

/**
 * Legacy bucket card retained for focused profile-editor tests. The Settings
 * route uses UnifiedAgentManager for both main and subagent definitions.
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
      <span className="text-[12px] font-medium text-ink-soft">{t('new.workspace')}</span>
      <SettingsSelect
        dataAttr="data-named-agents-workspace"
        ariaLabel={t('new.workspace')}
        className="max-w-64"
        value={selectedWorkspaceId ?? ''}
        onChange={(id) => { setWorkspaceId(id); }}
        choices={(workspacesQuery.data?.items ?? []).map((workspace) => ({ value: workspace.id, label: workspace.name ?? workspace.root, hint: workspace.root }))}
      />
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
      <AgentRuntimeCard />
      <PromptConfigCard />
    </div>
  );
}
