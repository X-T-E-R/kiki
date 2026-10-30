import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ListWorkspaceCatalogResponse, WorkspaceCatalogEntry as Workspace } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { workspaceSettingsPath } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { SshProfilesPanel } from '../SshProfilesPanel';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { InlineEditor } from '../InlineEditor';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { WorktreesCard } from './WorktreesCard';
import { Icon } from '../icons';
import { MiniContextMenu } from '../MiniContextMenu';
import {
  LIST_ROW_HEIGHT,
  ListBody,
  ListBulkBar,
  ListEmpty,
  ListGroup,
  ListToolbar,
  RowCheck,
  groupItems,
  useListView,
  type ListDensity,
  type ListFilterSpec,
  type ListSortSpec,
} from './list';
import { WorkspaceSettingsPage } from './workspaces/WorkspaceSettingsPage';

/**
 * The workspace list, or one workspace's own page.
 *
 * The page is not a modal because a workspace is not a dialog: its name, its
 * plugins and everything else scoped to it are what a reader configures once
 * and returns to. The list stays a list, and the row that opens a workspace is
 * the row's own name rather than a control that competes with its verbs.
 */
export function WorkspacesSection({ workspaceId }: { readonly workspaceId?: string | null }) {
  if (workspaceId !== null && workspaceId !== undefined && workspaceId !== '') {
    return <WorkspaceSettingsPage workspaceId={workspaceId} />;
  }
  return <WorkspacesList />;
}

function WorkspacesList() {
  const { client, scopeId, sshLabel, activateSshProfile, activateLocal } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['workspaces', 'catalog'], queryFn: () => client.listWorkspaceCatalog(), staleTime: 30_000 });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [bulkRemoving, setBulkRemoving] = useState<readonly Workspace[] | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  };

  const applyRenamed = (echoed: Workspace) => {
    queryClient.setQueryData(['workspaces', 'catalog'], (current: ListWorkspaceCatalogResponse | undefined) =>
      current === undefined ? current : { items: current.items.map((ws) => ws.id === echoed.id ? echoed : ws) },
    );
    setRenamingId(null);
    invalidate();
  };

  const togglePinned = (workspace: Workspace) => {
    setPinBusy(workspace.id);
    setFeedback(null);
    void client
      .setWorkspacePinnedCatalog(workspace.id, !workspace.pinned)
      .then((echoed) => {
        queryClient.setQueryData(['workspaces', 'catalog'], (current: ListWorkspaceCatalogResponse | undefined) =>
          current === undefined
            ? current
            : { items: current.items.map((ws) => (ws.id === echoed.id ? echoed : ws)) },
        );
        invalidate();
      })
      .catch((error: unknown) => {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
      })
      .finally(() => { setPinBusy(null); });
  };

  // Bulk pin/unpin: one write per workspace, the list refreshes once at the end.
  const bulkPin = (targets: readonly Workspace[], pinned: boolean) => {
    setPinBusy('bulk');
    setFeedback(null);
    void Promise.all(targets.filter((ws) => ws.pinned !== pinned).map((ws) => client.setWorkspacePinnedCatalog(ws.id, pinned)))
      .then(invalidate)
      .catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); })
      .finally(() => { setPinBusy(null); });
  };

  return (
    <>
    {/* The page intro already says what unregistering keeps; the card names
        only which machine's folders these are. */}
    <SectionCard id="st-card-workspaces" title={t('st.workspaces.title')}
      aside={sshLabel === null ? t('connect.localScope') : `${t('connect.remoteScope')} · ${sshLabel}`}>
      <div className="space-y-2">
        {scopeId.startsWith('ssh:') ? (
          <button type="button" onClick={activateLocal} className={SECONDARY_BUTTON}>
            {t('connect.switchLocal')}
          </button>
        ) : null}
        {items.length > 0 ? (
          <WorkspaceList
            items={items}
            pinBusy={pinBusy}
            onPin={togglePinned}
            onBulkPin={bulkPin}
            renamingId={renamingId}
            onRename={(workspace) => { setRenamingId(workspace.id); }}
            onRenameDone={applyRenamed}
            onRenameCancel={() => { setRenamingId(null); }}
            onRemove={setRemoving}
            onBulkRemove={setBulkRemoving}
            onNewSession={(workspace) => { void navigate(`/new?workspace=${encodeURIComponent(workspace.id)}`); }}
            onOpenDetail={(workspace) => { void navigate(workspaceSettingsPath(workspace.id)); }}
          />
        ) : null}
        {/* One page-level line stands in for any row whose trust read failed:
            N missing trust reads are one server problem, not N row problems.
            The failed rows themselves stay quiet, and a refetch resets this. */}
        <TrustReadFailure items={items} />
        {!query.isLoading && !query.isError && items.length === 0 ? (
          <ListEmpty
            kind="none"
            title={t('st.workspaces.emptyTitle')}
            body={t('st.workspaces.emptyBody')}
            action={<button type="button" className={SECONDARY_BUTTON} onClick={() => { void navigate('/new?workspace=new'); }}>{t('st.workspaces.emptyAction')}</button>}
          />
        ) : null}
        {query.isLoading ? <Hint>{t('st.workspaces.loading')}</Hint> : null}
        {query.isError ? <InlineError error={query.error} /> : null}
        {feedback !== null ? <FeedbackLine feedback={feedback} /> : null}
      </div>

      {removing !== null ? (
        <ConfirmDialog
          open
          overlayId="confirm-workspace-remove"
          title={t('st.workspaces.removeTitle', { name: removing.name })}
          body={t('st.workspaces.removeBody')}
          confirmLabel={t('st.workspaces.remove')}
          tone="danger"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            setFeedback(null);
            void client
              .removeWorkspace(target.id)
              .then(invalidate)
              .catch((error: unknown) => {
                setFeedback({ tone: 'error', text: errorText(locale, error) });
              });
          }}
        />
      ) : null}
      {bulkRemoving !== null ? (
        <ConfirmDialog
          open
          overlayId="confirm-workspace-bulk-remove"
          title={t('st.workspaces.bulkRemoveTitle', { count: bulkRemoving.length })}
          body={t('st.workspaces.bulkRemoveBody')}
          confirmLabel={t('st.workspaces.bulkRemoveConfirm', { count: bulkRemoving.length })}
          tone="danger"
          onCancel={() => setBulkRemoving(null)}
          onConfirm={() => {
            const targets = bulkRemoving;
            setBulkRemoving(null);
            setFeedback(null);
            void Promise.all(targets.map((ws) => client.removeWorkspace(ws.id)))
              .then(invalidate)
              .catch((error: unknown) => {
                invalidate();
                setFeedback({ tone: 'error', text: errorText(locale, error) });
              });
          }}
        />
      ) : null}
    </SectionCard>
    {/* A whole remote environment is its own object (F06): not part of the
        workspace directory card, and named differently from the session's
        SSH tool hosts. D24 will give remote spaces their real home; until
        then the panel stays here as a peer, not nested in workspace management. */}
    <SshProfilesPanel onConnect={activateSshProfile} />
    <WorktreesCard />
    </>
  );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const byRecent = (a: Workspace, b: Workspace) => Date.parse(b.last_opened_at) - Date.parse(a.last_opened_at);

/** The last path segment, across separators, without a trailing slash. */
function basenameOf(path: string): string {
  const cleaned = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const index = cleaned.lastIndexOf('/');
  return index === -1 ? cleaned : cleaned.slice(index + 1);
}

/**
 * The name a row leads with. A folder whose registered name reads as an
 * opaque id (releases/…/d300ab…) names the folder itself instead, truncated,
 * so the list stays scannable. Anything the user or server named reads as-is.
 */
export function workspaceDisplayName(workspace: Workspace): string {
  const name = workspace.name.trim();
  const opaque = (value: string): boolean => /^[0-9a-f]{7,}$/i.test(value) || (/^[0-9a-f-]{16,}$/i.test(value) && /[0-9]/.test(value));
  if (!opaque(name)) return name;
  // A hash-named folder (an install or release directory) reads by the
  // nearest readable ancestor, e.g. `Kiki · d300ab1…`.
  const parts = workspace.root.replaceAll('\\', '/').split('/').filter((part) => part !== '');
  const leaf = parts.at(-1) ?? name;
  const parent = [...parts.slice(0, -1)].reverse().find((part) => !opaque(part) && !/^releases?$/i.test(part));
  const short = `${leaf.slice(0, 7)}…`;
  return parent === undefined ? short : `${parent} · ${short}`;
}

/**
 * The registered-workspace list on the shared list pattern: search by name
 * or path, pinned chip, sort, density, folding groups
 * (pinned · this week · older), row selection with bulk pin / unregister.
 * Each row keeps one visible verb (New session) and the pin mark; rename
 * and unregister live in the row's ⋯ menu so 80 rows are not 320 buttons.
 */
function WorkspaceList({ items, pinBusy, onPin, onBulkPin, renamingId, onRename, onRenameDone, onRenameCancel, onRemove, onBulkRemove, onNewSession, onOpenDetail }: {
  items: readonly Workspace[];
  pinBusy: string | null;
  onPin: (workspace: Workspace) => void;
  onBulkPin: (targets: readonly Workspace[], pinned: boolean) => void;
  renamingId: string | null;
  onRename: (workspace: Workspace) => void;
  onRenameDone: (echoed: Workspace) => void;
  onRenameCancel: () => void;
  onRemove: (workspace: Workspace) => void;
  onBulkRemove: (targets: readonly Workspace[]) => void;
  onNewSession: (workspace: Workspace) => void;
  /** One workspace's own settings page; the row's name is the way in. */
  onOpenDetail: (workspace: Workspace) => void;
}) {
  const { t } = useI18n();
  const filters = useMemo<ListFilterSpec<Workspace>[]>(() => [
    { id: 'pinned', label: t('st.workspaces.filter.pinned'), test: (ws) => ws.pinned },
  ], [t]);
  const sorts = useMemo<ListSortSpec<Workspace>[]>(() => [
    { id: 'recent', label: t('st.list.sort.recent'), compare: byRecent },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => a.name.localeCompare(b.name) },
  ], [t]);
  const keyOf = useCallback((ws: Workspace) => ws.id, []);
  const textOf = useCallback((ws: Workspace) => [ws.name, ws.root], []);
  const view = useListView({ listId: 'workspaces', items, keyOf, textOf, filters, sorts });
  // Group only when sorted by recency; a name sort is one flat list.
  const [now] = useState(() => Date.now());
  const groups = useMemo(() => {
    if (view.sort !== 'recent') return [{ key: 'all', label: '', items: view.visible, total: items.length }];
    const bucket = (ws: Workspace) => [ws.pinned
      ? { key: 'pinned', label: t('st.workspaces.group.pinned') }
      : now - Date.parse(ws.last_opened_at) < WEEK_MS
        ? { key: 'recent', label: t('st.workspaces.group.recent') }
        : { key: 'older', label: t('st.workspaces.group.older') }];
    return groupItems(items, view.visible, bucket, ['pinned', 'recent', 'older']).filter((group) => group.items.length > 0);
  }, [view.sort, view.visible, items, now, t]);
  const selectedItems = items.filter((ws) => view.selected.has(ws.id));
  const allPinned = selectedItems.length > 0 && selectedItems.every((ws) => ws.pinned);
  const allShownSelected = view.visible.length > 0 && view.visible.every((ws) => view.selected.has(ws.id));

  const renderRow = (ws: Workspace) => (
    <WorkspaceRow workspace={ws} density={view.density} selecting={view.selected.size > 0} checked={view.selected.has(ws.id)}
      onCheck={() => { view.toggleSelected(ws.id); }} pinBusy={pinBusy === ws.id || pinBusy === 'bulk'}
      renaming={renamingId === ws.id}
      onPin={() => { onPin(ws); }} onRename={() => { onRename(ws); }} onRenameDone={onRenameDone} onRenameCancel={onRenameCancel}
      onRemove={() => { onRemove(ws); }}
      onNewSession={() => { onNewSession(ws); }} onOpenDetail={() => { onOpenDetail(ws); }} />
  );

  return (
    <div data-workspace-list className="space-y-2">
      <ListToolbar view={view} total={items.length} filters={filters} sorts={sorts}
        searchLabel={t('st.workspaces.search')} searchPlaceholder={t('st.workspaces.searchPlaceholder')}
        actions={(
          <label className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink" title={t('st.list.selectAll')}>
            <input type="checkbox" checked={allShownSelected} aria-label={t('st.list.selectAll')}
              onChange={() => { view.setSelected(allShownSelected ? new Set() : new Set(view.visible.map(keyOf))); }}
              className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-ink)]" />
          </label>
        )} />
      <ListBulkBar count={selectedItems.length} onClear={() => { view.setSelected(new Set()); }}>
        <button type="button" data-bulk-pin disabled={pinBusy !== null} className={SECONDARY_BUTTON}
          onClick={() => { onBulkPin(selectedItems, !allPinned); }}>
          {allPinned ? t('st.workspaces.bulkUnpin') : t('st.workspaces.bulkPin')}
        </button>
        <button type="button" data-bulk-remove className="rounded-md border border-danger/40 bg-paper px-3 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/5"
          onClick={() => { onBulkRemove(selectedItems); }}>
          {t('st.workspaces.bulkRemove')}
        </button>
      </ListBulkBar>
      {view.visible.length === 0 ? (
        <ListEmpty kind="no-match" title={t('st.workspaces.noMatchTitle')}
          body={view.query.trim() === '' ? undefined : t('st.workspaces.noMatches', { query: view.query.trim() })}
          onClear={view.clear} />
      ) : groups.length === 1 && groups[0]!.key === 'all' ? (
        <ListBody items={view.visible} keyOf={keyOf} density={view.density} renderRow={renderRow} label={t('st.workspaces.title')} />
      ) : (
        groups.map((group) => (
          <ListGroup key={group.key} groupKey={group.key} label={group.label} count={group.items.length} total={group.total}
            folded={view.isFolded(group.key)} onToggle={() => { view.toggleFold(group.key); }}>
            <ListBody items={group.items} keyOf={keyOf} density={view.density} renderRow={renderRow} label={group.label} />
          </ListGroup>
        ))
      )}
    </div>
  );
}
const ROW_ICON = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:text-ink-faint pointer-coarse:h-11 pointer-coarse:w-11';

function WorkspaceRow({ workspace, density, selecting, checked, onCheck, pinBusy, renaming, onPin, onRename, onRenameDone, onRenameCancel, onRemove, onNewSession, onOpenDetail }: {
  workspace: Workspace;
  density: ListDensity;
  /** Some row is selected: every box shows, not only the hovered one. */
  selecting: boolean;
  checked: boolean;
  onCheck: () => void;
  pinBusy: boolean;
  renaming: boolean;
  onPin: () => void;
  onRename: () => void;
  onRenameDone: (echoed: Workspace) => void;
  onRenameCancel: () => void;
  onRemove: () => void;
  onNewSession: () => void;
  onOpenDetail: () => void;
}) {
  const { client } = useConnection();
  const { t, time } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Trust is read-only here; the only place it changes is the workspace's own
  // page. Only a trusted row carries the tag, and one page-level line covers
  // every failed read, which also marks its own row 未知.
  const trustQuery = useQuery({
    queryKey: ['workspace-trust', workspace.id],
    queryFn: () => client.getWorkspaceTrust(workspace.id),
    staleTime: 30_000,
  });

  const isTrusted = trustQuery.data?.trusted === true;
  const displayName = workspaceDisplayName(workspace);

  const compact = density === 'compact';
  const facts = t('st.workspaces.lastOpened', { time: time.relativeTime(workspace.last_opened_at) });
  return (
    <div data-workspace-row={workspace.id} data-selected={checked ? '' : undefined}
      style={{ minHeight: LIST_ROW_HEIGHT[density] }}
      className={`group/row transition-colors ${checked ? 'bg-ink/[0.035]' : 'hover:bg-ink/[0.02]'}`}>
    <div className="flex h-full items-center gap-1 pr-1.5 pl-1">
      <RowCheck quiet={!selecting} checked={checked} onChange={onCheck} label={t('st.list.selectRow', { name: displayName })} />
      <div className="min-w-0 flex-1 py-1">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* The name is the way into the workspace's own page: one move,
              reachable by keyboard, that does not compete with the row's
              verbs to the right of it. Renaming unfolds under the row. */}
          <button
            type="button"
            data-workspace-open={workspace.id}
            aria-label={t('st.workspaces.detail.open', { name: displayName })}
            title={workspace.root}
            onClick={onOpenDetail}
            className="min-w-0 shrink truncate rounded text-left text-[13px] font-medium text-ink transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
          >
            {displayName}
          </button>
          {/* Trust is the exception here: an untrusted row is the common case
              and says nothing, a trusted row carries the one tag that matters,
              and a read that failed says 未知 rather than guessing a state. */}
          {isTrusted ? (
            <span
              data-workspace-trust-badge={workspace.id}
              className="inline-flex shrink-0 items-center rounded bg-ink/[0.08] px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-ink"
              title={t('st.workspaces.trustHint')}
            >
              {t('st.workspaces.trusted')}
            </span>
          ) : trustQuery.isError ? (
            <span
              data-workspace-trust-unknown={workspace.id}
              className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-ink-faint"
              title={t('st.workspaces.trustReadFailed')}
            >
              {t('st.workspaces.trustUnknown')}
            </span>
          ) : null}
          {compact ? (
            <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={workspace.root}>{workspace.root}</p>
          ) : null}
        </div>
        {compact ? null : (
          <p className="flex min-w-0 items-baseline gap-2 text-[12px] leading-4 text-ink-faint">
            <span className="min-w-0 truncate font-mono text-[11px]" title={workspace.root}>{workspace.root}</span>
            {/* On a phone the path is what tells two rows apart; the group
                heading above already says roughly when it was opened. */}
            <span aria-hidden className="hidden shrink-0 sm:inline">·</span>
            <span className="hidden shrink-0 sm:inline">{facts}</span>
          </p>
        )}
      </div>
      {compact ? <span className="hidden shrink-0 text-[12px] text-ink-faint tabular-nums sm:inline">{time.relativeTime(workspace.last_opened_at)}</span> : null}
      <button
        type="button"
        data-workspace-pin={workspace.id}
        disabled={pinBusy}
        aria-pressed={workspace.pinned}
        onClick={onPin}
        aria-label={workspace.pinned ? t('st.workspaces.unpinAria', { name: workspace.name }) : t('st.workspaces.pinAria', { name: workspace.name })}
        title={workspace.pinned ? t('st.workspaces.unpin') : t('st.workspaces.pin')}
        className={`${ROW_ICON} ${workspace.pinned ? 'text-ink' : 'text-ink-faint opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'}`}
      >
        <Icon name="pin" size={14} />
      </button>
      <button type="button" onClick={onNewSession}
        className="h-8 shrink-0 rounded-md px-2.5 text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11">
        {t('st.workspaces.newSession')}
      </button>
      <button type="button" data-workspace-more={workspace.id} aria-haspopup="menu" aria-expanded={menu !== null}
        aria-label={t('st.workspaces.more', { name: workspace.name })} title={t('st.workspaces.more', { name: workspace.name })}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu(menu === null ? { x: rect.right - 208, y: rect.bottom + 4 } : null);
        }}
        className={`${ROW_ICON} text-ink-faint`}>
        <Icon name="more" size={14} />
      </button>
      {menu !== null ? (
        <MiniContextMenu x={menu.x} y={menu.y} ariaLabel={t('st.workspaces.more', { name: workspace.name })}
          overlayId={`workspace-menu:${workspace.id}`} dataAttribute="data-workspace-menu"
          onClose={() => { setMenu(null); }}
          entries={[
            { key: 'rename', label: t('st.workspaces.rename'), run: onRename },
            { separator: true },
            { key: 'remove', label: `${t('st.workspaces.remove')}…`, danger: true, run: onRemove },
          ]} />
      ) : null}
    </div>
    {/* One value on the row: the input exists only while renaming (Esc cancels). */}
    <InlineEditor open={renaming} lazy className="mx-1 mb-1">
      <WorkspaceRenameEditor workspace={workspace} onDone={onRenameDone} onCancel={onRenameCancel} />
    </InlineEditor>
    </div>
  );
}

function WorkspaceRenameEditor({ workspace, onDone, onCancel }: {
  workspace: Workspace;
  onDone: (echoed: Workspace) => void;
  onCancel: () => void;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 100 || busy) return;
    setBusy(true);
    setError(null);
    void client
      .renameWorkspaceCatalog(workspace.id, trimmed)
      .then(onDone)
      .catch((cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-workspace-rename={workspace.id}>
      <input
        data-autofocus
        aria-label={t('st.workspaces.renameTitle')}
        className="min-w-0 max-w-[42ch] flex-1 rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-selected-ink"
        value={name}
        maxLength={100}
        onChange={(event) => { setName(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        }}
      />
      <button
        type="button"
        disabled={busy || name.trim() === '' || name.trim() === workspace.name}
        onClick={submit}
        className={PRIMARY_BUTTON}
      >
        {busy ? t('common.saving') : t('common.save')}
      </button>
      <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>{t('common.cancel')}</button>
      {error !== null ? <FeedbackLine feedback={{ tone: 'error', text: error }} /> : null}
    </div>
  );
}

/**
 * Some rows could not read their trust state. One quiet line for the whole
 * page replaces what used to be the same raw server error under every row;
 * retrying re-reads every failed trust query at once. No row settling
 * re-renders this sibling, so it tracks the trust queries itself.
 */
function TrustReadFailure({ items }: { readonly items: readonly Workspace[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // The line appears only after a row's trust read has settled into a
  // failure. No row settling re-renders this sibling, so it recounts on every
  // cache event; the id list decides whether the state actually changed.
  const [failingIds, setFailingIds] = useState('');
  useEffect(() => {
    const recount = () => {
      const ids = items.filter((workspace) =>
        queryClient.getQueryState(['workspace-trust', workspace.id])?.status === 'error'
      ).map((workspace) => workspace.id).join('');
      setFailingIds((current) => (current === ids ? current : ids));
    };
    recount();
    return queryClient.getQueryCache().subscribe(recount);
  }, [items, queryClient]);
  if (failingIds === '') return null;
  return (
    <div data-workspace-trust-failure className="flex flex-wrap items-center gap-2">
      <FeedbackLine feedback={{ tone: 'error', text: t('st.workspaces.trustReadFailed') }} />
      <button type="button" className={SECONDARY_BUTTON} onClick={() => {
        void queryClient.invalidateQueries({
          predicate: (entry) => entry.queryKey[0] === 'workspace-trust' && entry.state.status === 'error',
        });
      }}>{t('common.retry')}</button>
    </div>
  );
}
