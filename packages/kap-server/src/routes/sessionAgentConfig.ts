import {
  DEFAULT_AGENT_PROFILE_NAME,
  ErrorCodes,
  Error2,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  ProfileError,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type PermissionMode,
} from '@kiki/agent-core-v2';
import type {
  SessionAgentConfigCreate,
  SessionAgentConfigPartial,
} from '@kiki/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ensureMainAgent } from '../transport/mainAgent';

export async function applySessionAgentConfig(
  session: ISessionScopeHandle,
  agentConfig: SessionAgentConfigPartial,
): Promise<void> {
  const agent = await ensureMainAgent(session);

  const profile = agent.accessor.get(IAgentProfileService);
  let thinkingConsumed = false;
  const currentProfile = profile.data().profileName ?? DEFAULT_AGENT_PROFILE_NAME;
  if (agentConfig.profile !== undefined && currentProfile !== agentConfig.profile) {
    try {
      const current = profile.data();
      const requestedModel = agentConfig.model === '' ? undefined : agentConfig.model;
      await profile.bind({
        personaSnapshot: current.persona,
        personaOverrides: current.personaId === undefined ? undefined : {
          ...current.personaOverrides, profile: agentConfig.profile,
          model: agentConfig.model === undefined || agentConfig.model === '' ? current.personaOverrides?.model : agentConfig.model,
          thinking: agentConfig.thinking ?? current.personaOverrides?.thinking,
        },
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
  if (agentConfig.profile !== undefined && currentProfile === agentConfig.profile && profile.data().personaId !== undefined) {
    profile.update({ personaOverrides: { ...profile.data().personaOverrides, profile: agentConfig.profile } });
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
}

/** Live permission / plan flags from a materialized main agent. */
export async function readAgentRuntimeControls(agent: IAgentScopeHandle): Promise<{
  permission_mode?: PermissionMode;
  plan_mode?: boolean;
}> {
  try {
    return {
      permission_mode: agent.accessor.get(IAgentPermissionModeService).mode,
      plan_mode: (await agent.accessor.get(IAgentPlanService).status()) !== null,
    };
  } catch {
    return {};
  }
}
