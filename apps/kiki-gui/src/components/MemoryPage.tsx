/**
 * /memory — the one place memory is managed (`/api/memory/*`).
 *
 * Memory is on by default, and the nav entry is permanent either way: switched
 * off, this page is the turn-on guide (what it does, where the files live, one
 * switch); switched on, it is the entry console.
 *
 * Scope is the page's spine: Global, or one workspace via the shared
 * `WorkspaceScopeControl` (the scope rides `?workspace=` like /board and /cron,
 * so the sidebar can deep-link the active session's workspace). A workspace
 * scope also carries its own switch — follow global / on / off.
 *
 * List → detail: search and a type filter narrow the list; the detail pane
 * reads and edits the body, and offers pin, delete, and the journal-backed
 * history with per-operation Undo. Deletes are undoable, so the confirmation
 * says exactly that instead of claiming anything is permanent. Every write
 * carries `expected_revision`; 40944 surfaces as "reload before saving" and
 * never silently overwrites.
 *
 * The Inbox tab exists only while `approval` is `review` — with the default
 * `auto` there is nothing pending, so there is no tab.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { To } from 'react-router-dom';

import type { Workspace } from '@kiki/protocol';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { Icon } from './icons';
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
import { PageHeader, useWorkspaceScope } from './PageChrome';
import { RelativeTime } from './RelativeTime';
import { Toggle } from './controls';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { WorkspaceScopeControl, segmentClass } from './WorkspaceScopeControl';

export const MEMORY_SETTINGS_QUERY_KEY = ['memory-settings'] as const;

export interface MemoryPageProps {
  readonly workspaceOptions: readonly Workspace[];
  readonly onNavigate: (target: To) => void;
  readonly onToggleSidebar: () => void;
}

type MemoryTab = 'entries' | 'inbox';

/** Where a scope's files live, shown verbatim in the turn-on guide. */
function storagePath(target: MemoryTarget): string {
  return target.scope === 'global'
    ? '$KIKI_HOME/memory/global/'
    : `$KIKI_HOME/memory/workspaces/${target.workspaceId ?? ''}/`;
}

function memoryTargetOf(scope: string | undefined): MemoryTarget {
  return scope === undefined ? { scope: 'global' } : { scope: 'workspace', workspaceId: scope };
}

function targetKey(target: MemoryTarget): string {
  return target.scope === 'global' ? 'global' : `workspace:${target.workspaceId ?? ''}`;
}

/** Journal actions the history list names; anything else shows its raw verb. */
const HISTORY_LABELS = {
  create: 'memory.history.create',
  update: 'memory.history.update',
  delete: 'memory.history.delete',
  archive: 'memory.history.archive',
  supersede: 'memory.history.supersede',
  supersede_previous: 'memory.history.supersede_previous',
  undo: 'memory.history.undo',
} as const satisfies Readonly<Record<string, I18nKey>>;

function historyLabel(action: string, t: (key: I18nKey) => string): string {
  const key = (HISTORY_LABELS as Readonly<Record<string, I18nKey>>)[action];
  return key === undefined ? action : t(key);
}

function LeafGlyph({ className }: { readonly className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className={className}>
      <path d="M3.4 2.6h7.2l2 2v8.8a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z" />
      <path d="M5.2 6.3h4.6M5.2 8.9h3.2" />
    </svg>
  );
}

export function MemoryPage({ workspaceOptions, onNavigate, onToggleSidebar }: MemoryPageProps) {
  const { t, tp, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const { scope, setScope } = useWorkspaceScope(workspaceOptions);
  const target = memoryTargetOf(scope);

  const settingsQuery = useQuery({
    queryKey: MEMORY_SETTINGS_QUERY_KEY,
    queryFn: () => client.getMemorySettings(),
    staleTime: 15_000,
  });
  const settings = settingsQuery.data;
  const globalEnabled = settings?.enabled === true;
  const workspaceOverride = scope === undefined ? null : settings?.workspaces[scope] ?? null;
  const scopeEnabled = scope === undefined ? globalEnabled : globalEnabled && workspaceOverride !== false;

  const applySettings = (next: MemorySettings) => {
    queryClient.setQueryData(MEMORY_SETTINGS_QUERY_KEY, next);
  };
  const globalToggle = useMutation({
    mutationFn: (enabled: boolean) => client.patchMemorySettings({ enabled }),
    onSuccess: applySettings,
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: t('memory.toggleFailed', { detail: errorText(locale, error) }) });
    },
  });
  const workspaceToggle = useMutation({
    mutationFn: (enabled: boolean | null) => client.patchWorkspaceMemorySettings(scope!, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEMORY_SETTINGS_QUERY_KEY }),
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: t('memory.toggleFailed', { detail: errorText(locale, error) }) });
    },
  });

  return (
    <div data-memory-page className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      <PageHeader title={t('memory.title')} onToggleSidebar={onToggleSidebar} />
      <div data-memory-status className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-hairline px-4 py-2 text-[12px] text-ink-soft lg:px-6" role="status">
        <span>{settingsQuery.isPending ? t('memory.loading') : settingsQuery.isError
          ? t('st.memory.loadFailed', { detail: errorText(locale, settingsQuery.error) })
          : t(globalEnabled ? 'st.memory.enabled' : 'st.memory.disabled')}</span>
        {globalEnabled && scope !== undefined && workspaceOverride === false ? (
          <span data-memory-workspace-disabled className="font-medium text-amber-ink">{t('st.memory.workspaceDisabled')}</span>
        ) : null}
        <button type="button" data-memory-open-settings onClick={() => { onNavigate(`/settings/memory${scope === undefined ? '' : `?workspace=${encodeURIComponent(scope)}`}`); }} className="ml-auto font-medium text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent">
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
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline px-4 py-2.5 lg:px-6">
            <WorkspaceScopeControl
              workspaces={workspaceOptions}
              value={scope}
              onChange={(next) => { setScope(next); }}
              dataAttribute="data-memory-scope"
            />
            {scope !== undefined ? (
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
                        className={`${segmentClass(active, 'h-7 px-2.5 text-[13px]')} disabled:cursor-not-allowed disabled:opacity-60`}
                      >
                        {t(key)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <MemoryScopeView
            key={targetKey(target)}
            target={target}
            enabled={scopeEnabled}
            review={settings?.approval === 'review'}
            onOpenSession={(sessionId) => { onNavigate(`/s/${sessionId}`); }}
          />
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
  enabled,
  review,
  onOpenSession,
}: {
  readonly target: MemoryTarget;
  readonly enabled: boolean;
  readonly review: boolean;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const { t, tp, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<MemoryTab>('entries');
  useEffect(() => { if (!review) setTab('entries'); }, [review]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<MemoryType | 'all'>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const listKey = ['memory', targetKey(target), { search, typeFilter, showInactive }] as const;
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () => client.listMemory(target, {
      query: search,
      type: typeFilter === 'all' ? undefined : typeFilter,
      include_inactive: showInactive,
    }),
    staleTime: 5_000,
  });
  const inboxQuery = useQuery({
    queryKey: ['memory-inbox', targetKey(target)],
    queryFn: () => client.memoryInbox(target),
    enabled: review,
    staleTime: 5_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['memory', targetKey(target)] });
    void queryClient.invalidateQueries({ queryKey: ['memory-inbox', targetKey(target)] });
  };

  const entries = useMemo(
    () => (listQuery.data?.items ?? []).filter((entry) => entry.status !== 'pending'),
    [listQuery.data],
  );
  const inbox = inboxQuery.data ?? [];
  // A selection that filtered out of view drops back to the list.
  useEffect(() => {
    if (selectedId !== null && !entries.some((entry) => entry.id === selectedId)) setSelectedId(null);
  }, [entries, selectedId]);
  const selected = entries.find((entry) => entry.id === selectedId);
  const filtersActive = search.trim() !== '' || typeFilter !== 'all' || showInactive;

  const detail = creating ? (
    <MemoryEditor
      target={target}
      entry={undefined}
      onDone={(entry) => {
        setCreating(false);
        if (entry !== undefined) setSelectedId(entry.id);
        refresh();
      }}
    />
  ) : selected !== undefined ? (
    <MemoryDetail
      target={target}
      entry={selected}
      onOpenSession={onOpenSession}
      onChanged={refresh}
      onClosed={() => { setSelectedId(null); }}
    />
  ) : (
    <p className="py-8 text-[13px] text-ink-faint">{t('memory.detail.none')}</p>
  );

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

        {review && tab === 'inbox' ? (
          <MemoryInbox target={target} entries={inbox} loading={inboxQuery.isPending} onChanged={refresh} />
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
                className="h-8 w-full max-w-64 rounded-md border border-hairline bg-paper px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
              />
              <div role="group" aria-label={t('memory.filter.aria')} className="flex items-center gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
                {(['all', ...MEMORY_TYPES] as const).map((candidate) => {
                  const active = candidate === typeFilter;
                  return (
                    <button
                      key={candidate}
                      type="button"
                      data-memory-type-filter={candidate}
                      aria-pressed={active}
                      onClick={() => { setTypeFilter(candidate as MemoryType | 'all'); }}
                      className={segmentClass(active, 'h-7 px-2.5 text-[13px]')}
                    >
                      {t(`memory.type.${candidate}`)}
                    </button>
                  );
                })}
              </div>
              <Toggle label={t('memory.showInactive')} checked={showInactive} onChange={setShowInactive} />
              <span className="ml-auto flex items-center gap-3">
                {listQuery.data !== undefined ? (
                  <span data-memory-count className="text-[12px] text-ink-faint tabular-nums">
                    {tp('memory.count', entries.length)}
                  </span>
                ) : null}
                <button
                  type="button"
                  data-memory-new
                  onClick={() => { setSelectedId(null); setCreating(true); }}
                  className={SECONDARY_BUTTON}
                >
                  {t('memory.new')}
                </button>
              </span>
            </div>

            {listQuery.isPending ? (
              <p role="status" className="flex items-center gap-2 py-8 text-[13px] text-ink-faint">
                <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
                {t('memory.loading')}
              </p>
            ) : listQuery.isError ? (
              <div data-memory-error className="rounded-xl border border-danger/30 bg-danger/5 p-4">
                <p className="text-[13px] font-medium text-danger">{t('memory.loadFailed')}</p>
                <p className="mt-1 font-mono text-[11px] text-danger">{errorText(locale, listQuery.error)}</p>
                <button type="button" onClick={() => { void listQuery.refetch(); }} className="mt-2 text-[12px] font-medium text-danger underline">
                  {t('common.retry')}
                </button>
              </div>
            ) : entries.length === 0 && !creating ? (
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
                    <p className="font-display text-[17px] text-ink">{t('memory.empty.title')}</p>
                    <p className="mt-1 max-w-[46ch] text-[13px] leading-relaxed text-ink-soft">{t('memory.empty.body')}</p>
                  </>
                )}
              </div>
            ) : (
              <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.5fr)]" data-memory-list-detail>
                <ul
                  data-memory-list
                  className={`-mx-2 flex min-w-0 flex-col gap-0.5 ${
                    selected !== undefined || creating ? 'max-md:hidden' : ''
                  }`}
                >
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <MemoryListRow
                        entry={entry}
                        active={entry.id === selectedId}
                        onOpen={() => { setCreating(false); setSelectedId(entry.id); }}
                      />
                    </li>
                  ))}
                </ul>
                <div className={`min-w-0 md:border-l md:border-hairline md:pl-6 ${selected === undefined && !creating ? 'max-md:hidden' : ''}`}>
                  {selected !== undefined || creating ? (
                    <button
                      type="button"
                      data-memory-detail-back
                      onClick={() => { setSelectedId(null); setCreating(false); }}
                      className="mb-2 text-[13px] text-ink-soft underline underline-offset-2 md:hidden"
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

function TypeTag({ type }: { readonly type: MemoryType }) {
  const { t } = useI18n();
  return (
    <span data-memory-type={type} className="shrink-0 rounded-sm bg-ink/[0.05] px-1.5 py-px text-[11px] font-medium text-ink-soft">
      {t(`memory.type.${type}`)}
    </span>
  );
}

function MemoryListRow({
  entry,
  active,
  onOpen,
}: {
  readonly entry: MemoryEntry;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const inactive = entry.status === 'archived' || entry.status === 'superseded';
  return (
    <button
      type="button"
      data-memory-row={entry.id}
      aria-current={active ? 'true' : undefined}
      onClick={onOpen}
      className={`flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-left transition-[background-color,box-shadow] duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none ${
        active ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'
      }`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {entry.pinned ? <span role="img" aria-label={t('memory.pinned')} className="flex shrink-0 text-ink-faint"><Icon name="pin" size={12} /></span> : null}
        <span className={`min-w-0 truncate text-[13px] ${active ? 'font-medium text-ink' : inactive ? 'text-ink-soft' : 'text-ink'}`}>{entry.title}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-faint">
        <TypeTag type={entry.type} />
        <span className="shrink-0">{t(`memory.writer.${entry.source.writer}`)}</span>
        <span className="shrink-0">· <RelativeTime at={entry.updated} /></span>
        {inactive ? (
          <span className="shrink-0">· {t(entry.status === 'archived' ? 'memory.status.archived' : 'memory.status.superseded')}</span>
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
  onOpenSession,
  onChanged,
  onClosed,
}: {
  readonly target: MemoryTarget;
  readonly entry: MemoryEntry;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onChanged: () => void;
  readonly onClosed: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  return (
    <div data-memory-detail={entry.id} className="min-w-0 space-y-4">
      <MemoryEditor target={target} entry={entry} onDone={() => { onChanged(); }} />

      <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        <button
          type="button"
          data-memory-pin
          disabled={pinMutation.isPending}
          onClick={() => { pinMutation.mutate(); }}
          className={SECONDARY_BUTTON}
        >
          {t(entry.pinned ? 'memory.unpin' : 'memory.pin')}
        </button>
        <button
          type="button"
          data-memory-delete
          disabled={deleteMutation.isPending}
          onClick={() => { setConfirmDelete(true); }}
          className={DANGER_GHOST_BUTTON}
        >
          {t('memory.delete')}
        </button>
        {entry.source.session !== undefined ? (
          <button
            type="button"
            data-memory-source-session
            title={t('memory.openSource')}
            onClick={() => { onOpenSession(entry.source.session!); }}
            className="text-[12px] text-ink-soft underline underline-offset-2 transition-colors hover:text-ink"
          >
            {t('memory.openSource')}
          </button>
        ) : null}
      </div>

      <section data-memory-history aria-labelledby={`memory-history-${entry.id}`}>
        <h3 id={`memory-history-${entry.id}`} className={FIELD_LABEL}>{t('memory.history')}</h3>
        {history.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-ink-faint">{t('memory.history.empty')}</p>
        ) : (
          <ul className="mt-1.5 space-y-px">
            {[...history].reverse().map((record) => (
              <li key={`${record.operationId}:${record.at}`} className="flex min-w-0 items-center gap-2 py-1 text-[12px] text-ink-faint">
                <span className="min-w-0 flex-1 truncate">
                  {historyLabel(record.action, t)}
                  {' · '}
                  {t(`memory.writer.${record.writer}`)}
                  {' · '}
                  <RelativeTime at={record.at} />
                </span>
                <UndoButton
                  record={record}
                  busy={undoMutation.isPending}
                  onUndo={() => { undoMutation.mutate(record.operationId); }}
                />
              </li>
            ))}
          </ul>
        )}
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
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [type, setType] = useState<MemoryType>(entry?.type ?? 'project');
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false);

  // Re-seed from the entry whenever the server hands back a different
  // revision; the `expected_revision` guard still catches a real conflict.
  useEffect(() => {
    setTitle(entry?.title ?? '');
    setBody(entry?.body ?? '');
    setType(entry?.type ?? 'project');
    setReason('');
    setConflict(false);
  }, [entry?.id, entry?.revision, entry?.title, entry?.body, entry?.type]);

  const dirty = entry === undefined
    ? title.trim() !== '' || body.trim() !== ''
    : title !== entry.title || body !== entry.body || type !== entry.type;
  const valid = title.trim() !== '' && body.trim() !== '' && title.length <= 200 && body.length <= 1_500;

  const save = useMutation({
    mutationFn: () => client.putMemory(target, entry?.id ?? 'new', {
      action: entry === undefined ? 'create' : 'update',
      type,
      title: title.trim(),
      body: body.trim(),
      reason: reason.trim() === ''
        ? t(entry === undefined ? 'memory.defaultReason.create' : 'memory.defaultReason.edit')
        : reason.trim(),
      expected_revision: entry?.revision,
    }),
    onSuccess: (result) => {
      setConflict(false);
      setReason('');
      pushToast({ tone: 'success', text: t('memory.saved') });
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

  const fieldId = `memory-${entry?.id ?? 'new'}`;
  return (
    <div data-memory-editor={entry?.id ?? 'new'} className="min-w-0 space-y-3">
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
                className={segmentClass(active, 'h-7 px-2.5 text-[13px]')}
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
        <p role="alert" data-memory-conflict className="rounded-md border border-amber-rule/40 bg-amber-card px-2.5 py-2 text-[12px] leading-relaxed text-amber-ink">
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
          {t(entry === undefined ? 'memory.create' : 'memory.save')}
        </button>
        <button
          type="button"
          data-memory-discard
          disabled={!dirty || save.isPending}
          onClick={() => {
            setTitle(entry?.title ?? '');
            setBody(entry?.body ?? '');
            setType(entry?.type ?? 'project');
            setReason('');
            if (entry === undefined) onDone();
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
 * Inbox — only reachable while `approval` is `review`. Keep promotes the
 * pending entry to active; Discard removes it. Both are journal-backed, so
 * both are undoable from the entry's history.
 */
function MemoryInbox({
  target,
  entries,
  loading,
  onChanged,
}: {
  readonly target: MemoryTarget;
  readonly entries: readonly MemoryEntry[];
  readonly loading: boolean;
  readonly onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const fail = (error: unknown) => {
    pushToast({ tone: 'error', text: t('memory.actionFailed', { detail: errorText(locale, error) }) });
  };
  const keep = useMutation({
    mutationFn: (entry: MemoryEntry) => client.putMemory(target, entry.id, {
      action: 'update',
      type: entry.type,
      title: entry.title,
      body: entry.body,
      reason: t('memory.defaultReason.keep'),
      expected_revision: entry.revision,
    }),
    onSuccess: onChanged,
    onError: fail,
  });
  const discard = useMutation({
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
    return <p data-memory-inbox-empty className="py-8 text-[13px] text-ink-soft">{t('memory.inbox.empty')}</p>;
  }
  const busy = keep.isPending || discard.isPending;
  return (
    <ul data-memory-inbox className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-panel">
      {entries.map((entry) => (
        <li key={entry.id} data-memory-inbox-row={entry.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink">
              <TypeTag type={entry.type} />
              <span className="min-w-0 truncate">{entry.title}</span>
            </p>
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-ink-soft">{entry.body}</p>
            {entry.reason !== '' ? (
              <p className="mt-0.5 text-[12px] text-ink-faint">{t('memory.tool.reason')}: {entry.reason}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" data-memory-inbox-keep disabled={busy} onClick={() => { keep.mutate(entry); }} className={PRIMARY_BUTTON}>
              {t('memory.inbox.keep')}
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
