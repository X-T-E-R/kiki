import type { BindingAdvisory, BindingValueSource } from '@kiki/agent-profiles/bindingAdvisory';
import { modelAliasResolverForExecutor } from '@kiki/agent-profiles/ports';
import type { AgentCapabilityReasonCode } from '@kiki/protocol';

import type { AgentProfile, AgentProfileRouteCatalogEntry } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileCatalogSnapshot } from '#/app/agentProfileCatalog/scopedAgentProfile';
import { fillLeasePins, spawnConstraintOrigin, type CallerLeaseOwner } from '#/app/agentProfileCatalog/applySubagentLease';
import { evaluateSubagentDispatchDecision, resolveSubagentTarget, type SubagentDispatchCaller, type SubagentDispatchCatalog, type SubagentRecommendationStatus } from '#/app/agentProfileCatalog/subagentDispatch';
import type { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import type { IConfigService } from '#/app/config/config';
import { ErrorCodes, isError2 } from '#/errors';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { IModelService } from '#/kosong/model/model';
import { requiresStrictThinkingValidation, resolveThinkingEffortForModel, type ThinkingConfig } from '#/kosong/model/thinking';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { assertSubagentModelNotDenied, canonicalizeSubagentBinding, resolveInheritedModelAlias, resolveSubagentBinding } from '#/session/subagent/configSection';
import { pinBindingAdvisory, resolveRoleThinkingDefault, roleBindingAdvisories, roleConstraintsFromProfile } from '#/session/subagent/modelConstraints';
import { assertProfileRouteModelAvailable } from '#/session/subagent/profileRouteBinding';

export interface SubagentCapabilityCatalog {
  readonly catalog: SubagentDispatchCatalog;
  readonly caller: SubagentDispatchCaller & CallerLeaseOwner & {
    readonly modelAlias?: string;
    readonly thinkingLevel?: string;
    readonly effectiveThinkingLevel?: string;
  };
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
  readonly bindingAdvisories?: readonly BindingAdvisory[];
  readonly unavailableReason?: string;
  readonly unavailableReasonCode?: AgentCapabilityReasonCode;
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
  const snapshot = input.snapshot ?? input.catalog.snapshot?.();
  const scoped = snapshot?.scopedBindings.get(input.caller.profileDefinitionId ?? '') ?? new Map();
  const profiles = [
    ...input.profiles.filter((profile) => profile.main !== true && !scoped.has(profile.name)),
    ...[...scoped.values()].flatMap((binding) =>
      binding.status === 'ready' && binding.profile !== undefined && binding.profile.main !== true
        ? [{ ...binding.profile, name: binding.alias }] : []),
  ];
  const bindingSnapshot = snapshot === undefined ? undefined : {
    ...snapshot,
    publicProfiles: new Map([
      ...snapshot.publicProfiles,
      ...input.profiles.map((profile) => [profile.name, profile] as const),
    ]),
  };
  const rank = (profile: string) => {
    const status = evaluateSubagentDispatchDecision(input.catalog, input.caller, profile).recommendationStatus;
    return status === 'preferred' ? 0 : status === 'unconfigured' ? 1 : status === 'allowed_nonpreferred' ? 2 : 3;
  };
  return [
    ...profiles.toSorted((a, b) => rank(a.name) - rank(b.name))
      .map((profile) => projectTarget(profile.name, undefined, profile.description, profile.executor)),
    ...input.routes.filter((route) => profiles.some((profile) => profile.name === route.profile))
      .toSorted((a, b) => rank(a.profile) - rank(b.profile))
      .map((route) => projectTarget(route.profile, route.id, route.description,
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
      const bindingCaller = decision.allowed ? input.caller : { ...input.caller, subagentPolicy: 'advisory' as const };
      const target = resolveSubagentTarget(input.catalog, bindingCaller, {
        profileName,
        routeId,
        snapshot: bindingSnapshot,
      }, services.models);
      const profile = target.effectiveProfile;
      const route = target.selection.route;
      const native = (profile.executor ?? 'native') === 'native';
      const resolver = modelAliasResolverForExecutor(profile.executor, services.models);
      const filled = fillLeasePins<{ modelAlias?: string; thinkingEffort?: string }>({}, target.lease, route);
      const routeLock = resolveInheritedModelAlias(route?.lockedModelAlias, input.caller.modelAlias);
      if (native && route !== undefined) {
        assertProfileRouteModelAvailable({ ...route, lockedModelAlias: routeLock }, services.modelCatalog, resolver);
      }
      const constraints = roleConstraintsFromProfile(profile, spawnConstraintOrigin(target.lease, target.spawnPolicy));
      const binding = resolveSubagentBinding(services.config, { ...filled, thinkingEffort: filled.thinkingEffort ?? route?.lockedThinkingEffort }, {
        modelAlias: route?.lockedModelAlias ?? profile.modelAlias,
        thinkingEffort: route?.lockedThinkingEffort ?? profile.thinkingEffort,
      }, native ? services.models : undefined, constraints, { profileName, routeId }, {
        modelAlias: input.caller.modelAlias,
        thinkingEffort: input.caller.effectiveThinkingLevel ?? input.caller.thinkingLevel,
      });
      const resolved = native ? canonicalizeSubagentBinding(binding, services.models) : binding;
      const requestedModel = resolved.displayModel;
      const requestedThinking = resolved.thinking;
      const modelSource: SubagentCapabilityTarget['modelSource'] =
        filled.modelAlias !== undefined ? 'caller-lease' : route?.lockedModelAlias !== undefined ? 'route' : 'profile';
      let modelValueSource: BindingValueSource =
        modelSource === 'caller-lease' ? 'caller-lease-default'
          : modelSource === 'route' ? 'route-default' : 'profile-default';
      let modelAlias = resolved.model;
      let effectiveModel = resolved.model;
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
        assertSubagentModelNotDenied(services.config, resolved.model, services.models);
        effortSource ??= model.overrides?.defaultEffort !== undefined ? 'model'
          : defaults?.effort !== undefined || defaults?.enabled !== undefined ? 'config' : 'model';
      } else {
        const validated = services.executors.validateBinding(executor.descriptor.id, executor.options, {
          modelAlias: resolved.model,
          thinkingEffort: thinking ?? 'off',
        });
        if (!validated.ok || validated.binding.modelAlias === undefined) {
          return {
            ...identity,
            defaultsAvailable: false,
            unavailableReason: 'Executor binding is unavailable',
            unavailableReasonCode: 'executor_binding_unavailable',
          };
        }
        modelAlias = validated.binding.modelAlias;
        effectiveModel = validated.binding.modelAlias;
        thinking = validated.binding.thinkingEffort;
        if (modelAlias !== resolved.model) modelValueSource = 'executor-normalized';
        if (route !== undefined) {
          const locked = services.executors.validateBinding(executor.descriptor.id, executor.options, {
            modelAlias: routeLock ?? modelAlias,
            thinkingEffort: route.lockedThinkingEffort ?? thinking,
          });
          if (!locked.ok) return {
            ...identity,
            defaultsAvailable: false,
            unavailableReason: 'Executor route binding is unavailable',
            unavailableReasonCode: 'executor_route_binding_unavailable',
          };
        }
        assertSubagentModelNotDenied(services.config, modelAlias);
        effortSource ??= 'executor';
      }
      const thinkingValueSource = thinkingValueSourceFor(effortSource, requestedThinking, thinking);
      const bindingAdvisories = [
        ...roleBindingAdvisories({
          model: effectiveModel,
          requestedModel,
          thinking,
          requestedThinking,
          constraints,
          models: native ? services.models : undefined,
          ruleSource: `profile:${profileName}`,
          modelValueSource,
          thinkingValueSource,
        }),
        pinBindingAdvisory({
          dimension: 'model',
          ruleSource: `route:${route?.id ?? routeId ?? profileName}`,
          pinnedValue: routeLock ?? effectiveModel,
          requestedValue: requestedModel,
          effectiveValue: effectiveModel,
          valueSource: modelValueSource,
          model: effectiveModel,
          models: native ? services.models : undefined,
        }),
        pinBindingAdvisory({
          dimension: 'thinking_effort',
          ruleSource: `route:${route?.id ?? routeId ?? profileName}`,
          pinnedValue: route?.lockedThinkingEffort ?? thinking ?? 'off',
          requestedValue: requestedThinking,
          effectiveValue: thinking ?? 'off',
          valueSource: thinkingValueSource,
          model: effectiveModel,
        }),
        route?.lockedModelAlias === undefined && target.lease?.modelAlias !== undefined
          ? pinBindingAdvisory({
              dimension: 'model', ruleSource: `caller-lease:${profileName}`,
              pinnedValue: resolveInheritedModelAlias(target.lease.modelAlias, input.caller.modelAlias)!, requestedValue: requestedModel,
              effectiveValue: effectiveModel, valueSource: modelValueSource,
              model: effectiveModel, models: native ? services.models : undefined,
            })
          : undefined,
        route?.lockedThinkingEffort === undefined && target.lease?.thinkingEffort !== undefined
          ? pinBindingAdvisory({
              dimension: 'thinking_effort', ruleSource: `caller-lease:${profileName}`,
              pinnedValue: target.lease.thinkingEffort, requestedValue: requestedThinking,
              effectiveValue: thinking ?? 'off', valueSource: thinkingValueSource,
              model: effectiveModel,
            })
          : undefined,
      ].filter((advisory): advisory is BindingAdvisory => advisory !== undefined);
      return {
        ...identity,
        executor: profile.executor ?? 'native',
        modelAlias,
        modelSource,
        thinkingEffort: thinking,
        effortSource,
        defaultsAvailable: true,
        bindingAdvisories: bindingAdvisories.length === 0 ? undefined : bindingAdvisories,
      };
    } catch (error) {
      const failure = capabilityFailure(error);
      return {
        ...identity,
        defaultsAvailable: false,
        unavailableReason: failure.reason,
        unavailableReasonCode: failure.reasonCode,
      };
    }
  }
}

function thinkingValueSourceFor(
  source: SubagentCapabilityTarget['effortSource'],
  requested: string | undefined,
  effective: string | undefined,
): BindingValueSource {
  if (source === 'executor' && requested !== undefined && requested !== effective) return 'executor-normalized';
  switch (source) {
    case 'caller-lease': return 'caller-lease-default';
    case 'route': return 'route-default';
    case 'profile': return 'profile-default';
    case 'model-profile': return 'model-profile-default';
    case 'config': return 'config-default';
    case 'executor': return 'model-default';
    case 'model':
    default:
      return 'model-default';
  }
}

function capabilityFailure(error: unknown): {
  readonly reason: string;
  readonly reasonCode: AgentCapabilityReasonCode;
} {
  if (isError2(error)) {
    if (error.code === ErrorCodes.MODEL_NOT_CONFIGURED) return {
      reason: 'No default model is bound; pass model_alias explicitly',
      reasonCode: 'model_not_configured',
    };
    if (error.code === ErrorCodes.SCOPED_PROFILE_UNAVAILABLE) return {
      reason: 'Scoped profile is unavailable',
      reasonCode: 'scoped_profile_unavailable',
    };
    if (error.code === ErrorCodes.CONFIG_INVALID || error.code === ErrorCodes.ROUTE_BINDING_CONFLICT) return {
      reason: 'Default binding does not satisfy model, effort, or executor constraints',
      reasonCode: 'binding_constraints_unsatisfied',
    };
  }
  return {
    reason: 'Default model or executor binding is unavailable',
    reasonCode: 'default_binding_unavailable',
  };
}
