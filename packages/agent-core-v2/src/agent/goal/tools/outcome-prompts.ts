import type { GoalSnapshot } from '#/agent/goal/types';

export function buildGoalCompletionSummaryPrompt(goal: GoalSnapshot): string {
  return [
    `Goal completed successfully${goal.terminalReason ? `: ${goal.terminalReason}` : ''}.`,
    '',
    'Write a concise final message for the user. State that the goal is complete, summarize the main work completed, and mention any validation you ran. Do not call more goal tools.',
  ].join('\n');
}

export function buildGoalBlockedReasonPrompt(goal: GoalSnapshot): string {
  return [
    `Goal blocked${goal.terminalReason ? `: ${goal.terminalReason}` : ''}.`,
    '',
    'Write a concise final message for the user. State that the goal is blocked, explain the concrete blocker, and say what input or change is needed before work can continue. Do not call more goal tools.',
  ].join('\n');
}
