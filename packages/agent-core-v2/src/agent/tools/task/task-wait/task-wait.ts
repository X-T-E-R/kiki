import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TASK_WAIT_MAX_TIMEOUT_S = 86_400;

export const TaskWaitInputSchema = z.object({
  timeout: z
    .number()
    .int()
    .positive()
    .max(TASK_WAIT_MAX_TIMEOUT_S)
    .describe(
      `Longest time to wait, in seconds (1-${String(TASK_WAIT_MAX_TIMEOUT_S)}). Reaching it returns the tasks still running and leaves them running.`,
    ),
  task_id: z
    .string()
    .optional()
    .describe(
      'The task to wait for: a shell, subagent or other background task. Omit it to wait for the first running task to finish; as the main agent outside goal mode, subagent tasks are left out of that.',
    ),
  sync_wait: z.boolean().optional().describe('Explicit same-turn wait for a main agent on a running background subagent outside active goal mode. Requires task_id and a non-empty sync_reason.'),
  sync_reason: z.string().optional().describe('Concrete same-turn dependency requiring the subagent result before this turn can finish. Routine report collection should use automatic notification instead.'),
});

export type TaskWaitInput = z.infer<typeof TaskWaitInputSchema>;

export interface ITaskWaitTool extends AgentTool<TaskWaitInput> { readonly _serviceBrand: undefined }
export const ITaskWaitTool = createDecorator<ITaskWaitTool>('taskWaitTool');
