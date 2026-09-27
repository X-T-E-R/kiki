import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TaskListInputSchema = z.object({
  active_only: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to list only non-terminal background tasks.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of tasks to return.')
    .optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe('Number of matching tasks to skip before returning the page.')
    .optional(),
});

export type TaskListInput = z.infer<typeof TaskListInputSchema>;

export interface ITaskListTool extends AgentTool<TaskListInput> { readonly _serviceBrand: undefined }
export const ITaskListTool = createDecorator<ITaskListTool>('taskListTool');
