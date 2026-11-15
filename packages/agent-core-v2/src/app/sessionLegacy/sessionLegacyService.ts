import type { GoalSnapshot } from '#/agent/goal/types';
import { PersistedGoalReader } from '#/agent/goal/goalRead';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { PersistedStatusReader } from './persistedStatus';
import { readPersistedAgentProfileSnapshot } from '#/session/agentProfileSnapshot';
import { createUnscopedAgentProfileCatalog } from '#/workspace/workspaceAgentProfileLoader/unscopedAgentProfileCatalog';
import { TOKEN_COUNTING_SECTION, type TokenCountingConfig } from '#/agent/tokenCounting/configSection';
import { mergeModelParameters, resolveModelProfileEntry } from '#/app/agentProfileCatalog/modelProfileOverlay';
import { resolveEffectiveSessionModel } from './sessionModel';
import { modelWithUsage } from '#/kosong/model/parameters';
import { drivesThinkingThroughTraits, requiresStrictThinkingValidation, resolveForcedThinkingEffort, resolveThinkingEffortForModel, type ThinkingConfig } from '#/kosong/model/thinking';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { ThinkingEffort } from '#/kosong/contract/provider';
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
import { getLiveSessionById } from '#/app/sessionManager/sessionLookup';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentActivityView } from '#/agent/activityView/activityView';

import { ISessionLegacyService } from './sessionLegacy';

export class SessionLegacyService implements ISessionLegacyService {
  declare readonly _serviceBrand: undefined;

  private readonly services: ServicesAccessor;
  private readonly profileHost: { readonly accessor: ServicesAccessor };

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {
    this.services = {
      get: (id) => instantiation.invokeFunction((accessor) => accessor.get(id)),
    };
    this.profileHost = { accessor: this.services };
  }

  async status(sessionId: string): Promise<SessionStatusResponse> {
    const session = getLiveSessionById(this.services, sessionId);
    if (session !== undefined) return this.assembleStatus(sessionId, session);
    const summary = await this.services.get(ISessionIndex).get(sessionId);
    if (summary === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    const scope = `sessions/${summary.workspaceId}/${sessionId}`;
    const metadata = await this.services.get(IAtomicDocumentStore).get<SessionMeta>(scope, 'state.json');
    const profile = await readPersistedAgentProfileSnapshot(this.profileHost, summary.workspaceId, sessionId, 'main', metadata?.agents?.['main']);
    const preview = createUnscopedAgentProfileCatalog(this.instantiation, metadata?.cwd ?? summary.cwd, summary.workspaceId, false);
    try {
      await preview.catalog.ready;
      const models = this.services.get(IModelService);
      await models.ready;
      const binding = resolveEffectiveSessionModel(models, profile ?? {}, profile?.modelAlias ? undefined : preview.catalog.getDefault());
      const config = this.services.get(IConfigService);
      let thinkingLevel = profile?.modelAlias ? profile.thinkingLevel ?? '' : '';
      let modelName: string | null = null;
      let maxTokens = 0;
      if (binding.executorId === 'native' && binding.model !== undefined) {
        try {
          const boundProfile = profile?.boundProfile;
          const cognition = boundProfile?.promptBase?.inputs?.cognition;
          const settings = cognition?.modelAlias === binding.model ? cognition.modelSettings ?? cognition.recipe?.resolved.model : undefined;
          const model = modelWithUsage(this.services.get(IModelCatalog).get(binding.model, settings), cognition?.position ?? 'main');
          modelName = model.displayName ?? null;
          maxTokens = model.capabilities.max_input_tokens ?? model.capabilities.max_context_tokens;
          if (profile?.modelAlias) {
            const thinking = config.get<ThinkingConfig>(THINKING_SECTION);
            const base = thinkingLevel === 'off' && model.alwaysThinking
              ? resolveThinkingEffortForModel(thinkingLevel, thinking, model, requiresStrictThinkingValidation(
                this.services.get(IProtocolAdapterRegistry), model.protocol, model.providerType,
              )) : thinkingLevel as ThinkingEffort;
            thinkingLevel = resolveForcedThinkingEffort(thinking?.forcedEffort, base, drivesThinkingThroughTraits(model.providerType)) ?? base;
          }
          const entry = resolveModelProfileEntry(boundProfile?.modelProfiles, model.id, id => models.resolveId(id));
          const budget = mergeModelParameters(model, mergeModelParameters(boundProfile ?? {}, entry)).contextBudget;
          if (budget !== undefined) maxTokens = Math.min(maxTokens, budget);
        } catch { modelName = null; }
      }
      this.statusReader ??= new PersistedStatusReader(this.services.get(ICpuWorkerService),
        this.services.get(IAppendLogStore), this.services.get(IFileSystemStorageService));
      const projection = await this.statusReader.read(`${scope}/agents/main`);
      const strategy = config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)?.strategy ?? 'measured+estimated';
      const tokens = projection.contextTokens[strategy];
      return {
        busy: false, model: binding.model, model_name: modelName,
        thinking_level: thinkingLevel,
        permission: projection.permissionConfigured ? projection.permissionMode : config.get<string>('defaultPermissionMode') ?? 'auto',
        plan_mode: projection.planActive, context_tokens: tokens,
        max_context_tokens: maxTokens > 0 ? maxTokens : undefined,
        context_usage: maxTokens > 0 ? Math.min(1, tokens / maxTokens) : 0,
      };
    } finally { await preview.dispose(); }
  }

  private async assembleStatus(
    sessionId: string,
    session: ISessionScopeHandle,
  ): Promise<SessionStatusResponse> {
    const agent = session.accessor.get(IAgentLifecycleService).get('main');
    const profile = agent?.accessor.get(IAgentProfileService);
    const { model, executorId } = await resolveSessionModelBinding(session);
    let modelName: string | null = null;
    let maxTokens = 0;
    if (executorId === 'native' && model !== undefined) {
      try {
        const configured = session.accessor.get(IModelCatalog).get(model);
        modelName = configured.displayName ?? null;
        const unboundModel = modelWithUsage(configured, 'main');
        const capabilities = profile?.getModel() ? profile.getModelCapabilities() : unboundModel.capabilities;
        maxTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
        if (!profile?.getModel() && unboundModel.contextBudget !== undefined) maxTokens = Math.min(maxTokens, unboundModel.contextBudget);
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

  private statusReader: PersistedStatusReader | undefined;
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

/** Resolves the effective main model and executor without changing the session binding. */
export async function resolveSessionModelBinding(session: ISessionScopeHandle): Promise<{ model: string | undefined; executorId: string }> {
  const profile = session.accessor.get(IAgentLifecycleService).get('main')?.accessor.get(IAgentProfileService);
  const bound = profile?.getModel();
  const data = profile?.data();
  const metadata = bound ? undefined : (await session.accessor.get(ISessionMetadata).read()).agents?.['main'];
  const modelAlias = bound || metadata?.model;
  const executorId = data?.executorId ?? metadata?.executor;
  const placeholder = profile !== undefined && !modelAlias && data?.profileName === undefined && data?.execution === undefined
    && metadata?.execution === undefined && executorId === 'native' && (metadata?.executor ?? 'native') === 'native';
  const binding = { modelAlias, executorId: placeholder ? undefined : executorId };
  const models = session.accessor.get(IModelService);
  await models.ready;
  if (binding.modelAlias || data?.profileName !== undefined || binding.executorId !== undefined && binding.executorId !== 'native') {
    return resolveEffectiveSessionModel(models, binding);
  }
  const catalog = session.accessor.get(ISessionAgentProfileCatalog);
  await catalog.ready;
  return resolveEffectiveSessionModel(models, binding, catalog.getDefault());
}

registerScopedService(
  LifecycleScope.App,
  ISessionLegacyService,
  SessionLegacyService,
  ScopeActivation.OnScopeCreated,
  'sessionLegacy',
);
