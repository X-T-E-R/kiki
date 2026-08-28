/**
 * `agentProfileCatalog` domain — pure named profile-route composition.
 *
 * Composes a route over its canonical base profile. `tools`, `disallowedTools`,
 * and `subagents` replace the base when the route declares them and inherit
 * otherwise. Model locks, service tier, and request params keep their existing
 * merge rules. The base prompt is rendered exactly once.
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
  const tools = route.tools !== undefined ? route.tools : base.tools;
  const disallowedTools =
    route.disallowedTools !== undefined ? route.disallowedTools : base.disallowedTools;
  const subagents = route.subagents !== undefined ? route.subagents : base.subagents;
  const toolAllowPolicies =
    route.tools !== undefined
      ? undefined
      : ([base.tools, ...(base.toolAllowPolicies ?? [])].filter(
          (policy): policy is readonly string[] => policy !== undefined,
        ));
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
    toolAllowPolicies:
      toolAllowPolicies === undefined || toolAllowPolicies.length === 0
        ? undefined
        : toolAllowPolicies,
    disallowedTools,
    subagents,
    modelAlias: route.modelAlias ?? base.modelAlias,
    thinkingEffort: route.thinkingEffort ?? base.thinkingEffort,
    serviceTier,
    requestParams,
    renderSystemPrompt: (context) => {
      if (route.promptMode === 'inherit') return base.renderSystemPrompt(context);
      const template =
        route.promptMode === 'prepend'
          ? `${route.prompt}\n\n\${parent_prompt}`
          : route.promptMode === 'append'
            ? `\${parent_prompt}\n\n${route.prompt}`
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
    modelAlias: effective.modelAlias,
    thinkingEffort: effective.thinkingEffort,
    overriddenFields: route.overriddenFields,
    effectiveProfile: effective,
    lockedModelAlias: route.modelAlias,
    lockedThinkingEffort: route.thinkingEffort,
  };
}
