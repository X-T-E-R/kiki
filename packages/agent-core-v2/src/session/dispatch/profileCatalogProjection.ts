import {
  isToolActive as evaluateToolActive,
  literalToolNames,
  resolveActiveToolNames,
} from '#/agent/toolPolicy/evaluate';
import type { ToolReference } from '#/agent/toolRegistry/toolRegistry';
import type {
  AgentProfile,
  AgentRecommendedModel,
} from '#/app/agentProfileCatalog/agentProfileCatalog';

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
    alternativeModels: availableAlternativeModels(profile.modelProfiles, isModelAliasAvailable),
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
  entries: readonly AgentRecommendedModel[] | undefined,
  isModelAliasAvailable: (alias: string) => boolean,
): DispatchProfileCatalogEntry['alternativeModels'] {
  if (entries === undefined) return [];
  return entries.flatMap((entry) =>
    isModelAliasAvailable(entry.alias)
      ? [{
          alias: entry.alias,
          when: collapseWhitespace(entry.when),
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
  const activeTools = resolveActiveToolNames(profile);
  const restricted =
    literalToolNames(activeTools ?? []).some((name) => unavailableTools?.has(name)) ||
    tools.some(
      (tool) =>
        evaluateToolActive(profile, tool.name, tool.source) &&
        !isToolActive(profile, tool.name, tool.source),
    );
  if (restricted) {
    const effectiveTools = tools
      .filter((tool) => isToolActive(profile, tool.name, tool.source))
      .map((tool) => tool.name);
    return effectiveTools.length === 0 ? 'none' : effectiveTools.join(', ');
  }
  if (activeTools === undefined) {
    return (profile.disallowedTools?.length ?? 0) > 0
      ? `all except ${profile.disallowedTools!.join(', ')}`
      : 'all';
  }
  return activeTools.length === 0 ? 'none' : activeTools.join(', ');
}

function collapseWhitespace(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}
