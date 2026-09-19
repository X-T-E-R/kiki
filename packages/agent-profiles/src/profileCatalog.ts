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
  readonly reason: 'priority';
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
  readonly disabledNamedProfiles: ReadonlySet<string>;
  readonly routeBaseMissingCode: string;
  readonly warn: (message: string) => void;
}): ProfileCatalogProjection {
  const publicProfiles = new Map<string, AgentProfile>();
  const resolvableProfiles = new Map<string, AgentProfile>();
  const inspections = new Map<string, AgentProfileInspection>();
  let disabledMainProfile: AgentProfile | undefined;

  const fileCandidates = new Map<string, ProfileCandidate[]>();
  const ordered = [...input.entries].toSorted((a, b) => b.priority - a.priority);
  for (const entry of ordered) {
    const entryProfiles = new Map<string, AgentProfile>();
    for (const profile of entry.contribution.profiles) {
      const prior = entryProfiles.get(profile.name);
      if (prior?.sourcePath !== undefined && profile.sourcePath !== undefined && prior.sourcePath !== profile.sourcePath) {
        input.warn(`Duplicate agent profile "${profile.name}" at ${prior.sourcePath}; keeping higher-priority ${profile.sourcePath}`);
      }
      entryProfiles.set(profile.name, profile);
    }
    for (const declared of entryProfiles.values()) {
      const profile = declared.name === DEFAULT_AGENT_PROFILE_NAME && declared.main === undefined
        ? { ...declared, main: true as const }
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
    for (const [candidateIndex, candidate] of candidates.entries()) {
      let profile: AgentProfile;
      try {
        profile = resolveInheritedCandidate(candidates, candidateIndex);
      } catch (error) {
        if (!(error instanceof AgentProfileInheritanceError)) throw error;
        input.warn(`agent file profile "${candidate.profile.name}" ignored: ${error.message}`);
        continue;
      }
      if (!input.disabledNamedProfiles.has(profile.name)) {
        resolvableProfiles.set(profile.name, profile);
        if (profile.private === true) publicProfiles.delete(profile.name);
        else publicProfiles.set(profile.name, profile);
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
      } else if (profile.name === DEFAULT_AGENT_PROFILE_NAME && profile.main === true) {
        disabledMainProfile = profile;
      }
      break;
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
  for (const entry of ordered) {
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
    for (const entry of ordered) {
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
  const defaultProfile = resolvableProfiles.get(DEFAULT_AGENT_PROFILE_NAME) ?? disabledMainProfile;
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
): AgentProfile {
  const candidate = candidates[index]?.profile;
  if (candidate === undefined) throw new AgentProfileInheritanceError('unknown');
  const inheritsPrompt = candidate.systemPromptMode === 'inherit';
  const inheritsSubagents = candidate.subagentDeclaration?.kind === 'inherit';
  if (!inheritsPrompt && !inheritsSubagents) return candidate;
  const lower = candidates[index + 1] === undefined
    ? undefined
    : resolveInheritedCandidate(candidates, index + 1);
  if (inheritsPrompt && lower === undefined) throw new AgentProfileInheritanceError(candidate.name);
  let resolved = candidate;
  if (inheritsSubagents && lower !== undefined) {
    resolved = {
      ...resolved,
      subagentDeclaration: lower.subagentDeclaration,
      subagents: lower.subagents,
      subagentLeases: lower.subagentLeases,
    };
  }
  if (!inheritsPrompt) return resolved;
  const lowerLayers = lower!.promptOverrideLayers
    ?? (lower!.promptOverrides === undefined ? [] : [lower!.promptOverrides]);
  const promptOverrideLayers = candidate.promptOverrides === undefined
    ? lowerLayers
    : [...lowerLayers, candidate.promptOverrides];
  return {
    ...resolved,
    promptOverrideLayers,
    systemPrompt: lower!.systemPrompt,
    renderSystemPrompt: lower!.renderSystemPrompt,
  };
}
