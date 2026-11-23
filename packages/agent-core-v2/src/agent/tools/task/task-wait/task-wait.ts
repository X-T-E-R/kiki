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
      'The task to wait for: a shell or other background task (or a subagent task only from a subagent or active goal mode). Omit it to wait for the first running task to finish; as a main or branch agent outside goal mode, automatically notifying background subagents cannot be waited on and are left out.',
    ),
});

export type TaskWaitInput = z.infer<typeof TaskWaitInputSchema>;

export interface ITaskWaitTool extends AgentTool<TaskWaitInput> { readonly _serviceBrand: undefined }
export const ITaskWaitTool = createDecorator<ITaskWaitTool>('taskWaitTool');
