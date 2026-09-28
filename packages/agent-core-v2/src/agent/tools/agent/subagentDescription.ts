import type { AgentProfile, AgentProfileRouteCatalogEntry } from '#/app/agentProfileCatalog/agentProfileCatalog';

export { buildProfileDescriptions } from '#/session/dispatch/profileCatalogProjection';

export function compactProfileDescriptions(profiles: readonly AgentProfile[], limit = 8): string {
  return profiles.slice(0, limit).map((profile) =>
    `- ${profile.name}: ${firstSentence(profile.whenToUse ?? profile.description ?? 'Use when this profile fits the task.')}`,
  ).join('\n');
}

export function compactRouteDescriptions(routes: readonly AgentProfileRouteCatalogEntry[], limit = 4): string {
  return routes.slice(0, limit).map((route) =>
    `- ${route.id}: ${firstSentence(route.whenToUse ?? route.description ?? `Use the ${route.profile} route.`)}`,
  ).join('\n');
}

function firstSentence(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0]!.slice(0, 180);
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
