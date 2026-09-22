import { modelAliasResolverForExecutor } from '@kiki/agent-profiles/ports';
import { resolveProfileThinkingDefault } from '#/app/agentProfileCatalog/modelProfileOverlay';

import type { AgentProfile, AgentProfileRouteCatalogEntry } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { fillLeasePins, type CallerLeaseOwner } from '#/app/agentProfileCatalog/applySubagentLease';
import type { AgentProfileCatalogSnapshot } from '#/app/agentProfileCatalog/scopedAgentProfile';
import { listAvailableSubagentTargets, resolveSubagentTarget, type SubagentDispatchCaller, type SubagentDispatchCatalog } from '#/app/agentProfileCatalog/subagentDispatch';
import type { IConfigService } from '#/app/config/config';
import type { IModelService } from '#/kosong/model/model';

import { assertSubagentModelNotDenied } from './configSection';
import { roleConstraintsFromProfile, roleModelRecommended } from './modelConstraints';
import { profileRouteBindingRecommended } from './profileRouteBinding';

export function projectSubagentModelCatalog(
  catalog: SubagentDispatchCatalog,
  caller: SubagentDispatchCaller & CallerLeaseOwner,
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
  const profiles = targets.profiles.map((profile) => {
    const projected = projectTarget(profile.name);
    const resolver = modelAliasResolverForExecutor(profile.executor, models);
    const permitted = new Set(projected.allowedModels.map((alias) => resolver.resolveId(alias) ?? alias));
    return {
      ...profile,
      modelAlias: projected.modelAlias,
      thinkingEffort: projected.thinkingEffort,
      allowedModels: projected.allowedModels,
      modelProfiles: profile.modelProfiles?.filter((entry) => {
        try {
          return permitted.has(resolver.resolveId(entry.alias) ?? entry.alias);
        } catch {
          return false;
        }
      }),
    };
  });
  const routes = targets.routes.map((route) => {
    const projected = projectTarget(route.profile, route.id);
    return { ...route, allowedModels: projected.allowedModels };
  });
  return { profiles, routes, aliases: [...aliases] };

  function projectTarget(profileName: string, routeId?: string) {
    const target = resolveSubagentTarget(catalog, caller, { profileName, routeId, snapshot: input.snapshot }, models);
    const profile = target.effectiveProfile;
    const route = target.selection.route;
    const native = (profile.executor ?? 'native') === 'native';
    const resolver = modelAliasResolverForExecutor(profile.executor, models);
    const pins = fillLeasePins<{ modelAlias?: string; thinkingEffort?: string }>({}, target.lease, route);
    const modelAlias = pins.modelAlias ?? route?.lockedModelAlias ?? profile.modelAlias;
    const thinkingEffort = pins.thinkingEffort ?? route?.lockedThinkingEffort ??
      (modelAlias === undefined ? undefined : resolveProfileThinkingDefault(profile, modelAlias, (id) => resolver.resolveId(id)));
    const candidates = native ? Object.keys(models.list()) : [
      modelAlias,
      ...(profile.allowedModels ?? []),
      ...(profile.modelProfiles ?? []).map((entry) => entry.alias),
    ].filter((alias): alias is string => alias !== undefined);
    const constraints = roleConstraintsFromProfile(profile);
    const allowedModels = [...new Set(candidates)].filter((alias) => {
      if (!profileRouteBindingRecommended(route, { modelAlias: alias }, resolver)) return false;
      if (!roleModelRecommended(alias, constraints, native ? models : undefined)) return false;
      try {
        assertSubagentModelNotDenied(config, alias, native ? models : undefined);
        return true;
      } catch {
        return false;
      }
    });
    for (const alias of allowedModels) aliases.add(alias);
    return { modelAlias, thinkingEffort, allowedModels };
  }
}
