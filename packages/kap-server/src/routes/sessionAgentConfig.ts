import {
  DEFAULT_AGENT_PROFILE_NAME,
  ErrorCodes,
  Error2,
  IAgentExecutionService,
  IAgentGoalService,
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
  if (
    agentConfig.thinking !== undefined &&
    agentConfig.thinking_effort !== undefined &&
    agentConfig.thinking !== agentConfig.thinking_effort
  ) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'Conflicting thinking and thinking_effort values');
  }
  const requestedThinking =
    agentConfig.thinking !== undefined ? agentConfig.thinking : agentConfig.thinking_effort;
  const agent = await ensureMainAgent(session);

  const profile = agent.accessor.get(IAgentProfileService);
  const execution = agentConfig.execution ?? ((agentConfig.model !== undefined || requestedThinking !== undefined) && agentConfig.profile === undefined
    ? profile.data().execution?.selection : undefined);
  let selectionConsumed = false;
  if (execution !== undefined) {
    if (agent.accessor.get(IAgentExecutionService).status().state !== 'idle') {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Executor selection requires an idle agent; submit it with the next user message instead');
    }
    await profile.bind({ execution: { ...execution, overrides: { ...execution.overrides,
      permission_mode: agentConfig.permission_mode ?? execution.overrides?.permission_mode,
    } }, model: agentConfig.model || undefined, thinking: requestedThinking });
    const permission = profile.data().execution?.effective.permission_mode;
    if (permission !== undefined) agent.accessor.get(IAgentPermissionModeService).setMode(permission);
    selectionConsumed = true;
  }
  let thinkingConsumed = selectionConsumed;
  const currentProfile = profile.data().profileName ?? DEFAULT_AGENT_PROFILE_NAME;
  if (!selectionConsumed && agentConfig.profile !== undefined && currentProfile !== agentConfig.profile) {
    try {
      const current = profile.data();
      const requestedModel = agentConfig.model === '' ? undefined : agentConfig.model;
      const { thinking: previousPersonaThinking, ...personaRest } = current.personaOverrides ?? {};
      await profile.bind({
        personaSnapshot: current.persona,
        personaOverrides: current.personaId === undefined ? undefined : {
          ...personaRest, profile: agentConfig.profile,
          model: agentConfig.model === undefined || agentConfig.model === '' ? current.personaOverrides?.model : agentConfig.model,
          ...(requestedThinking === null ? {}
            : { thinking: requestedThinking ?? previousPersonaThinking }),
        },
        profile: agentConfig.profile,
        model: requestedModel ?? (current.modelAlias === '' ? undefined : current.modelAlias),
        thinking: requestedThinking === undefined ? current.thinkingLevel : requestedThinking,
        strictThinking: typeof requestedThinking === 'string',
      });
      thinkingConsumed = requestedThinking !== undefined;
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
  if (!selectionConsumed && agentConfig.model !== undefined && agentConfig.model !== '') {
    await profile.setModel(agentConfig.model);
  }
  if (requestedThinking === null && !thinkingConsumed) {
    const bound = profile.data();
    const sameProfile = agentConfig.profile === undefined || agentConfig.profile === (bound.profileName ?? DEFAULT_AGENT_PROFILE_NAME);
    if (bound.execution !== undefined && sameProfile) {
      if (agent.accessor.get(IAgentExecutionService).status().state !== 'idle') {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Executor selection requires an idle agent; submit it with the next user message instead');
      }
      await profile.bind({
        execution: {
          ...bound.execution.selection,
          overrides: { ...bound.execution.selection.overrides, thinking: null },
        },
        model: agentConfig.model || undefined,
        thinking: null,
      });
      const permission = profile.data().execution?.effective.permission_mode;
      if (permission !== undefined) agent.accessor.get(IAgentPermissionModeService).setMode(permission);
    } else {
      profile.restoreDefaultThinking();
    }
  } else if (typeof requestedThinking === 'string' && !thinkingConsumed) {
    profile.setThinking(requestedThinking);
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
      .get(IAgentPermissionModeService)
      .setModeAndBroadcast(agentConfig.permission_mode);
  }
  if (agentConfig.plan_gate !== undefined) {
    agent.accessor.get(IAgentPlanService).setGate(agentConfig.plan_gate);
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
  plan_gate?: 'free' | 'gated';
}> {
  try {
    return {
      permission_mode: agent.accessor.get(IAgentPermissionModeService).mode,
      plan_mode: (await agent.accessor.get(IAgentPlanService).status()) !== null,
      plan_gate: agent.accessor.get(IAgentPlanService).planGate,
    };
  } catch {
    return {};
  }
}
