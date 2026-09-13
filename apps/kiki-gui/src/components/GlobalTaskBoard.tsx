import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Session, Workspace } from '@kiki/protocol';
import type { To } from 'react-router-dom';

import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { Dialog } from './Dialog';
import { TaskBoardContainer } from './task-board/TaskBoardContainer';
import type { BoardSessionOption, BoardWorkspaceOption } from './task-board/types';

export interface GlobalTaskBoardScope {
  readonly workspaceIds: readonly string[];
  readonly currentWorkspaceId?: string;
  readonly currentSessionId?: string;
  readonly workspaces: readonly BoardWorkspaceOption[];
  readonly sessions: readonly BoardSessionOption[];
}

export function resolveGlobalTaskBoardScope(input: {
  readonly activeSessionId: string | undefined;
  readonly sessions: readonly Pick<Session, 'id' | 'title' | 'workspace_id'>[];
  readonly workspaceOptions: readonly Pick<Workspace, 'id' | 'name'>[];
}): GlobalTaskBoardScope {
  const workspaceIds = input.workspaceOptions.map((workspace) => workspace.id);
  const registeredWorkspaceIds = new Set(workspaceIds);
  const activeSession = input.sessions.find((session) => session.id === input.activeSessionId);
  const currentWorkspaceId =
    activeSession !== undefined && registeredWorkspaceIds.has(activeSession.workspace_id)
      ? activeSession.workspace_id
      : undefined;

  return {
    workspaceIds,
    currentWorkspaceId,
    currentSessionId: activeSession?.id,
    workspaces: input.workspaceOptions.map(({ id, name }) => ({ id, title: name })),
    sessions: input.sessions
      .filter((session) => registeredWorkspaceIds.has(session.workspace_id))
      .map(({ id, title }) => ({ id, title })),
  };
}

export function canOpenGlobalTaskBoardSession(input: {
  readonly targetSessionId: string;
  readonly sourceWorkspaceId?: string;
  readonly sessions: readonly Pick<Session, 'id' | 'workspace_id'>[];
  readonly workspaceIds: readonly string[];
}): boolean {
  const target = input.sessions.find((session) => session.id === input.targetSessionId);
  if (target === undefined || !input.workspaceIds.includes(target.workspace_id)) return false;
  return input.sourceWorkspaceId === undefined || input.sourceWorkspaceId === target.workspace_id;
}

function EmptyBoardState({ loading, onClose, onOpenSettings }: {
  readonly loading: boolean;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      data-global-task-board-empty
      className="flex min-h-[min(52vh,420px)] flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center"
    >
      <h2 className="font-display text-[18px] font-semibold text-ink">{t('st.agentBoard.title')}</h2>
      {loading ? (
        <p role="status" className="text-[12px] text-ink-soft">{t('hero.workspaceLoading')}</p>
      ) : (
        <>
          <p role="status" className="text-[13px] font-medium text-ink">{t('new.noWorkspaces')}</p>
          <p className="max-w-md text-[12px] leading-relaxed text-ink-soft">{t('taskBoard.empty.description')}</p>
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-panel transition-colors hover:bg-accent-deep"
          >
            {t('sidebar.manageWorkspaces')}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg border border-hairline px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-accent hover:text-accent"
      >
        {t('common.close')}
      </button>
    </div>
  );
}

export interface GlobalTaskBoardProps {
  readonly activeSessionId: string | undefined;
  readonly sessions: readonly Session[];
  readonly workspaceOptions: readonly Workspace[];
  readonly workspacesLoading?: boolean;
  readonly onNavigate: (target: To) => void;
}

export function GlobalTaskBoard({
  activeSessionId,
  sessions,
  workspaceOptions,
  workspacesLoading = false,
  onNavigate,
}: GlobalTaskBoardProps) {
  const { klient } = useConnection();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [railTarget, setRailTarget] = useState<HTMLElement | null>(null);
  const [floatLift, setFloatLift] = useState(0);
  useEffect(() => {
    const update = () => {
      setRailTarget(document.querySelector<HTMLElement>('[data-session-rail]'));
      // Keep the floating fallback clear of sticky bottom action bars (e.g. the
      // search settings save bar): when such a bar reaches the float's band,
      // lift the float above the bar's top edge.
      const bar = document.querySelector<HTMLElement>('[data-search-action-bar]');
      if (!bar) {
        setFloatLift(0);
        return;
      }
      const rect = bar.getBoundingClientRect();
      const base = window.innerWidth >= 640 ? 64 : 72;
      const nearBottom = rect.bottom > window.innerHeight - 110 && rect.top < window.innerHeight;
      setFloatLift(nearBottom ? Math.max(0, window.innerHeight - rect.top + 12 - base) : 0);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, { capture: true });
    };
  }, []);
  const scope = useMemo(
    () => resolveGlobalTaskBoardScope({ activeSessionId, sessions, workspaceOptions }),
    [activeSessionId, sessions, workspaceOptions],
  );

  const close = useCallback(() => { setOpen(false); }, []);
  const openSession = useCallback(
    (targetSessionId: string, sourceWorkspaceId?: string) => {
      if (!canOpenGlobalTaskBoardSession({
        targetSessionId,
        sourceWorkspaceId,
        sessions,
        workspaceIds: scope.workspaceIds,
      })) {
        return;
      }
      close();
      onNavigate(`/s/${targetSessionId}`);
    },
    [close, onNavigate, scope.workspaceIds, sessions],
  );
  const openSettings = useCallback(() => {
    close();
    onNavigate('/settings/workspaces');
  }, [close, onNavigate]);

  let content: ReactNode;
  if (scope.workspaceIds.length === 0) {
    content = (
      <EmptyBoardState
        loading={workspacesLoading}
        onClose={close}
        onOpenSettings={openSettings}
      />
    );
  } else {
    content = (
      <TaskBoardContainer
        key={`${scope.currentSessionId ?? 'none'}:${scope.workspaceIds.join(',')}`}
        client={klient.global.board}
        workspaceIds={scope.workspaceIds}
        currentWorkspaceId={scope.currentWorkspaceId}
        currentSessionId={scope.currentSessionId}
        workspaces={scope.workspaces}
        sessions={scope.sessions}
        onOpenSession={openSession}
        onOpenSettings={openSettings}
        onCloseBoard={close}
      />
    );
  }

  const launcher = (
    <button
      type="button"
      data-session-task-board
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t('st.agentBoard.title')}
      onClick={() => { setOpen(true); }}
      style={railTarget ? undefined : { marginBottom: floatLift }}
      className={railTarget
        ? 'app-rail__board-launcher flex min-h-12 shrink-0 items-center justify-between gap-2 border-t border-hairline bg-panel px-4 py-2 text-left text-[12px] font-medium text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent'
        : 'fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-50 rounded-lg border border-hairline bg-panel px-3 py-2 text-[11.5px] font-medium text-ink-soft shadow-sm transition-colors hover:border-accent hover:text-accent sm:bottom-[calc(4rem+env(safe-area-inset-bottom))]'}
    >
      <span>{t('st.agentBoard.title')}</span>
      {railTarget ? <span aria-hidden className="text-[16px] leading-none">↗</span> : null}
    </button>
  );

  return (
    <>
      {railTarget ? createPortal(launcher, railTarget) : launcher}
      {open ? (
        <Dialog
          onClose={close}
          ariaLabel={t('st.agentBoard.title')}
          overlayId="global-task-board"
          panelClassName="anim-enter flex h-[min(90vh,800px)] w-full max-w-[min(96vw,1280px)] flex-col overflow-hidden rounded-2xl border border-hairline bg-panel p-0 shadow-[0_16px_48px_-16px_rgba(28,25,23,0.35)]"
        >
          {content}
        </Dialog>
      ) : null}
    </>
  );
}
