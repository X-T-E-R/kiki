/**
 * `subagent` domain — named profile-route binding guards shared by Agent tools.
 */

import { Error2, ErrorCodes } from '#/errors';
import type { ResolvedAgentProfileRoute } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IModelCatalog } from '#/kosong/model/catalog';

export function assertProfileRouteBinding(
  route: ResolvedAgentProfileRoute | undefined,
  input: {
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
    readonly modelPreference?: 'primary' | 'secondary';
  },
): void {
  if (route === undefined) return;
  if (
    route.lockedModelAlias !== undefined &&
    (input.modelPreference !== undefined ||
      (input.modelAlias !== undefined && input.modelAlias !== route.lockedModelAlias))
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
): void {
  if (route?.lockedModelAlias === undefined) return;
  try {
    catalog.get(route.lockedModelAlias);
  } catch (error) {
    throw new Error2(
      ErrorCodes.ROUTE_MODEL_ALIAS_MISSING,
      `Agent profile route "${route.id}" requires unavailable model alias "${route.lockedModelAlias}"`,
      { details: { route: route.id, modelAlias: route.lockedModelAlias }, cause: error },
    );
  }
}
