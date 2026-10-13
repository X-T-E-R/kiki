import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentGoalService } from '#/agent/goal/goal';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import DESCRIPTION from './set-goal-budget.md?raw';
import {
  SetGoalBudgetToolInputSchema,
  ISetGoalBudgetTool,
  type SetGoalBudgetToolInput,
} from './set-goal-budget';

export class SetGoalBudgetTool implements ISetGoalBudgetTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SetGoalBudget' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SetGoalBudgetToolInputSchema);

  constructor(@IAgentGoalService _goal: IAgentGoalService) {}

  resolveExecution(_args: SetGoalBudgetToolInput): ToolExecution {
    return {
      isError: true,
      output: 'Goal budgets can only be set or cleared by the user in the goal editor.',
    };
  }
}

registerAgentToolService(ISetGoalBudgetTool, SetGoalBudgetTool, {
  name: 'SetGoalBudget',
  domain: 'goal',
  when: () => false,
});
