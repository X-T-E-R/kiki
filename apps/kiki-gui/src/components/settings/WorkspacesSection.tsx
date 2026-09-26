import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ListWorkspacesResponse, Workspace } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { filterWorkspaces, sortWorkspacesByPinnedThenRecency } from '@kiki/session-core/sessions';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Dialog } from '../Dialog';
import { useGuardedNavigate } from '../dirtyGuard';
import { PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';

export function WorkspacesSection() {
  const { client } = useConnection();
  const { t, tp, locale, time } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const visible = useMemo(
    () => filterWorkspaces(sortWorkspacesByPinnedThenRecency(items), filter),
    [items, filter],
  );

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

  return (
    <SectionCard id="st-card-workspaces" title={t('st.workspaces.title')}>
      <div className="space-y-2">
        <Hint>{t('st.workspaces.hint')}</Hint>
        {items.length > 0 ? (
          <input
            type="text"
            value={filter}
            onChange={(event) => { setFilter(event.target.value); }}
            placeholder={t('st.workspaces.search')}
            aria-label={t('st.workspaces.search')}
            className={SMALL_INPUT}
          />
        ) : null}
        {visible.map((workspace) => (
          <div key={workspace.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-[13px] font-medium text-ink" title={workspace.name}>{workspace.name}</p>
                {workspace.pinned ? (
                  <span className="rounded bg-accent/15 border border-accent/30 px-1.5 py-0.5 text-[9.5px] font-semibold text-accent">
                    {t('st.workspaces.pinnedBadge')}
                  </span>
                ) : null}
              </div>
              <p className="truncate font-mono text-[10.5px] text-ink-faint" title={workspace.root}>{workspace.root}</p>
              <p className="mt-0.5 text-[10.5px] text-ink-faint">
                {tp('st.workspaces.sessionCount', workspace.session_count)}
                {' · '}
                {t('st.workspaces.lastOpened', { time: time.relativeTime(workspace.last_opened_at) })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={() => navigate(`/new?workspace=${encodeURIComponent(workspace.id)}`)} className={SECONDARY_BUTTON}>{t('st.workspaces.newSession')}</button>
              <button
                type="button"
                data-workspace-pin={workspace.id}
                disabled={pinBusy === workspace.id}
                aria-pressed={workspace.pinned}
                onClick={() => { togglePinned(workspace); }}
                aria-label={
                  workspace.pinned
                    ? t('st.workspaces.unpinAria', { name: workspace.name })
                    : t('st.workspaces.pinAria', { name: workspace.name })
                }
                title={workspace.pinned ? t('st.workspaces.unpin') : t('st.workspaces.pin')}
                className={`rounded-md border px-2 py-1.5 text-[12px] transition-colors disabled:opacity-50 ${
                  workspace.pinned
                    ? 'border-accent/40 bg-accent-soft text-accent'
                    : 'border-hairline bg-paper text-ink-soft hover:border-hairline-strong hover:text-ink'
                }`}
              >
                ⍟
              </button>
              <button
                type="button"
                onClick={() => setRenaming(workspace)}
                aria-label={t('st.workspaces.renameAria', { name: workspace.name })}
                title={t('st.workspaces.rename')}
                className="rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
              >
                ✎
              </button>
              <button
                type="button"
                onClick={() => setRemoving(workspace)}
                aria-label={t('st.workspaces.removeAria', { name: workspace.name })}
                title={t('st.workspaces.remove')}
                className="rounded-md border border-danger/40 bg-paper px-2 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/5"
              >
                ×
              </button>
            </div>
          </div>
        ))}
        {visible.length === 0 && filter.trim() !== '' ? <Hint>{t('st.workspaces.noMatches', { query: filter.trim() })}</Hint> : null}
        {query.isLoading ? <Hint>{t('st.workspaces.loading')}</Hint> : null}
        {query.isError ? <InlineError error={query.error} /> : null}
        {!query.isLoading && !query.isError && items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-hairline bg-paper/60 px-4 py-8 text-center">
            <p className="text-[13px] font-medium text-ink">{t('st.workspaces.emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-md text-[11.5px] leading-relaxed text-ink-faint">
              {t('st.workspaces.emptyBody')}
            </p>
            <button
              type="button"
              className={`${SECONDARY_BUTTON} mt-3`}
              onClick={() => navigate('/new')}
            >
              {t('st.workspaces.newSession')}
            </button>
          </div>
        ) : null}
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
    </SectionCard>
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
      <h2 className="font-display text-[16px] font-semibold text-ink">{t('st.workspaces.renameTitle')}</h2>
      <input
        data-autofocus
        className="mt-3 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
        value={name}
        maxLength={100}
        onChange={(event) => { setName(event.target.value); }}
        onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
      />
      {error !== null ? <p className="mt-2 font-mono text-[11px] text-danger">{error}</p> : null}
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
