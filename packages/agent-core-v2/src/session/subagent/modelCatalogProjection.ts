import { modelAliasResolverForExecutor, type ExecutorCapabilityCatalog } from '@kiki/agent-profiles/ports';
import { captureProfileModelMenu } from '@kiki/agent-profiles/agentProfile';
import { resolveProfileThinkingDefault } from '#/app/agentProfileCatalog/modelProfileOverlay';

import type { AgentProfile, AgentProfileRouteCatalogEntry } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { fillLeasePins, type CallerLeaseOwner } from '#/app/agentProfileCatalog/applySubagentLease';
import type { AgentProfileCatalogSnapshot } from '#/app/agentProfileCatalog/scopedAgentProfile';
import { listAvailableSubagentTargets, resolveSubagentTarget, type SubagentDispatchCaller, type SubagentDispatchCatalog } from '#/app/agentProfileCatalog/subagentDispatch';
import type { IConfigService } from '#/app/config/config';
import { ErrorCodes, isError2 } from '#/errors';
import type { IModelService } from '#/kosong/model/model';

import { assertSubagentModelNotDenied, INHERIT_MODEL_ALIAS, resolveInheritedModelAlias } from './configSection';
import { roleConstraintsFromProfile, roleHasModelConstraints, roleModelAllowed } from './modelConstraints';

export type ProfileModelMenuInput = Pick<AgentProfile,
  'name' | 'executor' | 'modelAlias' | 'modelProfiles' | 'modelConstraintProfiles' | 'restrictModelsToMenu' |
  'modelMenuConstraint' | 'allowedModels' | 'denyModels' | 'allowedEfforts' | 'modelMenuDiagnostics'>;

export function projectProfileModelMenu(
  input: ProfileModelMenuInput,
  models: IModelService,
  config: IConfigService,
  position: 'main' | 'sub',
  options: {
    readonly frozen?: boolean;
    readonly modelAlias?: string;
    readonly executorCapabilityCatalog?: ExecutorCapabilityCatalog;
  } = {},
) {
  const native = (input.executor ?? 'native') === 'native';
  const resolver = modelAliasResolverForExecutor(input.executor, models);
  const executorModels = !native && (options.executorCapabilityCatalog?.models.state === 'ready' ||
      options.executorCapabilityCatalog?.models.state === 'partial')
    ? new Set(options.executorCapabilityCatalog.models.values ?? [])
    : undefined;
  const profile = options.frozen === true ? input : captureProfileModelMenu(input, (alias) => resolver.resolveId(alias));
  const menu = profile.modelMenuConstraint;
  const declared = menu ?? captureProfileModelMenu({ ...profile, restrictModelsToMenu: false }, (alias) => resolver.resolveId(alias)).modelMenuConstraint!;
  const nativeModels = native ? models.list() : undefined;
  const candidates = [...new Set([
    ...(nativeModels === undefined
      ? executorModels === undefined ? [...(profile.allowedModels ?? []), ...declared.identities] : [...executorModels]
      : Object.keys(nativeModels)),
    ...declared.aliases,
    ...(profile.modelProfiles ?? []).map((entry) => entry.alias),
    ...(options.modelAlias === undefined ? [] : [options.modelAlias]),
  ])];
  const constraints = roleConstraintsFromProfile(profile);
  const effectiveModelAliases = candidates.filter((alias) => {
    try {
      if (alias === INHERIT_MODEL_ALIAS || alias.trim() === '') return false;
      const identity = resolver.resolveId(alias);
      if (nativeModels !== undefined && (identity === undefined || !Object.hasOwn(nativeModels, identity))) return false;
      if (executorModels !== undefined && (identity === undefined || !executorModels.has(identity))) return false;
      if (!roleModelAllowed(alias, constraints, native ? models : undefined)) return false;
      if (position === 'sub') assertSubagentModelNotDenied(config, alias, native ? models : undefined);
      return true;
    } catch {
      return false;
    }
  });
  return {
    restrictModelsToMenu: profile.restrictModelsToMenu ?? false,
    declaredModelMenu: {
      aliases: [...(declared.profileAliases ?? declared.aliases)],
      defaultAlias: declared.defaultAlias,
      identities: [...declared.identities],
    },
    effectiveModelAliases,
    modelConstraintsActive: roleHasModelConstraints(constraints),
    configuredModelAliases: nativeModels === undefined ? effectiveModelAliases : effectiveModelAliases.filter((alias) => Object.hasOwn(nativeModels, alias)),
  };
}

export function projectSubagentModelCatalog(
  catalog: SubagentDispatchCatalog,
  caller: SubagentDispatchCaller & CallerLeaseOwner & {
    readonly modelAlias?: string;
    readonly thinkingLevel?: string;
    readonly effectiveThinkingLevel?: string;
  },
  input: {
    readonly profiles: readonly AgentProfile[];
    readonly routes: readonly AgentProfileRouteCatalogEntry[];
    readonly snapshot?: AgentProfileCatalogSnapshot;
  },
  models: IModelService,
  config: IConfigService,
): { readonly profiles: readonly AgentProfile[]; readonly routes: readonly (AgentProfileRouteCatalogEntry & { readonly allowedModels: readonly string[] })[]; readonly aliases: readonly string[] } {
  const targets = listAvailableSubagentTargets(catalog, caller, input, models);
  const aliases = new Set<string>();
  const profiles = targets.profiles.flatMap((profile) => {
    let projected: ReturnType<typeof projectTarget>;
    try {
      projected = projectTarget(profile.name);
    } catch (error) {
      if (isError2(error) && (
        error.code === ErrorCodes.PROFILE_UNKNOWN ||
        error.code === ErrorCodes.ROUTE_UNKNOWN ||
        error.code === ErrorCodes.ROUTE_BASE_MISSING
      )) return [];
      throw error;
    }
    const resolver = modelAliasResolverForExecutor(profile.executor, models);
    const permitted = new Set(projected.allowedModels.map((alias) => resolver.resolveId(alias) ?? alias));
    return [{
      ...profile,
      modelAlias: projected.modelAlias,
      thinkingEffort: projected.thinkingEffort,
      effectiveModelAliases: [...new Set([...projected.allowedModels, ...(profile.modelProfiles ?? []).flatMap((entry) => {
        try {
          return permitted.has(resolver.resolveId(entry.alias) ?? entry.alias) ? [entry.alias] : [];
        } catch {
          return [];
        }
      })])],
      modelMenuDiagnostics: profile.modelMenuDiagnostics,
    }];
  });
  const routes = targets.routes.flatMap((route) => {
    try {
      const projected = projectTarget(route.profile, route.id);
      const resolver = modelAliasResolverForExecutor(projected.profile.executor, models);
      if (route.modelAlias !== undefined && !projected.allowedModels.some((alias) => resolver.resolveId(alias) === resolver.resolveId(route.modelAlias!))) return [];
      return [{ ...route, allowedModels: projected.allowedModels }];
    } catch (error) {
      if (isError2(error) && (
        error.code === ErrorCodes.PROFILE_UNKNOWN ||
        error.code === ErrorCodes.ROUTE_UNKNOWN ||
        error.code === ErrorCodes.ROUTE_BASE_MISSING
      )) return [];
      throw error;
    }
  });
  return { profiles, routes, aliases: [...aliases] };

  function projectTarget(profileName: string, routeId?: string) {
    const target = resolveSubagentTarget(catalog, caller, { profileName, routeId, snapshot: input.snapshot }, models);
    const profile = target.effectiveProfile;
    const route = target.selection.route;
    const resolver = modelAliasResolverForExecutor(profile.executor, models);
    const pins = fillLeasePins<{ modelAlias?: string; thinkingEffort?: string }>({}, target.lease, route);
    const modelAlias = pins.modelAlias ?? route?.lockedModelAlias ?? profile.modelAlias;
    const resolvedAlias = modelAlias === INHERIT_MODEL_ALIAS
      ? caller.modelAlias === undefined ? undefined : resolveInheritedModelAlias(modelAlias, caller.modelAlias)
      : modelAlias;
    const thinkingEffort = pins.thinkingEffort ?? route?.lockedThinkingEffort ??
      (resolvedAlias === undefined ? undefined : resolveProfileThinkingDefault({
        ...profile,
        modelAlias: profile.modelAlias === INHERIT_MODEL_ALIAS ? resolvedAlias : profile.modelAlias,
      }, resolvedAlias, (id) => resolver.resolveId(id))) ??
      (modelAlias === INHERIT_MODEL_ALIAS ? caller.effectiveThinkingLevel ?? caller.thinkingLevel : undefined);
    const allowedModels = projectProfileModelMenu(profile, models, config, 'sub', {
      frozen: true,
      modelAlias: resolvedAlias,
    }).configuredModelAliases;
    for (const alias of allowedModels) aliases.add(alias);
    return { profile, modelAlias, thinkingEffort, allowedModels };
  }
}
