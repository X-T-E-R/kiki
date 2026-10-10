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
import { useAskKiki, useAskKikiWorkspace, AskKikiButton } from '../askKiki';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { Dialog } from '../Dialog';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { useDirtyGuard, useGuardedNavigate } from '../dirtyGuard';
import { SearchableSelect } from '../SearchableSelect';
import { ShippedProfileControls } from './ShippedProfileControls';
import { SectionCard } from './SectionCard';
import { AdvancedDetails } from './fields';
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
  const [namedDisabled, setNamedDisabled] = useState<string | null>(null);
  const [quickSaving, setQuickSaving] = useState<string>();
  const [quickSaved, pingQuickSaved] = useSavedTick();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const { ask: askKiki, busy: askingKiki } = useAskKiki();
  // Only consulted when this page has no workspace of its own to address.
  const kikiFallbackWorkspace = useAskKikiWorkspace();
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
  const workspaceOptions = useMemo(() => (workspacesQuery.data?.items ?? []).map((workspace) => ({
    value: workspace.id, label: workspace.name ?? workspace.root, hint: workspace.root, title: workspace.root,
  })), [workspacesQuery.data]);
  const editing = sheet?.kind === 'edit' ? rows.find((row) => row.key === sheet.key) : undefined;
  // Names disabled server-wide that no visible row exposes, so the by-name entry
  // can re-enable a profile the workspace filter does not show.
  const disabledNames = useMemo(
    () => (configQuery.data?.disabled_named_profiles ?? []).filter((name) =>
      !profiles.some((profile) => profile.name === name)),
    [configQuery.data, profiles],
  );
  const removed = shippedEntries.filter((entry) => entry.managed && entry.status === 'removed'
    && (filter === 'all' || (filter === 'main') === entry.main));

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
      {/* The handoff is disabled while this is unresolved; say why rather than
          leaving a dead button. */}
      {!askKikiReady && workspacesQuery.isError ? <InlineError error={workspacesQuery.error} /> : null}
      <AdvancedDetails summary={t('st.agentManager.disabledByName')}>
        <p className="max-w-[72ch] text-[11.5px] leading-5 text-ink-faint">{t('st.agentManager.disabledByNameHint')}</p>
        <p className="font-mono text-[11px] leading-5 text-ink-soft">
          {t('st.agentIdentity.disabledProfiles')} ={' '}
          {(configQuery.data?.disabled_named_profiles ?? []).join(', ') || '—'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
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
    </div>
    {sheet !== null ? <Dialog onClose={closeSheet} overlayId="agent-profile-sheet"
      ariaLabel={editing !== undefined ? t('st.namedAgents.editProfileTitle', { name: editing.profile.name }) : t('st.agentManager.new')}
      // z-40: the app-level discard confirmation (z-50) must stack above the sheet.
      overlayClassName="fixed inset-0 z-40 flex items-stretch justify-center bg-shell/25 p-0 sm:p-4"
      panelClassName="anim-enter flex w-full max-w-[1280px] flex-col overflow-y-auto overscroll-contain bg-canvas p-4 shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)] sm:rounded-2xl sm:border sm:border-hairline sm:p-6">
      {sheet.kind === 'new' ? <NewProfile workspaceId={selectedWorkspaceId} workspaceOptions={workspaceOptions} profiles={profiles} shipped={shippedEntries}
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
