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
    DELEGATION_FILE_MISSING: 'profile.delegation_file_missing',
    DELEGATION_PATH_INVALID: 'profile.delegation_path_invalid',
    TOOL_PATTERN_INACTIVE: 'profile.tool_pattern_inactive',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ProfileErrors);
