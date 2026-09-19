import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  AgentSubagentPolicy,
  PersistedAgentSubagentPolicy,
  ResolvedAgentProfileRoute,
  SubagentDeclaration,
} from './agentProfile';
import {
  aliasIdentity,
  appliedDispatchProfile,
  isDispatchBlocked,
  routePermittedByProfile,
  type CallerLeaseOwner,
} from './applySubagentLease';
import {
  modelAliasResolverForExecutor,
  type ModelAliasResolver,
} from './ports';
import type { AgentProfileCatalogSnapshot } from './scopedAgentProfile';
import type { SpawnConstraints, SubagentLease } from './subagentLease';

export interface SubagentDispatchCaller {
  readonly profileDefinitionId?: string;
  readonly profileName?: string;
  readonly subagentPolicy?: AgentSubagentPolicy;
  readonly subagentDeclaration?: SubagentDeclaration;
  readonly subagents?: readonly string[];
}

export type SubagentSelectionKind = 'profile' | 'route' | 'scoped' | 'profile_file';
export type SubagentSelectionOrigin = 'explicit' | 'recommended-default' | 'configured-fallback';
export type SubagentRecommendationStatus = 'preferred' | 'allowed_nonpreferred' | 'blocked' | 'unconfigured';
export type SubagentRecommendationFallback = 'no-recommendations' | 'recommended-unavailable';

export interface SubagentDispatchDecision {
  readonly version: 1;
  readonly policyMode: PersistedAgentSubagentPolicy;
  readonly policySource: 'profile' | 'default' | 'legacy';
  readonly declaration: SubagentDeclaration;
  readonly selectionKind: SubagentSelectionKind;
  readonly selectionOrigin: SubagentSelectionOrigin;
  readonly requestedProfile: string;
  readonly recommendationStatus: SubagentRecommendationStatus;
  readonly advisoryDeviation: boolean;
  readonly allowed: boolean;
  readonly fallback?: SubagentRecommendationFallback;
}

export interface CurrentSubagentDispatchDecision extends Omit<SubagentDispatchDecision, 'policyMode' | 'policySource'> {
  readonly policyMode: AgentSubagentPolicy;
  readonly policySource: 'profile' | 'default';
}

export interface SubagentDispatchSelection {
  readonly profile: AgentProfile;
  readonly baseProfile: AgentProfile;
  readonly route?: ResolvedAgentProfileRoute;
}

export interface SubagentDispatchCatalog {
  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  list(): readonly AgentProfile[];
  snapshot?(): AgentProfileCatalogSnapshot;
  resolveSelection(input: {
    readonly profile?: string;
    readonly route?: string;
  }): SubagentDispatchSelection;
}

export interface ResolveSubagentDispatchInput {
  readonly profileName?: string;
  readonly routeId?: string;
  readonly snapshot?: AgentProfileCatalogSnapshot;
  readonly selectionKind?: SubagentSelectionKind;
  readonly selectionOrigin?: SubagentSelectionOrigin;
  readonly fallback?: SubagentRecommendationFallback;
}

export interface ResolvedSubagentDispatch {
  readonly selection: SubagentDispatchSelection;
  readonly scoped: boolean;
  readonly decision: CurrentSubagentDispatchDecision;
  readonly snapshot?: AgentProfileCatalogSnapshot;
}

export interface ResolvedSubagentTarget extends ResolvedSubagentDispatch {
  readonly effectiveProfile: AgentProfile;
  readonly lease?: SubagentLease;
  readonly spawnPolicy?: SpawnConstraints;
}

export interface AvailableSubagentTargets {
  readonly profiles: readonly AgentProfile[];
  readonly routes: readonly AgentProfileRouteCatalogEntry[];
}

export function evaluateSubagentDispatchDecision(
  catalog: Pick<SubagentDispatchCatalog, 'getDefault'>,
  caller: SubagentDispatchCaller,
  profileName: string,
  options: {
    readonly selectionKind?: SubagentSelectionKind;
    readonly selectionOrigin?: SubagentSelectionOrigin;
    readonly fallback?: SubagentRecommendationFallback;
  } = {},
): CurrentSubagentDispatchDecision {
  const configured = caller.profileName === undefined ? catalog.getDefault() : caller;
  const policyMode: AgentSubagentPolicy = configured.subagentPolicy ?? 'advisory';
  const declaration = configured.subagentDeclaration ?? (
    configured.subagents === undefined
      ? { kind: 'all' as const }
      : { kind: 'set' as const, names: configured.subagents }
  );
  const recommended = declaration.kind === 'set' && declaration.names.includes(profileName);
  const constrained = declaration.kind === 'set';
  const allowed = policyMode === 'advisory' || !constrained || recommended;
  const recommendationStatus: SubagentRecommendationStatus = !constrained
    ? 'unconfigured'
    : recommended
      ? 'preferred'
      : allowed
        ? 'allowed_nonpreferred'
        : 'blocked';
  return {
    version: 1,
    policyMode,
    policySource: configured.subagentPolicy === undefined ? 'default' : 'profile',
    declaration,
    selectionKind: options.selectionKind ?? 'profile',
    selectionOrigin: options.selectionOrigin ?? 'explicit',
    requestedProfile: profileName,
    recommendationStatus,
    advisoryDeviation: policyMode === 'advisory' && recommendationStatus === 'allowed_nonpreferred',
    allowed,
    fallback: options.fallback,
  };
}

export function subagentDispatchAllowed(
  catalog: Pick<SubagentDispatchCatalog, 'getDefault'>,
  caller: SubagentDispatchCaller,
  profileName: string,
): boolean {
  return evaluateSubagentDispatchDecision(catalog, caller, profileName).allowed;
}

export function resolveSnapshotProfileDefinition(
  snapshot: AgentProfileCatalogSnapshot,
  definitionId: string,
  profileName: string,
): AgentProfile | undefined {
  const profile = (snapshot.resolvableProfiles ?? snapshot.publicProfiles).get(profileName);
  if (profile?.definitionId === definitionId) return profile;
  for (const table of snapshot.scopedBindings.values()) {
    const binding = table.get(profileName);
    if (
      binding?.status === 'ready' &&
      binding.sourceDefinitionId === definitionId &&
      binding.profile !== undefined
    ) {
      return binding.profile;
    }
  }
  return undefined;
}

export function listAvailableSubagentTargets(
  catalog: SubagentDispatchCatalog,
  caller: SubagentDispatchCaller & CallerLeaseOwner,
  input: {
    readonly profiles: readonly AgentProfile[];
    readonly routes: readonly AgentProfileRouteCatalogEntry[];
    readonly snapshot?: AgentProfileCatalogSnapshot;
  },
  models: ModelAliasResolver,
): AvailableSubagentTargets {
  const defaults = input.snapshot?.defaultProfile ?? catalog.getDefault();
  const resolveIdFor = (profile: AgentProfile) =>
    aliasIdentity(modelAliasResolverForExecutor(profile.executor, models));
  const scopedBindings = [...(
    caller.profileDefinitionId === undefined
      ? []
      : (input.snapshot?.scopedBindings.get(caller.profileDefinitionId)?.values() ?? [])
  )];
  const scopedNames = new Set(scopedBindings.map((binding) => binding.alias));
  const scopedProfiles = scopedBindings.flatMap((binding) => {
    if (binding.status !== 'ready' || binding.profile === undefined) return [];
    const profile = appliedDispatchProfile(
      binding.profile,
      binding.alias,
      caller,
      defaults,
      resolveIdFor(binding.profile),
    ).profile;
    if (
      profile.main === true ||
      !subagentDispatchAllowed(catalog, caller, binding.alias) ||
      isDispatchBlocked(profile)
    ) {
      return [];
    }
    return [profile];
  });
  const publicProfiles = input.profiles
    .filter((profile) => profile.main !== true && !scopedNames.has(profile.name))
    .map((profile) =>
      appliedDispatchProfile(
        profile,
        profile.name,
        caller,
        defaults,
        resolveIdFor(profile),
      ).profile,
    )
    .filter(
      (profile) =>
        subagentDispatchAllowed(catalog, caller, profile.name) && !isDispatchBlocked(profile),
    );
  const routes = input.routes.filter((route) => {
    if (!subagentDispatchAllowed(catalog, caller, route.profile)) return false;
    const base = (input.snapshot?.resolvableProfiles ?? input.snapshot?.publicProfiles)?.get(route.profile) ?? catalog.get(route.profile);
    if (base === undefined) return false;
    const resolver = modelAliasResolverForExecutor(base.executor, models);
    const effective = appliedDispatchProfile(
      base,
      route.profile,
      caller,
      defaults,
      aliasIdentity(resolver),
    ).profile;
    return routePermittedByProfile(route, effective, resolver);
  });
  return {
    profiles: [...publicProfiles, ...scopedProfiles].toSorted((left, right) =>
      recommendationRank(evaluateSubagentDispatchDecision(catalog, caller, left.name))
      - recommendationRank(evaluateSubagentDispatchDecision(catalog, caller, right.name))),
    routes: routes.toSorted((left, right) =>
      recommendationRank(evaluateSubagentDispatchDecision(catalog, caller, left.profile))
      - recommendationRank(evaluateSubagentDispatchDecision(catalog, caller, right.profile))),
  };
}

function recommendationRank(decision: SubagentDispatchDecision): number {
  switch (decision.recommendationStatus) {
    case 'preferred':
      return 0;
    case 'unconfigured':
      return 1;
    case 'allowed_nonpreferred':
      return 2;
    case 'blocked':
      return 3;
  }
}
