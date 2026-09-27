import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

/** `workspaceAgentProfileLoader` domain — coded failures raised by validated agent-profile file
 *  write-back. */
export const AgentProfileWriteErrors = {
  codes: {
    PROFILE_NOT_FOUND: 'agent_profile_write.not_found',
    PROFILE_READ_ONLY: 'agent_profile_write.read_only',
    PROFILE_ALREADY_EXISTS: 'agent_profile_write.already_exists',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentProfileWriteErrors);
