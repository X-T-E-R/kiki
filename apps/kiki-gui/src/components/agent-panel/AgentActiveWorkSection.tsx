import { memo } from 'react';
import { useI18n } from '../../i18n';
import type { AgentActiveWorkItem, AgentBoardSummary } from './types';

export interface AgentActiveWorkSectionProps {
  readonly activeItems: readonly AgentActiveWorkItem[];
  readonly onOpenItem?: (item: AgentActiveWorkItem) => void;
}

export const AgentActiveWorkSection = memo(function AgentActiveWorkSection({
  activeItems,
  onOpenItem,
}: AgentActiveWorkSectionProps) {
  const { t } = useI18n();
  const activeTodos = activeItems.filter((i) => i.kind === 'todo');
  const runningSubagents = activeItems.filter((i) => i.kind === 'subagent');

  return (
    <div
      data-agent-active-work-section
      className="space-y-2 rounded-xl border border-hairline bg-panel p-3 shadow-xs text-[11.5px]"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10.5px] font-semibold tracking-wider text-ink-faint uppercase">
          {t('agentPanel.activeExecution')}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">
          {t('agentPanel.activeCount', { count: activeItems.length })}
        </span>
      </div>

      {activeItems.length === 0 ? (
        <p className="text-[11px] text-ink-faint">{t('agentPanel.noActiveWork')}</p>
      ) : (
        <div className="space-y-2">
          {/* Running Subagents */}
          {runningSubagents.length > 0 ? (
            <div>
              <span className="text-[10px] font-mono font-medium text-accent uppercase">
                {t('agentPanel.runningChildren', { count: runningSubagents.length })}
              </span>
              <ul className="mt-1 space-y-1">
                {runningSubagents.map((item) => (
                  <li
                    key={item.id}
                    onClick={() => onOpenItem?.(item)}
                    className="flex items-center justify-between gap-2 rounded-lg border border-accent/40 bg-accent-soft/30 p-2 cursor-pointer hover:bg-accent-soft/50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 font-medium text-ink truncate">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent animate-ping" />
                        <span>{item.label}</span>
                      </div>
                      {item.detail ? (
                        <p className="mt-0.5 text-[10.5px] text-ink-soft truncate">
                          {item.detail}
                        </p>
                      ) : null}
                    </div>
                    {item.elapsedMs !== undefined ? (
                      <span className="font-mono text-[10px] text-ink-faint shrink-0">
                        {t('agentPanel.elapsedSeconds', { seconds: Math.round(item.elapsedMs / 1000) })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Active Todos */}
          {activeTodos.length > 0 ? (
            <div>
              <span className="text-[10px] font-mono font-medium text-ink-soft uppercase">
                {t('agentPanel.activeStep')}
              </span>
              <ul className="mt-1 space-y-1">
                {activeTodos.map((item) => (
                  <li
                    key={item.id}
                    onClick={() => onOpenItem?.(item)}
                    className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-paper/60 p-2 cursor-pointer hover:border-hairline-strong transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink truncate">{item.label}</p>
                      {item.detail ? (
                        <p className="text-[10.5px] text-ink-soft truncate">{item.detail}</p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});

export interface AgentPinnedBoardFooterProps {
  readonly summary?: AgentBoardSummary;
  readonly onOpenBoard: () => void;
  readonly onNewBoardTask?: () => void;
}

export const AgentPinnedBoardFooter = memo(function AgentPinnedBoardFooter({
  summary,
  onOpenBoard,
  onNewBoardTask,
}: AgentPinnedBoardFooterProps) {
  const { t } = useI18n();

  return (
    <div
      data-agent-pinned-board-footer
      className="sticky bottom-0 left-0 right-0 border-t border-hairline bg-panel/95 backdrop-blur-sm p-3 shadow-md transition-all"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10.5px] font-semibold text-accent uppercase tracking-wider">
              {t('agentPanel.workboard')}
            </span>
            {summary ? (
              <span className="rounded-full bg-accent-soft px-1.5 py-0.2 font-mono text-[9.5px] text-accent">
                {t('agentPanel.boardSummary', {
                  inProgress: summary.inProgressCount,
                  total: summary.totalTasksCount,
                })}
              </span>
            ) : null}
          </div>

          {summary?.activeTaskTitle ? (
            <p className="mt-1 truncate text-[11.5px] font-medium text-ink" title={summary.activeTaskTitle}>
              📌 {summary.activeTaskTitle}
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {t('agentPanel.noBoardRequirement')}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {onNewBoardTask ? (
            <button
              type="button"
              onClick={onNewBoardTask}
              className="rounded-lg border border-hairline bg-paper px-2 py-1 text-[11px] font-mono text-ink hover:border-accent hover:text-accent transition-colors"
              title={t('agentPanel.quickCreateBoardTask')}
            >
              +
            </button>
          ) : null}
          <button
            type="button"
            onClick={onOpenBoard}
            className="rounded-lg bg-accent px-2.5 py-1 text-[11.5px] font-medium text-panel hover:bg-accent-deep transition-colors shadow-xs"
          >
            {t('agentPanel.openBoard')}
          </button>
        </div>
      </div>
    </div>
  );
});
