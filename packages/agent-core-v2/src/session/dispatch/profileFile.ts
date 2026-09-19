import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { profilesFromDiscovery } from '@kiki/agent-profiles/agentProfileFromFile';
import type { AgentFileDefinition, AgentFileScopedBinding } from '@kiki/agent-profiles/agentFileTypes';
import { agentProfileDefinitionId, resolveAgentSourceGraph } from '@kiki/agent-profiles/agentSourceGraph';
import { agentProfilesHostFs } from '#/workspace/workspaceAgentProfileLoader/internal/hostFs';
import { resolvePathAccessPath } from '#/tool/path-access';
import { Error2, ErrorCodes } from '#/errors';
import type { ProfileData } from '#/agent/profile/profile';
import type {
  AgentProfile,
  AgentProfileContext,
  SystemPromptRenderResult,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileCatalogSnapshot, AgentProfileDiagnostic } from '#/app/agentProfileCatalog/scopedAgentProfile';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { Runtime, RuntimeWorkspaceRoots } from '#/runtime/runtime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';

export interface FrozenProfileFileSources {
  readonly root: AgentFileDefinition;
  readonly callerCeiling?: Pick<ProfileData, 'activeToolNames' | 'toolAllowPolicies' | 'disallowedTools' | 'subagents'>;
  readonly scopedBindings: Readonly<Record<string, Readonly<Record<string, AgentFileScopedBinding>>>>;
  readonly sourceDefinitions: Readonly<Record<string, AgentFileDefinition>>;
  readonly dependencyIndex: Readonly<Record<string, readonly string[]>>;
  readonly diagnostics: readonly AgentProfileDiagnostic[];
}

export function restoreProfileFileSources(
  sources: FrozenProfileFileSources,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
  definitionId?: string,
): AgentProfile | undefined {
  const restored = materializeSources(sources, basePrompt);
  return definitionId === undefined || restored.root.definitionId === definitionId ? restored.root : restored.sourceDefinitions.get(definitionId);
}

function materializeSources(
  sources: FrozenProfileFileSources,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
) {
  const contribution = profilesFromDiscovery({
    agents: [sources.root], routes: [], skipped: [], scannedRoots: [sources.root.contributionRoot],
    scopedBindings: new Map(Object.entries(sources.scopedBindings).map(([id, entries]) => [id, new Map(Object.entries(entries))])),
    sourceDefinitions: new Map(Object.entries(sources.sourceDefinitions)),
    dependencyIndex: new Map(Object.entries(sources.dependencyIndex)),
    diagnostics: [...sources.diagnostics],
  }, basePrompt);
  const attach = (profile: AgentProfile) => ({ ...profile, fileSources: sources });
  return {
    root: attach(contribution.profiles[0]!),
    scopedBindings: new Map([...(contribution.scopedBindings ?? [])].map(([id, entries]) => [id,
      new Map([...entries].map(([name, binding]) => [name, { ...binding, profile: binding.profile === undefined ? undefined : attach(binding.profile) }])),
    ])),
    sourceDefinitions: new Map([...(contribution.sourceDefinitions ?? [])].map(([id, profile]) => [id, attach(profile)])),
  };
}

export function inheritProfileFileSources(
  caller: ProfileData,
  catalog: ISessionAgentProfileCatalog,
  snapshot?: AgentProfileCatalogSnapshot,
): AgentProfileCatalogSnapshot | undefined {
  const sources = caller.boundProfile?.fileSources;
  if (sources === undefined) return snapshot;
  const base = snapshot ?? catalog.snapshot?.();
  const defaults = base?.defaultProfile ?? catalog.getDefault();
  const materialized = materializeSources(sources, (context) => defaults.renderSystemPrompt(context));
  return {
    publicProfiles: base?.publicProfiles ?? new Map(catalog.list().map((profile) => [profile.name, profile])),
    resolvableProfiles: base?.resolvableProfiles,
    defaultProfile: defaults, routes: base?.routes ?? new Map(),
    scopedBindings: new Map([...(base?.scopedBindings ?? []), ...materialized.scopedBindings]),
    sourceDefinitions: new Map([...(base?.sourceDefinitions ?? []), ...materialized.sourceDefinitions]),
    dependencyIndex: new Map([...(base?.dependencyIndex ?? []), ...Object.entries(sources.dependencyIndex)]),
    diagnostics: [...(base?.diagnostics ?? []), ...sources.diagnostics],
  };
}

export async function loadDispatchProfileFile(
  path: string,
  runtime: Runtime,
  roots: RuntimeWorkspaceRoots,
  catalog: ISessionAgentProfileCatalog,
  caller: ProfileData,
  snapshot?: AgentProfileCatalogSnapshot,
): Promise<{ readonly profileName: string; readonly snapshot: AgentProfileCatalogSnapshot }> {
  if (runtime.fs === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Profile file loading requires filesystem access in the caller runtime.');
  const view = new RuntimeWorkspaceView(runtime, roots);
  const guardedPath = (candidate: string): string => view.resolve(resolvePathAccessPath(candidate, {
    env: runtime.environment,
    workspace: { workspaceDir: view.workDir, additionalDirs: view.additionalDirs },
    operation: 'read',
  }), view.workDir, true);
  const lexical = guardedPath(path);
  const realpath = guardedPath(await runtime.fs.realpath(lexical));
  if (realpath !== lexical) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Profile file target changed after path admission. Retry the tool call.');
  const fs = agentProfilesHostFs(runtime.fs);
  const guardedFs = { ...fs, readFile: (candidate: string) => fs.readFile(guardedPath(candidate)) };
  const definition = parseAgentFileText({
    path: realpath, source: 'explicit', text: await guardedFs.readFile(realpath),
    definitionId: agentProfileDefinitionId(realpath), contributionRoot: runtime.path.dirname(realpath),
  });
  if (definition.main === true) throw new Error2(ErrorCodes.REQUEST_INVALID, 'profile_file must define a subagent, not a main profile.');
  const graph = await resolveAgentSourceGraph(guardedFs, [definition]);
  const sources: FrozenProfileFileSources = {
    root: definition,
    callerCeiling: structuredClone({
      activeToolNames: caller.activeToolNames, toolAllowPolicies: caller.toolAllowPolicies,
      disallowedTools: caller.disallowedTools, subagents: caller.subagents,
    }),
    scopedBindings: Object.fromEntries([...graph.scopedBindings].map(([id, entries]) => [id, Object.fromEntries(entries)])),
    sourceDefinitions: Object.fromEntries(graph.sourceDefinitions), dependencyIndex: Object.fromEntries(graph.dependencyIndex), diagnostics: graph.diagnostics,
  };
  const defaults = snapshot?.defaultProfile ?? catalog.getDefault();
  const { root: parsed, scopedBindings: loadedBindings, sourceDefinitions } = materializeSources(
    sources,
    (context) => defaults.renderSystemPrompt(context),
  );
  const profile = {
    ...parsed,
    toolAllowPolicies: [...(parsed.toolAllowPolicies ?? []), ...(caller.toolAllowPolicies ?? []), ...(caller.activeToolNames === undefined ? [] : [caller.activeToolNames])],
    disallowedTools: [...new Set([...(parsed.disallowedTools ?? []), ...(caller.disallowedTools ?? [])])],
    subagents: caller.subagents === undefined ? parsed.subagents
      : parsed.subagents === undefined ? caller.subagents : parsed.subagents.filter((name) => caller.subagents!.includes(name)),
  };
  const base = snapshot ?? catalog.snapshot?.();
  const publicProfiles = new Map<string, AgentProfile>([
    ...(base?.publicProfiles ?? catalog.list().map((entry) => [entry.name, entry] as const)),
    [profile.name, profile],
  ]);
  const resolvableProfiles = new Map<string, AgentProfile>([
    ...(base?.resolvableProfiles ?? publicProfiles),
    [profile.name, profile],
  ]);
  const scopedBindings = new Map([...(base?.scopedBindings ?? []), ...loadedBindings]);
  if (caller.profileDefinitionId !== undefined) {
    const own = new Map(scopedBindings.get(caller.profileDefinitionId));
    own.delete(profile.name);
    scopedBindings.set(caller.profileDefinitionId, own);
  }
  return {
    profileName: profile.name,
    snapshot: {
      publicProfiles, resolvableProfiles, defaultProfile: defaults, routes: base?.routes ?? new Map(), scopedBindings,
      sourceDefinitions: new Map([...(base?.sourceDefinitions ?? []), ...sourceDefinitions, [profile.definitionId!, profile]]),
      dependencyIndex: new Map([...(base?.dependencyIndex ?? []), ...graph.dependencyIndex]),
      diagnostics: [...(base?.diagnostics ?? []), ...graph.diagnostics],
    },
  };
}
