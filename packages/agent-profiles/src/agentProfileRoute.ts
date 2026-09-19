import type {
  AgentProfile,
  AgentProfileRouteDefinition,
  ResolvedAgentProfileRoute,
} from './agentProfile';
import { renderPromptTemplateResult } from './profileShared';
import { resolveProfileThinkingDefault } from './modelProfileOverlay';

export function resolveAgentProfileRoute(
  route: AgentProfileRouteDefinition,
  base: AgentProfile,
  resolveId: (id: string) => string | undefined = (id) => id,
): ResolvedAgentProfileRoute {
  const tools = route.tools !== undefined ? route.tools : base.tools;
  const disallowedTools =
    route.disallowedTools !== undefined ? route.disallowedTools : base.disallowedTools;
  const subagentsDeclared = route.overriddenFields.includes('subagents');
  const overlaidSubagents = subagentsDeclared ? route.subagents : base.subagents;
  const subagents = base.subagentPolicy === 'strict' && subagentsDeclared
    ? intersectSubagentLists(base.subagents, overlaidSubagents)
    : overlaidSubagents;
  const subagentDeclaration = base.subagentPolicy === undefined || !subagentsDeclared
    ? base.subagentDeclaration
    : subagents === undefined
      ? { kind: 'all' as const }
      : { kind: 'set' as const, names: subagents };
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
    routeDefinition: structuredClone(route),
    routeId: route.id,
    tools,
    toolAllowPolicies:
      toolAllowPolicies === undefined || toolAllowPolicies.length === 0
        ? undefined
        : toolAllowPolicies,
    disallowedTools,
    subagentDeclaration,
    subagents,
    modelAlias: route.modelAlias ?? base.modelAlias,
    thinkingEffort: route.thinkingEffort ?? (route.modelAlias === undefined ? base.thinkingEffort
      : resolveProfileThinkingDefault(base, route.modelAlias, resolveId)),
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

function intersectSubagentLists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): readonly string[] | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const allowed = new Set(right);
  return left.filter((name) => allowed.has(name));
}
