import { RPCError } from '../../core/errors.js';

/** One server transcript window plus its JSON envelope. A canonical header may exceed the old 96KB cap and still has to open; anything past this cap is refused. */
export const SESSION_READ_BODY_BYTES = 1024 * 1024 + 64 * 1024;

/** Count decoded response bytes while reading, without trusting headers or parsing an oversized body. */
export async function readBoundedJsonBody(response: Response, maxBytes = SESSION_READ_BODY_BYTES, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (response.body === null) throw new SyntaxError('Empty response body');
  const reader = response.body.getReader();
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
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
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
