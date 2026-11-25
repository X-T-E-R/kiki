import type { z } from 'zod';
import { sessionCommandContract, type SessionCommandChannel, type SessionCommandName } from '../../contract/session/commands.js';
import { KlientValidationError } from '../validation.js';
import { createSessionCommandsFacadeCore, type SessionCommandsFacade } from './session-commands-core.js';

export type { SessionCommandsFacade };

export function createSessionCommandsFacade(
  channel: SessionCommandChannel | undefined,
  sessionId: string,
  validate: boolean,
): SessionCommandsFacade {
  if (!validate) {
    return createSessionCommandsFacadeCore(channel, sessionId);
  }
  const parse = (phase: 'input' | 'output', name: string, schema: z.ZodType, value: unknown): unknown => {
    const result = schema.safeParse(value);
    if (!result.success) throw new KlientValidationError(phase, name, result.error.issues, value);
    return result.data;
  };
  return createSessionCommandsFacadeCore(channel, sessionId, (phase, command: SessionCommandName, value) => {
    const contract = sessionCommandContract[command];
    return parse(phase, `session.commands.${command}`, phase === 'input' ? contract.input : contract.output, value);
  });
}
