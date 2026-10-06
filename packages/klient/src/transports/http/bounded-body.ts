import { RPCError } from '../../core/errors.js';

/** History pages are bounded by the server; a required entity header may exceed its soft page budget. */
export const SESSION_READ_BODY_BYTES = Number.POSITIVE_INFINITY;

/** Count decoded response bytes while reading, without trusting headers or parsing an oversized body. */
export async function readBoundedJsonBody(response: Response, maxBytes = SESSION_READ_BODY_BYTES): Promise<unknown> {
  if (response.body === null) throw new SyntaxError('Empty response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('decoded response budget exceeded');
        throw new RPCError(50001, `Session response exceeded ${maxBytes} decoded bytes`);
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } finally {
    reader.releaseLock();
  }
}
