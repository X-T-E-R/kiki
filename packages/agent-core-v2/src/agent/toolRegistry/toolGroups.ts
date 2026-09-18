import type { ToolGroupId } from '@kiki/agent-profiles/toolGroups';

const TOOL_GROUP_BY_NAME: Readonly<Record<string, ToolGroupId>> = {
  AgentList: 'agent',
  AgentNotify: 'agent',
  AgentRun: 'agent',
  AgentSend: 'agent',
  AskUserQuestion: 'question',
  Bash: 'shell',
  BoardRead: 'board',
  BoardWrite: 'board',
  CreateGoal: 'goal',
  CronCreate: 'cron',
  CronDelete: 'cron',
  CronList: 'cron',
  Edit: 'fsWrite',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  FetchURL: 'web',
  GetGoal: 'goal',
  Glob: 'fsRead',
  Grep: 'fsRead',
  Read: 'fsRead',
  ReadMediaFile: 'fsRead',
  SelectTools: 'toolSelect',
  SetGoalBudget: 'goal',
  Skill: 'skill',
  TaskList: 'task',
  TaskOutput: 'task',
  TaskStop: 'task',
  TaskWait: 'task',
  ThreadList: 'thread',
  ThreadRead: 'thread',
  ThreadSend: 'thread',
  ThreadWait: 'thread',
  TodoList: 'plan',
  UpdateGoal: 'goal',
  WebSearch: 'web',
  Write: 'fsWrite',
};

export function toolGroupForName(name: string): ToolGroupId | undefined {
  return TOOL_GROUP_BY_NAME[name];
}

export function toolNamesForGroup(group: ToolGroupId): readonly string[] {
  return Object.entries(TOOL_GROUP_BY_NAME)
    .filter(([, candidate]) => candidate === group)
    .map(([name]) => name)
    .toSorted((a, b) => a.localeCompare(b));
}
