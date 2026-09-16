import { memo } from 'react';
import { BoardAssociatedTodos } from './BoardAssociatedTodos';
import { ClampText } from '../ClampText';
import type { BoardTask, TaskPriority } from './types';

export interface TaskCardProps {
  readonly task: BoardTask;
  readonly pending?: boolean;
  readonly onClick: (task: BoardTask) => void;
  readonly onMoveStatus?: (taskId: string, targetStatus: BoardTask['status']) => void;
  readonly sessionLabels?: Readonly<Record<string, string>>;
}

function priorityChip(priority?: TaskPriority): { label: string; className: string } {
  switch (priority) {
    case 'urgent':
      return { label: 'P0 紧急', className: 'bg-danger/10 text-danger border-danger/25' };
    case 'high':
      return { label: 'P1 高', className: 'bg-accent-soft text-accent-deep border-accent/25' };
    case 'medium':
      return { label: 'P2 中', className: 'bg-amber-card text-amber-ink border-amber-rule/40' };
    case 'low':
      return { label: 'P3 低', className: 'bg-paper text-ink-faint border-hairline' };
    default:
      return { label: 'P2 中', className: 'bg-paper text-ink-faint border-hairline' };
  }
}

function formatRelativeTime(ms: number): string {
  const diffMinutes = Math.floor((Date.now() - ms) / 60000);
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes}m 前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h 前`;
  return `${Math.floor(diffHours / 24)}d 前`;
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  pending = false,
  sessionLabels,
}: TaskCardProps) {
  const latestExecution = task.executions[task.executions.length - 1];
  const pChip = priorityChip(task.priority);

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
          {pChip.label}
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
          {latestExecution ? (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                latestExecution.result === 'succeeded'
                  ? 'bg-success/10 text-success'
                  : latestExecution.result === 'failed'
                    ? 'bg-danger/10 text-danger'
                    : 'bg-accent-soft text-accent'
              }`}
              title={`最近执行: ${latestExecution.result ?? '运行中'}`}
            >
              {latestExecution.result === 'succeeded'
                ? '✓ 成功'
                : latestExecution.result === 'failed'
                  ? '✕ 失败'
                  : '● 运行中'}
            </span>
          ) : task.linkedExecutionIds?.length ? (
            <span className="text-ink-faint text-[10.5px]" title="执行引用不表示运行状态">
              {task.linkedExecutionIds.length} 个执行引用
            </span>
          ) : null}

          {task.associatedSessionIds && task.associatedSessionIds.length > 0 ? (
            <span
              className="shrink-0 rounded border border-hairline bg-paper px-1.5 text-[10px] text-ink-soft"
              title={`${task.associatedSessionIds.length} 个关联会话`}
            >
              ⌁ {task.associatedSessionIds.length}
            </span>
          ) : null}
        </div>

        <span className="shrink-0 text-ink-faint text-[10.5px]">
          {formatRelativeTime(task.updatedAt)}
        </span>
      </div>

      <BoardAssociatedTodos
        sessionIds={task.associatedSessionIds ?? []}
        sessionLabels={sessionLabels}
      />
    </div>
  );
});
