/**
 * `subagent` domain — warning contracts and publishers for model binding.
 *
 * Defines the Session-scoped secondary-recipe warning service plus warning
 * codes and event-bus publishers for ignored legacy profile preferences and
 * dead profile aliases that fall back to the caller binding.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IEventBus } from '#/app/event/eventBus';

export const SECONDARY_MODEL_INVALID_WARNING_CODE = 'secondary-model-invalid';
export const SECONDARY_MODEL_EFFORT_WARNING_CODE = 'secondary-model-effort-not-listed';
export const PROFILE_MODEL_PREFERENCE_IGNORED_WARNING_CODE =
  'subagent-profile-model-preference-ignored';
export const PROFILE_MODEL_ALIAS_INVALID_WARNING_CODE = 'subagent-profile-model-alias-invalid';

export function publishIgnoredProfileModelPreferenceWarning(
  eventBus: IEventBus,
  profileName: string,
  preference: AgentModelPreference,
): void {
  eventBus.publish({
    type: 'warning',
    code: PROFILE_MODEL_PREFERENCE_IGNORED_WARNING_CODE,
    message:
      `Agent profile "${profileName}" sets model_preference="${preference}", but the secondary-model experiment is disabled. ` +
      'The preference was ignored; model_alias, [subagent] defaults, and caller fallback remain active.',
  });
}

export function publishInvalidProfileModelAliasWarning(
  eventBus: IEventBus,
  profileName: string,
  alias: string,
  error: unknown,
): void {
  eventBus.publish({
    type: 'warning',
    code: PROFILE_MODEL_ALIAS_INVALID_WARNING_CODE,
    message:
      `Agent profile "${profileName}" pins model_alias="${alias}", but that alias could not be resolved: ` +
      `${error instanceof Error ? error.message : String(error)} Falling back to the caller model and thinking effort.`,
  });
}

export interface SecondaryModelWarning {
  readonly code: string;
  readonly message: string;
}

export interface ISessionSecondaryModelWarningService {
  readonly _serviceBrand: undefined;
  getSecondaryModelWarning(): SecondaryModelWarning | undefined;
  recheckSecondaryModelWarning(): SecondaryModelWarning | undefined;
}

export const ISessionSecondaryModelWarningService: ServiceIdentifier<ISessionSecondaryModelWarningService> =
  createDecorator<ISessionSecondaryModelWarningService>('sessionSecondaryModelWarningService');
