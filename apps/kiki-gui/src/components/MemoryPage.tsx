/**
 * /memory — the one place memory is managed (`/api/memory/*`).
 *
 * Memory is on by default, and the nav entry is permanent either way: switched
 * off, this page is the turn-on guide (what it does, where the files live, one
 * switch); switched on, it is the entry console.
 *
 * Scope is the page's spine and stays three-way: Global, one Workspace, or one
 * Persona. Workspace and Persona pickers are searchable selects (a workspace
 * list can run to hundreds); picking one clears the other, and the choice
 * rides `?workspace=` / `?persona=` so deep links keep working. A workspace
 * scope also carries its own switch — follow global / on / off. A persona
 * scope surfaces the persona's own namespaces (its Bot home included) plus the
 * shared memory its policy reads.
 *
 * List → detail: search and a type filter narrow the list; the detail pane
 * shows the reading view with edit behind a toggle, plus pin, delete, and the
 * journal-backed history. History rows stay one line each; a row opens the
 * change in a panel with the full before/after and per-operation Undo. Deletes
 * are undoable, so the confirmation says exactly that instead of claiming
 * anything is permanent. Every write carries `expected_revision`; 40944
 * surfaces as "reload before saving" and never silently overwrites.
 *
 * The Inbox tab exists only while `approval` is `review` — with the default
 * `auto` there is nothing pending, so there is no tab.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemorySources, type MemorySource } from './useMemorySources';
import { MemorySharingControls } from './MemorySharingControls';
import { useSearchParams, type To } from 'react-router-dom';

import type { Workspace } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { Icon } from './icons';
import { BasisLine, historyLabel, MemoryHistoryDialog, MemoryReadView, TypeTag, ValidityLine } from './MemoryHistory';
import { memoryApplicability, parseMemoryEntry } from './memory/memoryReceipt';
import { continueMemory } from './memory/continueMemory';
import {
  ApiError,
  MEMORY_NOT_FOUND,
  MEMORY_REVISION_CONFLICT,
  MEMORY_TYPES,
  type MemoryEntry,
  type MemoryJournalRecord,
  type MemorySettings,
  type MemoryTarget,
  type MemoryType,
} from '../lib/client';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { PageHeader } from './PageChrome';
import { RelativeTime } from './RelativeTime';
import { Toggle } from './controls';
import { useDirtyGuard, useDirtyReporter } from './dirtyGuard';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { SearchableSelect } from './SearchableSelect';
import { segmentClass } from './WorkspaceScopeControl';
import { memoryTargetKey, personaMemoryTarget } from './persona/PersonaMemoryScope';
import { usePersonaList } from './persona/usePersonas';

export const MEMORY_SETTINGS_QUERY_KEY = ['memory-settings'] as const;
/** One dirty seat for the memory editor; the guard keys everything by it. */
const MEMORY_EDITOR_DIRTY_ID = 'memory-editor';
/** Every workspace's computed effective state, whichever one the card shows. */
const MEMORY_WORKSPACE_SETTINGS_KEY = ['memory-workspace-settings'] as const;

export interface MemoryPageProps {
  readonly workspaceOptions: readonly Workspace[];
  readonly workspacesLoading?: boolean;
  readonly onNavigate: (target: To) => void;
  readonly onToggleSidebar: () => void;
}

type MemoryTab = 'entries' | 'inbox';

/** Where a scope's files live, shown verbatim in the turn-on guide. */
function storagePath(target: MemoryTarget): string {
  if (target.scope === 'persona') return `$KIKI_HOME/memory/global/personas/${target.personaId ?? ''}/`;
  if (target.scope === 'persona_workspace') return `$KIKI_HOME/memory/workspaces/${target.workspaceId ?? ''}/personas/${target.personaId ?? ''}/`;
  return target.scope === 'global'
    ? '$KIKI_HOME/memory/global/'
    : `$KIKI_HOME/memory/workspaces/${target.workspaceId ?? ''}/`;
}

/** A picked persona narrows the scope to its own namespace in that range. */
function memoryTargetOf(scope: string | undefined, personaId?: string): MemoryTarget {
  if (personaId !== undefined) return personaMemoryTarget(personaId, scope);
  return scope === undefined ? { scope: 'global' } : { scope: 'workspace', workspaceId: scope };
}

const targetKey = memoryTargetKey;

/** Row-2 object pickers: the default bordered trigger pinned to the 28px row rhythm. */
const scopePickerClass = 'flex h-7 max-w-56 items-center gap-1.5 rounded-md border border-hairline bg-paper px-2 text-[13px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint';

function LeafGlyph({ className }: { readonly className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className={className}>
      <path d="M3.4 2.6h7.2l2 2v8.8a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z" />
      <path d="M5.2 6.3h4.6M5.2 8.9h3.2" />
    </svg>
  );
}

export function MemoryPage({ workspaceOptions, workspacesLoading, onNavigate, onToggleSidebar }: MemoryPageProps) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  // Observe App's directory query without starting a second request. Its error
  // and refetch remain available even though the route only passes isPending.
  const workspaceDirectory = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    enabled: false,
  });
  const [emptyKind, setEmptyKind] = useState<{ search: string; kind: 'workspace' | 'persona' }>();
  // Exactly one scope at a time: persona wins over workspace when a deep link
  // carries both. The kind buttons and object pickers are mutually exclusive —
  // choosing one clears the other's param, so the URL always names the visible scope.
  const [params, setParams] = useSearchParams();
  const personasQuery = usePersonaList();
  const personas = (personasQuery.data ?? []).filter((item) => !item.archived);
  const rawPersona = params.get('persona');
  const personaParam = rawPersona && rawPersona.trim() !== '' ? rawPersona : undefined;
  const persona = personas.find((item) => item.id === personaParam);
  // While personas are still loading, honour personaParam to prevent prematurely
  // falling back to another namespace. Once loaded, an unknown/empty/archived
  // persona recovers to workspace or global.
  const hasPersonaScope = personaParam !== undefined && (personasQuery.isPending || personasQuery.isError || persona !== undefined);
  const rawWorkspace = params.get('workspace');
  const normalizedWorkspaceParam = rawWorkspace && rawWorkspace.trim() !== '' ? rawWorkspace : undefined;
  const scope = normalizedWorkspaceParam !== undefined && (workspacesLoading || workspaceDirectory.isError || workspaceOptions.some((workspace) => workspace.id === normalizedWorkspaceParam))
    ? normalizedWorkspaceParam : undefined;
  const mode = hasPersonaScope ? 'persona' : scope !== undefined ? 'workspace'
    : emptyKind?.search === params.toString() ? emptyKind.kind : 'global';
  // Persona ranges may also be a Bot home outside the directory. The hook
  // validates that range, and waits rather than treating pending as absent.
  const effectiveScope = mode === 'persona' ? normalizedWorkspaceParam : scope;
  const patchParams = (workspaceId: string | undefined, personaId: string | undefined, kind?: 'workspace' | 'persona') => {
    const updated = new URLSearchParams(params);
    updated.delete('entry');
    updated.delete('tab');
    updated.delete('inactive');
    if (workspaceId === undefined) updated.delete('workspace');
    else updated.set('workspace', workspaceId);
    if (personaId === undefined) updated.delete('persona');
    else updated.set('persona', personaId);
    setEmptyKind(kind !== undefined && workspaceId === undefined && personaId === undefined ? { search: updated.toString(), kind } : undefined);
    setParams(updated);
  };
  const settingsQuery = useQuery({
    queryKey: MEMORY_SETTINGS_QUERY_KEY,
    queryFn: () => client.getMemorySettings(),
    staleTime: 15_000,
  });
  const settings = settingsQuery.data;
  const memorySources = useMemorySources({
    workspaceId: effectiveScope,
    workspaces: workspaceOptions,
    workspacesLoading,
    workspacesError: workspaceDirectory.error,
    persona,
    settings,
  });
  const resolvedPersonaScope = memorySources.effectiveWorkspaceId;
  const target = memoryTargetOf(resolvedPersonaScope, persona?.id);
  const missingObject = (mode === 'workspace' && scope === undefined) || (mode === 'persona' && persona === undefined);
  const objectLoading = mode === 'workspace' ? workspacesLoading : mode === 'persona' && personasQuery.isPending;
  const scopeError = (mode === 'persona' ? personasQuery.error : null)
    ?? (mode === 'workspace' && missingObject ? workspaceDirectory.error : null)
    ?? memorySources.error;
  // A Bot's home may live outside the workspace directory, so it joins the
  // memory-range options explicitly to keep that slice reachable.
  const botHomeId = memorySources.botWorkspaceId;
  const shardOptions = [
    { value: '', label: t('memory.shard.longterm') },
    ...workspaceOptions.map((workspace) => ({ value: workspace.id, label: workspace.name, hint: workspace.root, keywords: workspace.id })),
    ...(botHomeId !== undefined && !workspaceOptions.some((workspace) => workspace.id === botHomeId)
      ? [{ value: botHomeId, label: t('memory.source.botHome'), hint: memorySources.personaSnapshot?.definition.homeWorkspace ?? '', keywords: botHomeId }]
      : []),
  ];
  const globalEnabled = settings?.enabled === true;
  const workspaceOverride = scope === undefined ? null : settings?.workspaces[scope] ?? null;
  const scopeEnabled = scope === undefined ? globalEnabled : globalEnabled && workspaceOverride !== false;

  const applySettings = (next: MemorySettings) => {
    queryClient.setQueryData(MEMORY_SETTINGS_QUERY_KEY, next);
  };
  const globalToggle = useMutation({
    mutationFn: (enabled: boolean) => client.patchMemorySettings({ enabled }),
    // Every workspace's effective state is computed from this switch, including
    // the ones no card is showing. Re-reading only the settings key would leave
    // a cached `effective_enabled` contradicting the switch that was just turned.
    onSuccess: async (next) => {
      applySettings(next);
      await queryClient.invalidateQueries({ queryKey: MEMORY_WORKSPACE_SETTINGS_KEY });
    },
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: t('memory.toggleFailed', { detail: errorText(locale, error) }) });
    },
  });
  const workspaceToggle = useMutation({
    mutationFn: (enabled: boolean | null) => client.patchWorkspaceMemorySettings(scope!, enabled),
    // The settings page's workspace card holds this workspace's own computed
    // read, and this page is the other entry that writes that field. Only this
    // workspace moved, so only this workspace's read is re-read; the global
    // settings still are, because their `workspaces` map is what this page and
    // the header render from.
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: MEMORY_SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: [...MEMORY_WORKSPACE_SETTINGS_KEY, scope!] }),
      ]);
    },
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: t('memory.toggleFailed', { detail: errorText(locale, error) }) });
    },
  });

  return (
    <div data-memory-page className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('memory.title')} onToggleSidebar={onToggleSidebar} />
      <div data-memory-status className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[12px] text-ink-soft lg:px-6" role="status">
        <span>{settingsQuery.isPending ? t('memory.loading') : settingsQuery.isError
          ? t('st.memory.loadFailed', { detail: errorText(locale, settingsQuery.error) })
          : t(globalEnabled ? 'st.memory.enabled' : 'st.memory.disabled')}</span>
        {globalEnabled && scope !== undefined && workspaceOverride === false ? (
          <span data-memory-workspace-disabled className="font-medium text-amber-ink">{t('st.memory.workspaceDisabled')}</span>
        ) : null}
        <button type="button" data-memory-open-settings onClick={() => { onNavigate(`/settings/memory${scope === undefined ? '' : `?workspace=${encodeURIComponent(scope)}`}`); }} className="ml-auto font-medium text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink">
          {t('st.memory.settingsLink')}
        </button>
      </div>
      {!globalEnabled ? (
        <MemoryIntro
          loading={settingsQuery.isPending}
          busy={globalToggle.isPending}
          onEnable={() => { globalToggle.mutate(true); }}
        />
      ) : (
        <>
          {/* Row 1 names the three fixed kinds; the labels never change. Row 2
              picks the concrete object inside the active kind (workspace /
              persona + memory range). */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-2 lg:px-6">
            <div role="group" aria-label={t('memory.scope.aria')} data-memory-scope-kind={mode} className="flex min-w-0 items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
              <button
                type="button"
                data-memory-kind="global"
                aria-pressed={mode === 'global'}
                onClick={() => { patchParams(undefined, undefined); }}
                className={segmentClass(mode === 'global', 'h-7 shrink-0 px-3 text-[13px]')}
              >
                {t('memory.scope.global')}
              </button>
              <button
                type="button"
                data-memory-kind="workspace"
                aria-pressed={mode === 'workspace'}
                onClick={() => { if (mode !== 'workspace') patchParams(workspaceOptions.find((workspace) => workspace.id === scope)?.id ?? workspaceOptions[0]?.id, undefined, 'workspace'); }}
                className={`${segmentClass(mode === 'workspace', 'h-7 shrink-0 px-3 text-[13px]')} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {t('memory.scope.workspace')}
              </button>
              <button
                type="button"
                data-memory-kind="persona"
                aria-pressed={mode === 'persona'}
                onClick={() => { if (mode !== 'persona') patchParams(undefined, persona?.id ?? personas[0]?.id, 'persona'); }}
                className={segmentClass(mode === 'persona', 'h-7 shrink-0 px-3 text-[13px]')}
              >
                {t('memory.scope.persona')}
              </button>
            </div>
          </div>
          {mode !== 'global' ? (
            <div data-memory-scope-target={mode} className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-1 pt-1.5 lg:px-6">
              {mode === 'workspace' ? (
                <SearchableSelect
                  id="memory-workspace-picker"
                  ariaLabel={t('memory.workspace.aria')}
                  options={workspaceOptions.map((workspace) => ({ value: workspace.id, label: workspace.name, hint: workspace.root, keywords: workspace.id }))}
                  value={memorySources.effectiveWorkspaceId ?? ''}
                  disabled={workspaceOptions.length === 0}
                  triggerLabel={memorySources.rangeError !== null || (missingObject && workspaceDirectory.isError) ? t('memory.loadFailed') : memorySources.rangeLoading || (missingObject && workspacesLoading) ? t('memory.workspace.loading') : workspaceOptions.length === 0 ? t('memory.workspace.empty') : undefined}
                  onChange={(next) => { patchParams(next, undefined); }}
                  emptyText={t('memory.workspace.aria')}
                  searchPlaceholder={t('memory.workspace.search')}
                  density="compact"
                  buttonClassName={scopePickerClass}
                />
              ) : null}
              {mode === 'workspace' && memorySources.effectiveWorkspaceId !== undefined ? (
                <div className="flex min-w-0 items-center gap-2" data-memory-workspace-switch>
                  <span className="shrink-0 text-[12px] text-ink-faint">{t('memory.ws.label')}</span>
                  <div role="group" aria-label={t('memory.ws.label')} className="flex items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
                    {([[null, 'memory.ws.follow'], [true, 'memory.ws.on'], [false, 'memory.ws.off']] as const).map(([value, key]) => {
                      const active = workspaceOverride === value;
                      return (
                        <button
                          key={String(value)}
                          type="button"
                          data-memory-ws-option={String(value)}
                          aria-pressed={active}
                          disabled={workspaceToggle.isPending}
                          onClick={() => { if (!active) workspaceToggle.mutate(value); }}
                          className={`${segmentClass(active, 'h-7 px-3 text-[13px]')} disabled:cursor-not-allowed disabled:opacity-60`}
                        >
                          {t(key)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {mode === 'persona' ? (
                <>
                  <SearchableSelect
                    id="memory-persona-picker"
                    ariaLabel={t('memory.persona.aria')}
                    options={personas.map((item) => ({ value: item.id, label: item.name, description: item.title ?? item.job }))}
                    value={persona?.id ?? ''}
                    disabled={personas.length === 0}
                    triggerLabel={personasQuery.isPending ? t('memory.persona.loading') : personasQuery.isError ? t('memory.loadFailed') : personas.length === 0 ? t('memory.persona.empty') : undefined}
                    onChange={(next) => { patchParams(undefined, next); }}
                    emptyText={t('memory.persona.aria')}
                    searchPlaceholder={t('memory.persona.search')}
                    hideFilter={personas.length <= 8}
                    buttonClassName={scopePickerClass}
                  />
                  {persona !== undefined ? (
                    <div className="flex min-w-0 items-center gap-2" data-memory-shard>
                      <span className="shrink-0 text-[12px] text-ink-faint">{t('memory.shard.label')}</span>
                      <SearchableSelect
                        id="memory-shard-picker"
                        ariaLabel={t('memory.shard.label')}
                        options={shardOptions}
                        value={resolvedPersonaScope ?? ''}
                        triggerLabel={memorySources.rangeError !== null ? t('memory.loadFailed') : memorySources.rangeLoading ? t('memory.workspace.loading') : undefined}
                        onChange={(next) => { patchParams(next === '' ? undefined : next, personaParam); }}
                        searchPlaceholder={t('memory.workspace.search')}
                        density="compact"
                        buttonClassName={scopePickerClass}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          {persona !== undefined && memorySources.personaSnapshot !== undefined ? <MemorySharingControls key={persona.id} snapshot={memorySources.personaSnapshot} /> : null}
          {scopeError !== null ? (
            <div role="alert" className="px-4 py-6 text-[13px] text-danger lg:px-6">
              <p>{t('memory.loadFailed')}</p>
              <p className="mt-1">{errorText(locale, scopeError)}</p>
              <button type="button" data-memory-scope-retry disabled={((memorySources.rangeError !== null || (mode === 'workspace' && missingObject)) && workspaceDirectory.isFetching) || (mode === 'persona' && personasQuery.isError && personasQuery.isFetching)}
                onClick={() => {
                  if (mode === 'persona' && personasQuery.isError) void personasQuery.refetch();
                  if (memorySources.rangeError !== null || (mode === 'workspace' && missingObject)) void workspaceDirectory.refetch();
                  memorySources.retry();
                }} className="mt-2 underline">{t('common.retry')}</button>
            </div>
          ) : (missingObject && objectLoading) || memorySources.loading ? (
            <p data-memory-scope-loading role="status" className="px-4 py-8 text-[13px] text-ink-faint lg:px-6">{t(memorySources.rangeLoading || mode === 'workspace' ? 'memory.workspace.loading' : missingObject ? 'memory.persona.loading' : 'memory.loading')}</p>
          ) : missingObject ? (
            <p data-memory-scope-empty className="px-4 py-8 text-[13px] text-ink-faint lg:px-6">{t(mode === 'workspace' ? 'memory.workspace.empty' : 'memory.persona.empty')}</p>
          ) : (
            <MemoryScopeView
              key={targetKey(target)}
              target={target}
              sources={memorySources.sources}
              enabled={scopeEnabled}
              review={settings?.approval === 'review'}
              onOpenSession={(sessionId) => { onNavigate(`/s/${sessionId}`); }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Off state: what memory does, where it is kept, one switch. Deliberately
 * three lines — a page of prose here would be the wrong first impression for a
 * feature whose whole promise is that it stays quiet.
 */
function MemoryIntro({
  loading,
  busy,
  onEnable,
}: {
  readonly loading: boolean;
  readonly busy: boolean;
  readonly onEnable: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-10 lg:px-6" data-memory-intro>
      <div className="mx-auto max-w-[560px]">
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-panel text-ink-faint">
          <LeafGlyph className="h-5 w-5" />
        </span>
        <h2 className="mt-4 font-display text-[22px] leading-snug text-ink">{t('memory.off.title')}</h2>
        <p className="mt-2 max-w-[52ch] text-[13px] leading-relaxed text-ink-soft">{t('memory.off.body')}</p>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
          {t('memory.off.storage', { path: storagePath({ scope: 'global' }) })}
        </p>
        <div className="mt-5">
          <button
            type="button"
            data-memory-enable
            disabled={loading || busy}
            onClick={onEnable}
            className={PRIMARY_BUTTON}
          >
            {t('memory.toggle')}
          </button>
        </div>
      </div>
    </div>
  );
}

function MemoryScopeView({
  target,
  sources,
  enabled,
  review,
  onOpenSession,
}: {
  readonly target: MemoryTarget;
  readonly sources: readonly MemorySource[];
  readonly enabled: boolean;
  readonly review: boolean;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const { t, tp, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const linkedEntry = params.get('entry');
  const linkedTab = params.get('tab');
  const linkedInactive = params.get('inactive') === 'true';
  const namespace = targetKey(target);
  const [tab, setTab] = useState<MemoryTab>(review && linkedTab === 'inbox' ? 'inbox' : 'entries');
  useEffect(() => { if (!review) setTab('entries'); }, [review]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<MemoryType | 'all'>('all');
  const [showInactive, setShowInactive] = useState(linkedInactive);
  const [selectedId, setSelectedId] = useState<string | null>(linkedEntry === null ? null : `${namespace}:${linkedEntry}`);
  useEffect(() => {
    if (linkedEntry === null) return;
    setSelectedId(`${namespace}:${linkedEntry}`);
    setSearch('');
    setTypeFilter('all');
    setCreating(false);
    setShowInactive(linkedInactive);
    setTab(review && linkedTab === 'inbox' ? 'inbox' : 'entries');
  }, [linkedEntry, linkedInactive, linkedTab, review, namespace]);
  const [creating, setCreating] = useState(false);
  const guard = useDirtyGuard();

  /** Leave the open editor. An unsaved draft asks first, through the app-wide
   *  confirmation seat already used by the other editors on this page. */
  const leaveEditor = (go: () => void) => {
    if (guard === null) { go(); return; }
    guard.confirmDiscard?.(MEMORY_EDITOR_DIRTY_ID, go);
    if (guard.confirmDiscard === undefined) go();
  };

  const lists = useQueries({ queries: sources.map((source) => {
    const queryKey = ['memory', targetKey(source.target), { search, typeFilter, showInactive }];
    return {
      queryKey,
      queryFn: ({ signal }: { signal: AbortSignal }) => continueMemory(
        (cursor) => client.listMemory(source.target, cursor === undefined ? {
          mode: search.trim() === '' ? 'list' : 'search', query: search,
          type: typeFilter === 'all' ? undefined : typeFilter,
          include_inactive: showInactive, page_size: 20,
          statuses: showInactive ? ['active', 'superseded', 'archived'] : ['active'],
        } : { cursor }, signal),
        (page) => queryClient.setQueryData(queryKey, page), signal,
      ),
      staleTime: 5_000, retry: false,
    };
  }) });
  const listQuery = {
    isPending: lists.every((query) => query.data === undefined) && lists.some((query) => query.isPending),
    isError: lists.some((query) => query.isError),
    error: lists.find((query) => query.isError)?.error,
    data: lists.some((query) => query.data !== undefined) ? true : undefined,
    refetch: () => Promise.all(lists.map((query) => query.refetch())),
  };
  const inboxQuery = useQuery({
    queryKey: ['memory-inbox', targetKey(target)],
    queryFn: ({ signal }) => continueMemory(
      (cursor) => client.memoryInbox(target, cursor === undefined ? { page_size: 20 } : { cursor }, signal),
      (page) => queryClient.setQueryData(['memory-inbox', targetKey(target)], page), signal,
    ),
    enabled: review,
    staleTime: 5_000, retry: false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['memory'] });
    void queryClient.invalidateQueries({ queryKey: ['memory-journal'] });
    void queryClient.invalidateQueries({ queryKey: ['memory-related'] });
    void queryClient.invalidateQueries({ queryKey: ['memory-inbox'] });
  };
  const groups = sources.map((source, index) => ({
    ...source,
    entries: (lists[index]?.data?.items ?? []).filter((entry) => entry.status !== 'pending'),
  }));
  const entries = groups.flatMap((source) => source.entries.map((entry) => ({
    entry, source, key: `${targetKey(source.target)}:${entry.id}`,
  })));
  const inbox = inboxQuery.data?.items ?? [];
  const readingEntries = lists.some((query) => query.isFetching || query.data?.coverage?.exhausted === false);
  const readingInbox = inboxQuery.isFetching || inboxQuery.data?.coverage?.exhausted === false;
  const coverageWarnings = tab === 'inbox' ? inboxQuery.data?.coverage?.warnings ?? [] : lists.flatMap((query, index) => (query.data?.coverage?.warnings ?? []).map((warning) => `${sources[index]!.label}: ${warning}`));
  const coverageIncomplete = (tab === 'inbox' ? [inboxQuery.data] : lists.map((query) => query.data)).some((page) => page?.coverage?.complete === false);
  const readError = tab === 'inbox' ? inboxQuery.error : listQuery.error;
  // One reading of "now" for the whole list, so two rows cannot disagree about
  // whether the same check has run out.
  const now = Date.now();
  // Namespace is part of identity: copied/imported memories can share an id.
  const selected = entries.find((item) => item.key === selectedId);
  const selectedDetail = useQuery({
    queryKey: ['memory-detail', selected?.key, selected?.entry.revision],
    queryFn: () => client.getMemory(selected!.source.target, selected!.entry.id),
    enabled: selected?.entry.content_complete === false,
    gcTime: 0,
  });
  const selectedEntry = selected?.entry.content_complete === false ? selectedDetail.data : selected?.entry;
  useEffect(() => {
    if (!readingEntries && !listQuery.isError && !coverageIncomplete && selectedId !== null && selected === undefined) setSelectedId(null);
  }, [readingEntries, listQuery.isError, coverageIncomplete, selectedId, selected]);
  const filtersActive = search.trim() !== '' || typeFilter !== 'all' || showInactive;

  const detail = creating ? (
    <MemoryEditor
      target={target}
      entry={undefined}
      onDone={(entry) => {
        setCreating(false);
        if (entry !== undefined) setSelectedId(`${targetKey(target)}:${entry.id}`);
        refresh();
      }}
    />
  ) : selected !== undefined && selectedEntry !== undefined ? (
    <MemoryDetail
      key={selected.key}
      target={selected.source.target}
      sourceLabel={selected.source.label}
      entry={selectedEntry}
      now={now}
      onOpenSession={onOpenSession}
      onChanged={refresh}
      onClosed={() => { setSelectedId(null); }}
      onOpenCoveredBy={
        selected.entry.covered_by !== undefined &&
        entries.some((item) => item.key === `${targetKey(selected.source.target)}:${selected.entry.covered_by?.id}`)
          ? () => { setSelectedId(`${targetKey(selected.source.target)}:${selected.entry.covered_by?.id}`); }
          : undefined
      }
      onOpenReplacement={
        selected.entry.superseded_by !== undefined &&
        entries.some((item) => item.key === `${targetKey(selected.source.target)}:${selected.entry.superseded_by}`)
          ? () => { setSelectedId(`${targetKey(selected.source.target)}:${selected.entry.superseded_by}`); }
          : undefined
      }
    />
  ) : selected !== undefined ? (
    <div role="status" className="text-[13px] text-ink-soft">
      {selectedDetail.isError ? errorText(locale, selectedDetail.error) : t('memory.loading')}
      {selectedDetail.isError ? <button type="button" onClick={() => { void selectedDetail.refetch(); }} className={SECONDARY_BUTTON}>{t('common.retry')}</button> : null}
    </div>
  ) : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-8 lg:px-6" data-memory-console>
      <div className="mx-auto max-w-[1040px]">
        {!enabled ? (
          <p data-memory-scope-off role="status" className="mb-4 rounded-lg border border-hairline bg-panel px-3 py-2 text-[13px] leading-relaxed text-ink-soft">
            {t('memory.ws.offNotice')}
          </p>
        ) : null}

        {review ? (
          <div role="tablist" aria-label={t('memory.tab.aria')} className="mb-3 flex gap-1 border-b border-hairline">
            {(['entries', 'inbox'] as const).map((candidate) => {
              const active = candidate === tab;
              return (
                <button
                  key={candidate}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-memory-tab={candidate}
                  onClick={() => { setTab(candidate); }}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] transition-colors ${
                    active ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                  }`}
                >
                  {t(candidate === 'entries' ? 'memory.tab.entries' : 'memory.tab.inbox')}
                  {candidate === 'inbox' && inbox.length > 0 ? (
                    <span data-memory-inbox-count className="text-[12px] font-medium text-accent-ink tabular-nums">
                      {inbox.length}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {readError !== null && readError !== undefined || coverageIncomplete ? (
          <div data-memory-coverage role="status" className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] leading-relaxed text-danger">
            <p>{t(readError ? 'memory.loadFailed' : 'memory.readIncomplete')}</p>
            {readError ? <p>{errorText(locale, readError)}</p> : null}
            {coverageWarnings.map((warning) => <p key={warning}>{warning}</p>)}
            <button type="button" onClick={() => { void (tab === 'inbox' ? inboxQuery.refetch() : listQuery.refetch()); }} className="mt-1 underline">{t('common.retry')}</button>
          </div>
        ) : null}
        {(tab === 'inbox' ? readingInbox : readingEntries) && !readError ? (
          <p data-memory-continuing role="status" className="mb-3 text-[12px] text-ink-faint">{t('memory.readingMore')}</p>
        ) : null}
        {review && tab === 'inbox' ? (
          <MemoryInbox target={target} entries={inbox} loading={inboxQuery.isPending && inbox.length === 0 || readingInbox && inbox.length === 0 && !readError} incomplete={coverageIncomplete || Boolean(readError)} linkedEntry={linkedEntry} onChanged={refresh} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <input
                type="search"
                data-memory-search
                value={search}
                onChange={(event) => { setSearch(event.target.value); }}
                placeholder={t('memory.search.placeholder')}
                aria-label={t('memory.search.aria')}
                className="h-8 w-full max-w-56 rounded-md bg-ink/[0.04] px-3 text-[13px] text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-selected-ink"
              />
              <div role="group" aria-label={t('memory.filter.aria')} className="flex flex-wrap items-center gap-1">
                {(['all', ...MEMORY_TYPES] as const).map((candidate) => {
                  const active = candidate === typeFilter;
                  return (
                    <button
                      key={candidate}
                      type="button"
                      data-memory-type-filter={candidate}
                      aria-pressed={active}
                      onClick={() => { setTypeFilter(candidate as MemoryType | 'all'); }}
                      className={`h-8 rounded-md px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-selected-ink ${active ? 'bg-ink/[0.06] font-medium text-ink' : 'text-ink-soft hover:text-ink'}`}
                    >
                      {t(`memory.type.${candidate}`)}
                    </button>
                  );
                })}
              </div>
              <span data-memory-show-inactive><Toggle label={t('memory.showInactive')} checked={showInactive} onChange={setShowInactive} /></span>
              <span className="ml-auto flex items-center gap-3">
                {listQuery.data !== undefined ? (
                  <span data-memory-count className="text-[12px] text-ink-faint tabular-nums">
                    {tp('memory.count', entries.length)}
                  </span>
                ) : null}
                <button
                  type="button"
                  data-memory-new
                  onClick={() => { leaveEditor(() => { setSelectedId(null); setCreating(true); }); }}
                  className={SECONDARY_BUTTON}
                >
                  {t('memory.new')}
                </button>
              </span>
            </div>

            {listQuery.isPending || readingEntries && entries.length === 0 && !listQuery.isError ? (
              <p role="status" className="flex items-center gap-2 py-8 text-[13px] text-ink-faint">
                <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
                {t('memory.loading')}
              </p>
            ) : entries.length === 0 && (listQuery.isError || coverageIncomplete) ? null : entries.length === 0 && !creating ? (
              <div data-memory-empty className="py-10">
                {filtersActive ? (
                  <>
                    <p className="text-[13px] text-ink-soft">{t('memory.empty.filtered')}</p>
                    <button
                      type="button"
                      onClick={() => { setSearch(''); setTypeFilter('all'); setShowInactive(false); }}
                      className="mt-1 text-[13px] font-medium text-ink underline underline-offset-2"
                    >
                      {t('memory.empty.clear')}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="font-display text-[18px] text-ink">{t('memory.empty.title')}</p>
                    <p className="mt-1 max-w-[46ch] text-[13px] leading-relaxed text-ink-soft">{t('memory.empty.body')}</p>
                  </>
                )}
              </div>
            ) : (
              <div className={`grid min-w-0 gap-8 ${detail !== null ? 'md:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.5fr)]' : 'max-w-[720px]'}`} data-memory-list-detail>
                <div data-memory-list className={`min-w-0 space-y-7 ${detail !== null ? 'max-md:hidden' : ''}`}>
                  {groups.filter((group) => group.entries.length > 0).map((group) => (
                    <section key={targetKey(group.target)} data-memory-source={targetKey(group.target)} aria-label={group.label}>
                      <h2 className="mb-2 flex items-center gap-2 text-[12px] font-medium text-ink-soft">
                        {group.label}<span className="font-mono text-[11px] font-normal text-ink-faint">{group.entries.length}</span>
                      </h2>
                      <ul className="-mx-3 space-y-1">
                        {group.entries.map((entry) => {
                          const key = `${targetKey(group.target)}:${entry.id}`;
                          return (
                            <li key={key}>
                              <MemoryListRow entry={entry} active={key === selectedId} now={now} onOpen={() => { leaveEditor(() => { setCreating(false); setSelectedId(key); }); }} />
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
                <div className={`min-w-0 ${detail === null ? 'hidden' : ''}`}>
                  {selected !== undefined || creating ? (
                    <button
                      type="button"
                      data-memory-detail-back
                      onClick={() => { leaveEditor(() => { setSelectedId(null); setCreating(false); }); }}
                      className="mb-4 text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                    >
                      {t('memory.back')}
                    </button>
                  ) : null}
                  {detail}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One entry in the list: what it is, and the two states that want a reader's
 * attention before they rely on it. The basis stays in the detail view, so a
 * row is not a claim about who authorized the content.
 */
function MemoryListRow({
  entry,
  active,
  now,
  onOpen,
}: {
  readonly entry: MemoryEntry;
  readonly active: boolean;
  /** Shared across the list so every row reads "now" the same way. */
  readonly now: number;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const inactive = entry.status === 'archived' || entry.status === 'superseded';
  const applicability = memoryApplicability(entry.validity, now);
  return (
    <button
      type="button"
      data-memory-row={entry.id}
      data-memory-validity={applicability}
      aria-current={active ? 'true' : undefined}
      onClick={onOpen}
      className={`flex w-full min-w-0 flex-col gap-1.5 rounded-lg px-3 py-3 text-left transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-selected-ink ${
        active ? 'bg-ink/[0.05]' : 'hover:bg-ink/[0.03]'
      }`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {entry.pinned ? <span role="img" aria-label={t('memory.pinned')} className="flex shrink-0 text-ink-faint"><Icon name="pin" size={12} /></span> : null}
        <span className={`min-w-0 truncate text-[13px] ${active ? 'font-medium text-ink' : inactive ? 'text-ink-soft' : 'text-ink'}`}>{entry.title}</span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ink-faint">
        <TypeTag type={entry.type} />
        <span className="shrink-0">{t(`memory.writer.${entry.source.writer}`)}</span>
        <span className="shrink-0">· <RelativeTime at={entry.updated} /></span>
        {inactive ? (
          <span className="shrink-0">· {t(entry.status === 'archived' ? 'memory.status.archived' : 'memory.status.superseded')}</span>
        ) : null}
        {/* `unrecorded` says nothing on a row: a missing check is not a defect
            the reader has to triage, so only the two actionable states show. */}
        {applicability === 'recheck' || applicability === 'expired' ? (
          <span data-memory-row-validity={applicability}
            className={`shrink-0 rounded-sm px-1.5 py-px text-[11px] font-medium ${applicability === 'expired' ? 'bg-amber-card text-amber-ink' : 'bg-ink/[0.05] text-ink-soft'}`}>
            {t(applicability === 'expired' ? 'memory.validity.expiredShort' : 'memory.validity.recheckShort')}
          </span>
        ) : null}
        {entry.covered_by !== undefined && inactive ? (
          <span data-memory-row-covered className="shrink-0">· {t('memory.coveredBy.short')}</span>
        ) : null}
      </span>
    </button>
  );
}

const FIELD_LABEL = 'text-[12px] font-medium text-ink-soft';

/**
 * Read / edit one entry. The body is a plain textarea on purpose: entries are
 * capped at 1,500 characters by the store, and a code editor would promise a
 * document where the contract wants a sentence or two.
 */
function MemoryDetail({
  target,
  entry,
  sourceLabel,
  onOpenSession,
  onChanged,
  onClosed,
  onOpenReplacement,
  onOpenCoveredBy,
  now,
}: {
  readonly target: MemoryTarget;
  readonly entry: MemoryEntry;
  readonly sourceLabel: string;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onChanged: () => void;
  readonly onClosed: () => void;
  readonly onOpenReplacement?: () => void;
  readonly onOpenCoveredBy?: () => void;
  readonly now: number;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  const journalQuery = useQuery({
    queryKey: ['memory-journal', targetKey(target), entry.id],
    queryFn: () => client.memoryJournal(target, entry.id),
    staleTime: 5_000,
  });

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.code === MEMORY_REVISION_CONFLICT) {
      pushToast({ tone: 'error', text: t('memory.conflict'), retry: { run: onChanged } });
      return;
    }
    if (error instanceof ApiError && error.code === MEMORY_NOT_FOUND) {
      pushToast({ tone: 'error', text: t('memory.notFound') });
      onChanged();
      onClosed();
      return;
    }
    pushToast({ tone: 'error', text: t('memory.actionFailed', { detail: errorText(locale, error) }) });
  };

  const pinMutation = useMutation({
    mutationFn: () => client.putMemory(target, entry.id, {
      action: 'update',
      type: entry.type,
      title: entry.title,
      body: entry.body,
      reason: t('memory.defaultReason.edit'),
      expected_revision: entry.revision,
      pinned: !entry.pinned,
      // Pinning changes nothing about the content, so the recorded basis and
      // check ride along unchanged rather than being dropped by this save.
      basis: entry.basis,
      validity: entry.validity,
    }),
    onSuccess: () => { onChanged(); },
    onError: fail,
  });
  const deleteMutation = useMutation({
    mutationFn: () => client.deleteMemory(target, entry.id, entry.revision),
    onSuccess: (result) => {
      setConfirmDelete(false);
      const title = entry.title;
      pushToast({
        tone: 'success',
        text: t('memory.deleted', { title }),
        retry: {
          label: t('memory.undo'),
          run: () => {
            void client.undoMemory(target, result.operation_id)
              .then(() => {
                pushToast({ tone: 'success', text: t('memory.undone') });
                onChanged();
              })
              .catch(fail);
          },
        },
      });
      onChanged();
      onClosed();
    },
    onError: (error: unknown) => { setConfirmDelete(false); fail(error); },
  });
  const undoMutation = useMutation({
    mutationFn: (operationId: string) => client.undoMemory(target, operationId),
    onSuccess: () => {
      pushToast({ tone: 'success', text: t('memory.undone') });
      onChanged();
    },
    onError: fail,
  });

  const history = journalQuery.data ?? [];
  const inactive = entry.status === 'archived' || entry.status === 'superseded';
  const [editing, setEditing] = useState(false);

  return (
    <div data-memory-detail={entry.id} className="min-w-0 space-y-4">
      {editing && !inactive ? <MemoryEditor target={target} entry={entry} onDone={() => { setEditing(false); onChanged(); }} />
        : <MemoryReadView entry={entry} target={target} sourceLabel={sourceLabel} onOpenReplacement={onOpenReplacement} onOpenCoveredBy={onOpenCoveredBy} now={now} />}

      <div className="flex flex-wrap items-center gap-3">
        {!inactive ? <>
          <button type="button" data-memory-edit onClick={() => { setEditing(!editing); }} className="text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink">
            {t(editing ? 'common.close' : 'memory.edit')}
          </button>
          <button type="button" data-memory-pin disabled={pinMutation.isPending} onClick={() => { pinMutation.mutate(); }} className="text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink disabled:opacity-60">
            {t(entry.pinned ? 'memory.unpin' : 'memory.pin')}
          </button>
        </> : null}
        <button type="button" data-memory-delete disabled={deleteMutation.isPending} onClick={() => { setConfirmDelete(true); }} className={DANGER_GHOST_BUTTON}>
          {t('memory.delete')}
        </button>
        {entry.source.session !== undefined ? (
          <button type="button" data-memory-source-session title={t('memory.openSource')} onClick={() => { onOpenSession(entry.source.session!); }}
            className="text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink">
            {t('memory.openSource')}
          </button>
        ) : null}
      </div>

      <section data-memory-history aria-labelledby={`memory-history-${entry.id}`}>
        <h3 id={`memory-history-${entry.id}`} className={FIELD_LABEL}>{t('memory.history')}</h3>
        {journalQuery.isPending ? <p role="status" className="mt-1.5 text-[12px] text-ink-faint">{t('memory.loading')}</p>
          : journalQuery.isError ? <div role="alert" className="mt-1.5 text-[12px] text-danger">
            <p>{t('memory.loadFailed')}</p>
            <button type="button" onClick={() => { void journalQuery.refetch(); }} className="mt-1 underline">{t('common.retry')}</button>
          </div>
          : history.length === 0 ? <p className="mt-1.5 text-[12px] text-ink-faint">{t('memory.history.empty')}</p>
          : <ul className="mt-1.5 space-y-px">
            {[...history].reverse().map((record) => (
              <li key={`${record.operationId}:${record.at}`} className="flex min-w-0 items-center gap-2 py-1 text-[12px] text-ink-faint">
                <button
                  type="button"
                  data-memory-history-record={record.operationId}
                  title={t('memory.history.view')}
                  onClick={() => { setOpenHistory(record.operationId); }}
                  className="min-w-0 flex-1 truncate rounded-sm text-left hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  {historyLabel(record.action, t)}
                  {' · '}
                  {t(`memory.writer.${record.writer}`)}
                  {' · '}
                  <RelativeTime at={record.at} />
                </button>
                <UndoButton
                  record={record}
                  busy={undoMutation.isPending}
                  onUndo={() => { undoMutation.mutate(record.operationId); }}
                />
              </li>
            ))}
          </ul>}
        {openHistory !== null ? (
          <MemoryHistoryDialog
            recordId={openHistory}
            onNavigate={setOpenHistory}
            onClose={() => { setOpenHistory(null); }}
            history={history}
            current={entry}
            target={target}
            sourceLabel={sourceLabel}
            onUndo={(record) => { undoMutation.mutate(record.operationId); }}
            undoBusy={undoMutation.isPending}
          />
        ) : null}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title={t('memory.delete')}
        body={entry.title}
        consequences={[t('memory.deleteUndoable')]}
        confirmLabel={t('memory.delete')}
        tone="danger"
        busy={deleteMutation.isPending}
        overlayId="memory-delete-confirm"
        onCancel={() => { setConfirmDelete(false); }}
        onConfirm={() => { deleteMutation.mutate(); }}
      />
    </div>
  );
}

function UndoButton({
  record,
  busy,
  onUndo,
}: {
  readonly record: MemoryJournalRecord;
  readonly busy: boolean;
  readonly onUndo: () => void;
}) {
  const { t } = useI18n();
  if (record.action === 'undo') return null;
  return (
    <button
      type="button"
      data-memory-undo={record.operationId}
      disabled={busy}
      onClick={onUndo}
      className="shrink-0 text-[12px] text-ink-soft underline underline-offset-2 transition-colors hover:text-ink disabled:opacity-60"
    >
      {t('memory.undo')}
    </button>
  );
}

/**
 * The write surface for both new and existing entries. Existing entries always
 * send `expected_revision`, so a concurrent edit fails loudly (40944) instead
 * of overwriting; the error line says to reload.
 *
 * The form is seeded once, from the entry the reader opened. A newer revision
 * arriving while they are typing is a real fact, but re-seeding on it would
 * throw the draft away and silently move `expected_revision` to a version the
 * reader never saw — so the seed stays put, and the save is what discovers the
 * conflict.
 */
function MemoryEditor({
  target,
  entry,
  onDone,
}: {
  readonly target: MemoryTarget;
  readonly entry: MemoryEntry | undefined;
  readonly onDone: (entry?: MemoryEntry) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  // The fact the draft started from, including the revision a save must be
  // measured against. Read once, and never advanced by a background read.
  // The editor explicitly resends the seed's recorded basis and validity.
  // Omitting basis on a substantive content change would downgrade attribution;
  // omitting validity alone preserves the stored check.
  const [seed] = useState(() => ({
    id: entry?.id,
    revision: entry?.revision,
    title: entry?.title ?? '',
    body: entry?.body ?? '',
    type: entry?.type ?? ('project' as MemoryType),
    basis: entry?.basis,
    validity: entry?.validity,
  }));
  const [title, setTitle] = useState(seed.title);
  const [body, setBody] = useState(seed.body);
  const [type, setType] = useState<MemoryType>(seed.type);
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false);

  // `reason` rides the same save, so it is part of the same draft: a reader who
  // typed only a reason has an unsaved change worth keeping.
  const dirty = title !== seed.title || body !== seed.body || type !== seed.type || reason.trim() !== '';
  // The whole editor is one dirty seat in the app-wide guard, so leaving the
  // page, switching entries or going back asks before it unmounts.
  useDirtyReporter(MEMORY_EDITOR_DIRTY_ID, dirty);
  const valid = title.trim() !== '' && body.trim() !== '' && title.length <= 200 && body.length <= 1_500;

  const save = useMutation({
    mutationFn: () => client.putMemory(target, seed.id ?? 'new', {
      action: seed.id === undefined ? 'create' : 'update',
      type,
      title: title.trim(),
      body: body.trim(),
      reason: reason.trim() === ''
        ? t(seed.id === undefined ? 'memory.defaultReason.create' : 'memory.defaultReason.edit')
        : reason.trim(),
      expected_revision: seed.revision,
      basis: seed.basis,
      validity: seed.validity,
    }),
    onSuccess: (result) => {
      setConflict(false);
      setReason('');
      // A save whose content already matched is not a new version; saying
      // "Saved" would imply a change that did not happen.
      if (result.outcome === 'unchanged') pushToast({ tone: 'success', text: t('memory.savedUnchanged') });
      else pushToast({ tone: 'success', text: t('memory.saved') });
      onDone(result.entry);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.code === MEMORY_REVISION_CONFLICT) {
        setConflict(true);
        return;
      }
      pushToast({ tone: 'error', text: t('memory.actionFailed', { detail: errorText(locale, error) }) });
    },
  });

  const fieldId = `memory-${seed.id ?? 'new'}`;
  return (
    <div data-memory-editor={seed.id ?? 'new'} className="min-w-0 space-y-3">
      <div className="space-y-1.5">
        <label htmlFor={`${fieldId}-title`} className={FIELD_LABEL}>{t('memory.field.title')}</label>
        <input
          id={`${fieldId}-title`}
          type="text"
          data-memory-title
          value={title}
          maxLength={200}
          onChange={(event) => { setTitle(event.target.value); }}
          className={INPUT}
        />
      </div>
      <div className="space-y-1.5">
        <span className={FIELD_LABEL}>{t('memory.field.type')}</span>
        <div role="group" aria-label={t('memory.field.type')} className="flex flex-wrap items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
          {MEMORY_TYPES.map((candidate) => {
            const active = candidate === type;
            return (
              <button
                key={candidate}
                type="button"
                data-memory-type-option={candidate}
                aria-pressed={active}
                onClick={() => { setType(candidate); }}
                className={segmentClass(active, 'h-7 px-3 text-[13px]')}
              >
                {t(`memory.type.${candidate}`)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${fieldId}-body`} className={FIELD_LABEL}>{t('memory.field.body')}</label>
        <textarea
          id={`${fieldId}-body`}
          data-memory-body
          value={body}
          rows={6}
          maxLength={1_500}
          onChange={(event) => { setBody(event.target.value); }}
          className={`${INPUT} resize-y font-mono leading-relaxed`}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${fieldId}-reason`} className={FIELD_LABEL}>{t('memory.field.reason')}</label>
        <input
          id={`${fieldId}-reason`}
          type="text"
          data-memory-reason
          value={reason}
          placeholder={t('memory.field.reasonPlaceholder')}
          onChange={(event) => { setReason(event.target.value); }}
          className={INPUT}
        />
      </div>
      {conflict ? (
        <p role="alert" data-memory-conflict className="rounded-md border border-amber-rule/40 bg-amber-card px-3 py-2 text-[12px] leading-relaxed text-amber-ink">
          {t('memory.conflict')}
          {' '}
          <button type="button" onClick={() => { onDone(); }} className="font-semibold underline underline-offset-2">
            {t('memory.reload')}
          </button>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-memory-save
          disabled={!dirty || !valid || save.isPending}
          onClick={() => { save.mutate(); }}
          className={PRIMARY_BUTTON}
        >
          {t(seed.id === undefined ? 'memory.create' : 'memory.save')}
        </button>
        <button
          type="button"
          data-memory-discard
          disabled={!dirty || save.isPending}
          onClick={() => {
            // The reader chose the stored text, so the form is clean again and
            // asking them a second time would be noise.
            setTitle(seed.title);
            setBody(seed.body);
            setType(seed.type);
            setReason('');
            setConflict(false);
            if (seed.id === undefined) onDone();
          }}
          className={SECONDARY_BUTTON}
        >
          {t('memory.discard')}
        </button>
      </div>
    </div>
  );
}

/**
 * Inbox — only reachable while `approval` is `review`.
 *
 * A pending entry is a *proposal*: it names the entry it supersedes and, in
 * `pending_action`, what accepting it would do to that entry. Accepting is one
 * `update` on the candidate; the store performs the proposed action on the
 * original entry, so an accepted `update` keeps the original entry's id and an
 * accepted `archive` archives that entry. Discarding deletes only the
 * candidate, so the entry it proposed to change is left exactly as it was.
 *
 * Both are journal-backed, so both are undoable from the entry's history.
 */
function MemoryInbox({
  target,
  entries,
  loading,
  incomplete,
  linkedEntry,
  onChanged,
}: {
  readonly target: MemoryTarget;
  readonly entries: readonly MemoryEntry[];
  readonly loading: boolean;
  readonly incomplete: boolean;
  readonly linkedEntry: string | null;
  readonly onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const locatedRef = useRef<HTMLLIElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = useQuery({
    queryKey: ['memory-inbox-detail', targetKey(target), expandedId],
    queryFn: () => client.getMemory(target, expandedId!),
    enabled: expandedId !== null, gcTime: 0,
  });
  const locatedId = entries.find((entry) => entry.id === linkedEntry)?.id;
  const namespace = targetKey(target);
  useEffect(() => {
    if (loading || locatedId === undefined) return;
    locatedRef.current?.scrollIntoView?.({ block: 'nearest' });
    locatedRef.current?.focus({ preventScroll: true });
  }, [loading, linkedEntry, locatedId, namespace]);
  const fail = (error: unknown) => {
    pushToast({ tone: 'error', text: t('memory.actionFailed', { detail: errorText(locale, error) }) });
  };
  const keep = useMutation({
    // Accepting is an update *of the candidate*; which action that performs on
    // the entry it supersedes is the candidate's own `pending_action`, decided
    // by the store, so this page does not restate or guess it. The proposal's
    // basis and check are what the reviewer just decided on, so they ride the
    // acceptance instead of being dropped at the last step.
    mutationFn: async (entry: MemoryEntry) => {
      const full = entry.content_complete === false ? await client.getMemory(target, entry.id) : entry;
      if (full.revision !== entry.revision) throw new ApiError({ code: MEMORY_REVISION_CONFLICT, msg: t('memory.conflict'), data: null });
      return client.putMemory(target, entry.id, {
        action: 'update', type: full.type, title: full.title, body: full.body,
        reason: t('memory.defaultReason.keep'), expected_revision: entry.revision,
        basis: full.basis, validity: full.validity,
      });
    },
    onSuccess: onChanged,
    onError: fail,
  });
  const discard = useMutation({
    // Discarding is the candidate's own deletion: the entry it proposed to
    // change stays as it was.
    mutationFn: (entry: MemoryEntry) => client.deleteMemory(target, entry.id, entry.revision),
    onSuccess: onChanged,
    onError: fail,
  });

  if (loading) {
    return (
      <p role="status" className="flex items-center gap-2 py-8 text-[13px] text-ink-faint">
        <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
        {t('memory.loading')}
      </p>
    );
  }
  if (entries.length === 0) {
    return incomplete ? null : <p data-memory-inbox-empty className="py-8 text-[13px] text-ink-soft">{t('memory.inbox.empty')}</p>;
  }
  const busy = keep.isPending || discard.isPending;
  return (
    <ul data-memory-inbox className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-panel">
      {entries.map((entry) => (
        <li
          key={entry.id}
          ref={entry.id === linkedEntry ? locatedRef : undefined}
          tabIndex={entry.id === linkedEntry ? -1 : undefined}
          aria-current={entry.id === linkedEntry ? 'true' : undefined}
          data-memory-inbox-row={entry.id}
          className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-3"
        >
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink">
              <TypeTag type={entry.type} />
              <span className="min-w-0 truncate">{entry.title}</span>
            </p>
            <p className={`mt-0.5 text-[12px] leading-relaxed text-ink-soft ${expandedId === entry.id ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{expandedId === entry.id && expanded.data !== undefined ? expanded.data.body : entry.body}{entry.content_complete === false && expandedId !== entry.id ? '…' : ''}</p>
            {entry.content_complete === false ? (
              <button type="button" data-memory-inbox-read onClick={() => { setExpandedId(expandedId === entry.id ? null : entry.id); }} className="mt-1 text-[12px] text-ink-soft underline">{t('memory.tool.view')}</button>
            ) : null}
            {expandedId === entry.id && expanded.isPending ? <p role="status" className="text-[12px] text-ink-faint">{t('memory.loading')}</p> : null}
            {expandedId === entry.id && expanded.isError ? <button type="button" onClick={() => { void expanded.refetch(); }} className="text-[12px] text-danger underline">{errorText(locale, expanded.error)} · {t('common.retry')}</button> : null}
            {entry.reason !== '' ? (
              <p className="mt-0.5 text-[12px] text-ink-faint">{t('memory.tool.reason')}: {entry.reason}</p>
            ) : null}
            {/* What accepting does is the consequence the reader is deciding
                on, and it differs by proposal: an update replaces the entry's
                text under the same id, an archive retires the entry. Saying
                "keep" alone would present a retirement as a re-activation. */}
            {entry.pending_action !== undefined ? (
              <p data-memory-inbox-action={entry.pending_action} className="mt-0.5 text-[12px] text-ink-soft">
                {t(entry.pending_action === 'archive' ? 'memory.inbox.proposesArchive' : 'memory.inbox.proposesUpdate')}
              </p>
            ) : null}
            {/* What the proposal is based on, so a review is a decision about
                real content rather than about a title and a paragraph. */}
            {parseMemoryEntry(entry) !== undefined ? (
              <div data-memory-inbox-provenance className="mt-1.5 space-y-1 border-l border-hairline pl-2.5">
                <BasisLine entry={parseMemoryEntry(entry)!} />
                <ValidityLine validity={entry.validity} />
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-memory-inbox-keep
              data-memory-inbox-keep-action={entry.pending_action ?? 'none'}
              disabled={busy}
              onClick={() => { keep.mutate(entry); }}
              className={PRIMARY_BUTTON}
            >
              {t(entry.pending_action === 'archive' ? 'memory.inbox.acceptArchive' : 'memory.inbox.keep')}
            </button>
            <button type="button" data-memory-inbox-discard disabled={busy} onClick={() => { discard.mutate(entry); }} className={SECONDARY_BUTTON}>
              {t('memory.inbox.discard')}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
