import type { AgentProfileRouteDefinition } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { AgentFileParseError } from './agentFile';
import {
  parseAgentRouteFileText as parseRouteText,
  type ParseAgentRouteFileOptions,
} from '@kiki/agent-profiles/agentRouteFile';
import { AgentFileParseError as PackageAgentFileParseError } from '@kiki/agent-profiles/agentFile';

export type { ParseAgentRouteFileOptions };

export function parseAgentRouteFileText(
  options: ParseAgentRouteFileOptions,
): AgentProfileRouteDefinition {
  try {
    return parseRouteText(options);
  } catch (error) {
    if (error instanceof PackageAgentFileParseError) {
      throw new AgentFileParseError(error.message, error.reason);
    }
    throw error;
  }
}
