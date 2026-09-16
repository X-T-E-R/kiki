import type { ModelAliasResolver } from '@kiki/agent-profiles/ports';

import { Error2, ErrorCodes } from '#/errors';
import type { ResolvedAgentProfileRoute } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IModelCatalog } from '#/kosong/model/catalog';

/** `subagent` domain — named profile-route binding guards shared by Agent tools: route model pins
 *  keep their conflict semantics, while identity comparison and availability checks use the app model
 *  registry's canonical resolver. */
export function assertProfileRouteBinding(
  route: ResolvedAgentProfileRoute | undefined,
  input: {
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
  },
  models: ModelAliasResolver,
): void {
  if (route === undefined) return;
  if (
    route.lockedModelAlias !== undefined &&
    input.modelAlias !== undefined &&
    resolveModelId(models, input.modelAlias) !== resolveModelId(models, route.lockedModelAlias)
  ) {
    throw new Error2(
      ErrorCodes.ROUTE_BINDING_CONFLICT,
      `Agent profile route "${route.id}" locks model_alias to "${route.lockedModelAlias}"`,
      { details: { route: route.id, lockedModelAlias: route.lockedModelAlias } },
    );
  }
  if (
    route.lockedThinkingEffort !== undefined &&
    input.thinkingEffort !== undefined &&
    input.thinkingEffort !== route.lockedThinkingEffort
  ) {
    throw new Error2(
      ErrorCodes.ROUTE_BINDING_CONFLICT,
      `Agent profile route "${route.id}" locks thinking_effort to "${route.lockedThinkingEffort}"`,
      { details: { route: route.id, lockedThinkingEffort: route.lockedThinkingEffort } },
    );
  }
}

export function assertProfileRouteModelAvailable(
  route: ResolvedAgentProfileRoute | undefined,
  catalog: IModelCatalog,
  models: ModelAliasResolver,
): void {
  if (route?.lockedModelAlias === undefined) return;
  try {
    catalog.get(resolveModelId(models, route.lockedModelAlias));
  } catch (error) {
    throw new Error2(
      ErrorCodes.ROUTE_MODEL_ALIAS_MISSING,
      `Agent profile route "${route.id}" requires unavailable model alias "${route.lockedModelAlias}"`,
      { details: { route: route.id, modelAlias: route.lockedModelAlias }, cause: error },
    );
  }
}

function resolveModelId(models: ModelAliasResolver, modelId: string): string {
  return models.resolveId(modelId) ?? modelId;
}
