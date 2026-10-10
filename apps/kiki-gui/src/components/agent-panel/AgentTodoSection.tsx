import { memo, useState } from 'react';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../icons';
import { InspectorChevron } from './InspectorSection';
import type { AgentPanelTodo } from './types';

export interface AgentTodoSectionProps {
  readonly todos: readonly AgentPanelTodo[];
  readonly onToggleTodo?: (id: string) => void;
  readonly onNewTodo?: () => void;
  readonly incomplete?: boolean;
}

// A ticked todo is a settled fact: neutral, not the success tone (that is
// reserved for "just finished, you should know").
function todoTone(status: AgentPanelTodo['status']): { icon: IconName | null; className: string } {
  switch (status) {
    case 'done':
      return { icon: 'check', className: 'border-transparent bg-ink/[0.08] text-ink-soft' };
    case 'in_progress':
      return { icon: 'dot', className: 'border-ink-soft bg-transparent text-ink-soft' };
    case 'pending':
    default:
      return { icon: null, className: 'border-hairline-strong bg-panel text-transparent' };
  }
}

export const AgentTodoSection = memo(function AgentTodoSection({
  todos,
  onToggleTodo,
  onNewTodo,
  incomplete = false,
}: AgentTodoSectionProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  const doneCount = todos.filter((t) => t.status === 'done').length;
  return (
    <section data-agent-todo-section>
      <div className="flex min-h-8 items-center justify-between gap-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          className="group -ml-1.5 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          <span className="text-[12px] font-medium text-ink-soft transition-colors group-hover:text-ink">
            {t('inspector.todos')}
          </span>
          {!incomplete ? <span className="text-[12px] text-ink-faint tabular-nums">
            {doneCount}/{todos.length}
          </span> : null}
          <InspectorChevron open={!collapsed} />
        </button>

        {onNewTodo ? (
          <button
            type="button"
            onClick={onNewTodo}
            className="h-7 rounded-md px-1.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            {t('agentPanel.newTodo')}
          </button>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="pt-1">
          {todos.length === 0 ? (
            <p className="text-[13px] text-ink-faint">
              {t('agentPanel.noTodos')}
            </p>
          ) : (
            <ul className="space-y-1 max-h-52 overflow-y-auto pr-0.5">
              {todos.map((todo) => {
                const tone = todoTone(todo.status);
                return (
                  <li
                    key={todo.id}
                    className="flex items-start gap-2 py-0.5"
                  >
                    <button
                      type="button"
                      onClick={() => onToggleTodo?.(todo.id)}
                      disabled={!onToggleTodo}
                      aria-label={t('agentPanel.markTodo', { title: todo.title })}
                      className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${
                        tone.className
                      } ${onToggleTodo ? 'cursor-pointer' : 'cursor-default'}`}
                    >
                      {tone.icon === null ? null : <Icon name={tone.icon} size={12} />}
                    </button>
                    <span
                      className={`text-[13px] leading-snug break-words ${
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
    </section>
  );
});
