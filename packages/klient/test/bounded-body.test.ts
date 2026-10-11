import { describe, expect, it } from 'vitest';
import { RPCError } from '../src/core/errors.js';
import { readBoundedJsonBody, SESSION_READ_BODY_BYTES } from '../src/transports/http/bounded-body.js';

function jsonBody(pad: number): Response {
  return new Response(JSON.stringify({ code: 0, contentRefs: [{ path: ['text'], offset: 0 }], pad: 'x'.repeat(pad) }));
}

describe('session read budget', () => {
  it('opens a canonical header above the retired 96KB cap and refuses a body past the transcript window', async () => {
    expect(Number.isFinite(SESSION_READ_BODY_BYTES)).toBe(true);
    expect(SESSION_READ_BODY_BYTES).toBeGreaterThan(96 * 1024);
    const opened = await readBoundedJsonBody(jsonBody(100 * 1024));
    expect(opened).toMatchObject({ code: 0, contentRefs: [{ path: ['text'], offset: 0 }] });
    await expect(readBoundedJsonBody(jsonBody(SESSION_READ_BODY_BYTES))).rejects.toBeInstanceOf(RPCError);
  });
});
