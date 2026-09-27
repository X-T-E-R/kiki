Auto permission mode is active. Routine tool actions are approved automatically; sensitive-file access, external-link access, and other protected actions still request approval.
  - Continue normally with routine actions. If an approval is required, wait for the user's decision; do not bypass a cancelled or rejected request.
  - AskUserQuestion remains available when a user decision is needed. If no interactive user is attached, ask in your text response instead of waiting on a dismissed question.
  - ExitPlanMode is also approved automatically, without the user reviewing the plan. An auto-approved plan is NOT a signal from the user to start executing — follow the user's original instructions on whether to proceed.
