import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  disabledProfilePatch, mergeNamedAgentProfiles, namedAgentNewSessionBlocked, namedAgentOverrideRelations,
  namedAgentSessionHref, shippedEntryForProfile,
} from '@kiki/session-core/settings';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import { useI18n } from '../../i18n';
import { agentProfileCatalogQueryKey, invalidateAgentProfileCatalogs, loadAgentProfileCatalog } from '../../lib/agentProfileCatalog';
import type { NamedAgentProfile } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { Dialog } from '../Dialog';
import { useDirtyGuard, useGuardedNavigate } from '../dirtyGuard';
import { SearchableSelect } from '../SearchableSelect';
import { ShippedProfileControls } from './ShippedProfileControls';
import { SectionCard } from './SectionCard';
import { SETTINGS_SELECT_TRIGGER } from './SettingsPrimitives';
import { profileDiagnostics, sameProfile } from './profileEditor/diagnostics';
import { engineLabel, useExecutorCatalog } from './profileEditor/engines';
import { NewProfile } from './profileEditor/NewProfile';
import { ProfileEditor } from './profileEditor/ProfileEditor';
import { isWritable, writeScope } from './profileEditor/profileDraft';
import { TeamView, type TeamFilter, type TeamRow } from './profileEditor/TeamView';
import { useSavedTick } from './useSavedTick';

// Identity of the file, not of one workspace's registration: a refetch can
// re-merge rows under another workspace id while the sheet is open.
const profileKey = (profile: NamedAgentProfile) => `${profile.source}:${profile.source_file ?? ''}:${profile.name}`;

type Sheet = { kind: 'edit'; key: string } | { kind: 'new'; source?: string } | null;

/**
 * Agents: one team table across every profile (role, engine, model, effort,
 * who dispatches whom), and a full-width editor sheet per profile where the
 * instructions body is the main surface. Quick model/effort edits in the
 * table save immediately; the sheet is a draft with Save / Discard.
 */
export function UnifiedAgentManager() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const guard = useDirtyGuard();
  const navigate = useGuardedNavigate();
  const [filter, setFilter] = useState<TeamFilter>('all');
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toggleSaving, setToggleSaving] = useState(false);
  const [quickSaving, setQuickSaving] = useState<string>();
  const [quickSaved, pingQuickSaved] = useSavedTick();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const selectedWorkspaceId = workspaceId ?? sortWorkspacesByRecency(workspacesQuery.data?.items ?? [])[0]?.id;
  const profilesQuery = useQuery({
    queryKey: ['named-agent-profiles', selectedWorkspaceId ?? 'global'],
    queryFn: () => loadAgentProfileCatalog(client, selectedWorkspaceId
      ? { mode: 'workspace', workspaceId: selectedWorkspaceId } : { mode: 'global' }),
    enabled: !workspacesQuery.isPending, staleTime: 15_000,
  });
  const effectiveMode = selectedWorkspaceId === undefined ? { mode: 'disabled' as const }
    : { mode: 'workspace' as const, workspaceId: selectedWorkspaceId, effective: true };
  const effectiveQuery = useQuery({ queryKey: agentProfileCatalogQueryKey(effectiveMode),
    queryFn: () => loadAgentProfileCatalog(client, effectiveMode), enabled: selectedWorkspaceId !== undefined, staleTime: 15_000 });
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
  const closeSheet = () => {
    // The shared Dialog takes Escape in the capture phase, before an open
    // picker inside the sheet sees it. Close that picker instead of the sheet.
    const openPicker = document.querySelector<HTMLElement>('[role="dialog"] [aria-expanded="true"]');
    if (openPicker !== null) { openPicker.click(); openPicker.focus(); return; }
    const current = sheet?.kind === 'edit' ? rows.find((row) => row.key === sheet.key) : undefined;
    const draftId = sheet?.kind === 'new' ? 'agent-create'
      : current !== undefined ? `agent-detail:${current.profile.source}:${current.profile.source_file ?? ''}:${current.profile.name}` : undefined;
    const close = () => setSheet(null);
    if (guard?.confirmDiscard === undefined || draftId === undefined) { close(); return; }
    const afterRaw = () => guard.confirmDiscard!(draftId, close);
    if (current?.profile.source_file !== undefined) guard.confirmDiscard(`agent-raw:${current.profile.source_file}`, afterRaw);
    else afterRaw();
  };
  const toggleEnabled = async (profile: NamedAgentProfile, enabled: boolean) => {
    setToggleSaving(true);
    try {
      const echoed = await client.patchConfig(disabledProfilePatch(configQuery.data ?? {}, profile, enabled));
      queryClient.setQueryData(['config'], echoed);
      await invalidateAgentProfileCatalogs(queryClient);
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
  const workspaceOptions = useMemo(() => (workspacesQuery.data?.items ?? []).map((workspace) => ({
    value: workspace.id, label: workspace.name ?? workspace.root, hint: workspace.root, title: workspace.root,
  })), [workspacesQuery.data]);
  const editing = sheet?.kind === 'edit' ? rows.find((row) => row.key === sheet.key) : undefined;
  const removed = shippedEntries.filter((entry) => entry.managed && entry.status === 'removed'
    && (filter === 'all' || (filter === 'main') === entry.main));

  const workspacePicker = workspaceOptions.length > 0 ? <SearchableSelect id="agents-workspace-select" options={workspaceOptions}
    value={selectedWorkspaceId ?? ''} ariaLabel={t('new.workspace')} buttonClassName={SETTINGS_SELECT_TRIGGER}
    triggerLabel={<span className="text-ink-soft">{t('st.profiles.resolveIn')} <span className="text-ink">{workspaceOptions.find((option) => option.value === selectedWorkspaceId)?.label}</span></span>}
    onChange={(next) => { if (next !== selectedWorkspaceId) { setWorkspaceId(next); setSheet(null); } }} /> : null;

  return <SectionCard id="st-card-main-agents" title={t('st.agentManager.title')}>
    <div className="space-y-4">
      <Hint>{t('st.profiles.teamIntro')}</Hint>
      <TeamView rows={rows} models={models} filter={filter} onFilter={setFilter} savingKey={quickSaving}
        toolbar={<>
          <SaveStatus saving={quickSaving !== undefined} saved={quickSaved} />
          {workspacePicker}
        </>}
        onOpen={(row) => setSheet({ kind: 'edit', key: row.key })} onNew={() => setSheet({ kind: 'new' })}
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
      <FeedbackLine feedback={feedback} />
    </div>
    {sheet !== null ? <Dialog onClose={closeSheet} overlayId="agent-profile-sheet"
      ariaLabel={editing !== undefined ? t('st.namedAgents.editProfileTitle', { name: editing.profile.name }) : t('st.agentManager.new')}
      // z-40: the app-level discard confirmation (z-50) must stack above the sheet.
      overlayClassName="fixed inset-0 z-40 flex items-stretch justify-center bg-shell/25 p-0 sm:p-4"
      panelClassName="anim-enter flex w-full max-w-[1280px] flex-col overflow-y-auto overscroll-contain bg-canvas p-4 shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)] sm:rounded-2xl sm:border sm:border-hairline sm:p-6">
      {sheet.kind === 'new' ? <NewProfile workspaceId={selectedWorkspaceId} profiles={profiles} shipped={shippedEntries}
        initialSource={sheet.source} onCancel={closeSheet}
        onCreated={(created) => { refresh(); setSheet({ kind: 'edit', key: profileKey(created) }); setFeedback({ tone: 'success', text: t('st.agentManager.created') }); }} />
        : editing !== undefined ? <ProfileEditor key={editing.key} profile={editing.profile} writable={editing.writable} profiles={profiles}
          models={models} diagnostics={editing.diagnostics} shippedEntry={shippedEntryForProfile(editing.profile, shippedEntries)}
          onSaved={refresh} onClose={closeSheet}
          onOpenWinner={(() => {
            const winner = effective?.find((candidate) => candidate.name === editing.profile.name && !sameProfile(candidate, editing.profile));
            const target = winner === undefined ? undefined : rows.find((row) => sameProfile(row.profile, winner));
            return target === undefined ? undefined : () => setSheet({ kind: 'edit', key: target.key });
          })()}
          onToggleEnabled={(enabled) => toggleEnabled(editing.profile, enabled)} toggleSaving={toggleSaving || configQuery.isLoading}
          newSessionBlocked={namedAgentNewSessionBlocked(editing.profile, relations.get(editing.profile))
            || (effective !== undefined && !effective.some((winner) => sameProfile(winner, editing.profile)))}
          onNewSession={() => navigate(namedAgentSessionHref(editing.profile, selectedWorkspaceId))}
          onDuplicate={() => setSheet({ kind: 'new', source: editing.profile.name })} />
          : <Hint>{t('st.agentManager.select')}</Hint>}
    </Dialog> : null}
  </SectionCard>;
}
