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
      `Maximum time for an explicit same-turn wait, in seconds (1-${String(TASK_WAIT_MAX_TIMEOUT_S)}). A timeout returns still-running tasks without stopping them; do not automatically repeat the wait.`,
    ),
  task_id: z
    .string()
    .optional()
    .describe(
      'The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.',
    ),
  sync_wait: z
    .boolean()
    .optional()
    .describe(
      'Explicit synchronous exception for a main agent waiting on a running agent task outside active goal mode (default false). Requires a specific task_id and a concrete sync_reason; not needed for subagents waiting on their own tasks or a main agent waiting on a process task.',
    ),
  sync_reason: z
    .string()
    .optional()
    .describe(
      'Concrete same-turn dependency justifying the main-to-agent sync_wait exception. Routine report collection is not a valid reason; not needed for subagents waiting on their own tasks or a main agent waiting on a process task.',
    ),
});

export type TaskWaitInput = z.infer<typeof TaskWaitInputSchema>;

export interface ITaskWaitTool extends AgentTool<TaskWaitInput> { readonly _serviceBrand: undefined }
export const ITaskWaitTool = createDecorator<ITaskWaitTool>('taskWaitTool');
