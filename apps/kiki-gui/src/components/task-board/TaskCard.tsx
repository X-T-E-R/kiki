import { memo } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';
import { BoardAssociatedTodos } from './BoardAssociatedTodos';
import { ClampText } from '../ClampText';
import { RelativeTime } from '../RelativeTime';
import { useI18n } from '../../i18n';
import type { BoardTask, TaskExecution, TaskPriority } from './types';

export interface TaskCardProps {
  readonly task: BoardTask;
  readonly pending?: boolean;
  readonly onClick: (task: BoardTask) => void;
  readonly onMoveStatus?: (taskId: string, targetStatus: BoardTask['status']) => void;
  readonly sessionLabels?: Readonly<Record<string, string>>;
}

const PRIORITY_LABEL_KEYS: Record<TaskPriority, I18nKey> = {
  urgent: 'taskBoard.priority.urgent',
  high: 'taskBoard.priority.high',
  medium: 'taskBoard.priority.medium',
  low: 'taskBoard.priority.low',
};

function priorityChip(priority?: TaskPriority): { labelKey: I18nKey; className: string } {
  switch (priority) {
    case 'urgent':
      return { labelKey: PRIORITY_LABEL_KEYS.urgent, className: 'bg-danger/10 text-danger border-danger/25' };
    case 'high':
      return { labelKey: PRIORITY_LABEL_KEYS.high, className: 'bg-accent-soft text-accent-deep border-accent/25' };
    case 'medium':
      return { labelKey: PRIORITY_LABEL_KEYS.medium, className: 'bg-amber-card text-amber-ink border-amber-rule/40' };
    case 'low':
      return { labelKey: PRIORITY_LABEL_KEYS.low, className: 'bg-paper text-ink-faint border-hairline' };
    default:
      return { labelKey: PRIORITY_LABEL_KEYS.medium, className: 'bg-paper text-ink-faint border-hairline' };
  }
}

/** Run-state chip: a locale-neutral glyph plus the localized result label. */
function executionChip(result: TaskExecution['result']): {
  symbol: string;
  labelKey: I18nKey;
  className: string;
} {
  if (result === 'succeeded') {
    return { symbol: '✓', labelKey: 'taskBoard.result.succeeded', className: 'bg-success/10 text-success' };
  }
  if (result === 'failed') {
    return { symbol: '✕', labelKey: 'taskBoard.result.failed', className: 'bg-danger/10 text-danger' };
  }
  return { symbol: '●', labelKey: 'taskBoard.result.running', className: 'bg-accent-soft text-accent' };
}

/** Millisecond timestamps become ISO for the shared relative-time formatter; an
 * unparseable value renders as empty rather than throwing. */
function toIso(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  pending = false,
  sessionLabels,
}: TaskCardProps) {
  const { t, tp } = useI18n();
  const latestExecution = task.executions[task.executions.length - 1];
  const pChip = priorityChip(task.priority);
  const runChip = latestExecution === undefined ? undefined : executionChip(latestExecution.result);

  return (
    <div
      data-board-task-card={task.id}
      aria-busy={pending}
      draggable={!pending && !task.archivedAt}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onClick(task)}
      className="group relative flex min-w-0 flex-col rounded-xl border border-hairline bg-panel p-3.5 shadow-xs hover:border-accent/60 hover:shadow-sm transition-all cursor-pointer select-none"
    >
      {/* Top row: Priority & Workspace Tag */}
      <div className="flex min-w-0 items-center justify-between gap-1.5">
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${pChip.className}`}
        >
          {t(pChip.labelKey)}
        </span>

        {task.workspaceTitle ? (
          <span className="min-w-0 max-w-36 truncate font-mono text-[10.5px] text-ink-faint" title={task.workspaceTitle}>
            📁 {task.workspaceTitle}
          </span>
        ) : null}
      </div>

      {/* Card Title */}
      <h4 className="mt-2 min-w-0 text-[13.5px] font-semibold leading-snug text-ink group-hover:text-accent transition-colors line-clamp-2">
        {task.title}
      </h4>

      {/* Card Excerpt */}
      {task.description ? (
        <div className="mt-1.5 min-w-0" onClick={(e) => e.stopPropagation()}>
          <ClampText
            text={task.description}
            className="text-[12px] text-ink-soft leading-relaxed"
            lines={2}
          />
        </div>
      ) : null}

      {/* Context Freeze Snapshot Pill */}
      {task.freezeGoal ? (
        <div className="mt-2 rounded bg-amber-card/50 border border-amber-rule/30 px-2 py-1 text-[10.5px] text-amber-ink truncate font-mono">
          ❄️ {task.freezeGoal}
        </div>
      ) : null}

      {/* Bottom Meta: execution facts, associations, and update time */}
      <div className={`mt-3.5 flex items-center justify-between gap-1.5 text-[11px] font-mono ${latestExecution || task.linkedExecutionIds?.length || task.associatedSessionIds?.length ? 'border-t border-hairline pt-2.5' : ''}`}>
        <div className="flex min-w-0 items-center gap-1.5">
          {runChip ? (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${runChip.className}`}
              title={t('taskBoard.card.executionTitle', { result: t(runChip.labelKey) })}
            >
              {runChip.symbol} {t(runChip.labelKey)}
            </span>
          ) : task.linkedExecutionIds?.length ? (
            <span className="text-ink-faint text-[10.5px]" title={t('taskBoard.card.executionRefsHint')}>
              {tp('taskBoard.card.executionRefs', task.linkedExecutionIds.length)}
            </span>
          ) : null}

          {task.associatedSessionIds && task.associatedSessionIds.length > 0 ? (
            <span
              className="shrink-0 rounded border border-hairline bg-paper px-1.5 text-[10px] text-ink-soft"
              title={tp('taskBoard.card.linkedSessions', task.associatedSessionIds.length)}
            >
              ⌁ {task.associatedSessionIds.length}
            </span>
          ) : null}
        </div>

        <RelativeTime at={toIso(task.updatedAt)} className="shrink-0 text-ink-faint text-[10.5px]" />
      </div>

      <BoardAssociatedTodos
        sessionIds={task.associatedSessionIds ?? []}
        sessionLabels={sessionLabels}
      />
    </div>
  );
});
