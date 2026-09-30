import { memo, useState } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';
import { RelativeTime } from '../RelativeTime';
import { useI18n } from '../../i18n';
import { FolderGlyph, PriorityGlyph, SessionGlyph, StatusGlyph } from './glyphs';
import { Icon, type IconName } from '../icons';
import type { BoardTask, BoardTaskStatus, TaskExecution, TaskPriority } from './types';

export interface TaskCardProps {
  readonly task: BoardTask;
  readonly pending?: boolean;
  readonly onClick: (task: BoardTask) => void;
  readonly onMoveStatus?: (taskId: string, targetStatus: BoardTask['status']) => void;
  readonly sessionLabels?: Readonly<Record<string, string>>;
  /** Tag the card with its workspace — only meaningful in the all-workspaces view. */
  readonly showWorkspace?: boolean;
}

export const PRIORITY_LABEL_KEYS: Record<TaskPriority, I18nKey> = {
  urgent: 'taskBoard.priority.urgent',
  high: 'taskBoard.priority.high',
  medium: 'taskBoard.priority.medium',
  low: 'taskBoard.priority.low',
};

export const PRIORITY_CODE: Record<TaskPriority, string> = { urgent: 'P0', high: 'P1', medium: 'P2', low: 'P3' };

export const STATUS_LABEL_KEYS: Record<BoardTaskStatus, I18nKey> = {
  backlog: 'taskBoard.column.backlog',
  todo: 'taskBoard.column.todo',
  running: 'taskBoard.column.running',
  done: 'taskBoard.column.done',
  failed: 'taskBoard.column.failed',
  active: 'taskBoard.column.active',
  in_progress: 'taskBoard.column.in_progress',
  paused: 'taskBoard.column.paused',
  cancelled: 'taskBoard.column.cancelled',
  superseded: 'taskBoard.column.superseded',
};

/** Closed statuses read quieter: the work is no longer asking for attention. */
export function isClosedStatus(status: BoardTaskStatus): boolean {
  return status === 'done' || status === 'cancelled' || status === 'superseded';
}

/** Run-state chip: a drawn mark (none for success) plus the localized result label. */
function executionChip(result: TaskExecution['result']): {
  symbol: IconName | null;
  labelKey: I18nKey;
  className: string;
} {
  // Outcome rule: success is words only (no tick); failure and running carry
  // their mark. The label always says the result, so no state is glyph-only.
  if (result === 'succeeded') {
    return { symbol: null, labelKey: 'taskBoard.result.succeeded', className: 'text-ink-soft' };
  }
  if (result === 'failed') {
    return { symbol: 'cross', labelKey: 'taskBoard.result.failed', className: 'text-danger' };
  }
  return { symbol: 'dot', labelKey: 'taskBoard.result.running', className: 'text-ink-soft' };
}

/** Millisecond timestamps become ISO for the shared relative-time formatter; an
 * unparseable value renders as empty rather than throwing. */
export function toIso(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  pending = false,
  sessionLabels,
  showWorkspace = false,
}: TaskCardProps) {
  const { t, tp } = useI18n();
  const [dragging, setDragging] = useState(false);
  const priority = task.priority ?? 'medium';
  const latestExecution = task.executions[task.executions.length - 1];
  const runChip = latestExecution === undefined ? undefined : executionChip(latestExecution.result);
  const sessionIds = task.associatedSessionIds ?? [];
  const firstSession = sessionIds[0];
  const firstSessionLabel = firstSession === undefined ? undefined : sessionLabels?.[firstSession];
  const workspaceLabel = showWorkspace ? task.workspaceTitle : undefined;
  const closed = isClosedStatus(task.status);
  const canDrag = !pending && !task.archivedAt;
  const hasFooter = sessionIds.length > 0 || workspaceLabel !== undefined || runChip !== undefined || (task.linkedExecutionIds?.length ?? 0) > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      data-board-task-card={task.id}
      data-board-task-status={task.status}
      aria-busy={pending}
      draggable={canDrag}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => { setDragging(false); }}
      onClick={() => onClick(task)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(task);
        }
      }}
      className={`group relative flex min-w-0 cursor-pointer flex-col rounded-[10px] bg-panel px-3 pt-3 pb-3 text-left shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.07)] ring-1 ring-hairline transition-[box-shadow,transform,opacity] duration-150 select-none hover:shadow-[0_4px_14px_-6px_rgb(var(--kiki-shadow-ink)/0.22)] hover:ring-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink motion-safe:hover:-translate-y-px ${dragging ? 'opacity-45' : ''} ${pending ? 'cursor-progress opacity-60' : ''}`}
    >
      {/* Meta row: priority (quiet unless P0) and last activity. */}
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11.5px] text-ink-faint">
        <span className="flex min-w-0 items-center gap-1.5" title={t(PRIORITY_LABEL_KEYS[priority])}>
          <PriorityGlyph priority={priority} />
          <span aria-hidden className={`font-mono text-[11px] tabular-nums ${priority === 'urgent' ? 'font-semibold text-danger' : ''}`}>
            {PRIORITY_CODE[priority]}
          </span>
          <span className="sr-only">{t(PRIORITY_LABEL_KEYS[priority])}</span>
        </span>
        <span className="shrink-0 tabular-nums" title={t('taskBoard.card.updated')}>
          <RelativeTime at={toIso(task.updatedAt)} />
        </span>
      </div>

      {/* Title with its status mark, Linear-style: the one thing to scan. */}
      <div className="mt-1.5 flex min-w-0 items-start gap-2">
        <span className="mt-[3px]" title={t(STATUS_LABEL_KEYS[task.status])}>
          <StatusGlyph status={task.status} />
          <span className="sr-only">{t(STATUS_LABEL_KEYS[task.status])}</span>
        </span>
        <h4 className={`min-w-0 flex-1 text-[13.5px] leading-[1.4] font-medium break-words line-clamp-3 ${closed ? 'text-ink-soft' : 'text-ink'}`}>
          {task.title}
        </h4>
      </div>

      {task.description ? (
        <p className="mt-1 line-clamp-2 pl-[22px] text-[12.5px] leading-relaxed break-words text-ink-soft">
          {task.description}
        </p>
      ) : null}

      {task.freezeGoal ? (
        <p className="mt-2 ml-[22px] truncate rounded-md bg-amber-card px-2 py-1 text-[11.5px] text-amber-ink">
          {task.freezeGoal}
        </p>
      ) : null}

      {hasFooter ? (
        <div className="mt-2 flex min-w-0 items-center gap-3 pl-[22px] text-[11.5px] text-ink-faint">
          {sessionIds.length > 0 ? (
            <span
              data-board-card-sessions={sessionIds.length}
              className="flex min-w-0 items-center gap-1"
              title={tp('taskBoard.card.linkedSessions', sessionIds.length)}
            >
              <SessionGlyph />
              {firstSessionLabel !== undefined ? (
                <span className="min-w-0 truncate text-ink-soft">{firstSessionLabel}</span>
              ) : (
                <span className="tabular-nums">{sessionIds.length}</span>
              )}
              {firstSessionLabel !== undefined && sessionIds.length > 1 ? (
                <span className="shrink-0 tabular-nums">+{sessionIds.length - 1}</span>
              ) : null}
            </span>
          ) : null}

          {runChip ? (
            <span
              className={`shrink-0 ${runChip.className}`}
              title={t('taskBoard.card.executionTitle', { result: t(runChip.labelKey) })}
            >
              <span className="inline-flex items-center gap-1">
                {runChip.symbol === null ? null : <Icon name={runChip.symbol} size={12} />}
                {t(runChip.labelKey)}
              </span>
            </span>
          ) : task.linkedExecutionIds?.length ? (
            <span className="shrink-0" title={t('taskBoard.card.executionRefsHint')}>
              {tp('taskBoard.card.executionRefs', task.linkedExecutionIds.length)}
            </span>
          ) : null}

          {workspaceLabel !== undefined ? (
            <span data-board-card-workspace className="ml-auto flex min-w-0 max-w-[45%] shrink-0 items-center gap-1" title={workspaceLabel}>
              <FolderGlyph className="h-3 w-3" />
              <span className="min-w-0 truncate">{workspaceLabel}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
