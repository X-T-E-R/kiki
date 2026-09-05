import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { DEFAULT_BACKGROUND_TIMEOUT_S } from '#/agent/tools/os/bash/bash';

export const TASK_WAIT_MAX_TIMEOUT_S = DEFAULT_BACKGROUND_TIMEOUT_S;

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
});

export type TaskWaitInput = z.infer<typeof TaskWaitInputSchema>;

export interface ITaskWaitTool extends AgentTool<TaskWaitInput> { readonly _serviceBrand: undefined }
export const ITaskWaitTool = createDecorator<ITaskWaitTool>('taskWaitTool');
