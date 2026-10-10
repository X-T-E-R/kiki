import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ListWorkspacesResponse, Workspace } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { SshProfilesPanel } from '../SshProfilesPanel';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Dialog } from '../Dialog';
import { useGuardedNavigate } from '../dirtyGuard';
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

export function WorkspacesSection() {
  const { client, scopeId, sshLabel, activateSshProfile, activateLocal } = useConnection();
  const { t, tp, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [bulkRemoving, setBulkRemoving] = useState<readonly Workspace[] | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  };

  const togglePinned = (workspace: Workspace) => {
    setPinBusy(workspace.id);
    setFeedback(null);
    void client
      .setWorkspacePinned(workspace.id, !workspace.pinned)
      .then((echoed) => {
        queryClient.setQueryData(['workspaces'], (current: ListWorkspacesResponse | undefined) =>
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
    void Promise.all(targets.filter((ws) => ws.pinned !== pinned).map((ws) => client.setWorkspacePinned(ws.id, pinned)))
      .then(invalidate)
      .catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); })
      .finally(() => { setPinBusy(null); });
  };

  return (
    <>
    <SectionCard id="st-card-workspaces" title={t('st.workspaces.title')}>
      <div className="space-y-2">
        <Hint>{t('st.workspaces.hint')}</Hint>
        <p className="text-[12px] font-medium text-ink-soft">
          {sshLabel === null ? t('connect.localScope') : `${t('connect.remoteScope')} · ${sshLabel}`}
        </p>
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
            onRename={setRenaming}
            onRemove={setRemoving}
            onBulkRemove={setBulkRemoving}
            onNewSession={(workspace) => navigate(`/new?workspace=${encodeURIComponent(workspace.id)}`)}
          />
        ) : null}
        {!query.isLoading && !query.isError && items.length === 0 ? (
          <ListEmpty
            kind="none"
            title={t('st.workspaces.emptyTitle')}
            body={t('st.workspaces.emptyBody')}
            action={<button type="button" className={SECONDARY_BUTTON} onClick={() => navigate('/new')}>{t('st.workspaces.newSession')}</button>}
          />
        ) : null}
        {query.isLoading ? <Hint>{t('st.workspaces.loading')}</Hint> : null}
        {query.isError ? <InlineError error={query.error} /> : null}
        {feedback !== null ? <FeedbackLine feedback={feedback} /> : null}
      </div>

      {renaming !== null ? (
        <WorkspaceRenameDialog
          workspace={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(echoed) => {
            queryClient.setQueryData(['workspaces'], (current: ListWorkspacesResponse | undefined) =>
              current === undefined ? current : { items: current.items.map((ws) => ws.id === echoed.id ? echoed : ws) },
            );
            setRenaming(null);
            invalidate();
          }}
        />
      ) : null}
      {removing !== null ? (
        <ConfirmDialog
          open
          overlayId="confirm-workspace-remove"
          title={t('st.workspaces.removeTitle', { name: removing.name })}
          body={t('st.workspaces.removeBody')}
          consequences={
            removing.session_count > 0
              ? [
                  tp('st.workspaces.removeKeepSessions', removing.session_count),
                  t('st.workspaces.removeNoNewSessions'),
                ]
              : [t('st.workspaces.removeNoNewSessions')]
          }
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
          consequences={[t('st.workspaces.removeNoNewSessions')]}
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

/**
 * The registered-workspace list on the shared list pattern: search by name
 * or path, chips for pinned / unused, sort, density, folding groups
 * (pinned · this week · older), row selection with bulk pin / unregister.
 * Each row keeps one visible verb (New session) and the pin mark; rename
 * and unregister live in the row's ⋯ menu so 80 rows are not 320 buttons.
 */
function WorkspaceList({ items, pinBusy, onPin, onBulkPin, onRename, onRemove, onBulkRemove, onNewSession }: {
  items: readonly Workspace[];
  pinBusy: string | null;
  onPin: (workspace: Workspace) => void;
  onBulkPin: (targets: readonly Workspace[], pinned: boolean) => void;
  onRename: (workspace: Workspace) => void;
  onRemove: (workspace: Workspace) => void;
  onBulkRemove: (targets: readonly Workspace[]) => void;
  onNewSession: (workspace: Workspace) => void;
}) {
  const { t } = useI18n();
  const filters = useMemo<ListFilterSpec<Workspace>[]>(() => [
    { id: 'pinned', label: t('st.workspaces.filter.pinned'), test: (ws) => ws.pinned },
    { id: 'unused', label: t('st.workspaces.filter.unused'), test: (ws) => ws.session_count === 0 },
  ], [t]);
  const sorts = useMemo<ListSortSpec<Workspace>[]>(() => [
    { id: 'recent', label: t('st.list.sort.recent'), compare: byRecent },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => a.name.localeCompare(b.name) },
    { id: 'sessions', label: t('st.list.sort.sessions'), compare: (a, b) => b.session_count - a.session_count || byRecent(a, b) },
  ], [t]);
  const keyOf = useCallback((ws: Workspace) => ws.id, []);
  const textOf = useCallback((ws: Workspace) => [ws.name, ws.root], []);
  const view = useListView({ listId: 'workspaces', items, keyOf, textOf, filters, sorts });
  // Group only when sorted by recency; a name or count sort is one flat list.
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
      onPin={() => { onPin(ws); }} onRename={() => { onRename(ws); }} onRemove={() => { onRemove(ws); }}
      onNewSession={() => { onNewSession(ws); }} />
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

function WorkspaceRow({ workspace, density, selecting, checked, onCheck, pinBusy, onPin, onRename, onRemove, onNewSession }: {
  workspace: Workspace;
  density: ListDensity;
  /** Some row is selected: every box shows, not only the hovered one. */
  selecting: boolean;
  checked: boolean;
  onCheck: () => void;
  pinBusy: boolean;
  onPin: () => void;
  onRename: () => void;
  onRemove: () => void;
  onNewSession: () => void;
}) {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const { t, tp, time, locale } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustFeedback, setTrustFeedback] = useState<Feedback>(null);

  const trustQuery = useQuery({
    queryKey: ['workspace-trust', workspace.id],
    queryFn: () => client.getWorkspaceTrust(workspace.id),
    staleTime: 30_000,
  });

  const isTrusted = trustQuery.data?.trusted ?? false;

  const toggleTrust = async () => {
    if (trustBusy || trustQuery.data === undefined || trustQuery.isError) return;
    setTrustBusy(true);
    setTrustFeedback(null);
    try {
      const res = isTrusted
        ? await client.untrustWorkspace(workspace.id)
        : await client.trustWorkspace(workspace.id);
      queryClient.setQueryData(['workspace-trust', workspace.id], res);
    } catch (error) {
      setTrustFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setTrustBusy(false);
    }
  };

  const compact = density === 'compact';
  const facts = `${tp('st.workspaces.sessionCount', workspace.session_count)} · ${t('st.workspaces.lastOpened', { time: time.relativeTime(workspace.last_opened_at) })}`;
  return (
    <div data-workspace-row={workspace.id} data-selected={checked ? '' : undefined}
      style={{ minHeight: LIST_ROW_HEIGHT[density] }}
      className={`group/row flex h-full items-center gap-1 pr-1.5 pl-1 transition-colors ${checked ? 'bg-ink/[0.035]' : 'hover:bg-ink/[0.02]'}`}>
      <RowCheck quiet={!selecting} checked={checked} onChange={onCheck} label={t('st.list.selectRow', { name: workspace.name })} />
      <div className="min-w-0 flex-1 py-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="min-w-0 shrink truncate text-[13px] font-medium text-ink" title={workspace.name}>{workspace.name}</p>
          {trustQuery.data !== undefined ? (
            <span
              data-workspace-trust-badge={workspace.id}
              className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none ${
                isTrusted
                  ? 'bg-ink/[0.08] text-ink'
                  : 'border border-hairline text-ink-faint'
              }`}
              title={t('st.workspaces.trustHint')}
            >
              {isTrusted ? t('st.workspaces.trusted') : t('st.workspaces.untrusted')}
            </span>
          ) : null}
          {compact ? (
            <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={workspace.root}>{workspace.root}</p>
          ) : null}
        </div>
        {compact ? null : (
          <p className="flex min-w-0 items-baseline gap-2 text-[12px] leading-4 text-ink-faint">
            <span className="min-w-0 truncate font-mono text-[11px]" title={workspace.root}>{workspace.root}</span>
            <span aria-hidden className="shrink-0">·</span>
            <span className="shrink-0">{facts}</span>
          </p>
        )}
        {trustQuery.isError ? <InlineError error={trustQuery.error} /> : null}
        <FeedbackLine feedback={trustFeedback} />
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
        disabled={trustBusy}
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
            ...(trustQuery.data !== undefined && !trustQuery.isError && !trustBusy ? [{
              key: 'trust',
              label: isTrusted ? t('st.workspaces.untrust') : t('st.workspaces.trust'),
              run: toggleTrust,
            }] : []),
            { separator: true },
            { key: 'remove', label: `${t('st.workspaces.remove')}…`, danger: true, run: onRemove },
          ]} />
      ) : null}
    </div>
  );
}

function WorkspaceRenameDialog({
  workspace,
  onClose,
  onRenamed,
}: {
  workspace: Workspace;
  onClose: () => void;
  onRenamed: (workspace: Workspace) => void;
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
      .renameWorkspace(workspace.id, trimmed)
      .then(onRenamed)
      .catch((cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <Dialog onClose={onClose} ariaLabel={t('st.workspaces.renameTitle')} overlayId="workspace-rename-dialog">
      <h2 className="font-display text-[18px] font-semibold text-ink">{t('st.workspaces.renameTitle')}</h2>
      <input
        data-autofocus
        className="mt-3 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-selected-ink"
        value={name}
        maxLength={100}
        onChange={(event) => { setName(event.target.value); }}
        onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
      />
      {error !== null ? <div className="mt-2"><FeedbackLine feedback={{ tone: 'error', text: error }} /></div> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>{t('common.cancel')}</button>
        <button
          type="button"
          disabled={busy || name.trim() === '' || name.trim() === workspace.name}
          onClick={submit}
          className={PRIMARY_BUTTON}
        >
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Dialog>
  );
}
