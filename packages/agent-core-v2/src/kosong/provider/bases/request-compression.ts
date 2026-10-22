import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import type { RequestCompression } from '#/kosong/contract/requestCompression';
import { ambiguousRequestDelivery } from '#/kosong/contract/errors';
import { RequestDictionaryTransport } from './request-dictionary';

export function createRequestCompressionFetch(config: RequestCompression | undefined): (fetchImpl: typeof fetch) => typeof fetch {
  if (config === undefined || config.encoding === 'off') return (fetchImpl) => fetchImpl;
  const targets = config.targets.map((value) => new URL(value));
  const zstd = config.encoding === 'zstd' ? new RequestDictionaryTransport({ dictionary: config.dictionary }) : undefined;
  return (fetchImpl) => async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = init?.body;
    if (method.toUpperCase() !== 'POST' || headers.has('content-encoding') ||
      headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      !targets.some((target) => url.origin === target.origin &&
        (url.pathname === target.pathname || url.pathname.startsWith(`${target.pathname.replace(/\/$/, '')}/`)))) {
      return fetchImpl(input, init);
    }
    const bytes = typeof body === 'string' ? Buffer.from(body) :
      body instanceof ArrayBuffer ? Buffer.from(body) :
      ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : undefined;
    if (bytes === undefined || bytes.length === 0 || bytes.length < (config.minBytes ?? 1024)) return fetchImpl(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const send: typeof fetch = async (requestInput, requestInit) => {
      try {
        return await fetchImpl(requestInput, requestInit);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw ambiguousRequestDelivery(error);
      }
    };
    if (zstd !== undefined) return zstd.fetch(send, input, init, bytes);
    const chunks: Buffer[] = [];
    await pipeline(Readable.from([bytes]), createGzip(), new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }), { signal: signal ?? undefined });
    signal?.throwIfAborted();
    const compressed = Buffer.concat(chunks);
    if (compressed.length >= bytes.length) return fetchImpl(input, init);
    headers.set('content-encoding', 'gzip');
    headers.set('content-length', String(compressed.length));
    return send(input, { ...init, headers, body: compressed });
  };
}
