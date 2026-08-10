/**
 * Right rail (collapsible) — todos checklist, background tasks with terminate,
 * and session meta (model, cwd, message count, context/token usage).
 */

import type { Task } from '@moonshot-ai/protocol';

import { formatTokens, relativeTime } from '../lib/time';
import type { SessionViewState, TodoItem } from '../state/transcript';

function todoTone(status: string): { icon: string; className: string } {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'done') {
    return { icon: '✓', className: 'border-success/50 bg-success/10 text-success' };
  }
  if (normalized === 'in_progress' || normalized === 'running' || normalized === 'active') {
    return { icon: '●', className: 'border-accent/60 bg-accent-soft text-accent' };
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return { icon: '×', className: 'border-hairline-strong bg-paper text-ink-faint' };
  }
  return { icon: '', className: 'border-hairline-strong bg-panel text-transparent' };
}

function TodosSection({ todos }: { todos: readonly TodoItem[] }) {
  if (todos.length === 0) {
    return <p className="text-[12px] text-ink-faint">No todo list yet.</p>;
  }
  const done = todos.filter((todo) => {
    const status = todo.status.toLowerCase();
    return status === 'completed' || status === 'done';
  }).length;
  return (
    <div>
      <p className="mb-1.5 text-[10.5px] text-ink-faint">
        {done}/{todos.length} done
      </p>
      <ul className="space-y-1">
        {todos.map((todo, index) => {
          const tone = todoTone(todo.status);
          return (
            <li key={`${index}-${todo.title}`} className="flex items-start gap-2">
              <span
                aria-hidden
                className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border text-[9px] font-bold ${tone.className}`}
              >
                {tone.icon}
              </span>
              <span
                className={`text-[12px] leading-snug ${
                  tone.icon === '✓' ? 'text-ink-faint line-through' : 'text-ink'
                }`}
              >
                {todo.title}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function taskStatusTone(status: Task['status']): string {
  switch (status) {
    case 'running':
      return 'bg-accent-soft text-accent';
    case 'completed':
      return 'bg-success/10 text-success';
    case 'failed':
      return 'bg-danger/10 text-danger';
    case 'cancelled':
      return 'bg-paper text-ink-soft';
  }
}

function TasksSection({
  tasks,
  onCancel,
}: {
  tasks: readonly Task[];
  onCancel: (taskId: string) => void;
}) {
  if (tasks.length === 0) {
    return <p className="text-[12px] text-ink-faint">No background tasks.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {tasks.map((task) => (
        <li key={task.id} className="rounded-lg border border-hairline bg-panel px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${taskStatusTone(task.status)}`}>
              {task.status}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
              {task.description}
            </span>
            {task.status === 'running' ? (
              <button
                type="button"
                onClick={() => onCancel(task.id)}
                title="Terminate task"
                className="shrink-0 rounded-md border border-hairline px-1.5 py-0.5 text-[10px] text-ink-soft transition-colors hover:border-danger hover:text-danger"
              >
                Stop
              </button>
            ) : null}
          </div>
          {task.command !== undefined ? (
            <p className="mt-1 truncate font-mono text-[10.5px] text-ink-faint">{task.command}</p>
          ) : null}
          {task.output_preview !== undefined && task.output_preview !== '' ? (
            <p className="mt-1 line-clamp-2 font-mono text-[10.5px] break-all text-ink-faint">
              {task.output_preview}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function MetaRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-[11px] text-ink-faint">{label}</span>
      <span
        className={`min-w-0 truncate text-[11.5px] text-ink ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export function RightRail({
  state,
  onCancelTask,
  className,
}: {
  state: SessionViewState;
  onCancelTask: (taskId: string) => void;
  className?: string;
}) {
  const session = state.session;
  const usage = session?.usage;
  const contextTokens = state.contextTokens ?? usage?.context_tokens;
  const contextLimit =
    state.maxContextTokens ?? (usage !== undefined && usage.context_limit > 0 ? usage.context_limit : undefined);

  return (
    <aside
      className={
        className ?? 'flex h-full w-[300px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-hairline bg-panel px-4 py-4'
      }
    >
      <section>
        <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          Todos
        </h3>
        <TodosSection todos={state.todos} />
      </section>

      <section>
        <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          Background tasks
        </h3>
        <TasksSection tasks={state.tasks} onCancel={onCancelTask} />
      </section>

      <section>
        <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          Session
        </h3>
        <div className="space-y-1.5">
          {state.model !== undefined ? <MetaRow label="Model" value={state.model} mono /> : null}
          {session !== undefined ? (
            <MetaRow label="Directory" value={session.metadata.cwd} mono />
          ) : null}
          {session !== undefined ? (
            <MetaRow label="Messages" value={String(session.message_count)} />
          ) : null}
          {session !== undefined ? (
            <MetaRow label="Updated" value={relativeTime(session.updated_at)} />
          ) : null}
          {contextTokens !== undefined ? (
            <MetaRow
              label="Context"
              value={
                contextLimit !== undefined
                  ? `${formatTokens(contextTokens)} / ${formatTokens(contextLimit)}`
                  : formatTokens(contextTokens)
              }
              mono
            />
          ) : null}
          {usage !== undefined && usage.total_cost_usd > 0 ? (
            <MetaRow label="Cost" value={`$${usage.total_cost_usd.toFixed(4)}`} mono />
          ) : null}
          {usage !== undefined && (usage.input_tokens > 0 || usage.output_tokens > 0) ? (
            <MetaRow
              label="Tokens"
              value={`${formatTokens(usage.input_tokens)} in · ${formatTokens(usage.output_tokens)} out`}
              mono
            />
          ) : null}
        </div>
      </section>
    </aside>
  );
}
