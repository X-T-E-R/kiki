import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'TaskWait',
  'CronList',
  'WebSearch',
  'FetchURL',
  'MemoryRead',
  'MemorySearch',
  'MemoryWrite',
  'AgentRun',
  'AgentList',
  'AgentSend',
  'AgentNotify',
  'Branch',
  'Merge',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'SelectTools',
  'HistoryList',
  'HistorySearch',
  'HistoryRead',
]);

const DEFAULT_APPROVE_ACTIONS = new Map<string, ReadonlySet<string>>([
  ['Cron', new Set(['list'])],
  ['Goal', new Set(['get', 'create', 'update'])],
]);

export class DefaultToolApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const name = context.toolCall.name;
    if (DEFAULT_APPROVE_TOOLS.has(name)) return { kind: 'approve' };
    const action = typeof context.args === 'object' && context.args !== null
      ? (context.args as { readonly action?: unknown }).action : undefined;
    return typeof action === 'string' && DEFAULT_APPROVE_ACTIONS.get(name)?.has(action) === true
      ? { kind: 'approve' }
      : undefined;
  }
}
