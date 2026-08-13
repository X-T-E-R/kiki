/**
 * Right rail (collapsible) — todos checklist, background tasks with terminate,
 * and session meta (model, cwd, message count, context/token usage).
 */

import { memo, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import type { GoalSnapshot, Task } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import type { AgentForest } from '../state/agentTree';
import type { SessionViewState, TodoItem } from '../state/transcript';
import { AgentTreeView } from './AgentTreeView';

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

const TodosSection = memo(function TodosSection({ todos }: { todos: readonly TodoItem[] }) {
  const { t } = useI18n();
  if (todos.length === 0) {
    return <p className="text-[12px] text-ink-faint">{t('rail.noTodos')}</p>;
  }
  const done = todos.filter((todo) => {
    const status = todo.status.toLowerCase();
    return status === 'completed' || status === 'done';
  }).length;
  return (
    <div>
      <p className="mb-1.5 text-[10.5px] text-ink-faint">
        {t('rail.todosDone', { done, total: todos.length })}
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
});

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

const TasksSection = memo(function TasksSection({
  tasks,
  onCancel,
}: {
  tasks: readonly Task[];
  onCancel: (taskId: string) => void;
}) {
  const { t } = useI18n();
  if (tasks.length === 0) {
    return <p className="text-[12px] text-ink-faint">{t('rail.noTasks')}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {tasks.map((task) => (
        <li key={task.id} className="rounded-lg border border-hairline bg-panel px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${taskStatusTone(task.status)}`}>
              {t(`rail.taskStatus.${task.status}`)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
              {task.description}
            </span>
            {task.status === 'running' ? (
              <button
                type="button"
                onClick={() => { onCancel(task.id); }}
                title={t('rail.stopTitle')}
                className="shrink-0 rounded-md border border-hairline px-1.5 py-0.5 text-[10px] text-ink-soft transition-colors hover:border-danger hover:text-danger"
              >
                {t('rail.stop')}
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
});

const SubagentsSection = memo(function SubagentsSection({
  forest,
  selectedAgentId,
  onOpen,
}: {
  forest: AgentForest;
  selectedAgentId?: string;
  onOpen: (agentId: string) => void;
}) {
  return <AgentTreeView forest={forest} selectedAgentId={selectedAgentId} onOpen={onOpen} />;
});

const GoalSection = memo(function GoalSection({
  goal,
  goalUpdatedAt,
}: {
  goal: GoalSnapshot | null | undefined;
  goalUpdatedAt: string | undefined;
}) {
  const { t, time } = useI18n();
  if (goal === undefined) {
    return <p className="text-[12px] text-ink-faint">{t('rail.goalUnavailable')}</p>;
  }
  if (goal === null) {
    return <p className="text-[12px] text-ink-faint">{t('rail.noGoal')}</p>;
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
          {t(`composer.goalStatus.${goal.status}`)}
        </span>
        {goalUpdatedAt !== undefined ? (
          <span className="ml-auto text-[10px] text-ink-faint">
            {t('rail.updatedPrefix', { time: time.relativeTime(goalUpdatedAt) })}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[12.5px] font-medium leading-snug text-ink">{goal.objective}</p>
      {goal.completionCriterion !== undefined ? (
        <p className="mt-1 text-[10.5px] leading-snug text-ink-soft">
          {t('rail.doneWhen', { criterion: goal.completionCriterion })}
        </p>
      ) : null}
      {ratio !== undefined ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel">
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      ) : null}
      <p className="mt-1.5 font-mono text-[9.5px] text-ink-faint">
        {t('rail.goalUsage', {
          turns: `${goal.turnsUsed}${turnBudget === null ? '' : `/${turnBudget}`}`,
          tokens: time.formatTokens(goal.tokensUsed),
        })}
      </p>
    </div>
  );
});

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
  forest,
  selectedAgentId,
  onCancelTask,
  onOpenSubagent,
  className,
}: {
  state: SessionViewState;
  forest: AgentForest;
  selectedAgentId?: string;
  onCancelTask: (taskId: string) => void;
  onOpenSubagent: (agentId: string) => void;
  className?: string;
}) {
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const session = state.session;
  const usage = session?.usage;
  const contextTokens = state.contextTokens ?? usage?.context_tokens;
  const contextLimit =
    state.maxContextTokens ?? (usage !== undefined && usage.context_limit > 0 ? usage.context_limit : undefined);
  const backgroundTasks = useMemo(
    () => state.tasks.filter((task) => task.kind !== 'subagent'),
    [state.tasks],
  );
  // Empty sections collapse entirely (header included); when all four are
  // empty the rail shrinks to just the session meta card below.
  const showGoal = state.goal !== undefined && state.goal !== null;
  const showSubagents = Object.keys(forest.byId).some((id) => id !== 'main') || forest.roots.some((root) => root.agentId !== 'main');
  const showTodos = state.todos.length > 0;
  const showTasks = backgroundTasks.length > 0;

  return (
    <aside
      className={
        className ?? 'flex h-full w-[300px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-hairline bg-panel px-4 py-4'
      }
    >
      {showGoal ? (
        <section>
          <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {t('rail.goal')}
          </h3>
          <GoalSection goal={state.goal} goalUpdatedAt={state.goalUpdatedAt} />
        </section>
      ) : null}

      {showSubagents ? (
        <section>
          <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {t('rail.subagents')}
          </h3>
          <SubagentsSection forest={forest} selectedAgentId={selectedAgentId} onOpen={onOpenSubagent} />
        </section>
      ) : null}

      {showTodos ? (
        <section>
          <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {t('rail.todos')}
          </h3>
          <TodosSection todos={state.todos} />
        </section>
      ) : null}

      {showTasks ? (
        <section>
          <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {t('rail.tasks')}
          </h3>
          <TasksSection tasks={backgroundTasks} onCancel={onCancelTask} />
        </section>
      ) : null}

      <section>
        <h3 className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
          {t('rail.session')}
        </h3>
        <div className="space-y-1.5">
          {state.model !== undefined ? <MetaRow label={t('rail.model')} value={state.model} mono /> : null}
          {session !== undefined ? (
            <MetaRow label={t('rail.directory')} value={session.metadata.cwd} mono />
          ) : null}
          {session !== undefined ? (
            <MetaRow label={t('rail.messages')} value={String(session.message_count)} />
          ) : null}
          {session !== undefined ? (
            <MetaRow label={t('rail.updatedRow')} value={time.relativeTime(session.updated_at)} />
          ) : null}
          {contextTokens !== undefined ? (
            <MetaRow
              label={t('rail.context')}
              value={
                contextLimit !== undefined
                  ? `${time.formatTokens(contextTokens)} / ${time.formatTokens(contextLimit)}`
                  : time.formatTokens(contextTokens)
              }
              mono
            />
          ) : null}
          {usage !== undefined && usage.total_cost_usd > 0 ? (
            <MetaRow label={t('rail.cost')} value={`$${usage.total_cost_usd.toFixed(4)}`} mono />
          ) : null}
          {usage !== undefined && (usage.input_tokens > 0 || usage.output_tokens > 0) ? (
            <MetaRow
              label={t('rail.tokens')}
              value={t('rail.tokensInOut', {
                input: time.formatTokens(usage.input_tokens),
                output: time.formatTokens(usage.output_tokens),
              })}
              mono
            />
          ) : null}
          {usage !== undefined ? (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => void navigate('/usage')}
                className="text-[10.5px] font-medium text-accent transition-colors hover:text-accent-deep"
              >
                {t('usage.viewAll')}
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </aside>
  );
}
