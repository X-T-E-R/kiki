import type { GoalState } from './goalOps';
import type { GoalSnapshot } from './types';

export function goalSnapshot(state: GoalState, wallClockMs = state.wallClockMs): GoalSnapshot {
  const tokenBudget = state.budgetLimits.tokenBudget ?? null;
  const turnBudget = state.budgetLimits.turnBudget ?? null;
  const wallClockBudgetMs = state.budgetLimits.wallClockBudgetMs ?? null;
  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached = wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;
  return {
    goalId: state.goalId,
    objective: state.objective,
    completionCriterion: state.completionCriterion,
    status: state.status,
    followUpTiming: state.followUpTiming ?? 'subagents_done',
    controlRevision: state.controlRevision ?? 1,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    wallClockMs,
    budget: {
      tokenBudget, turnBudget, wallClockBudgetMs,
      remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
      remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
      remainingWallClockMs: wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
      tokenBudgetReached, turnBudgetReached, wallClockBudgetReached,
      overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
    },
    terminalReason: state.terminalReason,
  };
}
