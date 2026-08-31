import { describe, expect, it } from 'vitest';

import {
  AcpClientErrorCode,
  deserializeExecutorSessionRefEnvelope,
  parseExecutorSessionRefEnvelope,
  serializeExecutorSessionRefEnvelope,
} from '../src';

describe('executor session ref envelope', () => {
  it('round-trips a bounded JSON ref', () => {
    const value = parseExecutorSessionRefEnvelope({
      executorId: 'grok-acp',
      version: 1,
      ref: { sessionId: 'session-1', lineage: ['a', 'b'] },
    });
    expect(deserializeExecutorSessionRefEnvelope(serializeExecutorSessionRefEnvelope(value)))
      .toEqual(value);
  });

  it('rejects secret-like fields and non-JSON values', () => {
    expect(() =>
      parseExecutorSessionRefEnvelope({
        executorId: 'x',
        version: 1,
        ref: { apiKey: 'not-allowed' },
      }),
    ).toThrow(expect.objectContaining({ code: AcpClientErrorCode.InvalidSessionRef }));
    expect(() =>
      parseExecutorSessionRefEnvelope({
        executorId: 'x',
        version: 1,
        ref: { value: Number.NaN },
      }),
    ).toThrow(expect.objectContaining({ code: AcpClientErrorCode.InvalidSessionRef }));
  });

  it('enforces the serialized byte limit', () => {
    expect(() =>
      parseExecutorSessionRefEnvelope(
        { executorId: 'x', version: 1, ref: { payload: 'x'.repeat(100) } },
        { maxBytes: 32 },
      ),
    ).toThrow(expect.objectContaining({ code: AcpClientErrorCode.InvalidSessionRef }));
  });
});
