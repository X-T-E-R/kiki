import { captureProfileModelMenu } from './agentProfile';
import type {
  AgentProfile,
  AgentProfileRouteDefinition,
  ResolvedAgentProfileRoute,
} from './agentProfile';
import { renderPromptTemplateResult } from './profileShared';
import { isToolActive } from './toolPolicy';
import { resolveProfileThinkingDefault } from './modelProfileOverlay';
import { overlaySubagentPermissions } from './subagentPermissions';

export function resolveAgentProfileRoute(
  route: AgentProfileRouteDefinition,
  base: AgentProfile,
  resolveId: (id: string) => string | undefined = (id) => id,
): ResolvedAgentProfileRoute {
  base = captureProfileModelMenu(base, resolveId);
  const tools = route.tools !== undefined ? route.tools : base.tools;
  const disallowedTools =
    route.disallowedTools !== undefined ? route.disallowedTools : base.disallowedTools;
  const permissions = overlaySubagentPermissions(base, route);
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
    ...permissions,
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
      const skillActive = isToolActive(effective, 'Skill');
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
