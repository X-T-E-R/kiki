/**
 * Session sidebar — wordmark header with connection pill, new-session shortcut,
 * settings entry, and the session list (polled every 5s).
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { Session } from '@moonshot-ai/protocol';

import { relativeTime } from '../lib/time';
import { registerOverlay } from '../lib/uiBusy';
import { useConnection } from '../state/connection';
import { Wordmark } from './Wordmark';

function StatusDot({ session }: { session: Session }) {
  const pending = session.pending_interaction ?? 'none';
  if (pending === 'approval' || pending === 'question') {
    return (
      <span
        title={pending === 'approval' ? 'Awaiting approval' : 'Awaiting answer'}
        className="block h-2 w-2 shrink-0 rounded-full bg-amber-rule shadow-[0_0_0_2px_rgba(232,176,75,0.25)]"
      />
    );
  }
  if (session.busy) {
    return (
      <span
        title="Working"
        className="status-dot-busy block h-2 w-2 shrink-0 rounded-full bg-accent"
      />
    );
  }
  return (
    <span
      title="Idle"
      className="block h-2 w-2 shrink-0 rounded-full border border-hairline-strong bg-panel"
    />
  );
}

function sessionLabel(session: Session): string {
  if (session.title.trim() !== '') return session.title;
  if (session.last_prompt !== undefined && session.last_prompt.trim() !== '') {
    return session.last_prompt;
  }
  return 'Untitled session';
}

export function Sidebar({
  activeSessionId,
  sessions,
  sessionsQuery,
  showArchived,
  onToggleArchived,
  className,
}: {
  activeSessionId: string | undefined;
  sessions: readonly Session[];
  sessionsQuery: {
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    fetchNextPage?: () => Promise<unknown>;
  };
  showArchived: boolean;
  onToggleArchived: () => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const { client, meta, wsStatus, disconnect } = useConnection();
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshSessions = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const archive = (session: Session) => {
    setMenu(null);
    setActionError(null);
    void client
      .archiveSession(session.id)
      .then(() => refreshSessions())
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };

  const restore = (session: Session) => {
    setMenu(null);
    setActionError(null);
    void client
      .restoreSession(session.id)
      .then(() => refreshSessions())
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <aside className={className ?? 'flex h-full w-[264px] shrink-0 flex-col border-r border-hairline bg-panel'}>
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <Wordmark />
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            wsStatus === 'open'
              ? 'border-success/30 text-success'
              : wsStatus === 'connecting'
                ? 'border-amber-rule/40 text-amber-ink'
                : 'border-danger/30 text-danger'
          }`}
          title={`kap-server ${meta.server_version} · ws ${wsStatus}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              wsStatus === 'open'
                ? 'bg-success'
                : wsStatus === 'connecting'
                  ? 'bg-amber-rule'
                  : 'bg-danger'
            }`}
          />
          {wsStatus === 'open' ? `v${meta.server_version}` : wsStatus}
        </span>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => navigate('/new')}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-hairline-strong bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-accent hover:text-accent"
        >
          <span aria-hidden className="text-[14px] leading-none">＋</span> New session
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessionsQuery.isLoading && sessions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-2 pt-6 text-[12px] text-ink-faint">
            <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
            Loading sessions…
          </div>
        ) : null}
        {sessionsQuery.isError ? (
          <div className="mx-1 mt-2 rounded-md border border-danger/30 bg-danger/5 p-2">
            <p className="text-[11.5px] font-medium text-danger">Could not load sessions</p>
            <p className="font-mono text-[10px] text-danger/80">
              {sessionsQuery.error?.message ?? 'Unknown error'}
            </p>
            <button
              type="button"
              onClick={() => queryClient.invalidateQueries({ queryKey: ['sessions'] })}
              className="mt-1.5 text-[11px] font-medium text-danger underline"
            >
              Retry
            </button>
          </div>
        ) : null}
        {sessions.length === 0 && !sessionsQuery.isLoading && !sessionsQuery.isError ? (
          <p className="px-2 pt-6 text-center text-[12px] text-ink-faint">
            No sessions yet — start one above.
          </p>
        ) : null}
        {actionError !== null ? (
          <p className="mx-1 mb-1 rounded-md border border-danger/30 bg-danger/5 px-2 py-1 font-mono text-[10.5px] text-danger">
            {actionError}
          </p>
        ) : null}
        {sessions.map((session) => {
          const active = session.id === activeSessionId;
          const archived = session.archived === true;
          return (
            <div key={session.id} className="group relative mb-0.5">
              <button
                type="button"
                onClick={() => navigate(`/s/${session.id}`)}
                className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  active
                    ? 'border-hairline bg-accent-soft'
                    : 'border-transparent hover:bg-paper'
                } ${archived ? 'opacity-55' : ''}`}
              >
                <span className="flex w-2 shrink-0 justify-center pt-[7px]">
                  <StatusDot session={session} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[12.5px] leading-snug ${
                      active ? 'font-semibold text-ink' : 'font-medium text-ink'
                    }`}
                  >
                    {sessionLabel(session)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                    <span className="truncate font-mono">{shortCwd(session.metadata.cwd)}</span>
                    <span className="shrink-0">· {relativeTime(session.updated_at)}</span>
                    {archived ? <span className="shrink-0">· archived</span> : null}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`Session actions for ${sessionLabel(session)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu((current) =>
                    current?.session.id === session.id
                      ? null
                      : { session, x: rect.right + 4, y: rect.top },
                  );
                }}
                className={`absolute top-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[12px] leading-none text-ink-faint transition-opacity hover:bg-panel hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none ${
                  menu?.session.id === session.id
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                ⋯
              </button>
            </div>
          );
        })}
        {sessionsQuery.hasNextPage ? (
          <button
            type="button"
            disabled={sessionsQuery.isFetchingNextPage}
            onClick={() => sessionsQuery.fetchNextPage?.()}
            className="mt-2 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-center text-[11px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-60"
          >
            {sessionsQuery.isFetchingNextPage ? 'Loading…' : 'Load more sessions'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggleArchived}
          className="mt-1 w-full rounded-md px-2 py-1 text-center text-[10.5px] text-ink-faint transition-colors hover:text-ink-soft focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none"
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </div>

      <div className="border-t border-hairline px-3 py-2.5 space-y-1">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] text-ink-soft transition-colors hover:bg-paper hover:text-ink"
        >
          <span aria-hidden className="text-[13px]">⚙</span> Settings
        </button>
        <button
          type="button"
          onClick={disconnect}
          className="w-full rounded-lg px-2 py-1 text-left text-[11.5px] text-ink-soft transition-colors hover:text-danger"
        >
          Disconnect
        </button>
      </div>

      {menu !== null ? (
        <SessionMenu
          session={menu.session}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => {
            setRenaming(menu.session);
            setMenu(null);
          }}
          onArchive={() => archive(menu.session)}
          onRestore={() => restore(menu.session)}
        />
      ) : null}
      {renaming !== null ? (
        <RenameDialog
          session={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            void refreshSessions();
          }}
        />
      ) : null}
    </aside>
  );
}

/** Small hand-rolled context menu (no Radix): fixed panel, outside-click and
 * Escape to close. */
function SessionMenu({
  session,
  x,
  y,
  onClose,
  onRename,
  onArchive,
  onRestore,
}: {
  session: Session;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const archived = session.archived === true;
  useEffect(() => {
    const unregister = registerOverlay('session-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-session-menu]') === null) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  const itemClass =
    'w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper';
  return (
    <div
      data-session-menu
      role="menu"
      className="anim-enter fixed z-50 w-36 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]"
      style={{ left: Math.min(x, window.innerWidth - 160), top: y }}
    >
      {archived ? (
        <button type="button" role="menuitem" className={itemClass} onClick={onRestore}>
          Restore
        </button>
      ) : (
        <>
          <button type="button" role="menuitem" className={itemClass} onClick={onRename}>
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${itemClass} hover:text-danger`}
            onClick={onArchive}
          >
            Archive
          </button>
        </>
      )}
    </div>
  );
}

/** Rename dialog seeded with the current title; POSTs the profile update. */
function RenameDialog({
  session,
  onClose,
  onRenamed,
}: {
  session: Session;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { client } = useConnection();
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => registerOverlay('rename-dialog'), []);

  const submit = () => {
    const trimmed = title.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    void client
      .updateSessionProfile(session.id, { title: trimmed })
      .then(onRenamed)
      .catch((error: unknown) => {
        setBusy(false);
        setError(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20"
      onClick={onClose}
    >
      <div
        className="anim-enter w-full max-w-[360px] rounded-2xl border border-hairline bg-panel p-5 shadow-[0_16px_48px_-16px_rgba(28,25,23,0.35)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="font-display text-[16px] font-semibold text-ink">Rename session</h2>
        <input
          autoFocus
          className="mt-3 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
            if (event.key === 'Escape') onClose();
          }}
        />
        {error !== null ? (
          <p className="mt-2 font-mono text-[11px] text-danger">{error}</p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || title.trim() === ''}
            onClick={submit}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortCwd(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter((part) => part !== '');
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join('/')}`;
}
