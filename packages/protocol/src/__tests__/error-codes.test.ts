import { describe, expect, it } from 'vitest';

import { ErrorCode, ErrorCodeReason } from '../error-codes';

/**
 * Numbers documented in the source header as intentionally unallocated. A code
 * that appears here AND in the table is a silent reuse of a reserved slot.
 */
const RESERVED = [40102, 40103, 50002];

describe('ErrorCode table', () => {
  it('gives every code a reason string', () => {
    const missing = Object.entries(ErrorCode)
      .filter(([, code]) => ErrorCodeReason[code as ErrorCode] === undefined)
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  it('assigns each number to exactly one name', () => {
    const byNumber = new Map<number, string[]>();
    for (const [name, code] of Object.entries(ErrorCode)) {
      byNumber.set(code, [...(byNumber.get(code) ?? []), name]);
    }

    expect([...byNumber.values()].filter((names) => names.length > 1)).toEqual([]);
  });

  it('leaves the reserved numbers unallocated', () => {
    const allocated = new Set(Object.values(ErrorCode));

    expect(RESERVED.filter((code) => allocated.has(code as ErrorCode))).toEqual([]);
  });

  it('names codes the daemon actually sends', () => {
    // Each of these reached clients as a bare number before it had a name.
    expect(ErrorCode.RATE_LIMITED).toBe(42901);
    expect(ErrorCode.DISPATCH_LIMIT_EXCEEDED).toBe(42904);
    expect(ErrorCodeReason[ErrorCode.DISPATCH_LIMIT_EXCEEDED]).toBe('dispatch.limit_exceeded');
    expect(ErrorCode.SESSION_LOCKED).toBe(40933);
    expect(ErrorCode.AGENT_PROFILE_READ_ONLY).toBe(40934);
    expect(ErrorCode.MCP_SERVER_READ_ONLY).toBe(40935);
    expect(ErrorCode.MCP_OAUTH_FAILED).toBe(40940);
    expect(ErrorCode.CATALOG_UNAVAILABLE).toBe(50004);
    expect(ErrorCodeReason[ErrorCode.RATE_LIMITED]).toBe('rate.limited');
    expect(ErrorCodeReason[ErrorCode.SESSION_LOCKED]).toBe('session.locked');
  });
});
