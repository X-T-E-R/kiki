import { describe, expect, it } from 'vitest';
import { RPCError } from '../src/core/errors.js';
import { readBoundedJsonBody, SESSION_READ_BODY_BYTES } from '../src/transports/http/bounded-body.js';

function jsonBody(pad: number): Response {
  return new Response(JSON.stringify({ code: 0, contentRefs: [{ path: ['text'], offset: 0 }], pad: 'x'.repeat(pad) }));
}

describe('session read budget', () => {
  it('allows server-segmented session responses above 1114112 bytes while enforcing explicit caps and cancellation', async () => {
    expect(SESSION_READ_BODY_BYTES).toBe(Number.POSITIVE_INFINITY);
    const opened = await readBoundedJsonBody(jsonBody(1150 * 1024));
    expect(opened).toMatchObject({ code: 0, contentRefs: [{ path: ['text'], offset: 0 }] });
    await expect(readBoundedJsonBody(jsonBody(128 * 1024), 64 * 1024)).rejects.toBeInstanceOf(RPCError);
    let cancelled: unknown;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(new TextEncoder().encode('{"code":0,"pad":"' + 'x'.repeat(16384)));
        controller.abort(new DOMException('The operation was aborted.', 'AbortError'));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    await expect(readBoundedJsonBody(new Response(stream), SESSION_READ_BODY_BYTES, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBeDefined();
  });
});
