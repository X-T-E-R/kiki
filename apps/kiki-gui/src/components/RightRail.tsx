/**
 * Right rail (collapsible) — todos checklist, background tasks with terminate,
 * and session meta (model, cwd, message count, context/token usage).
 */

import { useEffect, useState } from 'react';

import type { Task } from '@moonshot-ai/protocol';

import { formatDuration, formatTokens, relativeTime } from '../lib/time';
import type { SessionViewState, SubagentBlock, TodoItem } from '../state/transcript';

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

function SubagentsSection({
  subagents,
  onOpen,
}: {
  subagents: readonly SubagentBlock[];
  onOpen: (agentId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const hasRunning = subagents.some((subagent) => subagent.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);
  if (subagents.length === 0) {
    return <p className="text-[12px] text-ink-faint">No subagents in this session.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {subagents.map((subagent) => {
        const start = new Date(subagent.startedAt).getTime();
        const end = subagent.endedAt === undefined ? now : new Date(subagent.endedAt).getTime();
        const elapsed = Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
        const dot =
          subagent.status === 'running'
            ? 'bg-accent'
            : subagent.status === 'completed'
              ? 'bg-success'
              : subagent.status === 'failed'
                ? 'bg-danger'
                : 'bg-amber-rule';
        return (
          <li key={subagent.subagentId}>
            <button
              type="button"
              onClick={() => onOpen(subagent.subagentId)}
              className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-panel px-2.5 py-2 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft/30"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot} ${subagent.status === 'running' ? 'status-dot-busy' : ''}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-ink">{subagent.name}</span>
                <span className="block truncate text-[10px] text-ink-faint">
                  {subagent.status} · {subagent.toolCallCount} tools
                </span>
              </span>
              <span className="shrink-0 font-mono text-[9.5px] text-ink-faint">
                {formatDuration(elapsed)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function GoalSection({ state }: { state: SessionViewState }) {
  const goal = state.goal;
  if (goal === undefined) {
    return <p className="text-[12px] text-ink-faint">Goal state unavailable from this server.</p>;
  }
  if (goal === null) {
    return <p className="text-[12px] text-ink-faint">No active goal.</p>;
  }
  const turnBudget = goal.budget.turnBudget;
  const tokenBudget = goal.budget.tokenBudget;
  const ratio =
    turnBudget !== null && turnBudget > 0
      ? goal.turnsUsed / turnBudget
      : tokenBudget !== null && tokenBudget > 0
        ? goal.tokensUsed / tokenBudget
        : undefined;
  return (
    <div className="rounded-xl border border-amber-rule/40 bg-amber-card/60 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-amber-ink">
          {goal.status}
        </span>
        {state.goalUpdatedAt !== undefined ? (
          <span className="ml-auto text-[10px] text-ink-faint">updated {relativeTime(state.goalUpdatedAt)}</span>
        ) : null}
      </div>
      <p className="mt-2 text-[12.5px] font-medium leading-snug text-ink">{goal.objective}</p>
      {goal.completionCriterion !== undefined ? (
        <p className="mt-1 text-[10.5px] leading-snug text-ink-soft">Done when: {goal.completionCriterion}</p>
      ) : null}
      {ratio !== undefined ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel">
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      ) : null}
      <p className="mt-1.5 font-mono text-[9.5px] text-ink-faint">
        {goal.turnsUsed}{turnBudget === null ? '' : `/${turnBudget}`} turns · {formatTokens(goal.tokensUsed)} tokens
      </p>
    </div>
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
  onOpenSubagent,
  className,
}: {
  state: SessionViewState;
  onCancelTask: (taskId: string) => void;
  onOpenSubagent: (agentId: string) => void;
  className?: string;
}) {
  const session = state.session;
  const usage = session?.usage;
  const contextTokens = state.contextTokens ?? usage?.context_tokens;
  const contextLimit =
    state.maxContextTokens ?? (usage !== undefined && usage.context_limit > 0 ? usage.context_limit : undefined);
  const subagents = state.blocks.filter(
    (block): block is SubagentBlock => block.kind === 'subagent',
  );

  return (
    <aside
      className={
        className ?? 'flex h-full w-[300px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-hairline bg-panel px-4 py-4'
      }
    >
      <section>
        <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          Goal
        </h3>
        <GoalSection state={state} />
      </section>

      <section>
        <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          Subagents
        </h3>
        <SubagentsSection subagents={subagents} onOpen={onOpenSubagent} />
      </section>

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
        <TasksSection tasks={state.tasks.filter((task) => task.kind !== 'subagent')} onCancel={onCancelTask} />
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
