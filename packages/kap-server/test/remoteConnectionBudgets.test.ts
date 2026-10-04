import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { ConnectionAdmission } from '../src/services/connections/admission';
import { RemoteConnectionManager } from '../src/services/connections/manager';
import { registerRemoteConnectionRoutes } from '../src/routes/remoteConnections';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });
const identity = () => ({ homeId: randomUUID(), hostId: randomUUID(), protocol: 1 as const });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'kiki-broker-budget-'));
  cleanups.push(() => rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const targetIdentity = identity(); const sourceIdentity = identity(); const grantId = randomUUID();
  const target = Fastify({ forceCloseConnections: true }); const source = Fastify({ forceCloseConnections: true });
  const owner = randomUUID(); const grant = randomUUID();
  target.get('/api/remote-connections/handshake', async () => ({ code: 0, data: { identity: targetIdentity, serverId: randomUUID(), inboundEnabled: true } }));
  target.post('/api/remote-connections/claim', async () => ({ code: 0, data: { grantId, revision: 1, grant, target: targetIdentity } }));
  const manager = new RemoteConnectionManager(home, sourceIdentity); await manager.ready();
  const admission = new ConnectionAdmission(home, sourceIdentity); await admission.ready();
  const broker = registerRemoteConnectionRoutes(source, admission, manager, randomUUID(), () => owner);
  source.server.on('upgrade', (request, socket, head) => broker.handleUpgrade(request, socket, head, (ws) => broker.emit('connection', ws, request)));
  const events = new WebSocketServer({ noServer: true });
  target.server.on('upgrade', (request, socket, head) => events.handleUpgrade(request, socket, head, (ws) => events.emit('connection', ws, request)));
  target.addHook('preClose', () => { for (const socket of events.clients) socket.terminate(); events.close(); });
  const start = async () => {
    const targetUrl = await target.listen({ port: 0, host: '127.0.0.1' });
    const sourceUrl = await source.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => target.close(), () => source.close());
    const record = await manager.add({ label: 'Adversarial fixture', endpoint: targetUrl, target: targetIdentity, ownerToken: owner, invitation: randomUUID(), backgroundSummary: false });
    const call = (suffix: string, body: unknown, signal?: AbortSignal) => fetch(`${sourceUrl}/api/remote-connections/${record.id}/${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    return { sourceUrl, record, call };
  };
  return { target, source, events, broker, manager, start };
}
describe('broker budgets against explicit adversarial transport fixtures', () => {
  it('counts decompressed HTTP bytes before JSON parsing and cancels an oversized decoded reader', async () => {
    const f = await fixture();
    const compressed = gzipSync('not-json'.repeat(40000));
    for (const route of ['/api/klient/session-view/:sessionId/snapshot', '/api/sessions/:sessionId/transcript/details']) {
      f.target.get(route, async (_req, reply) => reply.header('content-encoding', 'gzip').type('application/json').send(compressed));
    }
    const { call } = await f.start();
    for (const operation of ['snapshot', 'transcriptDetails']) {
      const response = await call('call', { operation, params: { sessionId: 'fixture' } });
      expect(response.status).toBe(500); expect(await response.text()).toContain('98304 decoded bytes');
    }
    let pulls = 0; let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(16384)); }, cancel(reason) { cancelled = reason; } });
    await expect(readBoundedJsonBody(new Response(stream), 98304)).rejects.toThrow('98304 decoded bytes');
    expect(pulls).toBeLessThanOrEqual(8); expect(cancelled).toBe('decoded response budget exceeded');
    expect(f.manager.list()[0]?.activeLeases).toBe(0);
  });
  it('does not send owner or grant credentials across an HTTP redirect', async () => {
    const collector = Fastify(); let hits = 0;
    collector.get('/leak', async () => { hits++; return { code: 0 }; });
    const collectorUrl = await collector.listen({ port: 0, host: '127.0.0.1' }); cleanups.push(() => collector.close());
    const f = await fixture(); f.target.get('/api/meta', async (_req, reply) => reply.redirect(collectorUrl + '/leak'));
    const { call } = await f.start(); const response = await call('call', { operation: 'meta' });
    expect(response.status).toBe(500); expect(hits).toBe(0); expect(f.manager.list()[0]?.activeLeases).toBe(0);
  });
  it('forwards only typed Range/ETag headers and cancels a paced original stream without downloading its tail', async () => {
    const f = await fixture(); let produced = 0; let producerClosed = false;
    f.target.get('/api/files/:fileId', async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      reply.header('etag', 'fixture-v1').header('accept-ranges', 'bytes');
      if (request.headers['if-none-match'] === 'fixture-v1') return reply.code(304).send();
      if (request.headers.range === 'bytes=0-15') return reply.code(206).header('content-range', 'bytes 0-15/1600000').send(Buffer.alloc(16, 42));
      if (fileId !== 'slow') return reply.send(Buffer.alloc(16));
      const stream = Readable.from((async function* () { try { for (let index = 0; index < 100; index++) { await new Promise<void>((resolve) => setTimeout(resolve, 10)); produced++; yield Buffer.alloc(16384, index); } } finally { producerClosed = true; } })());
      return reply.type('application/octet-stream').send(stream);
    });
    const { call } = await f.start();
    const range = await call('download', { operation: 'file', params: { fileId: 'slow' }, headers: { range: 'bytes=0-15' } });
    expect(range.status).toBe(206); expect(range.headers.get('content-range')).toBe('bytes 0-15/1600000'); expect(range.headers.get('etag')).toBe('fixture-v1'); expect((await range.arrayBuffer()).byteLength).toBe(16);
    const cached = await call('download', { operation: 'file', params: { fileId: 'slow' }, headers: { ifNoneMatch: 'fixture-v1' } });
    expect(cached.status).toBe(304); expect(cached.headers.get('etag')).toBe('fixture-v1');
    const invalid = await call('download', { operation: 'file', params: { fileId: 'slow' }, headers: { authorization: 'arbitrary' } });
    expect(invalid.status).toBe(500); await invalid.body?.cancel(); expect(produced).toBe(0);
    const response = await call('download', { operation: 'file', params: { fileId: 'slow' } });
    const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false); await reader.cancel(); reader.releaseLock();
    await expect.poll(() => f.manager.list()[0]?.activeLeases, { timeout: 3000 }).toBe(0);
    await expect.poll(() => producerClosed, { timeout: 3000 }).toBe(true); expect(produced).toBeLessThan(100);
  });
  it('forwards the source preview route and MIME hint without accepting arbitrary query fields', async () => {
    const f = await fixture(); let hits = 0;
    f.target.get('/api/sessions/:sessionId/media/:fileId/preview', async (request, reply) => {
      hits++; expect(request.query).toEqual({ media_type: 'image/png' });
      expect(request.headers.range).toBe('bytes=0-15');
      return reply.code(206).type('image/jpeg').header('etag', 'preview-v1-fixture').header('content-range', 'bytes 0-15/1024').send(Buffer.alloc(16, 42));
    });
    const { call } = await f.start();
    const input = { operation: 'mediaPreview', params: { sessionId: 'fixture', fileId: 'image' }, query: { media_type: 'image/png' }, headers: { range: 'bytes=0-15' } };
    const preview = await call('download', input);
    expect(preview.status).toBe(206); expect(preview.headers.get('content-type')).toContain('image/jpeg');
    expect(preview.headers.get('etag')).toBe('preview-v1-fixture'); expect(preview.headers.get('content-range')).toBe('bytes 0-15/1024');
    expect((await preview.arrayBuffer()).byteLength).toBe(16);
    const invalid = await call('download', { ...input, query: { ...input.query, url: 'https://example.test/' } });
    expect(invalid.status).toBe(400); expect(await invalid.text()).toContain('invalid_preview_query'); expect(hits).toBe(1);
    expect(f.manager.list()[0]?.activeLeases).toBe(0);
  });
  it('stops a native paused consumer at the broker buffer budget with an explicit recovery reason', async () => {
    const f = await fixture(); const { sourceUrl, record } = await f.start();
    const client = new WebSocket(sourceUrl.replace('http:', 'ws:') + `/api/remote-connections/${record.id}/events`);
    cleanups.push(async () => { client.terminate(); }); await once(client, 'open'); client.pause();
    await expect.poll(() => f.events.clients.size).toBe(1);
    const remote = [...f.events.clients][0]!; const local = [...f.broker.clients][0]!;
    const chunk = JSON.stringify({ type: 'pong', data: 'x'.repeat(24576) }); let sent = 0;
    const flood = () => { if (remote.readyState !== WebSocket.OPEN || sent >= 4096) return; for (let index = 0; index < 8 && remote.readyState === WebSocket.OPEN; index++) { remote.send(chunk); sent++; } setImmediate(flood); };
    flood();
    await expect.poll(() => local.readyState, { timeout: 10000 }).toBe(WebSocket.CLOSING);
    const closed = once(client, 'close'); client.resume(); const [code, reason] = await closed;
    expect(code).toBe(4008); expect(String(reason)).toContain('slow consumer; reload current window');
    await expect.poll(() => f.manager.list()[0]?.activeLeases).toBe(0); expect(sent).toBeLessThan(4096);
  });
});
