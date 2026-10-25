import type { AgentProfile, AgentProfileRouteCatalogEntry } from '#/app/agentProfileCatalog/agentProfileCatalog';

export { buildProfileDescriptions } from '#/session/dispatch/profileCatalogProjection';

export function compactProfileDescriptions(profiles: readonly AgentProfile[], limit = 8): string {
  return profiles.slice(0, limit).map((profile) => {
    const menu = profile.restrictModelsToMenu === true
      ? ` Model menu restriction (hard): ${[...new Set(profile.effectiveModelAliases ?? [])].join(', ') || 'no effective candidates'}; pins cannot expand the declared menu.`
      : '';
    const diagnostics = (profile.modelMenuDiagnostics ?? []).map((message) => ` Configuration diagnostic: ${message}`).join('');
    return `- ${profile.name}: ${firstSentence(profile.whenToUse ?? profile.description ?? 'Use when this profile fits the task.')}${menu}${diagnostics}`;
  }).join('\n');
}

export function compactRouteDescriptions(routes: readonly AgentProfileRouteCatalogEntry[], limit = 4): string {
  return routes.slice(0, limit).map((route) =>
    `- ${route.id}: ${firstSentence(route.whenToUse ?? route.description ?? `Use the ${route.profile} route.`)}`,
  ).join('\n');
}

function firstSentence(text: string): string {
  const sentence = text.replaceAll(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0]!;
  if (sentence.length <= 180) return sentence;
  const prefix = sentence.slice(0, 179);
  const boundary = prefix.lastIndexOf(' ');
  return `${boundary > 0 ? prefix.slice(0, boundary) : prefix}…`;
}

export function buildRouteDescriptions(
  routes: readonly (AgentProfileRouteCatalogEntry & { readonly allowedModels?: readonly string[] })[],
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
        route.allowedModels === undefined ? undefined : `Allowed models: ${route.allowedModels.join(', ') || 'none'}`,
      ]
        .filter((value): value is string => value !== undefined)
        .join('; ');
      return `- ${route.id} (base: ${route.profile}): ${details}\n  ${suffix}`;
    })
    .join('\n');
}
