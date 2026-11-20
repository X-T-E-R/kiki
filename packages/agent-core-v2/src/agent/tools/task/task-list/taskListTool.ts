import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesStringRuleSubject } from '#/tool/rule-match';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo } from '#/agent/task/task';
import { formatPlainObject } from '#/agent/task/tools/format';
import { ITaskListTool, TaskListInputSchema, type TaskListInput } from './task-list';
import TASK_LIST_DESCRIPTION from './task-list.md?raw';

const DEFAULT_TASK_LIST_LIMIT = 20;
const MAX_TASK_LIST_LIMIT = 100;
const TASK_LIST_DEFAULT_LIMIT_ENV = 'KIKI_TASK_LIST_DEFAULT_LIMIT';
const SNAPSHOT_CONCURRENCY = 16;

function resolveDefaultTaskListLimit(): number {
  const raw = process.env[TASK_LIST_DEFAULT_LIMIT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TASK_LIST_LIMIT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TASK_LIST_LIMIT
    ? parsed
    : DEFAULT_TASK_LIST_LIMIT;
}

async function resolveSnapshotsBounded(
  tasks: IAgentTaskService,
  items: readonly AgentTaskInfo[],
): Promise<AgentTaskInfo[]> {
  if (items.length === 0) return [];
  const results = new Array<AgentTaskInfo>(items.length);
  let cursor = 0;
  const workerCount = Math.min(SNAPSHOT_CONCURRENCY, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const task = items[index]!;
        results[index] = (await tasks.getTaskSnapshot(task.taskId)) ?? task;
      }
    }),
  );
  return results;
}

export function formatTaskList(tasks: readonly AgentTaskInfo[], activeOnly: boolean): string {
  const label = activeOnly ? 'active_background_tasks' : 'background_tasks';
  const header = `${label}: ${String(tasks.length)}`;
  if (tasks.length === 0) return `${header}\nNo background tasks found.`;
  return `${header}\n${tasks.map((task) => formatPlainObject({
    ...task,
    receipt: task.receiptVerification === 'verified' ? task.receipt : undefined,
    receiptPath: task.receiptVerification === 'verified' ? task.receipt?.path : undefined,
    receiptContentState: task.receiptVerification === 'verified' ? task.receipt?.contentState : undefined,
  })).join('\n---\n')}`;
}

export class TaskListTool implements ITaskListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskList' as const;
  readonly description = TASK_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskListInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: TaskListInput): ToolExecution {
    const listScope = (args.active_only ?? true) ? 'active' : 'all';
    return {
      description: 'Listing background tasks',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesStringRuleSubject(ruleArgs, listScope),
      execute: async () => {
        const activeOnly = args.active_only ?? true;
        const limit = Math.min(MAX_TASK_LIST_LIMIT, Math.max(1, args.limit ?? resolveDefaultTaskListLimit()));
        const offset = Math.max(0, args.offset ?? 0);
        const results = this.tasks.list(activeOnly, limit + 1, offset);
        const hasMore = results.length > limit;
        const tasks = await resolveSnapshotsBounded(this.tasks, results.slice(0, limit));
        const total = hasMore ? this.tasks.count?.(activeOnly) : undefined;
        const omitted = total !== undefined ? Math.max(0, total - (offset + tasks.length)) : undefined;
        return {
          output: [formatTaskList(tasks, activeOnly), formatPlainObject({
            hasMore,
            nextOffset: hasMore ? offset + limit : undefined,
            total,
            omitted,
          })].join('\n'),
          isError: false,
        };
      },
    };
  }
}

registerAgentToolService(ITaskListTool, TaskListTool, { name: 'TaskList', domain: 'agentTask' });
