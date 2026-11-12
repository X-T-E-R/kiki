import type { GoalSnapshot } from '#/agent/goal/types';
import { PersistedGoalReader } from '#/agent/goal/goalRead';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import type { SessionStatusResponse } from './sessionProtocol';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import {
  IInstantiationService,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  getLiveSessionById,
  resumeSessionById,
} from '#/app/sessionManager/sessionLookup';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { ErrorCodes, Error2 } from '#/errors';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentActivityView } from '#/agent/activityView/activityView';

import { ISessionLegacyService } from './sessionLegacy';

export class SessionLegacyService implements ISessionLegacyService {
  declare readonly _serviceBrand: undefined;

  private readonly services: ServicesAccessor;

  constructor(@IInstantiationService instantiation: IInstantiationService) {
    this.services = {
      get: (id) => instantiation.invokeFunction((accessor) => accessor.get(id)),
    };
  }

  private resume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    return resumeSessionById(this.services, sessionId);
  }

  private async resolveMainAgent(sessionId: string): Promise<IAgentScopeHandle> {
    const session = await this.resume(sessionId);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    return ensureMainAgent(session);
  }

  async status(sessionId: string): Promise<SessionStatusResponse> {
    const agent = await this.resolveMainAgent(sessionId);
    return this.assembleStatus(sessionId, agent);
  }

  private async assembleStatus(
    sessionId: string,
    agent: IAgentScopeHandle,
  ): Promise<SessionStatusResponse> {
    const profile = agent.accessor.get(IAgentProfileService);
    const tokenCounting = agent.accessor.get(IAgentTokenCountingService);
    const permission = agent.accessor.get(IAgentPermissionModeService);
    const plan = agent.accessor.get(IAgentPlanService);

    const model = profile.getModel();
    const capabilities = profile.getModelCapabilities();
    let maxTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
    if (maxTokens === 0 && model === '') {
      maxTokens = resolveDefaultModelContextTokens(agent) ?? 0;
    }
    const tokens = tokenCounting.statusSize();
    const planData = await plan.status();

    return {
      busy: this.readBusy(sessionId),
      model: model === '' ? undefined : model,
      thinking_level: model === '' ? '' : profile.getEffectiveThinkingLevel(),
      permission: permission.mode,
      plan_mode: planData !== null,
      context_tokens: tokens,
      max_context_tokens: maxTokens > 0 ? maxTokens : undefined,
      context_usage: maxTokens > 0 ? Math.min(1, tokens / maxTokens) : 0,
    };
  }

  private readBusy(sessionId: string): boolean {
    const handle = getLiveSessionById(this.services, sessionId);
    if (handle === undefined) return false;
    for (const agent of handle.accessor.get(IAgentLifecycleService).list()) {
      const state = agent.accessor.get(IAgentActivityView).state();
      if (state.turn !== undefined || state.background.length > 0) return true;
    }
    return false;
  }

  private goalReader: PersistedGoalReader | undefined;

  async goal(sessionId: string): Promise<GoalSnapshot | null> {
    const live = getLiveSessionById(this.services, sessionId);
    const agent = live?.accessor.get(IAgentLifecycleService).get('main');
    if (agent !== undefined) return agent.accessor.get(IAgentGoalService).getGoal().goal;
    const summary = live === undefined ? await this.services.get(ISessionIndex).get(sessionId) : undefined;
    if (live === undefined && summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const workspaceId = live?.accessor.get(ISessionContext).workspaceId ?? summary!.workspaceId;
    this.goalReader ??= new PersistedGoalReader(
      this.services.get(IAppendLogStore), this.services.get(IAtomicDocumentStore), this.services.get(IFileSystemStorageService),
    );
    return this.goalReader.readReady(`sessions/${workspaceId}/${sessionId}/agents/main`);
  }
}

function resolveDefaultModelContextTokens(agent: IAgentScopeHandle): number | undefined {
  const defaultModel = agent.accessor.get(IModelService).getDefaultModel();
  if (defaultModel === undefined || defaultModel.length === 0) return undefined;
  try {
    const capabilities = agent.accessor.get(IModelCatalog).get(defaultModel).capabilities;
    return capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  } catch {
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLegacyService,
  SessionLegacyService,
  ScopeActivation.OnScopeCreated,
  'sessionLegacy',
);
