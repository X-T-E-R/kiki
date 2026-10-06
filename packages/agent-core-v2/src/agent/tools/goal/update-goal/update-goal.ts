import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'blocked'])
      .describe(
        'The lifecycle status to set for the current goal. Use complete only when every explicit requirement and relevant validation is met. Use blocked for a demonstrated impasse requiring user input or an external change after reasonable local diagnosis; do not retry an unchanged blocker merely to reach a turn count.',
      ),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

export interface IUpdateGoalTool extends AgentTool<UpdateGoalToolInput> { readonly _serviceBrand: undefined }
export const IUpdateGoalTool = createDecorator<IUpdateGoalTool>('updateGoalTool');
