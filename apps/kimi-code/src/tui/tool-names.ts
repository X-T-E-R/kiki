/**
 * Tool names the TUI renders specially. Sessions recorded before the tool
 * surface was renamed still carry the old names on disk, so the predicates
 * accept both. Only the current names are ever emitted.
 */

export const AGENT_RUN_TOOL = 'AgentRun';
export const TASK_WAIT_TOOL = 'TaskWait';

const LEGACY_AGENT_RUN_TOOL = 'Agent';
const LEGACY_TASK_WAIT_TOOL = 'WaitFor';

export function isAgentRunTool(name: string): boolean {
  return name === AGENT_RUN_TOOL || name === LEGACY_AGENT_RUN_TOOL;
}

export function isTaskWaitTool(name: string): boolean {
  return name === TASK_WAIT_TOOL || name === LEGACY_TASK_WAIT_TOOL;
}
