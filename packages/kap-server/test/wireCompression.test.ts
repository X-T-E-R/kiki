import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { installErrorHandler } from '../src/error-handler';
import {
  createWireCompressionHook,
  isCompressibleContentType,
  isLoopbackRemoteAddress,
  negotiateWireEncoding,
  resolveWsPerMessageDeflate,
} from '../src/middleware/wireCompression';

function makeJsonPayload(targetBytes: number): { items: Array<{ id: number; title: string; summary: string; tags: string[] }> } {
  const items: Array<{ id: number; title: string; summary: string; tags: string[] }> = [];
  let size = 16;
  let index = 0;
  while (size < targetBytes) {
    const item = {
      id: index,
      title: `Session workspace snapshot item ${index}`,
      summary: 'Repeated structured transcript metadata payload for wire compression verification across remote transports.',
      tags: ['transport', 'multispace', 'compression', 'session'],
    };
    items.push(item);
    size += JSON.stringify(item).length + 1;
    index += 1;
  }
  return { items };
}

describe('wireCompression', () => {
  it('detects loopback vs non-loopback remote addresses and compressible MIME types', () => {
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('127.0.0.2')).toBe(true);
    expect(isLoopbackRemoteAddress('::1')).toBe(true);
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress(undefined)).toBe(true);
    expect(isLoopbackRemoteAddress('100.64.0.12')).toBe(false);
    expect(isLoopbackRemoteAddress('192.168.1.25')).toBe(false);
    expect(isLoopbackRemoteAddress('203.0.113.5')).toBe(false);

    expect(isCompressibleContentType('application/json; charset=utf-8')).toBe(true);
    expect(isCompressibleContentType('application/problem+json')).toBe(true);
    expect(isCompressibleContentType('text/plain; charset=utf-8')).toBe(true);
    expect(isCompressibleContentType('image/svg+xml')).toBe(true);
    expect(isCompressibleContentType('application/x-ndjson; charset=utf-8')).toBe(false);
    expect(isCompressibleContentType('text/event-stream')).toBe(false);
    expect(isCompressibleContentType('image/png')).toBe(false);
    expect(isCompressibleContentType('application/octet-stream')).toBe(false);
  });

  it('negotiates Accept-Encoding respecting preference order and q=0 exclusions', () => {
    expect(negotiateWireEncoding('gzip, deflate, br, zstd')).toBe('zstd');
    expect(negotiateWireEncoding('gzip, deflate, br')).toBe('br');
    expect(negotiateWireEncoding('gzip, deflate')).toBe('gzip');
    expect(negotiateWireEncoding('zstd;q=0, br, gzip')).toBe('br');
    expect(negotiateWireEncoding('zstd;q=0, br;q=0, gzip')).toBe('gzip');
    expect(negotiateWireEncoding('zstd;q=0, br;q=0, gzip;q=0')).toBeUndefined();
    expect(negotiateWireEncoding('gzip;q=1.0, zstd;q=0.5')).toBe('gzip');
    expect(negotiateWireEncoding('identity')).toBeUndefined();
    expect(negotiateWireEncoding(undefined)).toBeUndefined();
  });

  it('compresses non-loopback 100 KiB JSON by >80% with zstd, br, and gzip while bypassing loopback', async () => {
    const payload = makeJsonPayload(100 * 1024);
    const rawJson = JSON.stringify(payload);
    const rawBytes = Buffer.byteLength(rawJson, 'utf8');
    expect(rawBytes).toBeGreaterThanOrEqual(100 * 1024);

    const app = Fastify();
    installErrorHandler(app);
    app.addHook('onSend', async (_req, reply, body) => {
      reply.header('vary', 'Origin');
      return body;
    });
    app.addHook('onSend', createWireCompressionHook({ mode: 'non-loopback', thresholdBytes: 2048 }));
    app.get('/large', async () => payload);
    app.get('/small', async () => ({ ok: true }));
    app.get('/binary', async (_req, reply) => {
      reply.type('image/png');
      return Buffer.alloc(16 * 1024, 0x42);
    });
    app.get('/ndjson', async (_req, reply) => {
      reply.type('application/x-ndjson; charset=utf-8');
      return `${rawJson}\n`;
    });
    app.get('/no-transform', async (_req, reply) => {
      reply.header('cache-control', 'private, no-transform');
      return payload;
    });
    app.get('/error-400', async (_req, reply) => {
      reply.code(400);
      return payload;
    });

    try {
      const loopback = await app.inject({
        method: 'GET',
        url: '/large',
        remoteAddress: '127.0.0.1',
        headers: { 'accept-encoding': 'zstd, br, gzip' },
      });
      expect(loopback.statusCode).toBe(200);
      expect(loopback.headers['content-encoding']).toBeUndefined();
      expect(loopback.rawPayload.byteLength).toBe(rawBytes);

      const zstdRes = await app.inject({
        method: 'GET',
        url: '/large',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'gzip, br, zstd' },
      });
      expect(zstdRes.statusCode).toBe(200);
      expect(zstdRes.headers['content-encoding']).toBe('zstd');
      expect(String(zstdRes.headers['vary'])).toContain('Origin');
      expect(String(zstdRes.headers['vary'])).toContain('Accept-Encoding');
      expect(Number(zstdRes.headers['content-length'])).toBe(zstdRes.rawPayload.byteLength);
      const zstdRatio = 1 - zstdRes.rawPayload.byteLength / rawBytes;
      expect(zstdRatio).toBeGreaterThan(0.8);
      expect(zstdDecompressSync(zstdRes.rawPayload).toString('utf8')).toBe(rawJson);

      const brRes = await app.inject({
        method: 'GET',
        url: '/large',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'zstd;q=0, br, gzip' },
      });
      expect(brRes.headers['content-encoding']).toBe('br');
      const brRatio = 1 - brRes.rawPayload.byteLength / rawBytes;
      expect(brRatio).toBeGreaterThan(0.8);
      expect(brotliDecompressSync(brRes.rawPayload).toString('utf8')).toBe(rawJson);

      const gzipRes = await app.inject({
        method: 'GET',
        url: '/large',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'zstd;q=0, br;q=0, gzip' },
      });
      expect(gzipRes.headers['content-encoding']).toBe('gzip');
      const gzipRatio = 1 - gzipRes.rawPayload.byteLength / rawBytes;
      expect(gzipRatio).toBeGreaterThan(0.8);
      expect(gunzipSync(gzipRes.rawPayload).toString('utf8')).toBe(rawJson);

      const smallRes = await app.inject({
        method: 'GET',
        url: '/small',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'zstd, br, gzip' },
      });
      expect(smallRes.headers['content-encoding']).toBeUndefined();

      const binaryRes = await app.inject({
        method: 'GET',
        url: '/binary',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'zstd, br, gzip' },
      });
      expect(binaryRes.headers['content-encoding']).toBeUndefined();
      expect(binaryRes.rawPayload.byteLength).toBe(16 * 1024);

      const ndjsonRes = await app.inject({
        method: 'GET',
        url: '/ndjson',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'zstd, br, gzip' },
      });
      expect(ndjsonRes.headers['content-encoding']).toBeUndefined();

      const noTransformRes = await app.inject({
        method: 'GET',
        url: '/no-transform',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'zstd, br, gzip' },
      });
      expect(noTransformRes.headers['content-encoding']).toBeUndefined();

      const errRes = await app.inject({
        method: 'GET',
        url: '/error-400',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'zstd, br, gzip' },
      });
      expect(errRes.statusCode).toBe(400);
      expect(errRes.headers['content-encoding']).toBeUndefined();

      process.stdout.write(
        `[wireCompression] raw=${rawBytes}B zstd=${zstdRes.rawPayload.byteLength}B (${(zstdRatio * 100).toFixed(1)}% saved) ` +
        `br=${brRes.rawPayload.byteLength}B (${(brRatio * 100).toFixed(1)}% saved) ` +
        `gzip=${gzipRes.rawPayload.byteLength}B (${(gzipRatio * 100).toFixed(1)}% saved)\n`,
      );
    } finally {
      await app.close();
    }
  });

  it('honors KIKI_HTTP_COMPRESSION=always on real loopback TCP sockets and KIKI_HTTP_COMPRESSION=off everywhere', async () => {
    const payload = makeJsonPayload(24 * 1024);
    const appAlways = Fastify();
    appAlways.addHook('onSend', createWireCompressionHook({ env: { KIKI_HTTP_COMPRESSION: 'always' } }));
    appAlways.get('/data', async () => payload);
    const appOff = Fastify();
    appOff.addHook('onSend', createWireCompressionHook({ env: { KIKI_HTTP_COMPRESSION: 'off' } }));
    appOff.get('/data', async () => payload);
    try {
      await appAlways.listen({ host: '127.0.0.1', port: 0 });
      const { port } = appAlways.server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/data`, {
        headers: { 'accept-encoding': 'zstd, br, gzip' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBe('zstd');
      expect(await res.json()).toEqual(payload);

      const offRes = await appOff.inject({
        method: 'GET',
        url: '/data',
        remoteAddress: '100.64.1.10',
        headers: { 'accept-encoding': 'zstd, br, gzip' },
      });
      expect(offRes.headers['content-encoding']).toBeUndefined();
    } finally {
      await appAlways.close();
      await appOff.close();
    }
  });

  it('configures zero-idle-memory WS perMessageDeflate with NoContextTakeover and env toggle', () => {
    expect(resolveWsPerMessageDeflate({ env: {} })).toEqual({
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 8,
      threshold: 2048,
      zlibDeflateOptions: { level: 3 },
    });
    expect(resolveWsPerMessageDeflate({ env: { KIKI_WS_COMPRESSION: 'off' } })).toBe(false);
    expect(resolveWsPerMessageDeflate({
      env: {
        KIKI_WS_COMPRESSION: 'on',
        KIKI_WS_COMPRESS_THRESHOLD_BYTES: '4096',
        KIKI_WS_COMPRESS_LEVEL: '2',
        KIKI_WS_COMPRESS_CONCURRENCY: '4',
      },
    })).toEqual({
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 4,
      threshold: 4096,
      zlibDeflateOptions: { level: 2 },
    });
  });
});
