import { IAgentExecutorPreflightService, IAgentExecutorRegistry, IConfigService, IModelService, type AgentProfile, type Scope } from '@kiki/agent-core-v2';
import { projectProfileModelMenu, type ProfileModelMenuInput } from '@kiki/agent-core-v2/session/subagent/modelCatalogProjection';
import type { AgentModelMenuDraft, AgentModelMenuProjection } from '@kiki/protocol';

export function projectAgentModelMenu(
  scope: Pick<Scope, 'accessor'>,
  profile: ProfileModelMenuInput,
  position: 'main' | 'sub',
  frozen = false,
): AgentModelMenuProjection {
  const capabilityCatalog = profile.executor === undefined || profile.executor === 'native'
    ? undefined
    : (() => {
      const registry = scope.accessor.get(IAgentExecutorRegistry);
      const descriptor = registry.get(profile.executor);
      const checkedVersion = scope.accessor.get(IAgentExecutorPreflightService).lastCheck(profile.executor)?.version ?? descriptor?.version;
      return registry.getExecutorCapabilityCatalog?.(profile.executor, checkedVersion === undefined ? undefined : { version: checkedVersion });
    })();
  const projected = projectProfileModelMenu(profile, scope.accessor.get(IModelService), scope.accessor.get(IConfigService), position, {
    frozen,
    executorCapabilityCatalog: capabilityCatalog,
  });
  return {
    restrict_models_to_menu: projected.restrictModelsToMenu,
    declared_model_menu: {
      aliases: projected.declaredModelMenu.aliases,
      default_alias: projected.declaredModelMenu.defaultAlias,
      identities: projected.declaredModelMenu.identities,
    },
    effective_model_aliases: projected.effectiveModelAliases,
    model_constraints_active: projected.modelConstraintsActive,
    executor_capabilities: capabilityCatalog === undefined ? undefined : {
      source: capabilityCatalog.source,
      version: capabilityCatalog.version,
      observed_at: capabilityCatalog.observedAt,
      models: {
        state: capabilityCatalog.models.state,
        values: capabilityCatalog.models.values === undefined ? undefined : [...capabilityCatalog.models.values],
        diagnostic: capabilityCatalog.models.diagnostic,
      },
      thinking_levels: {
        state: capabilityCatalog.thinkingLevels.state,
        values: capabilityCatalog.thinkingLevels.values === undefined ? undefined : [...capabilityCatalog.thinkingLevels.values],
        diagnostic: capabilityCatalog.thinkingLevels.diagnostic,
      },
    },
  };
}

export function applyAgentModelMenuDraft(profile: AgentProfile, draft: AgentModelMenuDraft): AgentProfile {
  const existing = new Map(profile.modelProfiles?.map((entry) => [entry.alias, entry]));
  return {
    ...profile,
    modelMenuConstraint: undefined,
    modelMenuDiagnostics: undefined,
    modelAlias: draft.pinned_model_alias === undefined ? profile.modelAlias : draft.pinned_model_alias ?? undefined,
    restrictModelsToMenu: draft.restrict_models_to_menu ?? profile.restrictModelsToMenu,
    executor: draft.executor === undefined ? profile.executor : draft.executor ?? undefined,
    main: draft.main === undefined ? profile.main : draft.main ?? undefined,
    allowedModels: draft.allowed_models === undefined ? profile.allowedModels
      : draft.allowed_models?.includes('*') ? undefined : draft.allowed_models ?? undefined,
    denyModels: draft.deny_models === undefined ? profile.denyModels : draft.deny_models ?? undefined,
    modelProfiles: draft.model_profiles === undefined ? profile.modelProfiles : draft.model_profiles?.map((entry) => ({
      ...existing.get(entry.alias),
      alias: entry.alias,
      when: entry.when === undefined ? existing.get(entry.alias)?.when : entry.when ?? undefined,
      thinkingEffort: entry.thinking_effort === undefined ? existing.get(entry.alias)?.thinkingEffort : entry.thinking_effort ?? undefined,
    })),
  };
}
