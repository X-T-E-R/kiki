import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileRouteCatalogEntry,
} from './agentProfile';
import { applyModelProfilePromptDelta } from './modelProfileOverlay';
import type { ModelAliasResolver } from './ports';
import type { SpawnConstraints, SubagentLease } from './subagentLease';

export type AliasIdentity = (alias: string) => string;

export type CallerLeaseOwner = {
  readonly profileName?: string;
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly spawnPolicy?: SpawnConstraints;
};

export type CatalogLeaseOwner = {
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly spawnConstraints?: SpawnConstraints;
  readonly spawnPolicy?: SpawnConstraints;
};

export function aliasIdentity(models: ModelAliasResolver | undefined): AliasIdentity | undefined {
  if (models === undefined) return undefined;
  return (alias) => {
    try {
      return models.resolveId(alias) ?? alias;
    } catch {
      return alias;
    }
  };
}

export function leaseHasBindingPin(lease: SubagentLease | undefined): boolean {
  if (lease === undefined) return false;
  return lease.modelAlias !== undefined || lease.thinkingEffort !== undefined;
}

export function applyLease(
  profile: AgentProfile,
  lease: SubagentLease | undefined,
  resolveId?: AliasIdentity,
): AgentProfile {
  if (lease === undefined) return profile;
  const toolsDeclared = lease.tools !== undefined;
  const tools = !toolsDeclared ? profile.tools : lease.tools === null ? undefined : lease.tools;
  const toolAllowPolicies = toolsDeclared ? undefined : profile.toolAllowPolicies;
  const disallowedTools =
    lease.disallowedTools !== undefined ? lease.disallowedTools : profile.disallowedTools;
  const subagents =
    lease.subagents === null
      ? undefined
      : lease.subagents !== undefined
        ? lease.subagents
        : profile.subagents;
  const serviceTier =
    lease.serviceTier === undefined
      ? profile.serviceTier
      : lease.serviceTier === null
        ? undefined
        : lease.serviceTier;
  const requestParams = mergeRequestParams(profile.requestParams, lease.requestParams);
  return normalizeAgentProfile({
    ...profile,
    description: lease.description ?? profile.description,
    whenToUse: lease.whenToUse ?? profile.whenToUse,
    tools,
    toolAllowPolicies,
    disallowedTools,
    subagents,
    modelAlias: lease.modelAlias ?? profile.modelAlias,
    thinkingEffort: lease.thinkingEffort ?? profile.thinkingEffort,
    allowedModels: intersectAllowlists(profile.allowedModels, lease.allowedModels, resolveId),
    denyModels: unionLists(profile.denyModels, lease.denyModels, resolveId),
    allowedEfforts: intersectAllowlists(profile.allowedEfforts, lease.allowedEfforts),
    modelProfiles: lease.modelProfiles ?? profile.modelProfiles,
    serviceTier,
    requestParams,
    delegationNotice: lease.delegationNotice ?? profile.delegationNotice,
    renderSystemPrompt: wrapLeasePrompt(profile, lease),
  });
}

export function applySpawnPolicy(
  profile: AgentProfile,
  policy: SpawnConstraints | undefined,
  resolveId?: AliasIdentity,
): AgentProfile {
  if (policy === undefined) return profile;
  return normalizeAgentProfile({
    ...profile,
    allowedModels: intersectAllowlists(profile.allowedModels, policy.allowedModels, resolveId),
    denyModels: unionLists(profile.denyModels, policy.denyModels, resolveId),
    allowedEfforts: intersectAllowlists(profile.allowedEfforts, policy.allowedEfforts),
    disallowedTools: unionLists(profile.disallowedTools, policy.disallowedTools),
  });
}

export function intersectSpawnPolicy(
  parent: SpawnConstraints | undefined,
  child: SpawnConstraints | undefined,
  resolveId?: AliasIdentity,
): SpawnConstraints | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  const allowedModels = intersectAllowlists(parent.allowedModels, child.allowedModels, resolveId);
  const denyModels = unionLists(parent.denyModels, child.denyModels, resolveId);
  const allowedEfforts = intersectAllowlists(parent.allowedEfforts, child.allowedEfforts);
  const disallowedTools = unionLists(parent.disallowedTools, child.disallowedTools);
  if (
    allowedModels === undefined &&
    denyModels === undefined &&
    allowedEfforts === undefined &&
    disallowedTools === undefined
  ) {
    return undefined;
  }
  return {
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(denyModels === undefined ? {} : { denyModels }),
    ...(allowedEfforts === undefined ? {} : { allowedEfforts }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
  };
}

export function isDispatchBlocked(profile: AgentProfile): boolean {
  return profile.allowedModels !== undefined && profile.allowedModels.length === 0;
}

export function fillLeasePins<
  T extends {
    modelAlias?: string;
    thinkingEffort?: string;
  },
>(
  tool: T,
  lease: SubagentLease | undefined,
  route?: { readonly lockedModelAlias?: string; readonly lockedThinkingEffort?: string },
): T {
  if (lease === undefined) return tool;
  const modelAlias =
    tool.modelAlias === undefined && route?.lockedModelAlias === undefined
      ? lease.modelAlias
      : tool.modelAlias;
  const thinkingEffort =
    route?.lockedThinkingEffort !== undefined
      ? tool.thinkingEffort
      : (tool.thinkingEffort ?? lease.thinkingEffort);
  return { ...tool, modelAlias, thinkingEffort };
}

export function routePermittedByProfile(
  route: Pick<AgentProfileRouteCatalogEntry, 'modelAlias'>,
  profile: AgentProfile,
  models?: ModelAliasResolver,
): boolean {
  if (isDispatchBlocked(profile)) return false;
  const locked = route.modelAlias;
  if (locked === undefined || locked === '') return true;
  const identity = ident(locked, aliasIdentity(models));
  const denied = new Set((profile.denyModels ?? []).map((alias) => ident(alias, aliasIdentity(models))));
  if (denied.has(identity)) return false;
  const allowed = profile.allowedModels;
  if (allowed === undefined) return true;
  if (allowed.length === 0) return false;
  const allowedIds = new Set(allowed.map((alias) => ident(alias, aliasIdentity(models))));
  return allowedIds.has(identity);
}

export function callerLeaseTable(
  caller: CallerLeaseOwner,
  catalogDefault: CatalogLeaseOwner,
): {
  readonly leases: Readonly<Record<string, SubagentLease>>;
  readonly spawnPolicy?: SpawnConstraints;
} {
  if (caller.profileName === undefined) {
    return {
      leases: catalogDefault.subagentLeases ?? {},
      spawnPolicy: catalogDefault.spawnPolicy ?? catalogDefault.spawnConstraints,
    };
  }
  return {
    leases: caller.subagentLeases ?? {},
    spawnPolicy: caller.spawnPolicy,
  };
}

export function appliedDispatchProfile(
  profile: AgentProfile,
  childName: string,
  caller: CallerLeaseOwner,
  catalogDefault: CatalogLeaseOwner,
  resolveId?: AliasIdentity,
): {
  readonly profile: AgentProfile;
  readonly lease: SubagentLease | undefined;
  readonly spawnPolicy: SpawnConstraints | undefined;
} {
  const table = callerLeaseTable(caller, catalogDefault);
  const lease = table.leases[childName];
  return {
    profile: applySpawnPolicy(applyLease(profile, lease, resolveId), table.spawnPolicy, resolveId),
    lease,
    spawnPolicy: table.spawnPolicy,
  };
}

export function spawnConstraintOrigin(
  lease: SubagentLease | undefined,
  policy: SpawnConstraints | undefined,
): string | undefined {
  const parts: string[] = [];
  if (lease !== undefined) parts.push('caller lease');
  if (policy !== undefined) parts.push('spawn_constraints');
  if (parts.length === 0) return undefined;
  return `this agent's profile, ${parts.join(', and ')}`;
}

function wrapLeasePrompt(
  profile: AgentProfile,
  lease: SubagentLease,
): AgentProfile['renderSystemPrompt'] {
  const inner = profile.renderSystemPrompt.bind(profile);
  if (lease.promptMode === undefined || lease.prompt === undefined) return inner;
  const entry = {
    alias: lease.name,
    when: '',
    promptMode: lease.promptMode,
    prompt: lease.prompt,
  };
  return (context) => {
    const rendered = inner(context);
    return {
      ...rendered,
      text: applyModelProfilePromptDelta(rendered.text, entry),
    };
  };
}

function mergeRequestParams(
  base: AgentProfile['requestParams'],
  overlay: SubagentLease['requestParams'],
): AgentProfile['requestParams'] {
  if (overlay === undefined) return base;
  if (overlay === null) return undefined;
  return { ...(base ?? {}), ...overlay };
}

function ident(alias: string, resolveId?: AliasIdentity): string {
  if (resolveId === undefined) return alias;
  try {
    return resolveId(alias) ?? alias;
  } catch {
    return alias;
  }
}

function intersectAllowlists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
  resolveId?: AliasIdentity,
): readonly string[] | undefined {
  if (left !== undefined && left.length === 0) return [];
  if (right !== undefined && right.length === 0) return [];
  if (left === undefined) return right;
  if (right === undefined) return left;
  const rightIds = new Set(right.map((item) => ident(item, resolveId)));
  return left.filter((item) => rightIds.has(ident(item, resolveId)));
}

function unionLists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
  resolveId?: AliasIdentity,
): readonly string[] | undefined {
  if (left === undefined || left.length === 0) {
    return right === undefined || right.length === 0 ? undefined : right;
  }
  if (right === undefined || right.length === 0) return left;
  const seen = new Set(left.map((item) => ident(item, resolveId)));
  const out = [...left];
  for (const item of right) {
    const id = ident(item, resolveId);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}
