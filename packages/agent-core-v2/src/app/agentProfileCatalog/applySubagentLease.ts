import { Error2, ErrorCodes } from '#/errors';
import type { AgentProfile } from './agentProfileCatalog';
import { isDispatchBlocked } from '@kiki/agent-profiles/applySubagentLease';

export * from '@kiki/agent-profiles/applySubagentLease';

export function assertAutomaticDispatchPermitted(profile: AgentProfile): void {
  if (isDispatchBlocked(profile)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Subagent type "${profile.name}" is not available for automatic dispatch; the caller lease and spawn_constraints leave no permitted models.`,
      { details: { profile: profile.name } },
    );
  }
}
