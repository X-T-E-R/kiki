import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import type { PromptExecutionBinding } from './prompt';

export function readPromptRuntimeControlChanges(accessor: ServicesAccessor, binding: PromptExecutionBinding | undefined): () => Promise<boolean> {
  if (!hasPromptRuntimeControls(binding) || binding === undefined) return async () => false;
  const plan = binding.planMode === undefined ? undefined : accessor.get(IAgentPlanService);
  const swarm = binding.swarmMode === undefined ? undefined : accessor.get(IAgentSwarmService);
  const goal = binding.goalObjective === undefined && binding.goalControl === undefined ? undefined : accessor.get(IAgentGoalService);
  return async () => {
    if (plan !== undefined && ((await plan.status()) !== null) !== binding.planMode) return true;
    if (swarm !== undefined && swarm.isActive !== binding.swarmMode) return true;
    if (goal === undefined) return false;
    const current = goal.getGoal().goal;
    if (binding.goalObjective !== undefined && current?.objective !== binding.goalObjective.trim()) return true;
    if (binding.goalControl === 'cancel') return true;
    if (binding.goalControl === 'pause') return current?.status !== 'paused';
    if (binding.goalControl === 'resume') return current?.status !== 'active';
    return false;
  };
}

export function hasPromptRuntimeControls(binding: PromptExecutionBinding | undefined): boolean {
  return binding !== undefined && (binding.planMode !== undefined || binding.swarmMode !== undefined ||
    binding.goalObjective !== undefined || binding.goalControl !== undefined);
}

export function validatePromptRuntimeControls(accessor: ServicesAccessor, binding: PromptExecutionBinding | undefined): void {
  if (!hasPromptRuntimeControls(binding) || binding === undefined) return;
  if (accessor.get(IAgentScopeContext).agentId !== 'main') {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'Prompt plan, swarm and goal controls are only supported by the main agent');
  }
  if (binding.goalObjective === undefined && binding.goalControl === undefined) return;
  const objective = binding.goalObjective?.trim();
  if (objective !== undefined && (objective.length === 0 || objective.length > 4000)) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'Goal objective must contain 1 to 4000 characters');
  }
  const current = accessor.get(IAgentGoalService).getGoal().goal;
  if (objective !== undefined && current !== null && current.objective !== objective) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'A different goal already exists; cancel it before submitting a new objective');
  }
  if (binding.goalControl === undefined) return;
  if (current === null && objective === undefined) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'No goal exists for the requested prompt control');
  }
  const status = current?.status ?? 'active';
  if (binding.goalControl === 'pause' && status !== 'active' && status !== 'paused') {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `Cannot pause a goal in status "${status}"`);
  }
  if (binding.goalControl === 'resume' && status !== 'active' && status !== 'paused' && status !== 'blocked') {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `Cannot resume a goal in status "${status}"`);
  }
}

export function capturePromptGoalId(accessor: ServicesAccessor, binding: PromptExecutionBinding | undefined): string | null | undefined {
  if (binding?.goalObjective === undefined && binding?.goalControl === undefined) return undefined;
  return accessor.get(IAgentGoalService).getGoal().goal?.goalId ?? null;
}

function assertPromptGoalIdentity(goal: IAgentGoalService, expectedId: string | null | undefined): void {
  if (expectedId !== undefined && (goal.getGoal().goal?.goalId ?? null) !== expectedId) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'The goal changed after prompt admission; submit the intended control again for the current goal');
  }
}

export function preparePromptRuntimeControls(accessor: ServicesAccessor, binding: PromptExecutionBinding | undefined, expectedGoalId?: string | null): () => Promise<void> {
  validatePromptRuntimeControls(accessor, binding);
  const plan = binding?.planMode === undefined ? undefined : accessor.get(IAgentPlanService);
  const swarm = binding?.swarmMode === undefined ? undefined : accessor.get(IAgentSwarmService);
  const goal = binding?.goalObjective === undefined && binding?.goalControl === undefined
    ? undefined : accessor.get(IAgentGoalService);
  if (goal !== undefined) assertPromptGoalIdentity(goal, expectedGoalId);
  return async () => {
    if (plan !== undefined) {
      const active = (await plan.status()) !== null;
      if (active !== binding?.planMode) {
        if (binding?.planMode) await plan.enter();
        else plan.exit();
      }
    }
    if (swarm !== undefined && swarm.isActive !== binding?.swarmMode) {
      if (binding?.swarmMode) swarm.enter('manual');
      else swarm.exit();
    }
    if (goal === undefined) return;
    assertPromptGoalIdentity(goal, expectedGoalId);
    if (binding?.goalObjective !== undefined && goal.getGoal().goal === null) {
      const created = await goal.createGoal({ objective: binding.goalObjective });
      assertPromptGoalIdentity(goal, created.goalId);
    }
    switch (binding?.goalControl) {
      case 'pause': await goal.pauseGoal({}); break;
      case 'resume': await goal.resumeGoal({}); break;
      case 'cancel': await goal.cancelGoal({}); break;
    }
  };
}
