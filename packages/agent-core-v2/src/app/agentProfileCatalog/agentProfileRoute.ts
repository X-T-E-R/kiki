/**
 * `agentProfileCatalog` domain — pure named profile-route composition.
 *
 * Composes a route over its canonical base profile while retaining every
 * base authority ceiling and rendering the base prompt exactly once.
 */

import type {
  AgentProfile,
  AgentProfileRouteDefinition,
  ResolvedAgentProfileRoute,
} from './agentProfileCatalog';
import { renderPromptTemplateResult } from './profile-shared';

export function resolveAgentProfileRoute(
  route: AgentProfileRouteDefinition,
  base: AgentProfile,
): ResolvedAgentProfileRoute {
  const toolAllowPolicies = [base.tools, ...(base.toolAllowPolicies ?? []), route.tools].filter(
    (policy): policy is readonly string[] => policy !== undefined,
  );
  const tools = base.tools ?? route.tools;
  const disallowedTools = union(base.disallowedTools, route.disallowedTools);
  const subagents = intersectAllowlist(base.subagents, route.subagents);
  const serviceTier =
    route.serviceTier === undefined
      ? base.serviceTier
      : route.serviceTier === null
        ? undefined
        : route.serviceTier;
  let requestParams =
    route.requestParams === undefined
      ? base.requestParams
      : route.requestParams === null
        ? undefined
        : { ...base.requestParams, ...route.requestParams };
  if (route.serviceTier !== undefined && requestParams !== undefined) {
    const next = { ...requestParams };
    delete next['service_tier'];
    requestParams = next;
  }
  const effective: AgentProfile = {
    ...base,
    routeId: route.id,
    tools,
    toolAllowPolicies: toolAllowPolicies.length === 0 ? undefined : toolAllowPolicies,
    disallowedTools,
    subagents,
    modelPreference:
      route.modelPreference ?? (route.modelAlias === undefined ? base.modelPreference : undefined),
    modelAlias: route.modelAlias ?? (route.modelPreference === undefined ? base.modelAlias : undefined),
    thinkingEffort: route.thinkingEffort ?? base.thinkingEffort,
    serviceTier,
    requestParams,
    renderSystemPrompt: (context) => {
      if (route.promptMode === 'inherit') return base.renderSystemPrompt(context);
      const template =
        route.promptMode === 'prepend'
          ? `${route.prompt}\n\n\${base_prompt}`
          : route.promptMode === 'append'
            ? `\${base_prompt}\n\n${route.prompt}`
            : route.prompt;
      const skillActive =
        [effective.tools, ...(effective.toolAllowPolicies ?? [])]
          .filter((policy): policy is readonly string[] => policy !== undefined)
          .every((policy) => policy.includes('Skill')) &&
        !(effective.disallowedTools ?? []).includes('Skill');
      return renderPromptTemplateResult(
        template,
        context,
        { skillActive },
        (ctx) => base.renderSystemPrompt(ctx),
      );
    },
    systemPrompt: (context) => effective.renderSystemPrompt(context).text,
  };
  return {
    id: route.id,
    profile: route.profile,
    description: route.description,
    whenToUse: route.whenToUse,
    modelPreference: effective.modelPreference,
    modelAlias: effective.modelAlias,
    thinkingEffort: effective.thinkingEffort,
    overriddenFields: route.overriddenFields,
    effectiveProfile: effective,
    lockedModelAlias: route.modelAlias,
    lockedThinkingEffort: route.thinkingEffort,
  };
}

function union(
  base: readonly string[] | undefined,
  route: readonly string[] | undefined,
): readonly string[] | undefined {
  if (base === undefined && route === undefined) return undefined;
  return [...new Set([...(base ?? []), ...(route ?? [])])];
}

function intersectAllowlist(
  base: readonly string[] | undefined,
  route: readonly string[] | undefined,
): readonly string[] | undefined {
  if (route === undefined) return base;
  if (base === undefined) return route;
  if (base.includes('*')) return route;
  if (route.includes('*')) return base;
  return route.filter((name) => base.includes(name));
}
