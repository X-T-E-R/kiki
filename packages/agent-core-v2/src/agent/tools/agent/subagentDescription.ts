import type { AgentProfileRouteCatalogEntry } from '#/app/agentProfileCatalog/agentProfileCatalog';

export { buildProfileDescriptions } from '#/session/dispatch/profileCatalogProjection';

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
