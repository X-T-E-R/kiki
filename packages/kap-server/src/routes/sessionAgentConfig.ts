import {
  DEFAULT_AGENT_PROFILE_NAME,
  ErrorCodes,
  Error2,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentSwarmService,
  ProfileError,
  resumeSessionById,
  type IAgentScopeHandle,
  type PermissionMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type {
  SessionAgentConfigCreate,
  SessionAgentConfigPartial,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ensureMainAgent } from '../transport/mainAgent';

export async function applySessionAgentConfig(
  core: Scope,
  sessionId: string,
  agentConfig: SessionAgentConfigPartial,
): Promise<void> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const agent = await ensureMainAgent(session);

  const profile = agent.accessor.get(IAgentProfileService);
  let thinkingConsumed = false;
  const currentProfile = profile.data().profileName ?? DEFAULT_AGENT_PROFILE_NAME;
  if (agentConfig.profile !== undefined && currentProfile !== agentConfig.profile) {
    try {
      const current = profile.data();
      const requestedModel = agentConfig.model === '' ? undefined : agentConfig.model;
      await profile.bind({
        profile: agentConfig.profile,
        model: requestedModel ?? (current.modelAlias === '' ? undefined : current.modelAlias),
        thinking: agentConfig.thinking ?? current.thinkingLevel,
        strictThinking: agentConfig.thinking !== undefined,
      });
      thinkingConsumed = agentConfig.thinking !== undefined;
    } catch (error) {
      if (error instanceof ProfileError) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
      }
      throw error;
    }
  }
  if (agentConfig.model !== undefined && agentConfig.model !== '') {
    await profile.setModel(agentConfig.model);
  }
  if (agentConfig.thinking !== undefined && !thinkingConsumed) {
    profile.setThinking(agentConfig.thinking);
  }
  await applyAgentRuntimeControls(agent, agentConfig);
  if (agentConfig.goal_objective !== undefined) {
    await agent.accessor.get(IAgentGoalService).createGoal({ objective: agentConfig.goal_objective });
  }
  if (agentConfig.goal_control !== undefined) {
    const goal = agent.accessor.get(IAgentGoalService);
    switch (agentConfig.goal_control) {
      case 'pause':
        await goal.pauseGoal({});
        break;
      case 'resume':
        await goal.resumeGoal({ continueIfPaused: true, continueIfBlocked: true });
        break;
      case 'cancel':
        await goal.cancelGoal({});
        break;
    }
  }
}

export async function applyAgentRuntimeControls(
  agent: IAgentScopeHandle,
  agentConfig: SessionAgentConfigCreate,
): Promise<void> {
  if (agentConfig.permission_mode !== undefined) {
    agent.accessor
      .get(IAgentLifecycleService)
      .broadcastPermissionMode(agentConfig.permission_mode as PermissionMode);
  }
  if (agentConfig.plan_mode !== undefined) {
    const plan = agent.accessor.get(IAgentPlanService);
    const active = (await plan.status()) !== null;
    if (active !== agentConfig.plan_mode) {
      if (agentConfig.plan_mode) await plan.enter();
      else plan.exit();
    }
  }
  if (agentConfig.swarm_mode !== undefined) {
    const swarm = agent.accessor.get(IAgentSwarmService);
    if (swarm.isActive !== agentConfig.swarm_mode) {
      if (agentConfig.swarm_mode) swarm.enter('manual');
      else swarm.exit();
    }
  }
}

/** Live permission / plan / swarm flags from a materialized main agent. */
export async function readAgentRuntimeControls(agent: IAgentScopeHandle): Promise<{
  permission_mode?: PermissionMode;
  plan_mode?: boolean;
  swarm_mode?: boolean;
}> {
  try {
    return {
      permission_mode: agent.accessor.get(IAgentPermissionModeService).mode,
      plan_mode: (await agent.accessor.get(IAgentPlanService).status()) !== null,
      swarm_mode: agent.accessor.get(IAgentSwarmService).isActive,
    };
  } catch {
    return {};
  }
}
