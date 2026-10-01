import { z } from 'zod';
import GOAL_DESCRIPTION from './goal.md?raw';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { ICreateGoalTool, CreateGoalToolInputSchema } from './create-goal/create-goal';
import { IGetGoalTool, GetGoalToolInputSchema } from './get-goal/get-goal';
import { ISetGoalBudgetTool, SetGoalBudgetToolInputSchema } from './set-goal-budget/set-goal-budget';
import { IUpdateGoalTool, UpdateGoalToolInputSchema } from './update-goal/update-goal';

const GoalInputSchema = z.discriminatedUnion('action', [
  CreateGoalToolInputSchema.extend({ action: z.literal('create') }),
  GetGoalToolInputSchema.extend({ action: z.literal('get') }),
  SetGoalBudgetToolInputSchema.extend({ action: z.literal('set_budget') }),
  UpdateGoalToolInputSchema.extend({ action: z.literal('update') }),
]);

type GoalInput = z.infer<typeof GoalInputSchema>;

export interface IGoalTool extends AgentTool<GoalInput> {}
export const IGoalTool = createDecorator<IGoalTool>('goalTool');

export class GoalTool implements IGoalTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Goal';
  readonly description = GOAL_DESCRIPTION;
  readonly parameters = toInputJsonSchema(GoalInputSchema);

  constructor(
    @ICreateGoalTool private readonly create: ICreateGoalTool,
    @IGetGoalTool private readonly get: IGetGoalTool,
    @ISetGoalBudgetTool private readonly budget: ISetGoalBudgetTool,
    @IUpdateGoalTool private readonly update: IUpdateGoalTool,
    @IAgentToolPolicyService private readonly policy: IAgentToolPolicyService,
  ) {}

  async resolveExecution(input: GoalInput): Promise<ToolExecution> {
    const parsed = GoalInputSchema.safeParse(input);
    if (!parsed.success) return { isError: true, output: parsed.error.message };
    const action = parsed.data.action;
    const oldName = action === 'create' ? 'CreateGoal'
      : action === 'get' ? 'GetGoal'
        : action === 'set_budget' ? 'SetGoalBudget' : 'UpdateGoal';
    if (!this.policy.isToolActive(oldName)) {
      return { isError: true, output: `Goal action ${action} is disabled by the active tool policy.` };
    }
    const execution = await (action === 'create' ? this.create.resolveExecution(parsed.data)
      : action === 'get' ? this.get.resolveExecution({})
        : action === 'set_budget' ? this.budget.resolveExecution(parsed.data)
          : this.update.resolveExecution(parsed.data));
    if ('isError' in execution && execution.isError === true) return execution;
    return { ...execution, matchesRule: (rule) =>
      rule === action || execution.matchesRule?.(rule) === true };
  }
}

registerAgentToolService(IGoalTool, GoalTool, {
  name: 'Goal',
  domain: 'goal',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
