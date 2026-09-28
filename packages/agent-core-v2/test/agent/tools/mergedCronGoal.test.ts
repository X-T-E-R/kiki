import { describe, expect, it, vi } from 'vitest';
import { CronTool } from '#/agent/tools/cron/cronTool';
import { GoalTool } from '#/agent/tools/goal/goalTool';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { ToolExecution } from '#/tool/toolContract';
import type { ICronCreateTool } from '#/agent/tools/cron/cron-create/cron-create';
import type { ICronListTool } from '#/agent/tools/cron/cron-list/cron-list';
import type { ICronDeleteTool } from '#/agent/tools/cron/cron-delete/cron-delete';
import type { ICreateGoalTool } from '#/agent/tools/goal/create-goal/create-goal';
import type { IGetGoalTool } from '#/agent/tools/goal/get-goal/get-goal';
import type { ISetGoalBudgetTool } from '#/agent/tools/goal/set-goal-budget/set-goal-budget';
import type { IUpdateGoalTool } from '#/agent/tools/goal/update-goal/update-goal';

function legacy(name: string) {
  return { resolveExecution: vi.fn((): ToolExecution => ({
    approvalRule: name,
    execute: async () => ({ output: name }),
  })) };
}

const policy = (allowed: string[]) => ({ isToolActive: (name: string) => allowed.includes(name) }) as IAgentToolPolicyService;

describe('merged Cron tool', () => {
  it('dispatches each action to its legacy implementation and keeps the approval rule', async () => {
    const create = legacy('CronCreate');
    const list = legacy('CronList');
    const remove = legacy('CronDelete');
    const tool = new CronTool(create as unknown as ICronCreateTool, list as unknown as ICronListTool,
      remove as unknown as ICronDeleteTool, policy(['CronCreate', 'CronList', 'CronDelete']));
    const created = await tool.resolveExecution({ action: 'create', cron: '0 9 * * *', prompt: 'Check CI', recurring: true });
    const listed = await tool.resolveExecution({ action: 'list' });
    const deleted = await tool.resolveExecution({ action: 'delete', id: 'job-id' });
    expect(create.resolveExecution).toHaveBeenCalledOnce();
    expect(list.resolveExecution).toHaveBeenCalledWith({});
    expect(remove.resolveExecution).toHaveBeenCalledOnce();
    expect([created, listed, deleted].map((execution) => 'approvalRule' in execution ? execution.approvalRule : undefined))
      .toEqual(['CronCreate', 'CronList', 'CronDelete']);
    expect('matchesRule' in deleted && deleted.matchesRule?.('delete')).toBe(true);
  });

  it('rejects disabled actions and malformed inputs without invoking legacy tools', async () => {
    const create = legacy('CronCreate');
    const tool = new CronTool(create as unknown as ICronCreateTool, legacy('CronList') as unknown as ICronListTool,
      legacy('CronDelete') as unknown as ICronDeleteTool, policy(['CronList']));
    expect((await tool.resolveExecution({ action: 'create', cron: '* * * * *', prompt: 'check', recurring: true })).isError).toBe(true);
    expect((await tool.resolveExecution({ action: 'create', cron: '', prompt: '', recurring: true })).isError).toBe(true);
    expect(create.resolveExecution).not.toHaveBeenCalled();
  });
});

describe('merged Goal tool', () => {
  it('routes each action with the legacy approval rule', async () => {
    const create = legacy('CreateGoal');
    const get = legacy('GetGoal');
    const budget = legacy('SetGoalBudget');
    const update = legacy('UpdateGoal');
    const tool = new GoalTool(create as unknown as ICreateGoalTool, get as unknown as IGetGoalTool,
      budget as unknown as ISetGoalBudgetTool, update as unknown as IUpdateGoalTool,
      policy(['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal']));
    const results = [
      await tool.resolveExecution({ action: 'create', objective: 'Ship it' }),
      await tool.resolveExecution({ action: 'get' }),
      await tool.resolveExecution({ action: 'set_budget', unit: 'turns', value: 5 }),
      await tool.resolveExecution({ action: 'update', status: 'active' }),
    ];
    expect(results.map((result) => 'approvalRule' in result ? result.approvalRule : undefined))
      .toEqual(['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal']);
    expect(budget.resolveExecution).toHaveBeenCalledOnce();
  });

  it('rejects disabled actions without creating a goal', async () => {
    const create = legacy('CreateGoal');
    const tool = new GoalTool(create as unknown as ICreateGoalTool, legacy('GetGoal') as unknown as IGetGoalTool,
      legacy('SetGoalBudget') as unknown as ISetGoalBudgetTool,
      legacy('UpdateGoal') as unknown as IUpdateGoalTool, policy(['GetGoal']));
    expect((await tool.resolveExecution({ action: 'create', objective: 'Ship it' })).isError).toBe(true);
    expect(create.resolveExecution).not.toHaveBeenCalled();
  });
});
