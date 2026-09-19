import { modelAliasResolverForExecutor } from '@kiki/agent-profiles/ports';

import type { AgentProfile, AgentProfileRouteCatalogEntry } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileCatalogSnapshot } from '#/app/agentProfileCatalog/scopedAgentProfile';
import { fillLeasePins, spawnConstraintOrigin, type CallerLeaseOwner } from '#/app/agentProfileCatalog/applySubagentLease';
import { evaluateSubagentDispatchDecision, listAvailableSubagentTargets, resolveSubagentTarget, type SubagentDispatchCaller, type SubagentDispatchCatalog, type SubagentRecommendationStatus } from '#/app/agentProfileCatalog/subagentDispatch';
import type { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import type { IConfigService } from '#/app/config/config';
import { ErrorCodes, isError2 } from '#/errors';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { IModelService } from '#/kosong/model/model';
import { normalizeRequestedThinkingEffort, requiresStrictThinkingValidation, resolveThinkingEffortForModel, type ThinkingConfig } from '#/kosong/model/thinking';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { assertBoundModelAllowed, canonicalizeSubagentBinding, resolveSubagentBinding } from '#/session/subagent/configSection';
import { resolveRoleThinkingDefault, roleConstraintsFromProfile } from '#/session/subagent/modelConstraints';
import { assertProfileRouteBinding, assertProfileRouteModelAvailable } from '#/session/subagent/profileRouteBinding';

export interface SubagentCapabilityCatalog {
  readonly catalog: SubagentDispatchCatalog;
  readonly caller: SubagentDispatchCaller & CallerLeaseOwner;
  readonly profiles: readonly AgentProfile[];
  readonly routes: readonly AgentProfileRouteCatalogEntry[];
  readonly snapshot?: AgentProfileCatalogSnapshot;
}

export interface SubagentCapabilityTarget {
  readonly profile: string;
  readonly route?: string;
  readonly description?: string;
  readonly executor: string;
  readonly modelAlias?: string;
  readonly modelSource?: 'caller-lease' | 'route' | 'profile';
  readonly thinkingEffort?: string;
  readonly effortSource?: 'caller-lease' | 'route' | 'profile' | 'model-profile' | 'model' | 'config' | 'executor';
  readonly dispatchPolicy: 'advisory' | 'strict';
  readonly recommendationStatus: SubagentRecommendationStatus;
  readonly advisoryDeviation: boolean;
  readonly dispatchAllowed: boolean;
  readonly defaultsAvailable: boolean;
  readonly unavailableReason?: string;
}

export interface SubagentCapabilityServices {
  readonly models: IModelService;
  readonly modelCatalog: IModelCatalog;
  readonly config: IConfigService;
  readonly executors: IAgentExecutorRegistry;
  readonly protocols: IProtocolAdapterRegistry;
}

export function projectSubagentCapabilities(
  input: SubagentCapabilityCatalog,
  services: SubagentCapabilityServices,
): readonly SubagentCapabilityTarget[] {
  const targets = listAvailableSubagentTargets(input.catalog, input.caller, input, services.models);
  const snapshot = input.snapshot ?? input.catalog.snapshot?.();
  const bindingSnapshot = snapshot === undefined ? undefined : {
    ...snapshot,
    publicProfiles: new Map([
      ...snapshot.publicProfiles,
      ...input.profiles.map((profile) => [profile.name, profile] as const),
    ]),
  };
  return [
    ...targets.profiles.map((profile) => projectTarget(profile.name, undefined, profile.description, profile.executor)),
    ...targets.routes.map((route) => projectTarget(route.profile, route.id, route.description,
      (bindingSnapshot?.publicProfiles.get(route.profile) ?? input.catalog.get(route.profile))?.executor)),
  ];

  function projectTarget(profileName: string, routeId?: string, description?: string, executorId?: string): SubagentCapabilityTarget {
    const decision = evaluateSubagentDispatchDecision(input.catalog, input.caller, profileName, {
      selectionKind: routeId === undefined ? 'profile' : 'route',
    });
    const identity = {
      profile: profileName,
      route: routeId,
      description,
      executor: executorId ?? 'native',
      dispatchPolicy: decision.policyMode,
      recommendationStatus: decision.recommendationStatus,
      advisoryDeviation: decision.advisoryDeviation,
      dispatchAllowed: decision.allowed,
    };
    try {
      const target = resolveSubagentTarget(input.catalog, input.caller, {
        profileName,
        routeId,
        snapshot: bindingSnapshot,
      }, services.models);
      const profile = target.effectiveProfile;
      const route = target.selection.route;
      const native = (profile.executor ?? 'native') === 'native';
      const resolver = modelAliasResolverForExecutor(profile.executor, services.models);
      const filled = fillLeasePins<{ modelAlias?: string; thinkingEffort?: string }>({}, target.lease, route);
      if (native) {
        assertProfileRouteBinding(route, filled, resolver);
        assertProfileRouteModelAvailable(route, services.modelCatalog, resolver);
      }
      const constraints = roleConstraintsFromProfile(profile, spawnConstraintOrigin(target.lease, target.spawnPolicy));
      const binding = resolveSubagentBinding(services.config, { ...filled, thinkingEffort: filled.thinkingEffort ?? route?.lockedThinkingEffort }, {
        modelAlias: route?.lockedModelAlias ?? profile.modelAlias,
        thinkingEffort: route?.lockedThinkingEffort ?? profile.thinkingEffort,
      }, native ? services.models : undefined, constraints, { profileName, routeId });
      const resolved = native ? canonicalizeSubagentBinding(binding, services.models) : binding;
      let modelAlias = resolved.displayModel;
      let thinking = resolved.thinking;
      let effortSource: SubagentCapabilityTarget['effortSource'] =
        filled.thinkingEffort !== undefined ? 'caller-lease'
          : route?.lockedThinkingEffort !== undefined ? 'route'
            : resolveRoleThinkingDefault(constraints, resolved.model, native ? services.models : undefined) !== undefined ? 'model-profile'
              : thinking !== undefined ? 'profile' : undefined;
      const executor = services.executors.resolve(profile.executor, profile.executorOptions);
      if (native) {
        const model = services.modelCatalog.get(resolved.model);
        const defaults = services.config.get<ThinkingConfig>('thinking');
        thinking = resolveThinkingEffortForModel(thinking, defaults, model,
          requiresStrictThinkingValidation(services.protocols, model.protocol, model.providerType));
        assertProfileRouteBinding(route === undefined ? undefined : {
          ...route,
          lockedThinkingEffort: normalizeRequestedThinkingEffort(route.lockedThinkingEffort),
        }, { modelAlias: resolved.model, thinkingEffort: thinking }, resolver);
        assertBoundModelAllowed(services.config, resolved.model, constraints, services.models, thinking);
        effortSource ??= model.overrides?.defaultEffort !== undefined ? 'model'
          : defaults?.effort !== undefined || defaults?.enabled !== undefined ? 'config' : 'model';
      } else {
        const validated = services.executors.validateBinding(executor.descriptor.id, executor.options, {
          modelAlias: resolved.model,
          thinkingEffort: thinking ?? 'off',
        });
        if (!validated.ok || validated.binding.modelAlias === undefined) {
          return { ...identity, defaultsAvailable: false, unavailableReason: 'Executor binding is unavailable' };
        }
        modelAlias = validated.binding.modelAlias;
        thinking = validated.binding.thinkingEffort;
        if (route !== undefined) {
          const locked = services.executors.validateBinding(executor.descriptor.id, executor.options, {
            modelAlias: route.lockedModelAlias ?? modelAlias,
            thinkingEffort: route.lockedThinkingEffort ?? thinking,
          });
          if (!locked.ok) return { ...identity, defaultsAvailable: false, unavailableReason: 'Executor route binding is unavailable' };
          assertProfileRouteBinding({
            ...route,
            lockedModelAlias: route.lockedModelAlias === undefined ? undefined : locked.binding.modelAlias,
            lockedThinkingEffort: route.lockedThinkingEffort === undefined ? undefined : locked.binding.thinkingEffort,
          }, { modelAlias, thinkingEffort: thinking }, resolver);
        }
        assertBoundModelAllowed(services.config, modelAlias, constraints, undefined, thinking);
        effortSource ??= 'executor';
      }
      return {
        ...identity,
        executor: profile.executor ?? 'native',
        modelAlias,
        modelSource: filled.modelAlias !== undefined ? 'caller-lease' : route?.lockedModelAlias !== undefined ? 'route' : 'profile',
        thinkingEffort: thinking,
        effortSource,
        defaultsAvailable: true,
      };
    } catch (error) {
      return { ...identity, defaultsAvailable: false, unavailableReason: capabilityFailureReason(error) };
    }
  }
}

function capabilityFailureReason(error: unknown): string {
  if (isError2(error)) {
    if (error.code === ErrorCodes.MODEL_NOT_CONFIGURED) return 'No default model is bound; pass model_alias explicitly';
    if (error.code === ErrorCodes.SCOPED_PROFILE_UNAVAILABLE) return 'Scoped profile is unavailable';
    if (error.code === ErrorCodes.CONFIG_INVALID) return 'Default binding does not satisfy model, effort, or executor constraints';
  }
  return 'Default model or executor binding is unavailable';
}
