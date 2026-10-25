import type { GoalMarkerChange, GoalMeta } from '../model/meta';

export function projectGoalChange(
  before: GoalMeta | undefined,
  after: GoalMeta | undefined,
  detail?: { readonly reason?: string; readonly actor?: string },
): GoalMarkerChange | undefined {
  if (before === undefined && after === undefined) return undefined;
  if (after === undefined) return before?.status === 'complete' ? undefined : { kind: 'cleared', reason: detail?.reason, actor: detail?.actor };
  if (before === undefined || before.goalId !== after.goalId) return { kind: 'created', reason: detail?.reason, actor: detail?.actor };
  if (before.status !== after.status) {
    const kind = after.status === 'active' ? 'resumed'
      : after.status === 'complete' ? 'completed' : after.status;
    return { kind, reason: detail?.reason ?? after.terminalReason, actor: detail?.actor };
  }
  if (before.objective !== after.objective || before.completionCriterion !== after.completionCriterion ||
    (before.followUpTiming ?? 'subagents_done') !== (after.followUpTiming ?? 'subagents_done') ||
    before.budgetLimit !== after.budgetLimit || before.turnBudget !== after.turnBudget ||
    before.wallClockBudgetMs !== after.wallClockBudgetMs) return { kind: 'updated', reason: detail?.reason, actor: detail?.actor };
  return undefined;
}
