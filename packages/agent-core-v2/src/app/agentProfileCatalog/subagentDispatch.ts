import { Error2, ErrorCodes } from '#/errors';
import type { IModelService } from '#/kosong/model/model';
import { resolveProfileThinkingDefault } from './modelProfileOverlay';
import {
  listAvailableSubagentTargets as listTargets,
  resolveSnapshotProfileDefinition as resolveSnapshotDefinition,
  subagentDispatchAllowed as dispatchAllowed,
} from '@kiki/agent-profiles/subagentDispatch';

import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  ResolvedAgentProfileRoute,
} from './agentProfileCatalog';
import {
  aliasIdentity,
  appliedDispatchProfile,
  assertAutomaticDispatchPermitted,
  type CallerLeaseOwner,
} from './applySubagentLease';
import type { SpawnConstraints, SubagentLease } from './subagentLease';
import {
  subagentAllowlistFor,
  profileNotAllowedMessage,
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
  return dispatchAllowed(catalog, caller, profileName);
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
    profileNotAllowedMessage(profileName, allowlist),
    { details: { profileName, allowlist } },
  );
}

export function resolveSnapshotProfileDefinition(
  snapshot: AgentProfileCatalogSnapshot,
  definitionId: string,
  profileName: string,
): AgentProfile | undefined {
  return resolveSnapshotDefinition(snapshot, definitionId, profileName);
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
          : (snapshot.resolvableProfiles ?? snapshot.publicProfiles).get(profileName);
      if (profile === undefined) {
        const available = [
          ...(snapshot === undefined ? catalog.list() : snapshot.publicProfiles.values()),
        ]
          .map((item) => item.name)
          .join(', ');
        throw new Error2(
          ErrorCodes.PROFILE_UNKNOWN,
          `Unknown agent profile: "${profileName}". Available agent profiles: ${available}`,
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
    const baseProfile = (snapshot.resolvableProfiles ?? snapshot.publicProfiles).get(route.profile);
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
  const selection = resolved.selection;
  const resolveId = (selection.profile.executor ?? 'native') === 'native' ? aliasIdentity(models)! : (id: string) => id;
  const profile = selection.route === undefined ? selection.profile : {
    ...selection.profile,
    thinkingEffort: selection.route.lockedThinkingEffort ?? resolveProfileThinkingDefault(
      selection.baseProfile, selection.profile.modelAlias ?? '', resolveId,
    ),
  };
  const dispatched = appliedDispatchProfile(
    profile,
    selection.baseProfile.name,
    caller,
    resolved.snapshot?.defaultProfile ?? catalog.getDefault(),
    resolveId,
  );
  assertAutomaticDispatchPermitted(dispatched.profile);
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
  return listTargets(catalog, caller, input, models);
}
