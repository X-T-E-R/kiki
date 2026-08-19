/**
 * `profile` domain error codes — model/provider configuration failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ProfileErrors = {
  codes: {
    MODEL_NOT_CONFIGURED: 'model.not_configured',
    MODEL_CONFIG_INVALID: 'model.config_invalid',
    THINKING_ALIAS_CONFLICT: 'profile.thinking_alias_conflict',
    PROFILE_UNKNOWN: 'profile.unknown',
    PROFILE_ALREADY_BOUND: 'profile.already_bound',
    PROFILE_NOT_BOUND: 'profile.not_bound',
    COGNITION_FILE_MISSING: 'profile.cognition_file_missing',
    COGNITION_PATH_INVALID: 'profile.cognition_path_invalid',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ProfileErrors);
