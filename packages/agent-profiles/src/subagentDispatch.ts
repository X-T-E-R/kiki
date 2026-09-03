import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  ResolvedAgentProfileRoute,
} from './agentProfile';
import {
  aliasIdentity,
  appliedDispatchProfile,
  isDispatchBlocked,
  routePermittedByProfile,
  type CallerLeaseOwner,
} from './applySubagentLease';
import type { ModelAliasResolver } from './ports';
import { subagentAllowlistFor } from './profileShared';
import {
  scopedBinding,
  type AgentProfileCatalogSnapshot,
} from './scopedAgentProfile';
import type { SpawnConstraints, SubagentLease } from './subagentLease';

export interface SubagentDispatchCaller {
  readonly profileDefinitionId?: string;
  readonly profileName?: string;
  readonly subagents?: readonly string[];
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
}

export interface ResolvedSubagentDispatch {
  readonly selection: SubagentDispatchSelection;
  readonly scoped: boolean;
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

export function subagentDispatchAllowed(
  catalog: Pick<SubagentDispatchCatalog, 'getDefault'>,
  caller: SubagentDispatchCaller,
  profileName: string,
): boolean {
  const allowlist = subagentAllowlistFor(catalog, caller);
  return allowlist === undefined || allowlist.includes(profileName);
}

export function resolveSnapshotProfileDefinition(
  snapshot: AgentProfileCatalogSnapshot,
  definitionId: string,
  profileName: string,
): AgentProfile | undefined {
  const publicProfile = snapshot.publicProfiles.get(profileName);
  if (publicProfile?.definitionId === definitionId) return publicProfile;
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
  const resolveId = aliasIdentity(models);
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
      resolveId,
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
      appliedDispatchProfile(profile, profile.name, caller, defaults, resolveId).profile,
    )
    .filter(
      (profile) =>
        subagentDispatchAllowed(catalog, caller, profile.name) && !isDispatchBlocked(profile),
    );
  const routes = input.routes.filter((route) => {
    if (!subagentDispatchAllowed(catalog, caller, route.profile)) return false;
    const base = input.snapshot?.publicProfiles.get(route.profile) ?? catalog.get(route.profile);
    if (base === undefined) return false;
    const effective = appliedDispatchProfile(
      base,
      route.profile,
      caller,
      defaults,
      resolveId,
    ).profile;
    return routePermittedByProfile(route, effective, models);
  });
  return { profiles: [...publicProfiles, ...scopedProfiles], routes };
}
