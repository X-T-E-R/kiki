import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import type {
  AgentTaskInfo,
  AgentTaskOutputSnapshot,
} from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';
import { formatPlainObject } from '#/agent/task/tools/format';
import { ITaskOutputTool, TaskOutputInputSchema, type TaskOutputInput } from './task-output';
import TASK_OUTPUT_DESCRIPTION from './task-output.md?raw';

const OUTPUT_PREVIEW_BYTES = 32 * 1024;

function retrievalStatus(status: AgentTaskStatus): 'success' | 'not_ready' {
  return TERMINAL_STATUSES.has(status) ? 'success' : 'not_ready';
}

function terminalReason(info: AgentTaskInfo): 'timed_out' | 'stopped' | 'failed' | undefined {
  if (info.status === 'timed_out') return 'timed_out';
  if (info.status === 'killed' && info.stopReason !== undefined) return 'stopped';
  if (info.status === 'failed' && info.stopReason !== undefined) return 'failed';
  return undefined;
}

function fullOutputHint(output: AgentTaskOutputSnapshot): string | undefined {
  if (!output.truncated || !output.fullOutputAvailable || output.outputPath === undefined) return undefined;
  return 'Truncated tail; Read output_path for the full log.';
}

export class TaskOutputTool implements ITaskOutputTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskOutput' as const;
  readonly description: string = TASK_OUTPUT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskOutputInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: TaskOutputInput): ToolExecution {
    return {
      description: `Reading output of task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TaskOutputInput): Promise<ExecutableToolResult> {
    const current = this.tasks.getTask(args.task_id);
    if (!current) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    const paging = args.offset !== undefined || args.max_bytes !== undefined;
    const page = paging
      ? await this.tasks.getOutputPage(args.task_id, args.offset ?? 0, args.max_bytes ?? 16 * 1024)
      : undefined;
    const output: AgentTaskOutputSnapshot = page === undefined
      ? await this.tasks.getOutputSnapshot(args.task_id, paging ? 0 : OUTPUT_PREVIEW_BYTES)
      : { outputPath: page.outputPath, outputSizeBytes: page.totalBytes, previewBytes: 0,
          truncated: page.hasMore, fullOutputAvailable: true, preview: '' };
    const fullOutputAvailable = output.fullOutputAvailable && (!paging || page !== undefined);
    const availablePage = fullOutputAvailable ? page : undefined;
    const lines = [
      formatPlainObject({
        retrievalStatus: retrievalStatus(current.status),
        ...current,
        receipt: current.receiptVerification === 'verified' && fullOutputAvailable ? current.receipt : undefined,
        receiptVerification: current.receiptVerification === 'verified' && !output.fullOutputAvailable
          ? 'invalid' : current.receiptVerification,
        outputPath: fullOutputAvailable ? output.outputPath : undefined,
        terminalReason: terminalReason(current),
        outputSizeBytes: output.outputSizeBytes,
        outputPreviewBytes: paging ? undefined : output.previewBytes,
        outputTruncated: paging ? undefined : output.truncated,
        fullOutputAvailable,
        fullOutputTool: fullOutputAvailable && output.outputPath !== undefined ? 'Read' : undefined,
        fullOutputHint: paging ? undefined : fullOutputHint(output),
        offset: availablePage?.offset,
        nextOffset: availablePage?.nextOffset,
        hasMore: availablePage?.hasMore,
      }),
      '',
    ];

    if (paging) {
      lines.push(availablePage === undefined ? '[Full output unavailable; no verified page can be returned.]' : '[output]',
        availablePage?.text ?? '[no output available]');
    } else {
      if (output.truncated) {
        lines.push(
          fullOutputAvailable && output.outputPath !== undefined
            ? `[Truncated. Full output: ${output.outputPath}]`
            : '[Truncated. No persisted full log is available for this task.]',
        );
      }
      lines.push('[output]', output.preview || '[no output available]');
    }

    return {
      output: lines.join('\n'),
      isError: false,
    };
  }
}

registerAgentToolService(ITaskOutputTool, TaskOutputTool, { name: 'TaskOutput', domain: 'agentTask' });
