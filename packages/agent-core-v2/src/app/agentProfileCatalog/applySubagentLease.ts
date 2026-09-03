import { Error2, ErrorCodes } from '#/errors';
import type { IModelService } from '#/kosong/model/model';
import type { AgentProfile } from './agentProfileCatalog';
import {
  isDispatchBlocked,
  routePermittedByProfile,
} from '@kiki/agent-profiles/applySubagentLease';

export * from '@kiki/agent-profiles/applySubagentLease';

export function assertAutomaticDispatchPermitted(
  profile: AgentProfile,
  route?: { readonly id?: string; readonly modelAlias?: string; readonly lockedModelAlias?: string },
  models?: IModelService,
): void {
  if (isDispatchBlocked(profile)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Subagent type "${profile.name}" is not available for automatic dispatch; the caller lease and spawn_constraints leave no permitted models.`,
      { details: { profile: profile.name } },
    );
  }
  const locked = route?.lockedModelAlias ?? route?.modelAlias;
  if (route === undefined || locked === undefined || locked === '') return;
  if (routePermittedByProfile({ modelAlias: locked }, profile, models)) return;
  const routeId = route.id ?? 'this route';
  throw new Error2(
    ErrorCodes.CONFIG_INVALID,
    `Agent profile route "${routeId}" locks model_alias to "${locked}", which is outside the effective allowed_models from the caller lease or spawn_constraints.`,
    { details: { route: routeId, modelAlias: locked } },
  );
}
