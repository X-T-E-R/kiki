import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import {
  AgentFileParseError as PackageAgentFileParseError,
  parseAgentFileText as parseProfileText,
  type ParseAgentFileOptions,
} from '@kiki/agent-profiles/agentFile';
import type { AgentFileDefinition } from '@kiki/agent-profiles/agentFileTypes';

export type { ParseAgentFileOptions };

export class AgentFileParseError extends Error2 {
  readonly reason?: unknown;

  constructor(message: string, cause?: unknown) {
    super(CoreErrors.codes.VALIDATION_FAILED, message, {
      cause,
      name: 'AgentFileParseError',
    });
    if (cause !== undefined) this.reason = cause;
  }
}

export function parseAgentFileText(options: ParseAgentFileOptions): AgentFileDefinition {
  try {
    return parseProfileText(options);
  } catch (error) {
    if (error instanceof PackageAgentFileParseError) {
      throw new AgentFileParseError(error.message, error.reason);
    }
    throw error;
  }
}
