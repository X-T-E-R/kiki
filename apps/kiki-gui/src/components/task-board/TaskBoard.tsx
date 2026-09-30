import { memo, useState, useMemo } from 'react';
import { errorText, LocalizedError, type I18nKey, type ValidationIssue } from '@kiki/session-core/i18n';
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
import { StatusGlyph } from './glyphs';
import { TaskDetailModal } from './TaskDetailModal';
import { NewTaskModal } from './NewTaskModal';
import { WorkspaceScopeControl } from '../WorkspaceScopeControl';
import { Icon } from '../icons';

const ISSUE_REASON_KEYS: Readonly<Record<string, I18nKey>> = {
  BOARD_UNAVAILABLE: 'taskBoard.issueReason.BOARD_UNAVAILABLE',
  BOARD_ACCESS_DENIED: 'taskBoard.issueReason.BOARD_ACCESS_DENIED',
  WORKSPACE_NOT_FOUND: 'taskBoard.issueReason.WORKSPACE_NOT_FOUND',
  WORKSPACE_CUTOVER_REQUIRED: 'taskBoard.issueReason.WORKSPACE_CUTOVER_REQUIRED',
  BOARD_REQUEST_FAILED: 'taskBoard.issueReason.BOARD_REQUEST_FAILED',
};

function renderIssue(locale: 'en' | 'zh', issue: ValidationIssue): string {
  return errorText(locale, new LocalizedError(issue));
}

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
  readonly error?: ValidationIssue | string | null;
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
  /**
   * `fixed` (default): lanes keep their 284–320px width and the board
   * scrolls sideways. `fill`: from the `sm` breakpoint up, lanes share the
   * container width (never narrower than 200px), so a full-page board shows
   * every column without horizontal scroll. Narrow screens always snap-scroll.
   */
  readonly laneLayout?: 'fixed' | 'fill';
}

export const TaskBoard = memo(function TaskBoard({
  tasks,
  columns = DEFAULT_BOARD_COLUMNS,
  workspaces = [],
  sessions = [],
  currentWorkspaceId,
  currentSessionId: _currentSessionId,
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
  refreshLabel,
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
  laneLayout = 'fixed',
}: TaskBoardProps) {
  const { t, tp, locale } = useI18n();
  const resolvedColumns = useMemo(
    () => columns.map((column) => ({
      ...column,
      label: column.label ?? (column.labelKey === undefined ? column.status : t(column.labelKey)),
    })),
    [columns, t],
  );
  const renderedError = error === null || error === undefined
    ? null
    : typeof error === 'string' ? error : renderIssue(locale, error);

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
  const [dropTarget, setDropTarget] = useState<BoardTaskStatus | null>(null);
  const sessionLabels = useMemo(
    () => Object.fromEntries(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );

  const workspaceTitle = useMemo(() => {
    const titles = new Map(workspaces.map((entry) => [entry.id, entry.title]));
    return (workspaceId: string | undefined): string =>
      workspaceId === undefined ? '' : (titles.get(workspaceId) ?? workspaceId);
  }, [workspaces]);
  const scopeOptions = useMemo(
    () => workspaces.map((entry) => ({ id: entry.id, name: entry.title })),
    [workspaces],
  );
  const scopedWorkspaceName = workspaceFilterValue === 'all' ? undefined : workspaceTitle(workspaceFilterValue);

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
          <span>{t('taskBoard.prototype.banner')}</span>
          <span>{t('taskBoard.prototype.runtime')}</span>
        </div>
      ) : null}

      {/* Error alert banner */}
      {renderedError ? (
        <div className="shrink-0 bg-danger/10 border-b border-danger/20 px-5 py-2 text-[12px] text-danger flex items-center justify-between">
          <span>{renderedError}</span>
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
            title={[...issues, ...cardIssues].map((issue) => renderIssue(locale, issue.issue)).join('\n')}
          >
            {issues.length > 0 ? tp('taskBoard.issues.partial', issues.length) : ''}
            {issues.length > 0 && cardIssues.length > 0 ? ' · ' : ''}
            {cardIssues.length > 0 ? tp('taskBoard.issues.cards', cardIssues.length) : ''}
            {issueWorkspaceNames.length > 0 ? ` · ${issueWorkspaceNames.join(t('taskBoard.listSeparator'))}` : ''}
          </span>
        </div>
      ) : null}

      {/* Header: title row (identity + actions), then the scope/filter row. */}
      <header className="flex shrink-0 flex-col gap-3 border-b border-hairline bg-panel px-5 pt-3.5 pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {onCloseBoard ? (
            <button
              type="button"
              onClick={onCloseBoard}
              aria-label={t('taskBoard.backToSession')}
              className="flex items-center gap-1 rounded-lg border border-hairline px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:border-hairline-strong hover:text-ink transition-colors"
            >
              <Icon name="chevron" size={12} className="rotate-180" />
              <span>{t('taskBoard.backToSession')}</span>
            </button>
          ) : null}

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-[15px] font-semibold text-ink leading-none">
                {t('taskBoard.title')}
              </h2>
              {loading ? (
                <span role="status" className="text-[12px] text-ink-faint animate-pulse motion-reduce:animate-none">
                  {t('taskBoard.syncing')}
                </span>
              ) : null}
            </div>
            <span data-task-board-summary className="mt-1 block truncate text-[12px] text-ink-faint tabular-nums">
              {scopedWorkspaceName !== undefined ? `${scopedWorkspaceName} · ` : `${t('taskBoard.scope.all')} · `}
              {t('taskBoard.summary', { shown: filteredTasks.length, total: tasks.length })}
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {onRefresh ? (
              <button
                type="button"
                data-task-board-refresh
                disabled={refreshDisabled}
                onClick={() => { void onRefresh(); }}
                className="h-8 rounded-md border border-hairline px-3 text-[13px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {refreshLabel ?? t('taskBoard.refresh')}
              </button>
            ) : null}
            <button
              type="button"
              data-board-new-task
              onClick={() => setShowNewTaskModal(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-deep"
            >
              <Icon name="plus" size={14} />
              {t('taskBoard.newTask')}
            </button>
          </div>
        </div>

        {/* Scope first (it decides what loads), then the local view filters. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <WorkspaceScopeControl
            workspaces={scopeOptions}
            value={workspaceFilterValue === 'all' ? undefined : workspaceFilterValue}
            dataAttribute="data-task-board-scope"
            onChange={(next) => {
              const selection = next ?? 'all';
              if (onScopeSelectionChange !== undefined) onScopeSelectionChange(selection);
              else setSelectedWorkspaceFilter(selection);
            }}
          />
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
            <input
              type="search"
              aria-label={t('taskBoard.search.placeholder')}
              placeholder={t('taskBoard.search.placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-56 max-w-full min-w-0 rounded-md border border-hairline bg-paper px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-hidden"
            />
            <select
              data-task-board-session-filter
              aria-label={t('taskBoard.sessionFilter.all')}
              value={selectedSessionFilter}
              onChange={(e) => setSelectedSessionFilter(e.target.value)}
              className="h-8 w-52 max-w-full min-w-0 rounded-md border border-hairline bg-paper px-2.5 text-[13px] text-ink focus:border-accent focus:outline-hidden"
            >
              <option value="all">{t('taskBoard.sessionFilter.all')}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {/* Board body: full degradation when no workspace could be served */}
      {showUnavailable ? (
        <div
          data-task-board-unavailable
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3.5 overflow-y-auto px-6 py-12 text-center"
        >
          <h3 className="font-display text-[18px] font-semibold text-ink">
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
                  title={renderIssue(locale, issue.issue)}
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
                className="rounded-lg border border-hairline px-3.5 py-2 text-[13px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('common.retry')}
              </button>
            ) : null}
            {onOpenSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-lg border border-hairline px-3.5 py-2 text-[13px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
              >
                {t('sidebar.manageWorkspaces')}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
      /* Kanban lanes: tinted paper columns, cards lift off them. Scrolls
       * horizontally; on narrow screens each lane snaps into view. */
      <div className="flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-contain px-3 py-4 sm:snap-none sm:px-5">
        <div
          data-board-lanes={laneLayout}
          className={`grid h-full min-h-0 min-w-max grid-flow-col auto-cols-[minmax(284px,320px)] gap-3 ${
            laneLayout === 'fill' ? 'sm:min-w-min sm:flex-1 sm:auto-cols-[minmax(200px,1fr)]' : ''
          }`}
        >
          {resolvedColumns.map((col) => {
            const colTasks = filteredTasks.filter((t) => t.status === col.status);
            const isManualTarget = !prototypeMode || col.status === 'backlog' || col.status === 'todo';
            const dropping = dropTarget === col.status;

            return (
              <section
                key={col.status}
                data-board-column={col.status}
                data-board-drop-target={dropping ? '' : undefined}
                aria-label={col.label}
                onDragOver={(e) => {
                  if (isManualTarget) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dropTarget !== col.status) setDropTarget(col.status);
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((current) => current === col.status ? null : current);
                }}
                onDrop={(e) => {
                  setDropTarget(null);
                  if (isManualTarget) {
                    e.preventDefault();
                    const taskId = e.dataTransfer.getData('text/plain');
                    if (taskId && onMoveTaskStatus && !pendingTaskIds.includes(taskId)) {
                      void Promise.resolve(onMoveTaskStatus(taskId, col.status)).catch(() => undefined);
                    }
                  }
                }}
                className={`flex min-h-0 w-[min(320px,calc(100vw-1.5rem))] min-w-0 snap-start flex-col overflow-hidden rounded-xl bg-canvas/55 transition-shadow duration-150 ${laneLayout === 'fill' ? 'sm:w-auto' : ''} ${dropping ? 'shadow-[inset_0_0_0_1.5px_var(--color-hairline-strong)] bg-canvas/80' : ''}`}
              >
                {/* Lane header: status mark, sentence-case label, count. */}
                <div className="flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-2">
                  <StatusGlyph status={col.status} />
                  <h3 className="min-w-0 truncate text-[13px] font-medium text-ink">
                    {col.label}
                  </h3>
                  <span data-board-column-count className="text-[12px] text-ink-faint tabular-nums">
                    {colTasks.length}
                  </span>
                </div>

                {/* Column Cards Scrollable List */}
                <div className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain px-2 pt-0.5 pb-3">
                  {colTasks.length === 0 ? (
                    <div className="mx-1 rounded-lg border border-dashed border-hairline-strong/70 px-3 py-6 text-center text-[12px] text-ink-faint">
                      {t('taskBoard.column.empty')}
                    </div>
                  ) : (
                    colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        pending={pendingTaskIds.includes(task.id)}
                        sessionLabels={sessionLabels}
                        showWorkspace={workspaceFilterValue === 'all'}
                        onClick={(t) => {
                          setSelectedTask(t);
                          void Promise.resolve(onOpenTask?.(t.id)).catch(() => undefined);
                        }}
                        onMoveStatus={(taskId, newStatus) => {
                          void onMoveTaskStatus?.(taskId, newStatus);
                        }}
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
          statusOptions={resolvedColumns}
          showPrompt={prototypeMode}
          pending={pendingTaskIds.includes(selectedTask.id)}
          onMoveStatus={onMoveTaskStatus ? async (taskId, status) => { await onMoveTaskStatus(taskId, status); } : undefined}
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
            if (!onCreateTask) throw new LocalizedError({ key: 'taskBoard.error.serviceUnavailable' });
            await onCreateTask(formData);
            setShowNewTaskModal(false);
          }}
        />
      ) : null}
    </div>
  );
});
