import { effectiveModelConfig, resolveModelProviderId } from '#/kosong/model/modelAuth';
import type { IModelService } from '#/kosong/model/model';
import type { IProviderService } from '#/kosong/provider/provider';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { HookBinding } from './rules';

export interface HookBindingSources {
  readonly profile?: IAgentProfileService;
  readonly agent?: IAgentScopeContext;
  readonly models?: IModelService;
  readonly providers?: IProviderService;
  readonly permissionMode?: IAgentPermissionModeService;
}

export function resolveHookBinding(sources: HookBindingSources): HookBinding {
  const data = sources.profile?.data?.();
  const modelAlias = data?.modelAlias;
  const canonicalModelId =
    modelAlias === undefined ? undefined : (sources.models?.resolveId?.(modelAlias) ?? modelAlias);
  const modelRecord =
    canonicalModelId === undefined
      ? undefined
      : (sources.models?.get?.(canonicalModelId) ?? (modelAlias === undefined ? undefined : sources.models?.get?.(modelAlias)));
  const providerId =
    modelRecord === undefined
      ? undefined
      : resolveModelProviderId(modelRecord, sources.providers?.getDefaultProvider?.());
  const providerRecord = providerId === undefined ? undefined : sources.providers?.get?.(providerId);
  const providerType =
    providerRecord?.type ??
    modelRecord?.protocol ??
    (modelAlias === undefined ? undefined : sources.profile?.getModelProviderType?.(modelAlias));
  const effectiveModel =
    modelRecord === undefined ? undefined : effectiveModelConfig(modelRecord, providerType);
  const remoteModelId =
    effectiveModel === undefined
      ? canonicalModelId
      : (effectiveModel.name ?? effectiveModel.model ?? canonicalModelId);
  const thinkingEffort =
    sources.profile?.getEffectiveThinkingLevel?.() ??
    data?.effectiveThinkingLevel ??
    (data?.thinkingLevel === '' ? undefined : data?.thinkingLevel);
  const agentRole =
    sources.agent === undefined
      ? undefined
      : sources.agent.parentAgentId === undefined
        ? 'root'
        : 'subagent';
  const executorId =
    data !== undefined ? (data.executorId ?? 'native') : undefined;
  const permissionMode =
    sources.permissionMode?.mode ?? data?.permissionMode;
  return {
    modelAlias,
    modelId: canonicalModelId,
    remoteModelId,
    providerId,
    providerType,
    thinkingEffort,
    profileId: data === undefined ? undefined : (data.profileDefinitionId ?? data.profileName),
    profileName: data?.profileName,
    profilePath: data?.boundProfile?.sourcePath,
    routeId: data?.routeId,
    executorId,
    permissionMode,
    agentRole,
  };
}
