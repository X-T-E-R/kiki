import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import { runningSubagentStatus } from '#/agent/task/runningSubagentStatus';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ITaskStopTool, TaskStopInputSchema, type TaskStopInput } from './task-stop';
import TASK_STOP_DESCRIPTION from './task-stop.md?raw';

export class TaskStopTool implements ITaskStopTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskStop' as const;
  readonly description = TASK_STOP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskStopInputSchema);

  constructor(
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
  ) {}

  resolveExecution(args: TaskStopInput): ToolExecution {
    return {
      description: `Stopping task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: async () => {
        const info = this.tasks.getTask(args.task_id);
        if (!info) {
          return { isError: true, output: `Task not found: ${args.task_id}` };
        }

        const trimmedReason = args.reason?.trim();
        const reason =
          trimmedReason === undefined || trimmedReason.length === 0
            ? 'Stopped by TaskStop'
            : trimmedReason;

        if (TERMINAL_STATUSES.has(info.status)) {
          return {
            output:
              `task_id: ${info.taskId}\n` +
              `status: ${info.status}\n` +
              `reason: ${terminalStopReason(info.stopReason)}`,
            isError: false,
          };
        }

        await this.tasks.suppressTerminalNotification(args.task_id);
        const result = await this.tasks.stop(args.task_id, reason);
        if (!result) {
          return { isError: true, output: `Failed to stop task: ${args.task_id}` };
        }

        const remainingSubagents = result.kind === 'agent' && result.ownerAgentId !== undefined
          ? runningSubagentStatus(this.tasks, this.lifecycle, result.ownerAgentId, result.agentId)
          : undefined;
        return {
          output:
            `task_id: ${result.taskId}\n` +
            `status: ${result.status}\n` +
            `reason: ${result.stopReason ?? reason}` +
            (remainingSubagents === undefined ? '' : `\n${remainingSubagents}`),
          isError: false,
        };
      },
    };
  }
}

registerAgentToolService(ITaskStopTool, TaskStopTool, { name: 'TaskStop', domain: 'agentTask' });

function terminalStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? 'Task already in terminal state' : trimmed;
}
