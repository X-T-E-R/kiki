import type { AgentProfile } from './agentProfile';
import { subagentToolDefault } from './subagentToolPolicy';
import {
  isToolActive as evaluateToolActive,
  isMcpToolName,
  resolveActiveToolNames,
  type ToolReference,
} from './toolPolicy';

export interface DispatchProfileCatalogEntry {
  readonly profileName: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly allowedModels?: readonly string[];
  readonly alternativeModels: readonly {
    readonly alias: string;
    readonly when: string;
    readonly thinkingEffort?: string;
  }[];
  readonly tools?: string;
}

export function buildProfileCatalogEntries(
  profiles: readonly AgentProfile[],
  tools: readonly ToolReference[],
  isToolActive: (
    profile: { readonly tools?: readonly string[]; readonly disallowedTools?: readonly string[] },
    name: string,
    source: ToolReference['source'],
  ) => boolean,
  unavailableTools: ReadonlySet<string> | undefined,
  isModelAliasAvailable: (alias: string) => boolean,
  showTools = true,
): DispatchProfileCatalogEntry[] {
  return profiles.map((profile) => ({
    profileName: profile.name,
    description: profile.description,
    whenToUse: profile.whenToUse,
    modelAlias: profile.modelAlias,
    thinkingEffort: profile.thinkingEffort,
    allowedModels: profile.allowedModels,
    alternativeModels: availableAlternativeModels(profile, isModelAliasAvailable),
    tools: showTools
      ? projectedTools(profile, tools, isToolActive, unavailableTools)
      : undefined,
  }));
}

export function renderProfileCatalogEntries(
  entries: readonly DispatchProfileCatalogEntry[],
): string {
  return entries
    .map((entry) => {
      const details = [entry.description, entry.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header =
        details.length === 0
          ? `- ${entry.profileName}`
          : `- ${entry.profileName}: ${details.join(' ')}`;
      const lines = [header];
      if (entry.modelAlias !== undefined) lines.push(`  Model alias: ${entry.modelAlias}`);
      if (entry.thinkingEffort !== undefined) {
        lines.push(`  Thinking effort: ${entry.thinkingEffort}`);
      }
      if (entry.allowedModels !== undefined && entry.allowedModels.length > 0) {
        lines.push(`  Allowed models: ${entry.allowedModels.join(', ')}`);
      }
      if (entry.alternativeModels.length > 0) {
        lines.push(
          `  Alternative models: ${entry.alternativeModels
            .map((model) =>
              model.thinkingEffort === undefined
                ? `${model.alias} — ${model.when}`
                : `${model.alias} (thinking_effort=${model.thinkingEffort}) — ${model.when}`,
            )
            .join('; ')}`,
        );
      }
      if (entry.tools !== undefined) lines.push(`  Tools: ${entry.tools}`);
      return lines.join('\n');
    })
    .join('\n');
}

export function buildProfileDescriptions(
  profiles: readonly AgentProfile[],
  tools: readonly ToolReference[],
  isToolActive: (
    profile: { readonly tools?: readonly string[]; readonly disallowedTools?: readonly string[] },
    name: string,
    source: ToolReference['source'],
  ) => boolean,
  unavailableTools: ReadonlySet<string> | undefined,
  isModelAliasAvailable: (alias: string) => boolean,
  showTools = true,
): string {
  return renderProfileCatalogEntries(
    buildProfileCatalogEntries(
      profiles,
      tools,
      isToolActive,
      unavailableTools,
      isModelAliasAvailable,
      showTools,
    ),
  );
}

function availableAlternativeModels(
  profile: AgentProfile,
  isModelAliasAvailable: (alias: string) => boolean,
): DispatchProfileCatalogEntry['alternativeModels'] {
  if (profile.modelProfiles === undefined) return [];
  const external = profile.executor !== undefined && profile.executor !== 'native';
  return profile.modelProfiles.flatMap((entry) =>
    external || isModelAliasAvailable(entry.alias)
      ? [{
          alias: entry.alias,
          when: collapseWhitespace(entry.when ?? ''),
          thinkingEffort:
            entry.thinkingEffort === undefined
              ? undefined
              : collapseWhitespace(entry.thinkingEffort),
        }]
      : [],
  );
}

function projectedTools(
  profile: AgentProfile,
  tools: readonly ToolReference[],
  isToolActive: (
    profile: { readonly tools?: readonly string[]; readonly disallowedTools?: readonly string[] },
    name: string,
    source: ToolReference['source'],
  ) => boolean,
  unavailableTools: ReadonlySet<string> | undefined,
): string {
  if (profile.executor !== undefined && profile.executor !== 'native') {
    return 'managed by the external executor; native tool availability is not implied';
  }
  const activeTools = resolveActiveToolNames(profile);
  if (tools.length === 0 && activeTools === undefined) {
    return 'not inventoried; availability must be checked in the child runtime';
  }
  const candidates = new Map<string, ToolReference>();
  for (const name of activeTools ?? []) {
    const known = tools.find((tool) => tool.name === name);
    candidates.set(name, known ?? { name, source: isMcpToolName(name) ? 'mcp' : 'builtin' });
  }
  for (const tool of tools) candidates.set(tool.name, tool);
  const effectiveTools = [...candidates.values()]
    .filter(({ name, source }) =>
      !unavailableTools?.has(name) &&
      subagentToolDefault(name, source) !== 'main-only' &&
      evaluateToolActive(profile, name, source) &&
      isToolActive(profile, name, source))
    .map(({ name }) => name);
  if (effectiveTools.length === 0) return 'none';
  return `${effectiveTools.join(', ')}\n  Tool availability is conditional on the child runtime, feature configuration, and invocation approval.`;
}

function collapseWhitespace(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}
