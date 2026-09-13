import { memo, useState, useMemo } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';
import type {
  BoardTask,
  BoardColumnDef,
  BoardWorkspaceOption,
  BoardSessionOption,
  NewTaskFormData,
  BoardTaskStatus,
} from './types';
import { DEFAULT_BOARD_COLUMNS } from './types';
import type { BoardWorkspaceIssue } from './TaskBoardController';
import { useI18n } from '../../i18n';
import { TaskCard } from './TaskCard';
import { TaskDetailModal } from './TaskDetailModal';
import { NewTaskModal } from './NewTaskModal';

const ISSUE_REASON_KEYS: Readonly<Record<string, I18nKey>> = {
  BOARD_UNAVAILABLE: 'taskBoard.issueReason.BOARD_UNAVAILABLE',
  BOARD_ACCESS_DENIED: 'taskBoard.issueReason.BOARD_ACCESS_DENIED',
  WORKSPACE_NOT_FOUND: 'taskBoard.issueReason.WORKSPACE_NOT_FOUND',
  BOARD_REQUEST_FAILED: 'taskBoard.issueReason.BOARD_REQUEST_FAILED',
};

export interface TaskBoardProps {
  readonly tasks: readonly BoardTask[];
  readonly columns?: readonly BoardColumnDef[];
  readonly workspaces?: readonly BoardWorkspaceOption[];
  readonly sessions?: readonly BoardSessionOption[];
  readonly currentWorkspaceId?: string;
  readonly currentSessionId?: string;
  /** Controlled load scope ('all' or a workspace id); paired with onScopeSelectionChange. */
  readonly scopeSelection?: string;
  /** When set, the workspace selector drives the board's load scope instead of a local view filter. */
  readonly onScopeSelectionChange?: (selection: string) => void;
  readonly loading?: boolean;
  readonly error?: string | null;
  /** Refresh-time degradation: workspaces whose board data could not load. */
  readonly issues?: readonly BoardWorkspaceIssue[];
  /** Card-level load issues from healthy workspaces, counted apart from workspaces. */
  readonly cardIssues?: readonly BoardWorkspaceIssue[];
  /** No workspace could be loaded at all — the host cannot serve the board. */
  readonly unavailable?: boolean;
  readonly pendingTaskIds?: readonly string[];
  readonly onRefresh?: () => void | Promise<void>;
  readonly refreshDisabled?: boolean;
  readonly refreshLabel?: string;
  readonly onOpenSettings?: () => void;
  readonly onMoveTaskStatus?: (taskId: string, newStatus: BoardTaskStatus) => void | Promise<void>;
  readonly onCreateTask?: (data: NewTaskFormData) => void | Promise<void>;
  readonly onUpdateTask?: (taskId: string, updated: Partial<BoardTask>) => void | Promise<void>;
  readonly onOpenTask?: (taskId: string) => void | Promise<void>;
  readonly onDeleteTask?: (taskId: string) => void | Promise<void>;
  readonly onRunInSession?: (taskId: string, sessionId?: string) => void;
  readonly onOpenSession?: (sessionId: string, workspaceId?: string) => void;
  readonly onCloseBoard?: () => void;
  readonly className?: string;
  readonly prototypeMode?: boolean;
}

export const TaskBoard = memo(function TaskBoard({
  tasks,
  columns = DEFAULT_BOARD_COLUMNS,
  workspaces = [],
  sessions = [],
  currentWorkspaceId,
  currentSessionId,
  scopeSelection,
  onScopeSelectionChange,
  loading = false,
  error = null,
  issues = [],
  cardIssues = [],
  unavailable = false,
  pendingTaskIds = [],
  onRefresh,
  refreshDisabled = false,
  refreshLabel = 'Refresh',
  onOpenSettings,
  onMoveTaskStatus,
  onCreateTask,
  onUpdateTask,
  onOpenTask,
  onDeleteTask,
  onRunInSession,
  onOpenSession,
  onCloseBoard,
  className = '',
  prototypeMode = true,
}: TaskBoardProps) {
  const { t, tp } = useI18n();

  // Local view filters (pure UI state)
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedWorkspaceFilter, setSelectedWorkspaceFilter] = useState<string>(
    currentWorkspaceId ?? 'all',
  );
  const [selectedSessionFilter, setSelectedSessionFilter] = useState<string>('all');
  // When the host controls the load scope, the workspace selector reflects and
  // drives that scope; otherwise it stays a pure client-side filter.
  const workspaceFilterValue = onScopeSelectionChange !== undefined
    ? (scopeSelection ?? 'all')
    : selectedWorkspaceFilter;

  // Active modals
  const [selectedTask, setSelectedTask] = useState<BoardTask | null>(null);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const sessionLabels = useMemo(
    () => Object.fromEntries(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );

  const workspaceTitle = useMemo(() => {
    const titles = new Map(workspaces.map((entry) => [entry.id, entry.title]));
    return (workspaceId: string | undefined): string =>
      workspaceId === undefined ? '' : (titles.get(workspaceId) ?? workspaceId);
  }, [workspaces]);

  const issueWorkspaceNames = useMemo(
    () =>
      [
        ...new Set(
          issues
            .map((issue) => issue.workspaceId)
            .filter((id): id is string => id !== undefined),
        ),
      ].map((id) => workspaceTitle(id)),
    [issues, workspaceTitle],
  );

  const showUnavailable = unavailable && tasks.length === 0;

  // Filtering tasks by query, workspace and session
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // 1. Search Query
      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        const matches =
          task.title.toLowerCase().includes(q) ||
          task.description.toLowerCase().includes(q) ||
          (task.prompt && task.prompt.toLowerCase().includes(q));
        if (!matches) return false;
      }

      // 2. Workspace Filter
      if (workspaceFilterValue !== 'all') {
        if (task.workspaceId !== workspaceFilterValue) return false;
      }

      // 3. Session Filter
      if (selectedSessionFilter !== 'all') {
        if (!task.associatedSessionIds?.includes(selectedSessionFilter)) return false;
      }

      return true;
    });
  }, [tasks, searchQuery, workspaceFilterValue, selectedSessionFilter]);

  return (
    <div
      data-task-board-container
      className={`flex min-h-0 min-w-0 flex-1 flex-col bg-paper font-sans text-ink select-none relative ${className}`}
    >
      {/* Prototype Indicator Banner */}
      {prototypeMode ? (
        <div
          data-prototype-badge
          className="shrink-0 bg-amber-card/80 border-b border-amber-rule/30 px-5 py-1.5 text-[11px] font-mono text-amber-ink flex items-center justify-between"
        >
          <span>PROTOTYPE DISPLAY SLICE · Workboard / 看板 (未接持久服务)</span>
          <span>Runtime: Decoupled Mock Layer</span>
        </div>
      ) : null}

      {/* Error alert banner */}
      {error ? (
        <div className="shrink-0 bg-danger/10 border-b border-danger/20 px-5 py-2 text-[12px] text-danger flex items-center justify-between">
          <span>看板数据加载/同步异常: {error}</span>
        </div>
      ) : null}

      {/* Partial refresh degradation: failed workspaces and broken cards are counted separately */}
      {!showUnavailable && (issues.length > 0 || cardIssues.length > 0) ? (
        <div
          data-task-board-issues
          className="flex shrink-0 items-center gap-2 border-b border-amber-rule/30 bg-amber-card/70 px-5 py-2 text-[12px] text-amber-ink"
        >
          <span
            className="min-w-0 truncate"
            title={[...issues, ...cardIssues].map((issue) => issue.message).join('\n')}
          >
            {issues.length > 0 ? tp('taskBoard.issues.partial', issues.length) : ''}
            {issues.length > 0 && cardIssues.length > 0 ? ' · ' : ''}
            {cardIssues.length > 0 ? tp('taskBoard.issues.cards', cardIssues.length) : ''}
            {issueWorkspaceNames.length > 0 ? ` · ${issueWorkspaceNames.join('、')}` : ''}
          </span>
        </div>
      ) : null}

      {/* Header Bar */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-panel px-5 py-3.5">
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          {onCloseBoard ? (
            <button
              type="button"
              onClick={onCloseBoard}
              aria-label="Back to Session"
              className="flex items-center gap-1 rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] font-medium text-ink-soft hover:border-accent hover:text-accent transition-colors"
            >
              <span>‹</span>
              <span>返回会话</span>
            </button>
          ) : null}

          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-display text-[19px] font-semibold text-ink leading-none">
                需求与任务看板
              </h2>
              {loading ? (
                <span className="font-mono text-[10.5px] text-accent animate-pulse">
                  同步中...
                </span>
              ) : null}
            </div>
            <span className="font-mono text-[11px] text-ink-faint">
              共 {filteredTasks.length} / {tasks.length} 项需求
            </span>
          </div>
        </div>

        {/* Action Controls & Filters */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2.5">
          {/* Search Box */}
          <input
            type="search"
            placeholder="搜索任务/提示词..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-60 max-w-full min-w-0 rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-hidden"
          />

          {/* Workspace scope (All / Specific Workspace) — drives the load scope when controlled */}
          <select
            data-task-board-scope
            aria-label={t('taskBoard.scope.label')}
            title={t('taskBoard.scope.label')}
            value={workspaceFilterValue}
            onChange={(e) => {
              if (onScopeSelectionChange !== undefined) onScopeSelectionChange(e.target.value);
              else setSelectedWorkspaceFilter(e.target.value);
            }}
            className="w-52 max-w-full min-w-0 rounded-lg border border-hairline bg-paper px-2.5 py-1.5 text-[12px] text-ink focus:border-accent focus:outline-hidden font-mono"
          >
            <option value="all">{t('taskBoard.scope.all')}</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                📁 {ws.title}
              </option>
            ))}
          </select>

          {/* Session Association Filter */}
          <select
            value={selectedSessionFilter}
            onChange={(e) => setSelectedSessionFilter(e.target.value)}
            className="w-60 max-w-full min-w-0 rounded-lg border border-hairline bg-paper px-2.5 py-1.5 text-[12px] text-ink focus:border-accent focus:outline-hidden font-mono"
          >
            <option value="all">全部会话关联</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                ⌁ {s.title}
              </option>
            ))}
          </select>

          {onRefresh ? (
            <button
              type="button"
              data-task-board-refresh
              disabled={refreshDisabled}
              onClick={() => { void onRefresh(); }}
              className="rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshLabel}
            </button>
          ) : null}

          {/* New Task Button */}
          <button
            type="button"
            onClick={() => setShowNewTaskModal(true)}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-panel hover:bg-accent-deep transition-colors shadow-xs"
          >
            + 新建需求
          </button>
        </div>
      </header>

      {/* Board body: full degradation when no workspace could be served */}
      {showUnavailable ? (
        <div
          data-task-board-unavailable
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3.5 overflow-y-auto px-6 py-12 text-center"
        >
          <h3 className="font-display text-[17px] font-semibold text-ink">
            {t('taskBoard.unavailable.title')}
          </h3>
          <p className="max-w-xl text-[13px] leading-relaxed text-ink-soft">
            {t('taskBoard.unavailable.description')}
          </p>
          {issues.length > 0 ? (
            <ul className="w-full max-w-xl space-y-1.5 rounded-xl border border-hairline bg-panel px-4 py-3 text-left">
              {issues.slice(0, 8).map((issue, index) => (
                <li
                  key={`${issue.workspaceId ?? 'host'}:${index}`}
                  className="flex items-baseline gap-2 text-[12px]"
                  title={issue.message}
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-ink-soft">
                    {workspaceTitle(issue.workspaceId)}
                  </span>
                  <span className="shrink-0 text-ink-faint">
                    {t(ISSUE_REASON_KEYS[issue.code] ?? 'taskBoard.issueReason.unknown')}
                  </span>
                </li>
              ))}
              {issues.length > 8 ? (
                <li className="text-[11px] text-ink-faint">+{issues.length - 8}</li>
              ) : null}
            </ul>
          ) : null}
          <div className="flex items-center gap-2.5">
            {onRefresh ? (
              <button
                type="button"
                data-task-board-unavailable-retry
                disabled={refreshDisabled}
                onClick={() => { void onRefresh(); }}
                className="rounded-lg border border-hairline px-3.5 py-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('common.retry')}
              </button>
            ) : null}
            {onOpenSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-lg border border-hairline px-3.5 py-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent"
              >
                {t('sidebar.manageWorkspaces')}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
      /* Kanban Columns Grid (Scrollable horizontally) */
      <div className="flex min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-contain p-5">
        <div className="grid h-full min-h-0 min-w-max grid-flow-col auto-cols-[minmax(330px,400px)] gap-4">
          {columns.map((col) => {
            const colTasks = filteredTasks.filter((t) => t.status === col.status);
            const isManualTarget = !prototypeMode || col.status === 'backlog' || col.status === 'todo';

            return (
              <section
                key={col.status}
                data-board-column={col.status}
                onDragOver={(e) => {
                  if (isManualTarget) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(e) => {
                  if (isManualTarget) {
                    e.preventDefault();
                    const taskId = e.dataTransfer.getData('text/plain');
                    if (taskId && onMoveTaskStatus && !pendingTaskIds.includes(taskId)) {
                      void Promise.resolve(onMoveTaskStatus(taskId, col.status)).catch(() => undefined);
                    }
                  }
                }}
                className="flex min-h-0 min-w-0 w-[min(400px,calc(100vw-2.5rem))] max-w-[400px] flex-col overflow-hidden rounded-2xl border border-hairline bg-paper/60 p-3.5"
              >
                {/* Column Header */}
                <div className="flex shrink-0 items-center justify-between gap-2 pb-2.5 mb-2.5 border-b border-hairline">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        col.status === 'running' || col.status === 'in_progress'
                          ? 'bg-accent/60'
                          : col.status === 'done'
                            ? 'bg-success/60'
                            : col.status === 'todo'
                              ? 'bg-amber-rule'
                              : col.status === 'failed'
                                ? 'bg-danger/60'
                                : 'bg-ink-faint'
                      }`}
                    />
                    <h3 className="min-w-0 truncate font-mono text-[12.5px] font-semibold tracking-wider text-ink uppercase">
                      {col.label}
                    </h3>
                  </div>
                  <span className="shrink-0 rounded-full border border-hairline bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-faint">
                    {colTasks.length}
                  </span>
                </div>

                {/* Column Cards Scrollable List */}
                <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-y-contain pr-1">
                  {colTasks.length === 0 ? (
                    <div className="py-8 text-center text-[12px] text-ink-faint border border-dashed border-hairline rounded-xl">
                      暂无需求卡片
                    </div>
                  ) : (
                    colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        pending={pendingTaskIds.includes(task.id)}
                        sessionLabels={sessionLabels}
                        onClick={(t) => {
                          setSelectedTask(t);
                          void Promise.resolve(onOpenTask?.(t.id)).catch(() => undefined);
                        }}
                        onMoveStatus={onMoveTaskStatus}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      )}

      {/* Task Detail Modal */}
      {selectedTask ? (
        <TaskDetailModal
          task={tasks.find((task) => task.id === selectedTask.id) ?? selectedTask}
          availableSessions={sessions}
          sessionLabels={sessionLabels}
          statusOptions={columns}
          showPrompt={prototypeMode}
          onClose={() => setSelectedTask(null)}
          onSave={onUpdateTask ? async (updated) => {
            await onUpdateTask(selectedTask.id, updated);
            if (prototypeMode) setSelectedTask({ ...selectedTask, ...updated });
          } : undefined}
          onRunInSession={onRunInSession}
          onOpenSession={onOpenSession}
          onDelete={onDeleteTask ? async (id) => {
            await onDeleteTask(id);
            setSelectedTask(null);
          } : undefined}
        />
      ) : null}

      {/* New Task Modal */}
      {showNewTaskModal ? (
        <NewTaskModal
          workspaces={workspaces}
          sessions={sessions}
          defaultWorkspaceId={currentWorkspaceId}
          showPrompt={prototypeMode}
          onClose={() => setShowNewTaskModal(false)}
          onCreate={async (formData) => {
            if (!onCreateTask) throw new Error('The board service is not connected.');
            await onCreateTask(formData);
            setShowNewTaskModal(false);
          }}
        />
      ) : null}
    </div>
  );
});
