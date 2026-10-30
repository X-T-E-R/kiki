import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import {
  disabledProfilePatch, mergeNamedAgentProfiles, namedAgentNewSessionBlocked, namedAgentOverrideRelations,
  namedAgentSessionHref, shippedEntryForProfile,
} from '@kiki/session-core/settings';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import { useI18n } from '../../i18n';
import { agentProfileCatalogQueryKey, agentProfileCatalogRefetchInterval, invalidateAgentProfileCatalogs, loadAgentProfileCatalog } from '../../lib/agentProfileCatalog';
import type { NamedAgentProfile } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { useAskKiki, useAskKikiWorkspace, AskKikiButton } from '../askKiki';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { Icon } from '../icons';
import { DetailSplit, DetailRailGroup, DetailRailItem, useDetailParam } from '../overlays';
import { SidePanel } from '../SidePanel';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { useDirtyGuard, useGuardedNavigate } from '../dirtyGuard';
import { SearchableSelect } from '../SearchableSelect';
import { ShippedProfileControls } from './ShippedProfileControls';
import { SectionCard } from './SectionCard';
import { AdvancedDetails } from './fields';
import { SETTINGS_SELECT_TRIGGER } from './SettingsPrimitives';
import { diagnosticTone, profileDiagnostics, sameProfile } from './profileEditor/diagnostics';
import { engineLabel, useExecutorCatalog } from './profileEditor/engines';
import { NewProfile } from './profileEditor/NewProfile';
import { ProfileEditor } from './profileEditor/ProfileEditor';
import { isWritable, writeScope } from './profileEditor/profileDraft';
import { displayName, TeamView, type TeamRow } from './profileEditor/TeamView';
import { useSavedTick } from './useSavedTick';

// Identity of the file, not of one workspace's registration: a refetch can
// re-merge rows under another workspace id while the detail is open.
const profileKey = (profile: NamedAgentProfile) => `${profile.source}:${profile.source_file ?? ''}:${profile.name}`;

/** The `?agent=` query: the profile whose detail is open. */
export const AGENT_QUERY_PARAM = 'agent';
/** The `?workspace=` query: the workspace this page is filtered to. */
const WORKSPACE_QUERY_PARAM = 'workspace';

/** The create flow, in a side panel; `source` prefills a duplicate. */
type Creating = { source?: string } | null;

/**
 * Agents: one team table across every profile (role, engine, model, effort,
 * who dispatches whom). Opening a profile edits it in the page
 * (`overlays/DetailSplit`): the table folds into a rail of names beside the
 * editor, and `?agent=<name>` addresses it. Creating one is a side panel that
 * lands in the new profile's detail. Quick model/effort edits in the table
 * save immediately; the detail is a draft with Save / Discard.
 */
export function UnifiedAgentManager() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const guard = useDirtyGuard();
  const navigate = useGuardedNavigate();
  const [workspaceId, setWorkspaceId] = useState<string>();
  const detail = useDetailParam(AGENT_QUERY_PARAM);
  const [creating, setCreating] = useState<Creating>(null);
  // A profile just created: opened once the create panel's draft is gone, so
  // landing on it does not trip the unsaved-changes guard.
  const [landing, setLanding] = useState<string | null>(null);
  const [toggleSaving, setToggleSaving] = useState(false);
  const [namedDisabled, setNamedDisabled] = useState<string | null>(null);
  const [quickSaving, setQuickSaving] = useState<string>();
  const [quickSaved, pingQuickSaved] = useSavedTick();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const { ask: askKiki, busy: askingKiki } = useAskKiki();
  // Only consulted when this page has no workspace of its own to address.
  const kikiFallbackWorkspace = useAskKikiWorkspace();
  const workspacesQuery = useQuery({ queryKey: ['workspaces', 'catalog'], queryFn: () => client.listWorkspaceCatalog(), staleTime: 30_000 });
  // The address is the truth for the scope: an explicit pick is written to
  // `?workspace=` (replace, so Back lands on the previous page state) and a
  // link carrying it wins; only without a param does the page fall back to
  // the most recently used workspace.
  const [searchParams, setSearchParams] = useSearchParams();
  const workspaceParam = searchParams.get(WORKSPACE_QUERY_PARAM) ?? undefined;
  const selectedWorkspaceId = workspaceParam
    ?? (workspaceId !== undefined && (workspacesQuery.data?.items ?? []).some((workspace) => workspace.id === workspaceId)
      ? workspaceId : undefined)
    ?? sortWorkspacesByRecency(workspacesQuery.data?.items ?? [])[0]?.id;
  const profilesQuery = useQuery({
    queryKey: ['named-agent-profiles', selectedWorkspaceId ?? 'global'],
    queryFn: () => loadAgentProfileCatalog(client, selectedWorkspaceId
      ? { mode: 'workspace', workspaceId: selectedWorkspaceId } : { mode: 'global' }),
    enabled: !workspacesQuery.isPending, staleTime: 15_000,
    refetchInterval: agentProfileCatalogRefetchInterval,
  });
  const effectiveMode = selectedWorkspaceId === undefined ? { mode: 'disabled' as const }
    : { mode: 'workspace' as const, workspaceId: selectedWorkspaceId, effective: true };
  const effectiveQuery = useQuery({ queryKey: agentProfileCatalogQueryKey(effectiveMode),
    queryFn: () => loadAgentProfileCatalog(client, effectiveMode), enabled: selectedWorkspaceId !== undefined,
    staleTime: 15_000, refetchInterval: agentProfileCatalogRefetchInterval });
  const shippedQuery = useQuery({ queryKey: ['shipped-agent-profiles'],
    queryFn: () => client.listShippedAgentProfiles(), staleTime: 15_000, retry: false });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const models = modelsQuery.data?.items ?? [];
  const executors = useExecutorCatalog();
  const profiles = useMemo(() => mergeNamedAgentProfiles(profilesQuery.data?.items ?? []), [profilesQuery.data]);
  const shippedEntries = shippedQuery.data?.items ?? [];
  const effective = effectiveQuery.data?.items;
  const relations = useMemo(() => {
    const winners = effective ?? [];
    return new Map(namedAgentOverrideRelations(profiles.filter((profile) =>
      profile.source === 'builtin' || winners.some((winner) => sameProfile(winner, profile)))));
  }, [profiles, effective]);
  const modelIds = useMemo(() => modelsQuery.data === undefined ? undefined : new Set(models.map((model) => model.id)), [modelsQuery.data]);
  const rows = useMemo<TeamRow[]>(() => profiles
    // A built-in hidden by an overriding file is the file's origin, not a second agent.
    .filter((profile) => relations.get(profile)?.kind !== 'overridden')
    .map((profile) => {
      const shippedEntry = shippedEntryForProfile(profile, shippedEntries);
      return {
        key: profileKey(profile), profile, writable: isWritable(profile), shipped: shippedEntry !== undefined || profile.source === 'builtin',
        engineLabel: engineLabel(profile.executor, t('st.profiles.engineNative'), executors),
        diagnostics: profileDiagnostics(profile, { profiles, effective, modelIds, shippedEntry, overrideRelation: relations.get(profile) }),
      };
    })
    .toSorted((a, b) => Number(b.profile.name === 'agent' && b.profile.main) - Number(a.profile.name === 'agent' && a.profile.main)
      || Number(b.profile.main) - Number(a.profile.main) || a.profile.name.localeCompare(b.profile.name)),
  [profiles, shippedEntries, effective, modelIds, relations, t, executors]);

  const refresh = () => {
    void invalidateAgentProfileCatalogs(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['shipped-agent-profiles'] });
  };
  // A name is the address when it is unique on this page; two files with one
  // name (a shadowed copy) fall back to the full file identity.
  const paramOf = (row: TeamRow) => rows.filter((other) => other.profile.name === row.profile.name).length === 1 ? row.profile.name : row.key;
  const editing = detail.selected === null ? undefined
    : rows.find((row) => paramOf(row) === detail.selected) ?? rows.find((row) => row.key === detail.selected);
  // `?agent=` resolves across every workspace, not only the one in view: a
  // deep link taken while another workspace is filtered names where the
  // profile lives instead of reading as "not found". Only asked while the
  // current catalog cannot answer.
  const workspaces = workspacesQuery.data?.items ?? [];
  const elsewhereQueries = useQueries({
    queries: workspaces
      .filter((workspace) => workspace.id !== selectedWorkspaceId)
      .map((workspace) => ({
        queryKey: ['named-agent-profiles', workspace.id],
        queryFn: () => loadAgentProfileCatalog(client, { mode: 'workspace', workspaceId: workspace.id }),
        enabled: detail.selected !== null && editing === undefined && profilesQuery.isSuccess && !profilesQuery.data.items.some((item) => item.name === detail.selected),
        staleTime: 15_000,
      })),
  });
  const elsewhere = useMemo(() => {
    if (detail.selected === null || editing !== undefined) return undefined;
    for (let i = 0; i < elsewhereQueries.length; i++) {
      const items = elsewhereQueries[i]?.data?.items;
      if (items !== undefined && items.some((item) => item.name === detail.selected)) return workspaces.filter((workspace) => workspace.id !== selectedWorkspaceId)[i];
    }
    return undefined;
  }, [elsewhereQueries, workspaces, selectedWorkspaceId, editing, detail.selected]);
  // A deliberate workspace switch keeps the open detail when the same name
  // resolves there too.
  const openName = editing !== undefined && detail.selected === editing.profile.name ? detail.selected : null;
  const switchWorkspace = (next: string, keepOpen: boolean) => {
    if (next === selectedWorkspaceId) return;
    setWorkspaceId(next);
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set(WORKSPACE_QUERY_PARAM, next);
      if (!keepOpen) params.delete(AGENT_QUERY_PARAM);
      return params;
    }, { replace: true });
  };
  const openRow = (row: TeamRow) => { detail.open(paramOf(row)); };
  const closeCreate = () => {
    if (guard?.confirmDiscard === undefined) { setCreating(null); return; }
    guard.confirmDiscard('agent-create', () => setCreating(null));
  };
  useEffect(() => {
    if (landing === null || creating !== null || guard?.dirty === true) return;
    const row = rows.find((candidate) => candidate.key === landing);
    if (row === undefined) return;
    setLanding(null);
    openRow(row);
  }, [landing, creating, guard?.dirty, rows]);
  const toggleEnabled = async (profile: NamedAgentProfile, enabled: boolean) => {
    setToggleSaving(true);
    try {
      const echoed = await client.patchConfig(disabledProfilePatch(configQuery.data ?? {}, profile, enabled));
      queryClient.setQueryData(['config'], echoed);
      await invalidateAgentProfileCatalogs(queryClient);
    } finally { setToggleSaving(false); }
  };
  /**
   * The same server-wide list the row toggle writes, addressed by name. A name
   * that is not in this catalog can still be disabled ahead of time, which is
   * what the row toggle alone cannot reach.
   */
  const setDisabledByName = async (name: string, enabled: boolean) => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setToggleSaving(true);
    setFeedback(null);
    try {
      const current = configQuery.data?.disabled_named_profiles ?? [];
      const next = enabled
        ? current.filter((entry) => entry !== trimmed)
        : [...new Set([...current, trimmed])];
      const echoed = await client.patchConfig({ disabled_named_profiles: next });
      queryClient.setQueryData(['config'], echoed);
      await invalidateAgentProfileCatalogs(queryClient);
      setNamedDisabled('');
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setToggleSaving(false); }
  };
  const quickSave = async (row: TeamRow, patch: { pinned_model_alias?: string | null; thinking_effort?: string | null }) => {
    if (!row.writable || row.profile.workspace_id === undefined) return;
    setQuickSaving(row.key); setFeedback(null);
    try {
      await client.updateNamedAgentProfile(row.profile.name, {
        scope: writeScope(row.profile), workspace_id: row.profile.workspace_id, source_file: row.profile.source_file, ...patch,
      });
      pingQuickSaved();
      refresh();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setQuickSaving(undefined); }
  };
  const workspaceOptions = useMemo(() => (workspacesQuery.data?.items ?? []).map((workspace) => {
    // A workspace's own name, else the folder it points at — never the raw
    // registration id, which reads as a hash.
    const base = workspace.root.replace(/[\/]+$/, '').split(/[\/]/).pop();
    const label = workspace.name !== undefined && workspace.name !== '' ? workspace.name : base !== '' && base !== undefined ? base : workspace.id;
    return { value: workspace.id, label, hint: workspace.root, title: workspace.root };
  }), [workspacesQuery.data]);
  // Names disabled server-wide that no visible row exposes, so the by-name entry
  // can re-enable a profile the workspace filter does not show.
  const disabledNames = useMemo(
    () => (configQuery.data?.disabled_named_profiles ?? []).filter((name) =>
      !profiles.some((profile) => profile.name === name)),
    [configQuery.data, profiles],
  );
  const removed = shippedEntries.filter((entry) => entry.managed && entry.status === 'removed');

  /**
   * Whether the handoff knows where the session should run.
   *
   * A workspace this page is already filtered to is enough on its own, so the
   * unrelated fallback query cannot hold a working entry hostage. Only when
   * there is no selection does the fallback decide — and then it must have
   * actually answered. An unanswered or failed list is not an empty list, and
   * guessing here is what produces a throwaway directory per press.
   */
  const askKikiReady = selectedWorkspaceId !== undefined || kikiFallbackWorkspace.resolved;

  const workspacePicker = workspaceOptions.length > 0 ? <SearchableSelect id="agents-workspace-select" options={workspaceOptions}
    value={selectedWorkspaceId ?? ''} ariaLabel={t('new.workspace')} buttonClassName={SETTINGS_SELECT_TRIGGER}
    triggerLabel={<span className="min-w-0 text-ink-soft">{t('st.profiles.project')} <span className="inline-block max-w-56 truncate align-bottom text-ink">{workspaceOptions.find((option) => option.value === selectedWorkspaceId)?.label}</span></span>}
    onChange={(next) => { switchWorkspace(next, openName !== null); }} /> : null;

  const list = <div className="space-y-4">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2" data-agents-scope>
        {workspacePicker ?? <span />}
        <SaveStatus saving={quickSaving !== undefined} saved={quickSaved} />
      </div>
      <TeamView rows={rows} models={models} savingKey={quickSaving}
        // Beside "New agent", because that is the verb this one stands in for —
        // not in the filter row, where it read as another workspace control.
        newActions={
          <AskKikiButton
            label={t('st.agentManager.askKiki')}
            labelAria={t('st.agentManager.askKikiAria')}
            busy={askingKiki}
            // Only a page that already knows which workspace it is editing is
            // ready. `selectedWorkspaceId` collapses to undefined when the
            // workspace list fails or is still loading, and passing that
            // through would ask the server for a throwaway directory.
            disabled={!askKikiReady}
            testId="data-agent-ask-kiki"
            onAsk={() => {
              void askKiki({
                skill: 'kiki-profile',
                promptKey: 'st.agentManager.askKiki.prompt',
                context: selectedWorkspaceId === undefined
                  ? undefined
                  : t('st.agentManager.askKiki.context', {
                    target: workspaceOptions.find((option) => option.value === selectedWorkspaceId)?.label ?? selectedWorkspaceId,
                  }),
                // The page is filtered to one workspace and the prompt above
                // names it, so the session must run there. The id, never the
                // label: a display name is not an address.
                location: selectedWorkspaceId === undefined ? kikiFallbackWorkspace.location : { kind: 'workspace', workspaceId: selectedWorkspaceId },
              });
            }}
          />
        }
        onOpen={openRow} onNew={() => setCreating({})} loading={profilesQuery.isPending}
        onQuickSave={(row, patch) => void quickSave(row, patch)} />
      {removed.length > 0 ? <div className="space-y-1" data-shipped-removed-list>
        {removed.map((entry) => <div key={entry.template_id} data-shipped-removed={entry.template_id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md px-1 py-1.5">
          <span className="text-[13px] text-ink-faint"><span className="font-mono">{entry.template_id}</span>{entry.description !== undefined ? ` · ${entry.description}` : ''}</span>
          <ShippedProfileControls entry={entry} onRestored={() => { refresh(); setFeedback({ tone: 'success', text: t('st.shipped.restored') }); }}
            onError={(error) => setFeedback({ tone: 'error', text: errorText(locale, error) })} />
        </div>)}
      </div> : null}
      {profilesQuery.isLoading ? <Hint>{t('st.namedAgents.loading')}</Hint> : null}
      {profilesQuery.isError ? <InlineError error={profilesQuery.error} /> : null}
      {effectiveQuery.isError ? <InlineError error={effectiveQuery.error} /> : null}
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      {/* The handoff is disabled while this is unresolved; say why rather than
          leaving a dead button. */}
      {!askKikiReady && workspacesQuery.isError ? <InlineError error={workspacesQuery.error} /> : null}
      <AdvancedDetails summary={t('st.agentManager.disabledByName')} data-disabled-by-name-fold className="pt-3 text-[11px] text-ink-soft">
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className={`${INPUT} font-mono`}
            value={namedDisabled ?? ''}
            placeholder="profile-name"
            aria-label={t('st.agentManager.disabledByName')}
            onChange={(event) => { setNamedDisabled(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void setDisabledByName(namedDisabled ?? '', false);
            }}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-disabled-by-name-add
            disabled={toggleSaving || (namedDisabled ?? '').trim() === ''}
            onClick={() => { void setDisabledByName(namedDisabled ?? '', false); }}
          >
            {t('st.agentManager.disableByName')}
          </button>
        </div>
        {disabledNames.length > 0 ? (
          <ul className="space-y-1">
            {disabledNames.map((name) => (
              <li key={name} data-disabled-by-name={name} className="flex items-center justify-between gap-2 text-[12px] text-ink-soft">
                <span className="font-mono">{name}</span>
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  disabled={toggleSaving}
                  onClick={() => { void setDisabledByName(name, true); }}
                >
                  {t('st.agentManager.enableByName', { name })}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </AdvancedDetails>
      <FeedbackLine feedback={feedback} />
    </div>;

  // The rail: the same two groups as the table, names only.
  const railGroups = (['main', 'subagent'] as const).map((kind) => ({
    kind, rows: rows.filter((row) => (kind === 'main') === row.profile.main),
  })).filter((group) => group.rows.length > 0);
  const rail = <div data-agent-rail>
    {railGroups.map((group) => <DetailRailGroup key={group.kind} count={group.rows.length}
      label={t(group.kind === 'main' ? 'st.profiles.groupMain' : 'st.profiles.groupSubagents')}>
      {group.rows.map((row) => <DetailRailItem key={row.key} itemKey={row.profile.name}
        label={displayName(row.profile, locale)} current={row === editing}
        muted={row.profile.disabled || row.diagnostics.some((item) => item.kind === 'shadowedBy')}
        trailing={row.diagnostics.some((item) => diagnosticTone(item) === 'warning')
          ? <Icon name="warning" size={12} className="shrink-0 text-amber-ink" /> : undefined}
        onSelect={() => openRow(row)} />)}
    </DetailRailGroup>)}
  </div>;

  const editor = editing === undefined ? null : <ProfileEditor key={editing.key} profile={editing.profile} writable={editing.writable} profiles={profiles}
    models={models} diagnostics={editing.diagnostics} shippedEntry={shippedEntryForProfile(editing.profile, shippedEntries)}
    onSaved={refresh} onClose={detail.close}
    onOpenWinner={(() => {
      const winner = effective?.find((candidate) => candidate.name === editing.profile.name && !sameProfile(candidate, editing.profile));
      const target = winner === undefined ? undefined : rows.find((row) => sameProfile(row.profile, winner));
      return target === undefined ? undefined : () => openRow(target);
    })()}
    onToggleEnabled={(enabled) => toggleEnabled(editing.profile, enabled)} toggleSaving={toggleSaving || configQuery.isLoading}
    newSessionBlocked={namedAgentNewSessionBlocked(editing.profile, relations.get(editing.profile))
      || (effective !== undefined && !effective.some((winner) => sameProfile(winner, editing.profile)))}
    onNewSession={() => { void navigate(namedAgentSessionHref(editing.profile, selectedWorkspaceId)); }}
    onDuplicate={() => setCreating({ source: editing.profile.name })} />;

  return <SectionCard id="st-card-main-agents" title={t('st.agentManager.title')}>
    <DetailSplit selected={editing === undefined ? null : editing.profile.name} label={t('st.profiles.team')}
      data={{ 'data-agents-split': '' }} list={list} rail={rail} detail={editor} />
    {detail.selected !== null && editing === undefined && !profilesQuery.isLoading
      ? (elsewhere !== undefined ? (
        <p data-agent-elsewhere className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-ink-faint">
          {t('st.profiles.inOtherWorkspace', { name: detail.selected, workspace: elsewhere.name ?? elsewhere.root })}
          <button type="button" data-agent-elsewhere-open className="font-medium text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
            onClick={() => { switchWorkspace(elsewhere.id, true); }}>
            {t('st.profiles.openThere')}
          </button>
        </p>
      ) : (
        <p data-agent-missing className="text-[13px] text-ink-soft">{t('st.profiles.notFound')}</p>
      )) : null}
    {creating !== null ? <SidePanel title={t('st.agentManager.new')} overlayId="agent-create-panel" width="lg"
      onClose={closeCreate} data={{ 'data-agent-create-panel': '' }}>
      <NewProfile workspaceId={selectedWorkspaceId} workspaceOptions={workspaceOptions} profiles={profiles} shipped={shippedEntries}
        initialSource={creating.source} onCancel={closeCreate}
        onCreated={(created) => {
          refresh();
          setCreating(null);
          setLanding(profileKey(created));
          setFeedback({ tone: 'success', text: t('st.agentManager.created') });
        }} />
    </SidePanel> : null}
  </SectionCard>;
}
