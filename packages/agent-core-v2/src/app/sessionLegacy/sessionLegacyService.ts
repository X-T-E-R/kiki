import type { GoalSnapshot } from '#/agent/goal/types';
import { PersistedGoalReader } from '#/agent/goal/goalRead';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IConfigService } from '#/app/config/config';

import type { SessionStatusResponse } from './sessionProtocol';
import { LifecycleScope } from '#/app/scopes';
import {
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

  async status(sessionId: string): Promise<SessionStatusResponse> {
    const session = await this.resume(sessionId);
    if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    return this.assembleStatus(sessionId, session);
  }

  private async assembleStatus(
    sessionId: string,
    session: ISessionScopeHandle,
  ): Promise<SessionStatusResponse> {
    const agent = session.accessor.get(IAgentLifecycleService).get('main');
    const profile = agent?.accessor.get(IAgentProfileService);
    const model = await resolveSessionModel(session);
    let modelName: string | null = null;
    let maxTokens = 0;
    if (model !== undefined) {
      try {
        const configured = session.accessor.get(IModelCatalog).get(model);
        modelName = configured.displayName ?? null;
        const capabilities = profile?.getModel() ? profile.getModelCapabilities() : configured.capabilities;
        maxTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
      } catch {
        modelName = null;
      }
    }
    const tokens = agent?.accessor.get(IAgentTokenCountingService).statusSize() ?? 0;
    const planData = await agent?.accessor.get(IAgentPlanService).status();

    return {
      busy: this.readBusy(sessionId),
      model,
      model_name: modelName,
      thinking_level: profile?.getModel() ? profile.getEffectiveThinkingLevel() : '',
      permission: agent?.accessor.get(IAgentPermissionModeService).mode ?? session.accessor.get(IConfigService).get<string>('defaultPermissionMode') ?? 'auto',
      plan_mode: planData != null,
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

/** Resolves the effective main model without creating an agent or changing its binding. */
export async function resolveSessionModel(session: ISessionScopeHandle): Promise<string | undefined> {
  const profile = session.accessor.get(IAgentLifecycleService).get('main')?.accessor.get(IAgentProfileService);
  const bound = profile?.getModel() || (await session.accessor.get(ISessionMetadata).read()).agents?.['main']?.model;
  if (!bound && (profile?.data().executorId ?? 'native') !== 'native') return undefined;
  const models = session.accessor.get(IModelService);
  await models.ready;
  if (bound) return models.resolveId(bound) ?? bound;
  if (profile?.data().profileName === undefined) {
    const catalog = session.accessor.get(ISessionAgentProfileCatalog);
    await catalog.ready;
    const selected = catalog.getDefault().modelAlias;
    if (selected) return models.resolveId(selected) ?? selected;
  }
  return models.getDefaultModel();
}

registerScopedService(
  LifecycleScope.App,
  ISessionLegacyService,
  SessionLegacyService,
  ScopeActivation.OnScopeCreated,
  'sessionLegacy',
);
