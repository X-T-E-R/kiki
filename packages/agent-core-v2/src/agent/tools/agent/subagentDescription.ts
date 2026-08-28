import {
  isToolActive as evaluateToolActive,
  literalToolNames,
  resolveActiveToolNames,
} from '#/agent/toolPolicy/evaluate';
import type { ToolReference } from '#/agent/toolRegistry/toolRegistry';
import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  AgentRecommendedModel,
} from '#/app/agentProfileCatalog/agentProfileCatalog';

export function buildRouteDescriptions(
  routes: readonly AgentProfileRouteCatalogEntry[],
): string {
  return routes
    .map((route) => {
      const details = [route.description, route.whenToUse].filter(Boolean).join(' ');
      const bindings = [
        route.modelAlias === undefined ? undefined : `model_alias=${route.modelAlias}`,
        route.thinkingEffort === undefined
          ? undefined
          : `thinking_effort=${route.thinkingEffort}`,
      ].filter((value): value is string => value !== undefined);
      const suffix = [
        bindings.length === 0 ? undefined : bindings.join(', '),
        `overrides=${route.overriddenFields.join(',') || 'none'}`,
      ]
        .filter((value): value is string => value !== undefined)
        .join('; ');
      return `- ${route.id} (base: ${route.profile}): ${details}\n  ${suffix}`;
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
  externallyUnavailableTools: ReadonlySet<string> | undefined,
  isModelAliasAvailable: (alias: string) => boolean,
  showTools = true,
): string {
  return profiles
    .map((profile) => {
      const details = [profile.description, profile.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header =
        details.length === 0 ? `- ${profile.name}` : `- ${profile.name}: ${details.join(' ')}`;
      const bindingLines: string[] = [];
      if (profile.modelAlias !== undefined) {
        bindingLines.push(`  Model alias: ${profile.modelAlias}`);
      }
      if (profile.thinkingEffort !== undefined) {
        bindingLines.push(`  Thinking effort: ${profile.thinkingEffort}`);
      }
      if (profile.allowedModels !== undefined && profile.allowedModels.length > 0) {
        bindingLines.push(`  Allowed models: ${profile.allowedModels.join(', ')}`);
      }
      const alternativeModelsLine = formatAlternativeModelsLine(
        profile.modelProfiles,
        isModelAliasAvailable,
      );
      if (alternativeModelsLine !== undefined) {
        bindingLines.push(alternativeModelsLine);
      }
      const headerLines =
        bindingLines.length === 0 ? header : `${header}\n${bindingLines.join('\n')}`;
      if (!showTools) return headerLines;
      const activeTools = resolveActiveToolNames(profile);
      const externallyRestricted =
        literalToolNames(activeTools ?? []).some((name) => externallyUnavailableTools?.has(name)) ||
        tools.some(
          (tool) =>
            evaluateToolActive(profile, tool.name, tool.source) &&
            !isToolActive(profile, tool.name, tool.source),
        );
      if (externallyRestricted) {
        const effectiveTools = tools
          .filter((tool) => isToolActive(profile, tool.name, tool.source))
          .map((tool) => tool.name);
        if (effectiveTools.length === 0) {
          return `${headerLines}\n  Tools: none`;
        }
        return `${headerLines}\n  Tools: ${effectiveTools.join(', ')}`;
      }
      if (activeTools === undefined) {
        if ((profile.disallowedTools?.length ?? 0) > 0) {
          return `${headerLines}\n  Tools: all except ${profile.disallowedTools!.join(', ')}`;
        }
        return `${headerLines}\n  Tools: all`;
      }
      if (activeTools.length === 0) {
        return `${headerLines}\n  Tools: none`;
      }
      return `${headerLines}\n  Tools: ${activeTools.join(', ')}`;
    })
    .join('\n');
}

function formatAlternativeModelsLine(
  entries: readonly AgentRecommendedModel[] | undefined,
  isModelAliasAvailable: (alias: string) => boolean,
): string | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const parts: string[] = [];
  for (const entry of entries) {
    if (!isModelAliasAvailable(entry.alias)) continue;
    const when = collapseWhitespace(entry.when);
    const effort =
      entry.thinkingEffort === undefined ? undefined : collapseWhitespace(entry.thinkingEffort);
    parts.push(
      effort === undefined
        ? `${entry.alias} — ${when}`
        : `${entry.alias} (thinking_effort=${effort}) — ${when}`,
    );
  }
  if (parts.length === 0) return undefined;
  return `  Alternative models: ${parts.join('; ')}`;
}

function collapseWhitespace(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}
