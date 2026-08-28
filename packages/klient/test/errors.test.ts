import { Error2, ErrorCodes, type ErrorCode as EngineErrorCode } from '@moonshot-ai/agent-core-v2/errors';
import { ErrorCode } from '@moonshot-ai/protocol';
import { describe, expect, it } from 'vitest';

import { RPCError, toRPCError } from '../src/core/errors.js';

/**
 * REST already names these; the IPC/memory path used to answer 50001 for the
 * same engine error, so one product spoke two dialects to its two clients.
 */
const NAMED_BY_REST: [EngineErrorCode, number][] = [
  [ErrorCodes.SESSION_NOT_FOUND, ErrorCode.SESSION_NOT_FOUND],
  [ErrorCodes.AGENT_NOT_FOUND, ErrorCode.SESSION_NOT_FOUND],
  [ErrorCodes.SESSION_BUSY, ErrorCode.SESSION_BUSY],
  [ErrorCodes.STORAGE_LOCKED, ErrorCode.SESSION_LOCKED],
  [ErrorCodes.SESSION_INDEX_BUILDING, ErrorCode.SESSION_INDEX_BUILDING],
  [ErrorCodes.COMPACTION_UNABLE, ErrorCode.COMPACTION_UNABLE],
  [ErrorCodes.SKILL_NOT_FOUND, ErrorCode.SKILL_NOT_FOUND],
  [ErrorCodes.TERMINAL_NOT_FOUND, ErrorCode.TERMINAL_NOT_FOUND],
  [ErrorCodes.WORKSPACE_NOT_FOUND, ErrorCode.WORKSPACE_NOT_FOUND],
  [ErrorCodes.PROMPT_NOT_FOUND, ErrorCode.PROMPT_NOT_FOUND],
];

describe('toRPCError', () => {
  it.each(NAMED_BY_REST)('maps %s to the wire code REST sends', (engineCode, wireCode) => {
    const mapped = toRPCError(new Error2(engineCode, 'boom'));

    expect(mapped).toBeInstanceOf(RPCError);
    expect((mapped as RPCError).code).toBe(wireCode);
    expect((mapped as RPCError).reason).toBe(engineCode);
  });

  it('still falls back to INTERNAL_ERROR for an unmapped engine code', () => {
    const mapped = toRPCError(
      new Error2('totally.unmapped' as EngineErrorCode, 'boom'),
    );

    expect((mapped as RPCError).code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('passes non-Error2 values through untouched', () => {
    const raw = new Error('plain');

    expect(toRPCError(raw)).toBe(raw);
  });
});
