/**
 * `workspaceAgentProfileLoader` domain — coded failures raised by validated
 * agent-profile file write-back.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AgentProfileWriteErrors = {
  codes: {
    PROFILE_NOT_FOUND: 'agent_profile_write.not_found',
    PROFILE_READ_ONLY: 'agent_profile_write.read_only',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentProfileWriteErrors);
