import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

const BUDGET_UNITS = ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'] as const;

export const SetGoalBudgetToolInputSchema = z
  .object({
    value: z.number().positive().describe('The positive numeric budget value.'),
    unit: z.enum(BUDGET_UNITS).describe("Budget dimension. tokens counts only this agent's goal-driven output, not context size, total billed tokens, or the agent tree."),
  })
  .strict();

export type SetGoalBudgetToolInput = z.infer<typeof SetGoalBudgetToolInputSchema>;

export interface ISetGoalBudgetTool extends AgentTool<SetGoalBudgetToolInput> { readonly _serviceBrand: undefined }
export const ISetGoalBudgetTool = createDecorator<ISetGoalBudgetTool>('setGoalBudgetTool');
