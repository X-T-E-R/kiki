/**
 * `agentProfileCatalog` domain error codes — named profile-route failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AgentProfileRouteErrors = {
  codes: {
    ROUTE_FEATURE_DISABLED: 'agent_profile_route.feature_disabled',
    ROUTE_INVALID_ID: 'agent_profile_route.invalid_id',
    ROUTE_UNKNOWN: 'agent_profile_route.unknown',
    ROUTE_BASE_MISMATCH: 'agent_profile_route.base_mismatch',
    ROUTE_BASE_MISSING: 'agent_profile_route.base_missing',
    ROUTE_BINDING_CONFLICT: 'agent_profile_route.binding_conflict',
    ROUTE_MODEL_ALIAS_MISSING: 'agent_profile_route.model_alias_missing',
    ROUTE_SWITCH_FORBIDDEN: 'agent_profile_route.switch_forbidden',
    ROUTE_INVALID_SIDECAR: 'agent_profile_route.invalid_sidecar',
    ROUTE_DUPLICATE: 'agent_profile_route.duplicate',
    SCOPED_PROFILE_UNAVAILABLE: 'agent_profile_source.unavailable',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentProfileRouteErrors);
