import type { GoalSnapshot } from '#/agent/goal/types';
import { Service } from "#/_base/di/service";
import { renderPrompt } from "#/_base/utils/render-prompt";
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import GOAL_ACTIVE_REMINDER from './goal-active-reminder.md?raw';
import GOAL_BLOCKED_REMINDER from './goal-blocked-reminder.md?raw';
import GOAL_PAUSED_REMINDER from './goal-paused-reminder.md?raw';

export interface GoalInjectionOptions {
  readonly getGoal: () => GoalSnapshot | null;
  readonly isTaskWaitEnabled?: () => boolean;
  readonly shouldInject?: () => boolean;
}

export function buildGoalFollowUpGuidance(goal: Pick<GoalSnapshot, 'followUpTiming'>, taskWaitEnabled: boolean): string {
  if (goal.followUpTiming === 'tasks_done') {
    return 'Goal follow-up waits for background sub-agents and finite background tasks to finish. Do useful independent work, or end the turn normally to await completion notifications; the goal will continue when those tasks settle. Long-running services do not delay goal follow-up.';
  }
  const guidance = 'Goal follow-up waits for background sub-agents to finish. Do useful independent work, or end the turn normally to await their completion notifications. Background bash tasks do not delay goal follow-up.';
  return taskWaitEnabled
    ? `${guidance} If a finite background bash task is a concrete dependency for your next goal action, call TaskWait for that task inside this turn to avoid repeated goal continuations while it is still running.`
    : guidance;
}

export class GoalInjection extends Service {
  constructor(
    private readonly options: GoalInjectionOptions,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      injector.register('goal', ({ lastDisclosure }) => {
        const goal = this.options.getGoal();
        if (goal === null) return undefined;
        const signature = JSON.stringify([goal.goalId, goal.objective, goal.completionCriterion, goal.status, goal.terminalReason,
          goal.budget.turnBudget, goal.budget.tokenBudget, goal.budget.wallClockBudgetMs, isNearingBudget(goal),
          goal.followUpTiming, this.options.isTaskWaitEnabled?.() === true]);
        if ((lastDisclosure as { signature?: string } | undefined)?.signature === signature) return undefined;
        const content = this.reminder();
        return content === undefined ? undefined : { content, disclosure: { signature } };
      }),
    );
  }

  private reminder(): string | undefined {
    if (this.options.shouldInject?.() === false) return undefined;
    const goal = this.options.getGoal();
    if (goal === null) return undefined;
    if (goal.status === 'active') {
      return buildGoalReminder(goal, this.options.isTaskWaitEnabled?.() === true);
    }
    if (goal.status === 'blocked') return buildBlockedNote(goal);
    if (goal.status === 'paused') return buildPausedNote(goal);
    return undefined;
  }
}

function buildBlockedNote(goal: GoalSnapshot): string {
  return renderPrompt(GOAL_BLOCKED_REMINDER, {
    reason_suffix: reasonSuffix(goal),
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
  });
}

function buildPausedNote(goal: GoalSnapshot): string {
  return renderPrompt(GOAL_PAUSED_REMINDER, {
    reason_suffix: reasonSuffix(goal),
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
  });
}

function buildGoalReminder(goal: GoalSnapshot, taskWaitEnabled: boolean): string {
  const budgets = formatBudgets(goal);
  return renderPrompt(GOAL_ACTIVE_REMINDER, {
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
    status: goal.status,
    budgets_block: budgets.length > 0
      ? `Budgets as of this reminder: ${budgets}.\nUse Goal({action:"get"}) when a decision needs the latest remaining amount.\n${goal.budget.tokenBudget !== null ? "Goal output tokens count this agent's goal-driven output only, not context size, total billed tokens, or the agent tree.\n" : ''}${isNearingBudget(goal) ? 'A configured budget is nearing its limit. Prioritize the required outcome and essential verification; avoid optional expansion. Report partial work honestly if the limit prevents completion.\n' : ''}`
      : '',
    follow_up_guidance: buildGoalFollowUpGuidance(goal, taskWaitEnabled),
  });
}

function reasonSuffix(goal: GoalSnapshot): string {
  const reason = goal.terminalReason;
  return reason === undefined ? '' : ` (${escapeUntrustedText(reason)})`;
}

function completionCriterionBlock(goal: GoalSnapshot): string {
  if (goal.completionCriterion === undefined) return '';
  return `<untrusted_completion_criterion>\n${escapeUntrustedText(goal.completionCriterion)}\n</untrusted_completion_criterion>\n`;
}

function formatBudgets(goal: GoalSnapshot): string {
  const budgetLines: string[] = [];
  if (goal.budget.turnBudget !== null) {
    budgetLines.push(
      `turns ${goal.turnsUsed}/${goal.budget.turnBudget} (remaining ${goal.budget.remainingTurns})`,
    );
  }
  if (goal.budget.tokenBudget !== null) {
    budgetLines.push(
      `goal output tokens ${goal.tokensUsed}/${goal.budget.tokenBudget} (remaining ${goal.budget.remainingTokens})`,
    );
  }
  if (goal.budget.wallClockBudgetMs !== null) {
    budgetLines.push(
      `time ${formatElapsed(goal.wallClockMs)}/${formatElapsed(goal.budget.wallClockBudgetMs)} (remaining ${formatElapsed(goal.budget.remainingWallClockMs ?? 0)})`,
    );
  }
  return budgetLines.join('; ');
}

function isNearingBudget(goal: GoalSnapshot): boolean {
  return maxBudgetFraction(goal) >= 0.75;
}

function maxBudgetFraction(goal: GoalSnapshot): number {
  const fractions: number[] = [];
  if (goal.budget.turnBudget !== null && goal.budget.turnBudget > 0) {
    fractions.push(goal.turnsUsed / goal.budget.turnBudget);
  }
  if (goal.budget.tokenBudget !== null && goal.budget.tokenBudget > 0) {
    fractions.push(goal.tokensUsed / goal.budget.tokenBudget);
  }
  if (goal.budget.wallClockBudgetMs !== null && goal.budget.wallClockBudgetMs > 0) {
    fractions.push(goal.wallClockMs / goal.budget.wallClockBudgetMs);
  }
  return fractions.length === 0 ? 0 : Math.max(...fractions);
}

function escapeUntrustedText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}
