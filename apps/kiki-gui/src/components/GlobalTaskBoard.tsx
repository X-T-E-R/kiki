/**
 * /board — the one task board page. Workspace is a filter, not a separate
 * page: the scope rides `?workspace=` (the sidebar nav and the inspector
 * link pre-fill it from the current session), and the board's own scope
 * select switches between one workspace and all of them.
 */
import { useCallback, useMemo } from 'react';
import type { Session, Workspace } from '@kiki/protocol';
import type { To } from 'react-router-dom';

import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { PageHeader, useWorkspaceScope } from './PageChrome';
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

function EmptyBoardState({ loading, onOpenSettings }: {
  readonly loading: boolean;
  readonly onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-global-task-board-empty
      className="flex flex-1 flex-col items-start justify-center gap-2 px-6 py-10 lg:px-10"
    >
      {loading ? (
        <p role="status" className="text-[13px] text-ink-soft">{t('hero.workspaceLoading')}</p>
      ) : (
        <>
          <h2 className="font-display text-[18px] font-semibold text-ink">{t('new.noWorkspaces')}</h2>
          <p className="max-w-md text-[13px] leading-relaxed text-ink-soft">{t('taskBoard.empty.description')}</p>
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-1 rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-paper transition-colors hover:bg-ink/85"
          >
            {t('sidebar.manageWorkspaces')}
          </button>
        </>
      )}
    </div>
  );
}

export interface TaskBoardPageProps {
  /** The session the user came from (last session route), for the create default. */
  readonly originSessionId: string | undefined;
  readonly sessions: readonly Session[];
  readonly workspaceOptions: readonly Workspace[];
  readonly workspacesLoading?: boolean;
  readonly onNavigate: (target: To) => void;
  readonly onToggleSidebar: () => void;
}

export function TaskBoardPage({
  originSessionId,
  sessions,
  workspaceOptions,
  workspacesLoading = false,
  onNavigate,
  onToggleSidebar,
}: TaskBoardPageProps) {
  const { klient } = useConnection();
  const { t } = useI18n();
  const { scope: workspaceScope, setScope } = useWorkspaceScope(workspaceOptions);
  const scope = useMemo(
    () => resolveGlobalTaskBoardScope({ activeSessionId: originSessionId, sessions, workspaceOptions }),
    [originSessionId, sessions, workspaceOptions],
  );
  const openSession = useCallback(
    (targetSessionId: string, sourceWorkspaceId?: string) => {
      if (!canOpenGlobalTaskBoardSession({ targetSessionId, sourceWorkspaceId, sessions, workspaceIds: scope.workspaceIds })) return;
      onNavigate(`/s/${targetSessionId}`);
    },
    [onNavigate, scope.workspaceIds, sessions],
  );
  const openSettings = useCallback(() => { onNavigate('/settings/workspaces'); }, [onNavigate]);

  return (
    <div data-task-board-page className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
      {/* The board renders its own title row (search, scope, new task), so the
          page header only carries the mobile menu entry. */}
      <div className="md:hidden">
        <PageHeader title={t('nav.board')} onToggleSidebar={onToggleSidebar} />
      </div>
      {scope.workspaceIds.length === 0 ? (
        <EmptyBoardState loading={workspacesLoading} onOpenSettings={openSettings} />
      ) : (
        <TaskBoardContainer
          key={scope.workspaceIds.join(',')}
          client={klient.global.board}
          workspaceIds={scope.workspaceIds}
          currentWorkspaceId={workspaceScope ?? scope.currentWorkspaceId}
          currentSessionId={scope.currentSessionId}
          workspaces={scope.workspaces}
          sessions={scope.sessions}
          scopeSelection={workspaceScope ?? 'all'}
          onScopeSelectionChange={(next) => { setScope(next === 'all' ? undefined : next); }}
          onOpenSession={openSession}
          onOpenSettings={openSettings}
          // The routed page shares the sheet between lanes (1fr each, 200px
          // floor) so all five fit a 1440 window beside the sidebar; phones
          // keep the board's one-lane snap layout.
          laneLayout="fill"
        />
      )}
    </div>
  );
}
