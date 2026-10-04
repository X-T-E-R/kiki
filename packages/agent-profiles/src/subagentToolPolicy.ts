import { isToolExplicitlyNamed, type ToolSource } from './toolPolicy';

export const SUBAGENT_OPT_IN_TOOL_NAMES = [
  'BoardRead', 'BoardWrite', 'AskUserQuestion', 'Cron', 'CronCreate', 'CronDelete', 'CronList',
  'EnterPlanMode', 'ExitPlanMode', 'ThreadCreate', 'ThreadList', 'ThreadRead', 'ThreadWait',
] as const;

export const SUBAGENT_MAIN_ONLY_TOOL_NAMES = [
  'MemoryWrite', 'ThreadSend', 'SendMessage', 'Goal', 'CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal',
] as const;

export const SUBAGENT_DEFAULT_ALLOWED_TOOL_NAMES = [
  'AgentList',
  'AgentNotify',
  'AgentRun',
  'AgentSend',
  'Bash',
  'Edit',
  'FetchURL',
  'Glob',
  'Grep',
  'MemorySearch',
  'MemoryRead',
  'Read',
  'ReadMediaFile',
  'SelectTools',
  'Skill',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskWait',
  'TodoList',
  'WebSearch',
  'Write',
] as const;

export type SubagentToolDefault = 'allowed' | 'opt-in' | 'main-only';

export interface SubagentToolPolicy {
  readonly allowedTools?: readonly string[];
  readonly explicitProfileTools?: readonly string[];
}

export function subagentToolDefault(name: string, source: ToolSource = 'builtin'): SubagentToolDefault {
  if (source !== 'builtin') return 'allowed';
  if ((SUBAGENT_MAIN_ONLY_TOOL_NAMES as readonly string[]).includes(name)) return 'main-only';
  if ((SUBAGENT_OPT_IN_TOOL_NAMES as readonly string[]).includes(name)) return 'opt-in';
  return 'allowed';
}

export function isSubagentToolAllowed(
  policy: SubagentToolPolicy,
  name: string,
  source: ToolSource = 'builtin',
): boolean {
  const access = subagentToolDefault(name, source);
  if (access === 'main-only') return false;
  if (access === 'allowed') return true;
  return isToolExplicitlyNamed(policy.allowedTools, name) || isToolExplicitlyNamed(policy.explicitProfileTools, name);
}
