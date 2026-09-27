import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TaskOutputInputSchema = z.object({
  task_id: z.string().describe('The background task ID to inspect.'),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
    .describe('Byte offset from the beginning of the persisted output; starts at 0. Requires an available full log.'),
  max_bytes: z.number().int().min(4).max(32 * 1024).optional()
    .describe('Maximum UTF-8 bytes to return in a page (4–32768; default 16384 when paging).'),
});

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export interface ITaskOutputTool extends AgentTool<TaskOutputInput> { readonly _serviceBrand: undefined }
export const ITaskOutputTool = createDecorator<ITaskOutputTool>('taskOutputTool');
