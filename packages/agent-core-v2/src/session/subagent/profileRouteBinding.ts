import type { ModelAliasResolver } from '@kiki/agent-profiles/ports';

import { Error2, ErrorCodes } from '#/errors';
import type { ResolvedAgentProfileRoute } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IModelCatalog } from '#/kosong/model/catalog';

/** Returns whether a binding matches a route's recommended model and effort pins. */
export function profileRouteBindingRecommended(
  route: ResolvedAgentProfileRoute | undefined,
  input: {
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
  },
  models: ModelAliasResolver,
): boolean {
  if (route === undefined) return true;
  const modelMatches = route.lockedModelAlias === undefined || input.modelAlias === undefined ||
    resolveModelId(models, input.modelAlias) === resolveModelId(models, route.lockedModelAlias);
  const effortMatches = route.lockedThinkingEffort === undefined || input.thinkingEffort === undefined ||
    input.thinkingEffort === route.lockedThinkingEffort;
  return modelMatches && effortMatches;
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
