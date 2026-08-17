/**
 * `subagent` domain — nested spawn default-model context.
 *
 * Resolves the main agent's live model and thinking state when a subagent
 * performs an otherwise caller-derived spawn. This keeps nested default
 * selection rooted at the session's main agent while leaving explicit and
 * pool-selected bindings fixed by their normal resolver paths.
 */

import { Error2, ErrorCodes } from '#/errors';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  type IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';

import type { SubagentBindingOwner } from './configSection';

export function resolveNestedSubagentDefaultContext(
  lifecycle: IAgentLifecycleService,
  callerMeta: AgentMeta | undefined,
): SubagentBindingOwner | undefined {
  if (!isSubagentMeta(callerMeta)) return undefined;
  const main = lifecycle.get(MAIN_AGENT_ID);
  if (main === undefined) {
    throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent does not exist', {
      details: { agentId: MAIN_AGENT_ID },
    });
  }
  const data = main.accessor.get(IAgentProfileService).data();
  if (data.modelAlias === undefined) {
    throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Main agent has no model bound', {
      details: { agentId: MAIN_AGENT_ID },
    });
  }
  return {
    modelAlias: data.modelAlias,
    thinkingLevel: data.thinkingLevel,
    inheritByDefault: false,
  };
}
