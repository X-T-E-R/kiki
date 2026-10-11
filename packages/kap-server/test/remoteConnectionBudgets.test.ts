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
  it('returns an operation-level 403 unchanged without replaying the write or pausing other calls', async () => {
    const f = await fixture(); let writes = 0;
    const rejected = { code: 40301, msg: 'operation_denied', data: null };
    f.target.post('/api/sessions', async (_request, reply) => { writes++; return reply.code(403).send(rejected); });
    f.target.get('/api/meta', async () => ({ code: 0, data: { readable: true } }));
    const { call, record } = await f.start();
    const response = await call('call', { operation: 'sessionCreate', body: { cwd: '/example' } });
    expect(response.status).toBe(403); expect(await response.json()).toEqual(rejected);
    expect(writes).toBe(1); expect(f.manager.get(record.id).state).toBe('online');
    const reading = await call('call', { operation: 'meta' });
    expect(reading.status).toBe(200); expect(await reading.json()).toEqual({ code: 0, data: { readable: true } });
    expect(writes).toBe(1);
  });
  it('forwards a legal history response over the former HTTP cap and cancels an unfinished read', async () => {
    const f = await fixture(); let producerClosed = false;
    const expected = { code: 0, msg: 'success', data: { items: [{ prompt: '界'.repeat(400000) }] } };
    f.target.get('/api/klient/session-view/:sessionId/snapshot', async (request, reply) => {
      if ((request.params as { sessionId: string }).sessionId !== 'slow') return expected;
      return reply.type('application/json').send(Readable.from((async function* () {
        try { yield '{"code":0,"msg":"success","data":"';
          for (let index = 0; index < 100; index += 1) { await new Promise<void>((resolve) => setTimeout(resolve, 10)); yield 'x'.repeat(4096); }
          yield '"}';
        } finally { producerClosed = true; }
      })()));
    });
    const { call } = await f.start();
    const response = await call('call', { operation: 'snapshot', params: { sessionId: 'fixture' } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(expected);
    const controller = new AbortController();
    const pending = call('call', { operation: 'snapshot', params: { sessionId: 'slow' } }, controller.signal);
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => f.manager.list()[0]?.activeLeases).toBe(1);
    controller.abort(); await failure;
    await expect.poll(() => f.manager.list()[0]?.activeLeases).toBe(0);
    await expect.poll(() => producerClosed).toBe(true);
  });
  it('rejects malformed compressed history while keeping explicit non-history decoded budgets', async () => {
    const f = await fixture();
    const compressed = gzipSync('not-json'.repeat(40000));
    for (const route of ['/api/klient/session-view/:sessionId/snapshot', '/api/sessions/:sessionId/transcript/details']) {
      f.target.get(route, async (_req, reply) => reply.header('content-encoding', 'gzip').type('application/json').send(compressed));
    }
    const { call } = await f.start();
    for (const operation of ['snapshot', 'transcriptDetails']) {
      const response = await call('call', { operation, params: { sessionId: 'fixture' } });
      expect(response.status).toBe(500); expect(await response.text()).toContain('Unexpected token');
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
  it('passes a 512 KiB derived preview through the broker unchanged', async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(512 * 1024, 42);
    f.target.get('/api/sessions/:sessionId/media/:fileId/preview', async (_request, reply) => reply.type('image/png').send(bytes));
    const { call } = await f.start();
    const response = await call('download', { operation: 'mediaPreview', params: { sessionId: 'fixture', fileId: 'image' } });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(f.manager.list()[0]?.activeLeases).toBe(0);
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
  it('drains legal oversized history resets to a paused reader and cancels the stream on disconnect', async () => {
    const f = await fixture(); const { sourceUrl, record } = await f.start();
    const client = new WebSocket(sourceUrl.replace('http:', 'ws:') + `/api/remote-connections/${record.id}/events`);
    cleanups.push(async () => { client.terminate(); }); await once(client, 'open');
    await expect.poll(() => f.events.clients.size).toBe(1);
    const remote = [...f.events.clients][0]!;
    const reset = JSON.stringify({ type: 'view_signal', id: 'history', data: { type: 'transcript', event: { type: 'transcript.reset', snapshot: { items: [{ kind: 'turn', prompt: '界'.repeat(400000) }] } } } });
    expect(Buffer.byteLength(reset)).toBeGreaterThan(1024 * 1024);
    client.pause();
    remote.send(reset);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(client.readyState).toBe(WebSocket.OPEN);
    const messages: string[] = [];
    client.on('message', (body) => {
      const bytes = Array.isArray(body) ? Buffer.concat(body) : Buffer.from(body as Uint8Array);
      messages.push(bytes.toString('utf8'));
    });
    client.resume();
    await expect.poll(() => messages.length, { timeout: 3000 }).toBe(1);
    expect(messages[0]).toBe(reset);
    remote.send(JSON.stringify({ type: 'pong', seq: 2 }));
    await expect.poll(() => messages.length, { timeout: 3000 }).toBe(2);
    expect(messages[1]).toContain('"seq":2');
    client.terminate();
    await expect.poll(() => f.manager.list()[0]?.activeLeases).toBe(0);
    await expect.poll(() => remote.readyState).toBe(WebSocket.CLOSED);
  });

  it('still rejects oversized client-to-server commands', async () => {
    const f = await fixture(); const { sourceUrl, record } = await f.start();
    const client = new WebSocket(sourceUrl.replace('http:', 'ws:') + `/api/remote-connections/${record.id}/events`);
    cleanups.push(async () => { client.terminate(); }); await once(client, 'open');
    await expect.poll(() => f.events.clients.size).toBe(1);
    const closed = once(client, 'close');
    client.send(JSON.stringify({ type: 'ping', data: 'x'.repeat(129 * 1024) }));
    expect((await closed)[0]).toBe(1009);
    await expect.poll(() => f.manager.list()[0]?.activeLeases).toBe(0);
  });
});
