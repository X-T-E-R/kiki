import { memo, useState } from 'react';
import { useI18n } from '../../i18n';
import type { AgentPanelTodo } from './types';

export interface AgentTodoSectionProps {
  readonly todos: readonly AgentPanelTodo[];
  readonly onToggleTodo?: (id: string) => void;
  readonly onNewTodo?: () => void;
}

function todoTone(status: AgentPanelTodo['status']): { icon: string; className: string } {
  switch (status) {
    case 'done':
      return { icon: '✓', className: 'border-success/50 bg-success/15 text-success' };
    case 'in_progress':
      return { icon: '●', className: 'border-accent/60 bg-accent-soft text-accent' };
    case 'pending':
    default:
      return { icon: '', className: 'border-hairline-strong bg-panel text-transparent' };
  }
}

export const AgentTodoSection = memo(function AgentTodoSection({
  todos,
  onToggleTodo,
  onNewTodo,
}: AgentTodoSectionProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  const doneCount = todos.filter((t) => t.status === 'done').length;
  return (
    <div data-agent-todo-section className="border-y border-hairline py-2.5">
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 text-left group"
        >
          <span
            aria-hidden
            className={`inline-block shrink-0 text-[8px] text-ink-faint transition-transform duration-150 ${
              collapsed ? '' : 'rotate-90'
            }`}
          >
            ▶
          </span>
          <span className="font-mono text-[10.5px] font-semibold tracking-wider text-ink-faint group-hover:text-ink uppercase transition-colors">
            {t('agentPanel.todoTitle')}
          </span>
          <span className="rounded-full bg-paper border border-hairline px-1.5 py-0.2 font-mono text-[9.5px] text-ink-faint">
            {doneCount}/{todos.length}
          </span>
        </button>

        {onNewTodo ? (
          <button
            type="button"
            onClick={onNewTodo}
            className="text-[10.5px] text-accent hover:text-accent-deep transition-colors font-mono"
          >
            {t('agentPanel.newTodo')}
          </button>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="mt-2 space-y-1.5">
          {todos.length === 0 ? (
            <p className="py-2 text-center text-[11.5px] text-ink-faint">
              {t('agentPanel.noTodos')}
            </p>
          ) : (
            <ul className="space-y-1 max-h-52 overflow-y-auto pr-0.5">
              {todos.map((todo) => {
                const tone = todoTone(todo.status);
                return (
                  <li
                    key={todo.id}
                    className="flex items-start gap-2 rounded-md p-1 hover:bg-paper/80 transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => onToggleTodo?.(todo.id)}
                      disabled={!onToggleTodo}
                      aria-label={t('agentPanel.markTodo', { title: todo.title })}
                      className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border text-[9px] font-bold ${
                        tone.className
                      } ${onToggleTodo ? 'cursor-pointer' : 'cursor-default'}`}
                    >
                      {tone.icon}
                    </button>
                    <span
                      className={`text-[12px] leading-snug break-words ${
                        todo.status === 'done'
                          ? 'text-ink-faint line-through'
                          : todo.status === 'in_progress'
                            ? 'font-medium text-ink'
                            : 'text-ink-soft'
                      }`}
                    >
                      {todo.title}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
});
