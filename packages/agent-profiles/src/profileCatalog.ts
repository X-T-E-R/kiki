import {
  DEFAULT_AGENT_PROFILE_NAME,
  type AgentProfile,
  type AgentProfileRouteDefinition,
  type ResolvedAgentProfileRoute,
} from './agentProfile';
import type { AgentProfileContribution } from './agentProfileContribution';
import { resolveAgentProfileRoute } from './agentProfileRoute';
import type {
  AgentProfileCatalogSnapshot,
  AgentProfileDiagnostic,
  ScopedAgentProfileBinding,
} from './scopedAgentProfile';

export const BUILTIN_AGENT_PROFILE_SOURCE_ID = 'builtin';

export interface AgentProfileRegistration {
  readonly sourceId: string;
  readonly priority: number;
  readonly workspaceKey?: string;
  readonly contribution: AgentProfileContribution;
}

export interface AgentProfileRouteDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly routeId?: string;
}

export interface AgentProfileSuppressedCandidate {
  readonly sourceId: string;
  readonly priority: number;
  readonly reason: 'priority' | 'builtin-override-required';
}

export interface AgentProfileInspection {
  readonly name: string;
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
  readonly suppressed: readonly AgentProfileSuppressedCandidate[];
}

export interface ProfileCatalogProjection {
  readonly profiles: ReadonlyMap<string, AgentProfile>;
  readonly resolvableProfiles: ReadonlyMap<string, AgentProfile>;
  readonly defaultBindingProfile?: AgentProfile;
  readonly inspections: ReadonlyMap<string, AgentProfileInspection>;
  readonly routes: ReadonlyMap<string, ResolvedAgentProfileRoute>;
  readonly publicRoutes: ReadonlyMap<string, ResolvedAgentProfileRoute>;
  readonly routeDiagnostics: readonly AgentProfileRouteDiagnostic[];
  readonly snapshot: AgentProfileCatalogSnapshot;
}

interface ProfileCandidate {
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
}

export class AgentProfileInheritanceError extends Error {
  constructor(readonly profileName: string) {
    super(`Agent profile "${profileName}" uses system_prompt_mode "inherit" but has no lower-priority base profile`);
    this.name = 'AgentProfileInheritanceError';
  }
}

export function projectAgentProfileCatalog(input: {
  readonly entries: readonly AgentProfileRegistration[];
  readonly disabledBuiltinProfiles: ReadonlySet<string>;
  readonly disabledNamedProfiles: ReadonlySet<string>;
  readonly routeBaseMissingCode: string;
  readonly warn: (message: string) => void;
}): ProfileCatalogProjection {
  const publicProfiles = new Map<string, AgentProfile>();
  const resolvableProfiles = new Map<string, AgentProfile>();
  let defaultBindingProfile: AgentProfile | undefined;
  const inspections = new Map<string, AgentProfileInspection>();
  const builtinEntry = input.entries.find(
    (entry) => entry.sourceId === BUILTIN_AGENT_PROFILE_SOURCE_ID,
  );
  if (builtinEntry !== undefined) {
    for (const profile of builtinEntry.contribution.profiles) {
      if (profile.name === DEFAULT_AGENT_PROFILE_NAME) defaultBindingProfile = profile;
      if (input.disabledBuiltinProfiles.has(profile.name)) continue;
      publicProfiles.set(profile.name, profile);
      resolvableProfiles.set(profile.name, profile);
      inspections.set(profile.name, {
        name: profile.name,
        profile,
        sourceId: builtinEntry.sourceId,
        priority: builtinEntry.priority,
        suppressed: [],
      });
    }
  }

  const fileCandidates = new Map<string, ProfileCandidate[]>();
  const ordered = input.entries
    .filter((entry) => entry.sourceId !== BUILTIN_AGENT_PROFILE_SOURCE_ID)
    .toSorted((a, b) => b.priority - a.priority);
  for (const entry of ordered) {
    const entryProfiles = new Map<string, AgentProfile>();
    for (const profile of entry.contribution.profiles) entryProfiles.set(profile.name, profile);
    for (const declared of entryProfiles.values()) {
      const builtin = builtinEntry?.contribution.profiles.find((item) => item.name === declared.name);
      const profile = declared.main === undefined && builtin?.main !== undefined
        ? { ...declared, main: builtin.main }
        : declared;
      if (profile.main === true && profile.executor !== undefined && profile.executor !== 'native') {
        input.warn(`External executor "${profile.executor}" is unsupported for main agent profile "${profile.name}"`);
        continue;
      }
      if (input.disabledNamedProfiles.has(profile.name)
        && !(profile.name === DEFAULT_AGENT_PROFILE_NAME && profile.main === true)) continue;
      const candidates = fileCandidates.get(profile.name) ?? [];
      candidates.push({ profile, sourceId: entry.sourceId, priority: entry.priority });
      fileCandidates.set(profile.name, candidates);
    }
  }

  for (const candidates of fileCandidates.values()) {
    const suppressed: AgentProfileSuppressedCandidate[] = [];
    let winner = false;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const builtinBase = resolvableProfiles.get(candidate.profile.name);
      if (builtinBase !== undefined && candidate.profile.override !== true) {
        input.warn(
          `agent file profile "${candidate.profile.name}" ignored: a same-name builtin profile exists; set "override: true" in the frontmatter to replace it`,
        );
        suppressed.push({
          sourceId: candidate.sourceId,
          priority: candidate.priority,
          reason: 'builtin-override-required',
        });
        continue;
      }
      const profile = resolveInheritedCandidate(candidates, candidateIndex, builtinBase);
      if (input.disabledNamedProfiles.has(profile.name)) {
        defaultBindingProfile = profile;
        publicProfiles.delete(profile.name);
        resolvableProfiles.delete(profile.name);
      } else {
        resolvableProfiles.set(profile.name, profile);
        if (profile.private === true) publicProfiles.delete(profile.name);
        else publicProfiles.set(profile.name, profile);
      }
      inspections.set(profile.name, {
        name: profile.name,
        profile,
        sourceId: candidate.sourceId,
        priority: candidate.priority,
        suppressed: [
          ...suppressed,
          ...candidates.slice(candidateIndex + 1).map((rest) => ({
            sourceId: rest.sourceId,
            priority: rest.priority,
            reason: 'priority' as const,
          })),
        ],
      });
      winner = true;
      break;
    }
    if (!winner && suppressed.length > 0) {
      const name = candidates[0]?.profile.name;
      const existing = name === undefined ? undefined : inspections.get(name);
      if (existing !== undefined) inspections.set(existing.name, { ...existing, suppressed });
    }
  }

  const routeDiagnostics: AgentProfileRouteDiagnostic[] = [];
  for (const entry of input.entries) {
    for (const skipped of entry.contribution.skipped ?? []) {
      if (skipped.code?.startsWith('agent_profile_route.') !== true) continue;
      routeDiagnostics.push({ code: skipped.code, message: skipped.reason, path: skipped.path });
    }
  }
  const routeCandidates = new Map<string, AgentProfileRouteDefinition>();
  const routeEntries = input.entries.toSorted((a, b) => b.priority - a.priority);
  for (const entry of routeEntries) {
    for (const route of entry.contribution.routes ?? []) {
      if (!routeCandidates.has(route.id)) routeCandidates.set(route.id, route);
    }
  }
  const routes = new Map<string, ResolvedAgentProfileRoute>();
  const publicRoutes = new Map<string, ResolvedAgentProfileRoute>();
  for (const route of routeCandidates.values()) {
    const base = resolvableProfiles.get(route.profile);
    if (base === undefined) {
      const message = `Agent profile route "${route.id}" ignored because base profile "${route.profile}" is unavailable`;
      routeDiagnostics.push({
        code: input.routeBaseMissingCode,
        message,
        path: route.path,
        routeId: route.id,
      });
      input.warn(message);
      continue;
    }
    const resolved = resolveAgentProfileRoute(route, base);
    routes.set(route.id, resolved);
    if (publicProfiles.has(route.profile)) publicRoutes.set(route.id, resolved);
  }

  const scopedBindings = new Map<string, ReadonlyMap<string, ScopedAgentProfileBinding>>();
  const sourceDefinitions = new Map<string, AgentProfile>();
  const dependencyIndex = new Map<string, readonly string[]>();
  const diagnostics: AgentProfileDiagnostic[] = [];
  const visited = new Set<string>();
  const visit = (definitionId: string): void => {
    if (visited.has(definitionId)) return;
    visited.add(definitionId);
    for (const entry of routeEntries) {
      const table = entry.contribution.scopedBindings?.get(definitionId);
      if (table === undefined) continue;
      scopedBindings.set(definitionId, new Map(table));
      for (const binding of table.values()) {
        if (binding.diagnostic !== undefined) diagnostics.push(binding.diagnostic);
        if (binding.sourceDefinitionId === undefined) continue;
        const source = entry.contribution.sourceDefinitions?.get(binding.sourceDefinitionId);
        if (source !== undefined && !sourceDefinitions.has(binding.sourceDefinitionId)) {
          sourceDefinitions.set(binding.sourceDefinitionId, source);
        }
        const owners = entry.contribution.dependencyIndex?.get(binding.sourceDefinitionId);
        if (owners !== undefined) dependencyIndex.set(binding.sourceDefinitionId, [...owners]);
        visit(binding.sourceDefinitionId);
      }
      return;
    }
  };
  for (const profile of resolvableProfiles.values()) {
    if (profile.definitionId !== undefined) visit(profile.definitionId);
  }
  const defaultProfile = resolvableProfiles.get(DEFAULT_AGENT_PROFILE_NAME) ?? defaultBindingProfile;
  if (defaultProfile?.definitionId !== undefined) visit(defaultProfile.definitionId);
  const snapshot: AgentProfileCatalogSnapshot = {
    publicProfiles: new Map(publicProfiles),
    resolvableProfiles: new Map(resolvableProfiles),
    defaultProfile,
    routes: new Map(routes),
    scopedBindings,
    sourceDefinitions,
    dependencyIndex,
    diagnostics,
  };

  return {
    profiles: publicProfiles,
    resolvableProfiles,
    defaultBindingProfile,
    inspections,
    routes,
    publicRoutes,
    routeDiagnostics,
    snapshot,
  };
}

function resolveInheritedCandidate(
  candidates: readonly ProfileCandidate[],
  index: number,
  builtinBase: AgentProfile | undefined,
): AgentProfile {
  const candidate = candidates[index]?.profile;
  if (candidate === undefined) throw new AgentProfileInheritanceError('unknown');
  if (candidate.systemPromptMode !== 'inherit') return candidate;
  let lowerIndex = index + 1;
  while (builtinBase !== undefined) {
    const lowerCandidate = candidates[lowerIndex];
    if (lowerCandidate === undefined || lowerCandidate.profile.override === true) break;
    lowerIndex += 1;
  }
  const lower = candidates[lowerIndex] === undefined
    ? builtinBase
    : resolveInheritedCandidate(candidates, lowerIndex, builtinBase);
  if (lower === undefined) throw new AgentProfileInheritanceError(candidate.name);
  const lowerLayers = lower.promptOverrideLayers
    ?? (lower.promptOverrides === undefined ? [] : [lower.promptOverrides]);
  const promptOverrideLayers = candidate.promptOverrides === undefined
    ? lowerLayers
    : [...lowerLayers, candidate.promptOverrides];
  return {
    ...candidate,
    promptOverrideLayers,
    systemPrompt: lower.systemPrompt,
    renderSystemPrompt: lower.renderSystemPrompt,
  };
}
