import {
  Error2,
  ErrorCodes,
  IAgentExecutorPreflightService,
  IAgentExecutorRegistry,
  IAgentLifecycleService,
  IAgentProfileService,
  IConfigService,
  IInstantiationService,
  IKosongConfigService,
  IModelCatalog,
  IModelService,
  ISessionAgentProfileCatalog,
  ISessionIndex,
  ISessionLegacyService,
  ISessionManager,
  IWorkspaceService,
  MAIN_AGENT_ID,
  type Scope,
} from '@kiki/agent-core-v2';
import { resolveSessionModelBinding } from '@kiki/agent-core-v2/app/sessionLegacy/sessionLegacyService';
import { resolveEffectiveSessionModel } from '@kiki/agent-core-v2/app/sessionLegacy/sessionModel';
import {
  PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET,
  readPersistedAgentProfileSnapshot,
} from '@kiki/agent-core-v2/session/agentProfileSnapshot';
import { createUnscopedAgentProfileCatalog } from '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/unscopedAgentProfileCatalog';
import {
  ErrorCode,
  sessionModelsResponseSchema,
  type ModelCatalogItem,
  type ProviderQuotaMeter,
  type SessionModelEntry,
  type SessionModelsResponse,
  type SessionQuotaSummary,
  type SessionQuotaWindow,
} from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { sessionAccessSignal } from '../services/sessionAccess/access';
import { readColdSessionMeta } from '../services/snapshot/coldSessionMeta';
import type { ProviderQuotaService } from '../usage/quota/service';
import { projectAgentModelMenu } from './agentModelMenu';
import { resolveBoundPanelProfile, type PanelProfileDefinition } from './agentPanelProfileResolution';
import { trySendMappedError } from './_error';

interface SessionModelsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const ENGINE_ERROR_CODES: Readonly<Record<string, number>> = {
  [ErrorCodes.SESSION_NOT_FOUND]: ErrorCode.SESSION_NOT_FOUND,
  [ErrorCodes.REQUEST_INVALID]: ErrorCode.VALIDATION_FAILED,
};

function sanitizeNativeModel(item: ModelCatalogItem): SessionModelEntry {
  const capabilities = [...(item.effective_capabilities ?? item.capabilities ?? [])];
  const thinkingEfforts = item.support_efforts === undefined
    ? []
    : [...new Set(item.support_efforts.filter((effort) => effort.length > 0))];
  const supportsThinking =
    capabilities.includes('thinking') ||
    capabilities.includes('always_thinking') ||
    thinkingEfforts.some((effort) => effort !== 'off');
  return {
    id: item.id,
    name: item.display_name ?? item.remote_id ?? item.id,
    ...(item.provider_id ? { provider_id: item.provider_id } : {}),
    capabilities,
    supports_thinking: supportsThinking,
    thinking_efforts: thinkingEfforts,
    ...(item.max_context_size > 0 ? { context_length: item.max_context_size } : {}),
  };
}

function computeRemainingPercent(meter: ProviderQuotaMeter): number | null {
  let raw: number | null = null;
  if (meter.unit === 'percent') {
    if (meter.remaining !== null) raw = meter.remaining;
    else if (meter.used !== null) raw = 100 - meter.used;
  } else if (meter.limit !== null && meter.limit > 0) {
    if (meter.remaining !== null) raw = (meter.remaining / meter.limit) * 100;
    else if (meter.used !== null) raw = ((meter.limit - meter.used) / meter.limit) * 100;
  }
  if (raw === null || !Number.isFinite(raw)) return null;
  return Math.round(Math.max(0, Math.min(100, raw)) * 100) / 100;
}

function sanitizeQuotaWindow(meter: ProviderQuotaMeter): SessionQuotaWindow {
  return {
    id: meter.id,
    label: meter.label,
    remaining_percent: computeRemainingPercent(meter),
    reset_at: meter.window?.reset_at ?? null,
  };
}

async function resolveQuotaSummary(
  providerQuota: ProviderQuotaService | undefined,
  executorId: string,
  activeProviderId: string | undefined,
): Promise<SessionQuotaSummary | null> {
  if (providerQuota === undefined || activeProviderId === undefined || activeProviderId === '') return null;
  try {
    const snapshot = await providerQuota.snapshot();
    const expectedKind = executorId === 'native' ? 'provider' : 'executor';
    const source = snapshot.sources.find(
      (candidate) => candidate.kind === expectedKind && candidate.provider_id === activeProviderId,
    );
    if (source === undefined || !source.supported || !source.enabled) return null;
    return {
      provider_id: source.provider_id,
      status: source.status,
      windows: source.meters.map(sanitizeQuotaWindow),
    };
  } catch {
    return null;
  }
}

async function resolveSessionModels(
  core: Scope,
  sessionId: string,
  providerQuota: ProviderQuotaService | undefined,
  signal?: AbortSignal,
): Promise<SessionModelsResponse> {
  const manager = core.accessor.get(ISessionManager);
  const live = manager.get(sessionId);
  let executorId = 'native';
  let profile: PanelProfileDefinition | undefined;
  let frozenProfile = false;
  let explicitThinkingLevel: string | undefined;

  if (live === undefined) {
    if (manager.isEphemeral(sessionId)) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const summary = await core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const saved = await readColdSessionMeta(core, summary.workspaceId, sessionId);
    const mainMetadata = saved?.agents?.[MAIN_AGENT_ID];
    const snapshot = await readPersistedAgentProfileSnapshot(
      core,
      summary.workspaceId,
      sessionId,
      MAIN_AGENT_ID,
      mainMetadata,
      signal,
      { inlineByteBudget: PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET, skipRequestAndMcp: true },
    );
    const workspaceRoot =
      saved?.worktree?.sourceRoot ??
      summary.worktree?.sourceRoot ??
      saved?.cwd ??
      summary.cwd ??
      (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
    const preview = workspaceRoot === undefined
      ? undefined
      : createUnscopedAgentProfileCatalog(
          core.accessor.get(IInstantiationService),
          workspaceRoot,
          summary.workspaceId,
          false,
        );
    try {
      await preview?.catalog.ready;
      const modelsSvc = core.accessor.get(IModelService);
      await modelsSvc.ready;
      const defaultProfile = preview?.catalog.getDefault();
      const binding = resolveEffectiveSessionModel(modelsSvc, snapshot ?? {}, defaultProfile);
      executorId = binding.executorId;
      const profileName =
        snapshot?.profileName ??
        snapshot?.boundProfile?.name ??
        snapshot?.execution?.selection.profile ??
        defaultProfile?.name;
      profile = preview === undefined
        ? snapshot?.boundProfile
        : resolveBoundPanelProfile(preview.catalog, profileName, snapshot?.profileDefinitionId, {
            bound: snapshot?.boundProfile,
            metadataMain: true,
          }).profile ?? defaultProfile;
      frozenProfile = snapshot?.boundProfile !== undefined && profile === snapshot.boundProfile;
      if (snapshot?.thinkingLevel !== undefined && snapshot.thinkingLevel !== '') {
        explicitThinkingLevel = snapshot.thinkingLevel;
      }
    } finally {
      await preview?.dispose();
    }
  } else {
    const main = live.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
    const catalog = live.accessor.get(ISessionAgentProfileCatalog);
    await catalog.ready;
    const binding = await resolveSessionModelBinding(live);
    executorId = binding.executorId;
    if (main !== undefined) {
      const data = main.accessor.get(IAgentProfileService).data();
      profile = resolveBoundPanelProfile(catalog, data.profileName, data.profileDefinitionId, {
        bound: data.boundProfile,
        metadataMain: true,
      }).profile ?? catalog.getDefault();
      frozenProfile = data.boundProfile !== undefined && profile === data.boundProfile;
      const candidateEffort = data.effectiveThinkingLevel ?? data.thinkingLevel;
      if (candidateEffort !== undefined && candidateEffort !== '') {
        explicitThinkingLevel = candidateEffort;
      }
    } else {
      profile = catalog.getDefault();
    }
  }

  const status = await core.accessor.get(ISessionLegacyService).status(sessionId);
  const currentModel = status.model ?? null;
  const thinkingEffort = status.thinking_level !== '' ? status.thinking_level : (explicitThinkingLevel ?? null);
  const thinking = thinkingEffort === null ? null : thinkingEffort !== 'off';

  let models: SessionModelEntry[];
  let activeProviderId: string | undefined;

  if (executorId === 'native') {
    await core.accessor.get(IConfigService).ready;
    await core.accessor.get(IKosongConfigService).ready;
    const modelsSvc = core.accessor.get(IModelService);
    await modelsSvc.ready;
    const allModels = await core.accessor.get(IModelCatalog).listModels();
    const enabledModels = allModels.filter((item) => item.enabled !== false);
    let selectable = enabledModels;
    if (profile !== undefined) {
      const projected = projectAgentModelMenu(core, { ...profile, executor: undefined }, 'main', frozenProfile);
      const allowedIds = new Set(
        projected.effective_model_aliases.map((alias) => modelsSvc.resolveId(alias) ?? alias),
      );
      selectable = enabledModels.filter((item) => allowedIds.has(item.id));
    }
    models = selectable.map(sanitizeNativeModel);
    if (currentModel !== null) {
      const resolvedCurrentId = modelsSvc.resolveId(currentModel) ?? currentModel;
      activeProviderId = allModels.find((item) => item.id === resolvedCurrentId)?.provider_id;
    }
  } else {
    const registry = core.accessor.get(IAgentExecutorRegistry);
    const descriptor = registry.get(executorId);
    const checkedVersion =
      core.accessor.get(IAgentExecutorPreflightService).lastCheck(executorId)?.version ?? descriptor?.version;
    const execCatalog = registry.getExecutorCapabilityCatalog?.(
      executorId,
      checkedVersion === undefined ? undefined : { version: checkedVersion },
    );
    const modelIds = profile !== undefined
      ? projectAgentModelMenu(core, { ...profile, executor: executorId }, 'main', frozenProfile).effective_model_aliases
      : [...(execCatalog?.models.values ?? [])];
    const thinkingLevels = execCatalog?.thinkingLevels.values === undefined
      ? []
      : [...execCatalog.thinkingLevels.values];
    const supportsThinking = thinkingLevels.some((level) => level !== 'off');
    const contextWindow = execCatalog?.context.contextWindow;
    models = modelIds.map((id): SessionModelEntry => ({
      id,
      name: id,
      provider_id: executorId,
      capabilities: supportsThinking ? ['thinking'] : [],
      supports_thinking: supportsThinking,
      thinking_efforts: thinkingLevels,
      ...(contextWindow !== undefined && contextWindow > 0 ? { context_length: contextWindow } : {}),
    }));
    activeProviderId = executorId;
  }

  const quotaSummary = await resolveQuotaSummary(providerQuota, executorId, activeProviderId);

  return {
    executor_id: executorId,
    current: {
      model: currentModel,
      model_name: status.model_name,
      thinking,
      thinking_effort: thinkingEffort,
      permission_mode: status.permission !== '' ? status.permission : null,
      plan_mode: status.plan_mode,
    },
    models,
    quota_summary: quotaSummary,
  };
}

/** Register cold-safe `GET /sessions/{session_id}/models` returning sanitized selectable models and quota summary. */
export function registerSessionModelsRoutes(
  app: SessionModelsRouteHost,
  core: Scope,
  providerQuota?: ProviderQuotaService,
): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/models',
      params: sessionIdParamSchema,
      success: { data: sessionModelsResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Read sanitized selectable models, active model/thinking/mode state, and quota summary for one session without resuming a cold session',
      tags: ['sessions'],
      operationId: 'getSessionModels',
    },
    async (req, reply) => {
      try {
        const data = await resolveSessionModels(
          core,
          req.params.session_id,
          providerQuota,
          sessionAccessSignal(req),
        );
        reply.send(okEnvelope(data, req.id));
      } catch (error) {
        if (trySendMappedError(reply, req.id, error, { codes: ENGINE_ERROR_CODES })) return;
        reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<SessionModelsRouteHost['get']>[2]);
}
