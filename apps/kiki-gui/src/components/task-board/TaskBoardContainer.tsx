import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { LocalizedError } from '@kiki/session-core/i18n';
import type { BoardCard, BoardPatch, BoardStatus, BoardSummary } from '@kiki/klient/contract/board/types';
import { useI18n } from '../../i18n';
import { useConnection, useControllerRegistry } from '../../state/connection';
import { TaskBoard } from './TaskBoard';
import {
  BoardAssociatedTodosProvider,
  createBoardAssociatedTodoManager,
} from './BoardAssociatedTodos';
import { boardCardKey, TaskBoardController, type TaskBoardClient } from './TaskBoardController';
import { OWN_WORK_BOARD_COLUMNS, type BoardSessionOption, type BoardTask, type BoardWorkspaceOption, type TaskPriority } from './types';

export interface TaskBoardContainerProps {
  readonly client: TaskBoardClient;
  readonly workspaceIds: readonly string[];
  readonly currentWorkspaceId?: string;
  readonly currentSessionId?: string;
  readonly workspaces?: readonly BoardWorkspaceOption[];
  readonly sessions?: readonly BoardSessionOption[];
  readonly onOpenSession?: (sessionId: string, workspaceId?: string) => void;
  readonly onOpenSettings?: () => void;
  readonly onCloseBoard?: () => void;
}
const toPriority: Record<string, TaskPriority> = { P0: 'urgent', P1: 'high', P2: 'medium', P3: 'low' };
const fromPriority = { urgent: 'P0', high: 'P1', medium: 'P2', low: 'P3' } as const;
const statuses = new Set<string>(['active', 'in_progress', 'paused', 'done', 'cancelled', 'superseded']);
function nativeStatus(value: string): BoardStatus {
  if (!statuses.has(value)) throw new LocalizedError({ key: 'taskBoard.error.invalidPresentationStatus' });
  return value as BoardStatus;
}
function view(card: BoardSummary | BoardCard, workspaces: readonly BoardWorkspaceOption[]): BoardTask {
  return {
    id: boardCardKey(card), recordId: card.id, title: card.title, description: 'description' in card ? card.description : '',
    detailLoaded: 'description' in card, category: card.category, status: card.status,
    priority: toPriority[card.priority] ?? 'medium', revision: card.revision,
    createdAt: Date.parse(card.createdAt), updatedAt: Date.parse(card.updatedAt),
    workspaceId: card.workspaceId, workspaceTitle: workspaces.find((entry) => entry.id === card.workspaceId)?.title,
    associatedSessionIds: card.sessionIds, linkedExecutionIds: card.executionIds,
    executions: [], archivedAt: card.archived ? Date.parse(card.completedAt ?? card.updatedAt) : undefined,
  };
}

export function TaskBoardContainer({ client, workspaceIds, currentWorkspaceId, currentSessionId, workspaces = [], sessions = [], onOpenSession, onOpenSettings, onCloseBoard }: TaskBoardContainerProps) {
  const { t } = useI18n();
  const { client: sessionClient, klient } = useConnection();
  const registry = useControllerRegistry();
  const associatedTodoManager = useMemo(() => createBoardAssociatedTodoManager({
    sessionClient: sessionClient.sessions,
    klient,
    registry,
  }), [sessionClient, klient, registry]);
  const controller = useMemo(() => new TaskBoardController(client), [client]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Load scope: opening the board from a session reads only that session's
  // workspace (~tens of ms) instead of aggregating every registered one; the
  // header switcher opts back into the full cross-workspace overview.
  const [scopeSelection, setScopeSelection] = useState<string>(currentWorkspaceId ?? 'all');
  const scopedWorkspaceIds = useMemo(
    () => (scopeSelection === 'all' || !workspaceIds.includes(scopeSelection) ? workspaceIds : [scopeSelection]),
    [scopeSelection, workspaceIds],
  );
  const scopeKey = JSON.stringify(scopedWorkspaceIds);
  useEffect(() => {
    void controller.refresh(JSON.parse(scopeKey) as string[]);
    return () => controller.cancelRefresh();
  }, [controller, scopeKey]);
  const tasks = useMemo(() => snapshot.cards.map((card) => view(card, workspaces)), [snapshot.cards, workspaces]);
  const columns = OWN_WORK_BOARD_COLUMNS;
  const refresh = () => controller.refresh(scopedWorkspaceIds);
  return (
    <BoardAssociatedTodosProvider manager={associatedTodoManager}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <TaskBoard
        tasks={tasks} columns={columns} prototypeMode={false}
        onRefresh={refresh} refreshDisabled={snapshot.loading} refreshLabel={t('taskBoard.refresh')}
        workspaces={workspaces} sessions={sessions} currentWorkspaceId={currentWorkspaceId} currentSessionId={currentSessionId}
        scopeSelection={scopeSelection} onScopeSelectionChange={setScopeSelection}
        loading={snapshot.loading} error={snapshot.error} pendingTaskIds={snapshot.pendingKeys}
        issues={snapshot.issues} cardIssues={snapshot.cardIssues} unavailable={snapshot.refreshFailed} onOpenSettings={onOpenSettings}
        onOpenTask={(key) => controller.open(key)} onOpenSession={onOpenSession} onCloseBoard={onCloseBoard}
        onCreateTask={async (data) => {
          const workspaceId = data.workspaceId ?? currentWorkspaceId;
          if (!workspaceId) throw new LocalizedError({ key: 'taskBoard.error.workspaceRequired' });
          if (!workspaceIds.includes(workspaceId)) throw new LocalizedError({ key: 'taskBoard.error.workspaceUnauthorized' });
          await controller.create({ workspaceId, requestKey: data.requestKey ?? crypto.randomUUID(), title: data.title,
            description: data.description, category: data.category, priority: fromPriority[data.priority],
            sessionIds: data.associatedSessionId ? [data.associatedSessionId] : [] });
        }}
        onUpdateTask={async (key, updated) => {
          if (updated.revision === undefined) throw new LocalizedError({ key: 'taskBoard.error.reloadBeforeEdit' });
          const patch: BoardPatch = {
            title: updated.title, description: updated.description, category: updated.category,
            priority: updated.priority ? fromPriority[updated.priority] : undefined,
            status: updated.status ? nativeStatus(updated.status) : undefined,
            sessionIds: updated.associatedSessionIds ? [...updated.associatedSessionIds] : undefined,
          };
          await controller.update(key, updated.revision, patch);
        }}
        onMoveTaskStatus={async (key, status) => {
          const card = snapshot.cards.find((entry) => boardCardKey(entry) === key);
          if (!card) throw new LocalizedError({ key: 'taskBoard.error.refreshBeforeMove' });
          await controller.update(key, card.revision, { status: nativeStatus(status) });
        }}
        />
      </div>
    </BoardAssociatedTodosProvider>
  );
}
