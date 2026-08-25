import { Error2, ErrorCodes } from '#/errors';
import type { IModelService } from '#/kosong/model/model';

import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  ResolvedAgentProfileRoute,
} from './agentProfileCatalog';
import {
  aliasIdentity,
  appliedDispatchProfile,
  assertAutomaticDispatchPermitted,
  isDispatchBlocked,
  routePermittedByProfile,
  type CallerLeaseOwner,
} from './applySubagentLease';
import type { SpawnConstraints, SubagentLease } from './subagentLease';
import {
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
} from './profile-shared';
import {
  scopedBinding,
  type AgentProfileCatalogSnapshot,
} from './scopedAgentProfile';

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

export function assertSubagentDispatchAllowed(
  catalog: Pick<SubagentDispatchCatalog, 'getDefault'>,
  caller: SubagentDispatchCaller,
  profileName: string,
): void {
  const allowlist = subagentAllowlistFor(catalog, caller);
  if (allowlist === undefined || allowlist.includes(profileName)) return;
  throw new Error2(
    ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
    subagentTypeNotAllowedMessage(profileName, allowlist),
    { details: { profileName, allowlist } },
  );
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

export function resolveSubagentDispatch(
  catalog: SubagentDispatchCatalog,
  caller: SubagentDispatchCaller,
  input: ResolveSubagentDispatchInput,
): ResolvedSubagentDispatch {
  const snapshot = input.snapshot ?? catalog.snapshot?.();
  let selection: SubagentDispatchSelection;
  let scoped = false;
  if (input.routeId === undefined) {
    const profileName = input.profileName ?? '';
    const binding =
      snapshot === undefined
        ? undefined
        : scopedBinding(snapshot, caller.profileDefinitionId, profileName);
    if (binding !== undefined) {
      scoped = true;
      if (binding.status !== 'ready' || binding.profile === undefined) {
        throw new Error2(
          ErrorCodes.SCOPED_PROFILE_UNAVAILABLE,
          `Scoped subagent type "${profileName}" is unavailable`,
          {
            details: {
              profileName,
              diagnostic: binding.diagnostic?.code,
            },
          },
        );
      }
      selection = { profile: binding.profile, baseProfile: binding.profile };
    } else {
      const profile =
        snapshot === undefined
          ? catalog.get(profileName)
          : snapshot.publicProfiles.get(profileName);
      if (profile === undefined) {
        const available = [
          ...(snapshot === undefined ? catalog.list() : snapshot.publicProfiles.values()),
        ]
          .map((item) => item.name)
          .join(', ');
        throw new Error2(
          ErrorCodes.PROFILE_UNKNOWN,
          `Unknown agent type: "${profileName}". Available agent types: ${available}`,
          { details: { profileName, available } },
        );
      }
      selection = { profile, baseProfile: profile };
    }
  } else if (snapshot === undefined) {
    selection = catalog.resolveSelection({
      profile: input.profileName,
      route: input.routeId,
    });
  } else {
    const route = snapshot.routes.get(input.routeId);
    if (route === undefined) {
      throw new Error2(
        ErrorCodes.ROUTE_UNKNOWN,
        `Unknown agent profile route: "${input.routeId}"`,
        { details: { route: input.routeId } },
      );
    }
    if (input.profileName !== undefined && input.profileName !== route.profile) {
      throw new Error2(
        ErrorCodes.ROUTE_BASE_MISMATCH,
        `Agent profile route "${route.id}" belongs to "${route.profile}", not "${input.profileName}"`,
        {
          details: {
            route: route.id,
            expectedProfile: route.profile,
            profile: input.profileName,
          },
        },
      );
    }
    const baseProfile = snapshot.publicProfiles.get(route.profile);
    if (baseProfile === undefined) {
      throw new Error2(
        ErrorCodes.ROUTE_BASE_MISSING,
        `Agent profile route "${route.id}" cannot resolve base profile "${route.profile}"`,
        { details: { route: route.id, profile: route.profile } },
      );
    }
    selection = {
      profile: route.effectiveProfile,
      baseProfile,
      route,
    };
  }
  assertSubagentDispatchAllowed(catalog, caller, selection.baseProfile.name);
  return { selection, scoped, snapshot };
}

export function resolveSubagentTarget(
  catalog: SubagentDispatchCatalog,
  caller: SubagentDispatchCaller & CallerLeaseOwner,
  input: ResolveSubagentDispatchInput,
  models: IModelService,
): ResolvedSubagentTarget {
  const resolved = resolveSubagentDispatch(catalog, caller, input);
  const dispatched = appliedDispatchProfile(
    resolved.selection.profile,
    resolved.selection.baseProfile.name,
    caller,
    resolved.snapshot?.defaultProfile ?? catalog.getDefault(),
    aliasIdentity(models),
  );
  assertAutomaticDispatchPermitted(dispatched.profile, resolved.selection.route, models);
  return {
    ...resolved,
    effectiveProfile: dispatched.profile,
    lease: dispatched.lease,
    spawnPolicy: dispatched.spawnPolicy,
  };
}

export function listAvailableSubagentTargets(
  catalog: SubagentDispatchCatalog,
  caller: SubagentDispatchCaller & CallerLeaseOwner,
  input: {
    readonly profiles: readonly AgentProfile[];
    readonly routes: readonly AgentProfileRouteCatalogEntry[];
    readonly snapshot?: AgentProfileCatalogSnapshot;
  },
  models: IModelService,
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
