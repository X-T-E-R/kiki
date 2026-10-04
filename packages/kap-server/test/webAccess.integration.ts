import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createKlient, type HttpChannelOptions } from '@kiki/klient/http';
import { applyContentSegment } from '@kiki/transcript';
import { IAgentLoopService, IAgentContextMemoryService, IWireService, ensureMainAgent, getLiveSessionById } from '@kiki/agent-core-v2';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { buildContentDisposition } from '../src/lib/contentDisposition';
import type { WebAccessStatus } from '@kiki/protocol';

describe('shared daemon Web access', () => {
  let home: string;
  let server: RunningServer;
  let base: string;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-web-access-'));
    await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, port: 0, logLevel: 'silent', debugEndpoints: true });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  async function owner(path: string, method = 'GET', body?: unknown) {
    const headers: Record<string, string> = { authorization: `Bearer ${server.localOwnerToken}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    const response = await fetch(base + path, init);
    const result = await response.json() as { code: number; data: any; msg: string };
    expect(response.status, result.msg).toBe(200); expect(result.code, result.msg).toBe(0); return result.data;
  }
  async function enter(mode: 'temporary' | 'persistent' = 'temporary', extra = true) {
    const status = await owner('/api/web-access', 'PUT', { mode, port: extra ? 0 : undefined }) as WebAccessStatus;
    const link = await owner('/api/web-access/links', 'POST', {});
    const url = new URL(link.url); const code = url.hash.slice('#access='.length);
    const response = await fetch(url.origin + '/api/web-access/exchange', { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(response.status).toBe(200); const result = await response.json() as { data: { session: { id: string } } };
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict'); expect(setCookie).not.toContain('Domain=');
    return { status, origin: url.origin, code, cookie: setCookie.split(';')[0]!, sessionId: result.data.session.id };
  }
  async function socket(origin: string, cookie?: string, local = false): Promise<WebSocket> {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/klient/events', local ? [`kimi-code.bearer.${server.localOwnerToken}`] : [], { headers: local ? {} : { cookie: cookie!, origin } });
    sockets.push(ws); await once(ws, 'open'); return ws;
  }
  it('exchanges one-time codes, rejects replay, exact-origin violations and explicit invalid bearer', async () => {
    const browser = await enter();
    const replay = await fetch(browser.origin + '/api/web-access/exchange', { method: 'POST', headers: { origin: browser.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: browser.code }) });
    expect(replay.status).toBe(401); expect(replay.headers.get('cache-control')).toBe('no-store');
    const link = await owner('/api/web-access/links', 'POST', {});
    const code = new URL(link.url).hash.slice(8);
    for (const origin of [undefined, 'null', 'not-an-origin', browser.origin.replace('http:', 'https:'), browser.origin + '0']) {
      const headers: Record<string, string> = { 'content-type': 'application/json', forwarded: 'host=example.test;proto=https' }; if (origin !== undefined) headers['origin'] = origin;
      const response = await fetch(browser.origin + '/api/web-access/exchange', { method: 'POST', headers, body: JSON.stringify({ code }) });
      expect(response.status, String(origin)).toBe(403);
      const write = await fetch(browser.origin + '/api/sessions', { method: 'POST', headers: { ...headers, cookie: browser.cookie }, body: JSON.stringify({ metadata: { cwd: home } }) });
      expect(write.status, String(origin)).toBe(403);
    }
    const correct = await fetch(browser.origin + '/api/web-access/exchange', { method: 'POST', headers: { origin: browser.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(correct.status).toBe(200);
    for (const authorization of ['Bearer invalid', 'Bearer ', 'Basic invalid']) {
      const rejected = await fetch(browser.origin + '/api/meta', { headers: { cookie: browser.cookie, authorization } }); expect(rejected.status).toBe(401);
    }
    expect((await fetch(browser.origin + '/api/meta', { headers: { cookie: browser.cookie } })).status).toBe(200);
    expect((await fetch(browser.origin + '/api/web-access', { headers: { cookie: browser.cookie } })).status).toBe(403);
    expect((await fetch(browser.origin + '/api/debug/channels', { headers: { cookie: browser.cookie } })).status).toBe(403);
    const bare = await fetch(base + '/api/web-access', { headers: { authorization: `Bearer ${server.authTokenService.getToken()}` } }); expect(bare.status).toBeGreaterThanOrEqual(400);
  });
  it('preserves native bearer and approved-peer admission on the extra carrier without granting Web control', async () => {
    const browser = await enter(); const token = server.authTokenService.getToken();
    const handshake = await fetch(browser.origin + '/api/remote-connections/handshake', { headers: { authorization: `Bearer ${token}` } }); expect(handshake.status).toBe(200);
    await server.admission.setEnabled(true);
    const source = { homeId: randomUUID(), hostId: 'test-peer-host', protocol: 1 as const };
    const invitation = await server.admission.invite(source, 'Native peer'); const claim = await server.admission.claim(invitation.invitation, source);
    const headers = { authorization: `Bearer ${token}`, 'x-kiki-connection-grant': claim.grant };
    expect((await fetch(browser.origin + '/api/sessions', { headers })).status).toBe(200);
    expect((await fetch(browser.origin + '/api/web-access', { headers })).status).toBe(403);
    const ws = new WebSocket(browser.origin.replace('http:', 'ws:') + '/api/klient/events', { headers }); sockets.push(ws); await once(ws, 'open');
    const closed = once(ws, 'close'); await server.admission.revoke(claim.grantId); await closed;
    expect((await fetch(base + '/api/meta', { headers: { authorization: `Bearer ${server.localOwnerToken}` } })).status).toBe(200);
  });
  it('keeps local client, sessions and the shared core alive while logout, revoke and off close browser sockets and downloads', async () => {
    const local = await socket(base, undefined, true);
    const browser = await enter();
    const ws = await socket(browser.origin, browser.cookie);
    const created = await fetch(browser.origin + '/api/sessions', { method: 'POST', headers: { cookie: browser.cookie, origin: browser.origin, 'content-type': 'application/json' }, body: JSON.stringify({ metadata: { cwd: home }, title: 'shared web session' }) });
    const session = (await created.json() as { data: { id: string } }).data;
    const localSessions = await owner('/api/sessions'); expect(JSON.stringify(localSessions)).toContain(session.id);
    const ended = once(ws, 'close');
    const logout = await fetch(browser.origin + '/api/web-access/logout', { method: 'POST', headers: { cookie: browser.cookie, origin: browser.origin, 'content-type': 'application/json' }, body: '{}' });
    expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0'); await ended;
    expect(local.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(browser.origin + '/api/meta', { headers: { cookie: browser.cookie } })).status).toBe(401);
    const second = await enter(); const secondWs = await socket(second.origin, second.cookie);
    const revoked = once(secondWs, 'close'); await owner('/api/web-access/revoke', 'POST', { sessionId: second.sessionId }); await revoked;
    const third = await enter(); const thirdWs = await socket(third.origin, third.cookie);
    await writeFile(join(home, 'large.bin'), Buffer.alloc(16 * 1024 * 1024, 7));
    const path = `/api/sessions/${session.id}/fs/large.bin:download`;
    const range = await fetch(third.origin + path, { headers: { cookie: third.cookie, range: 'bytes=0-31' } });
    expect(range.status).toBe(206); expect(range.headers.get('cache-control')).toBe('no-store'); expect((await range.arrayBuffer()).byteLength).toBe(32);
    const etag = range.headers.get('etag')!;
    const unchanged = await fetch(third.origin + path, { headers: { cookie: third.cookie, 'if-none-match': etag } }); expect(unchanged.status).toBe(304); expect(unchanged.headers.get('cache-control')).toBe('no-store');
    const controller = new AbortController(); const download = await fetch(third.origin + path, { headers: { cookie: third.cookie }, signal: controller.signal });
    const reader = download.body!.getReader(); expect((await reader.read()).done).toBe(false);
    const closed = once(thirdWs, 'close'); await owner('/api/web-access', 'DELETE'); await closed;
    let failure: unknown;
    try { for (;;) { const next = await reader.read(); if (next.done) break; } } catch (error) { failure = error; }
    finally { controller.abort(); reader.releaseLock(); }
    expect(failure).toBeDefined(); expect(local.readyState).toBe(WebSocket.OPEN);
    expect((await owner('/api/web-access')).enabled).toBe(false);
    expect(JSON.stringify(await owner('/api/sessions'))).toContain(session.id);
    await expect(fetch(third.origin + '/api/meta')).rejects.toThrow();
  });
  it('restores persistent sessions and rejects temporary ones across restart without storing secrets', async () => {
    const temporary = await enter('temporary', false);
    await server.close(); server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, port: 0, logLevel: 'silent' }); base = `http://127.0.0.1:${server.port}`;
    expect((await owner('/api/web-access')).enabled).toBe(false);
    expect((await fetch(base + '/api/meta', { headers: { cookie: temporary.cookie } })).status).toBe(401);
    const persistent = await enter('persistent');
    const text = await readFile(join(home, 'server', 'web-access.json'), 'utf8');
    expect(text).not.toContain(persistent.code); expect(text).not.toContain(persistent.cookie.split('=')[1]!); expect(text).toContain('digest');
    await server.close(); server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, port: 0, logLevel: 'silent' }); base = `http://127.0.0.1:${server.port}`;
    expect((await owner('/api/web-access')).url).toBe(persistent.origin);
    expect((await fetch(persistent.origin + '/api/meta', { headers: { cookie: persistent.cookie } })).status).toBe(200);
    await owner('/api/web-access', 'DELETE'); await owner('/api/web-access', 'PUT', { mode: 'persistent', port: 0 });
    const status = await owner('/api/web-access'); expect(status.sessions).toEqual([]);
    expect((await fetch(status.url + '/api/meta', { headers: { cookie: persistent.cookie } })).status).toBe(401);
  });
  it('rejects wrong/missing WS origins and does not fall back from an explicit bad Authorization', async () => {
    const browser = await enter();
    for (const origin of [undefined, 'null', browser.origin.replace('http:', 'https:'), browser.origin + '0']) {
      const headers: Record<string, string> = { cookie: browser.cookie }; if (origin !== undefined) headers['origin'] = origin;
      const ws = new WebSocket(browser.origin.replace('http:', 'ws:') + '/api/klient/events', { headers }); sockets.push(ws);
      await expect(new Promise<void>((resolve, reject) => { ws.once('open', () => reject(new Error('unexpected open'))); ws.once('error', () => resolve()); })).resolves.toBeUndefined();
    }
    const ws = new WebSocket(browser.origin.replace('http:', 'ws:') + '/api/klient/events', { headers: { cookie: browser.cookie, origin: browser.origin, authorization: 'Bearer invalid' } }); sockets.push(ws);
    await expect(new Promise<void>((resolve, reject) => { ws.once('open', () => reject(new Error('unexpected open'))); ws.once('error', () => resolve()); })).resolves.toBeUndefined();
  });
  it('executes a browser prompt on the same daemon while Web off does not cancel its agent turn', async () => {
    let release!: () => void; let received!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const called = new Promise<void>((resolve) => { received = resolve; });
    const provider = createServer((request, response) => { request.resume(); received(); void gate.then(() => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'web-fake', choices: [{ index: 0, delta: { role: 'assistant', content: 'Shared daemon reply.' }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: 'web-fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    }); });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    try {
      const address = provider.address() as { port: number };
      await server.close();
      await writeFile(join(home, 'config.toml'), `default_model = "stub"\n[providers.stub]\ntype = "openai"\nbase_url = "http://127.0.0.1:${address.port}/v1"\napi_key = "stub"\n[models.stub]\nprovider = "stub"\nmodel = "stub"\nmax_context_size = 100000\n[search]\nenabled = false\n`);
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, port: 0, logLevel: 'silent' }); base = `http://127.0.0.1:${server.port}`;
      const browser = await enter();
      const session = await owner('/api/sessions', 'POST', { metadata: { cwd: home } });
      const client = createKlient({ endpoint: base, token: server.localOwnerToken, WebSocket: WebSocket as unknown as HttpChannelOptions['WebSocket'] });
      try {
        let ready!: () => void; const attached = new Promise<void>((resolve) => { ready = resolve; });
        let receivedText!: () => void; const liveText = new Promise<void>((resolve) => { receivedText = resolve; });
        const view = client.session(session.id).view.subscribe({ sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } }, (signal) => {
          if (signal.type === 'ready') ready();
          if (JSON.stringify(signal).includes('Shared daemon reply.')) receivedText();
        });
        await attached;
        const response = await fetch(browser.origin + `/api/sessions/${session.id}/prompts`, { method: 'POST', headers: { cookie: browser.cookie, origin: browser.origin, 'content-type': 'application/json' }, body: JSON.stringify({ content: [{ type: 'text', text: 'Respond from the shared session.' }], model: 'stub' }) });
        const prompt = await response.json() as { code: number }; expect(prompt.code).toBe(0); await called;
        const handle = getLiveSessionById(server.core.accessor, session.id)!; const main = await ensureMainAgent(handle); const loop = main.accessor.get(IAgentLoopService);
        await owner('/api/web-access', 'DELETE'); expect(getLiveSessionById(server.core.accessor, session.id)).toBe(handle);
        release(); await loop.settled();
        const memory = JSON.stringify(main.accessor.get(IAgentContextMemoryService).get());
        const wire = main.accessor.get(IWireService); await wire.flush(); const records = []; for await (const record of wire.readJournal()) records.push(record);
        process.stdout.write(JSON.stringify({ webFake: { memoryHasReply: memory.includes('Shared daemon reply.'), wireHasReply: JSON.stringify(records).includes('Shared daemon reply.') } }) + '\n');
        expect(memory).toContain('Shared daemon reply.');
        await liveText;
        const transcript = await client.session(session.id).view.transcript.page({ agentId: 'main' });
        const items = await Promise.all(transcript.items.map(async (item) => {
          if (item.kind !== 'turn') return item;
          let expanded = item; let segments = 0;
          while ((expanded.contentRefs?.length ?? 0) > 0) {
            expect(++segments).toBeLessThan(32);
            const segment = await client.session(session.id).view.transcript.content!({ agentId: 'main', ref: expanded.contentRefs![0]! });
            expanded = applyContentSegment(expanded, segment);
          }
          return expanded;
        }));
        expect(JSON.stringify({ ...transcript, items })).toContain('Shared daemon reply.'); view.close();
      } finally { await client.close(); }
    } finally { release(); await new Promise<void>((resolve) => provider.close(() => resolve())); }
  });
  it('uses the formal klient Cookie facade, scalar environment and event transport without a bearer', async () => {
    const local = createKlient({ endpoint: base, token: server.localOwnerToken });
    let browserClient: ReturnType<typeof createKlient> | undefined;
    try {
      const status = await local.rest!.webAccess.enable({ mode: 'temporary', port: 0 });
      const link = await local.rest!.webAccess.issueLink(); const origin = status.url!; let cookie = '';
      const browserFetch: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers); headers.set('origin', origin); if (cookie !== '') headers.set('cookie', cookie);
        expect(headers.has('authorization')).toBe(false);
        const response = await fetch(input, { ...init, headers }); const setCookie = response.headers.get('set-cookie'); if (setCookie !== null) cookie = setCookie.split(';')[0]!; return response;
      };
      class BrowserSocket extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols ?? [], { headers: { origin, cookie } }); sockets.push(this); }
      }
      browserClient = createKlient({ endpoint: origin, fetch: browserFetch, WebSocket: BrowserSocket as unknown as HttpChannelOptions['WebSocket'] });
      const receipt = await browserClient.rest!.webAccess.exchange({ code: new URL(link.url).hash.slice(8), label: 'Typed browser' });
      expect(receipt.authenticated).toBe(true); expect((await browserClient.rest!.webAccess.current()).session?.id).toBe(receipt.session?.id);
      expect((await browserClient.global.env()).homeDir).toBe(home);
      expect(await browserClient.global.sessions.list({ limit: 5 })).toBeDefined();
      const subscription = browserClient.events.on('config.changed', () => {}); await subscription.ready;
      expect(sockets.at(-1)?.readyState).toBe(WebSocket.OPEN); subscription.dispose();
      await browserClient.rest!.webAccess.logout(); expect((await browserClient.rest!.webAccess.current()).authenticated).toBe(false);
      expect((await local.rest!.webAccess.status()).sessions).toEqual([]);
    } finally { await browserClient?.close(); await local.close(); }
  });
  it('keeps active document downloads attachment without changing raster or ordinary media', () => {
    expect(buildContentDisposition('unsafe.svg', 'image/svg+xml')).toMatch(/^attachment/);
    expect(buildContentDisposition('unsafe.HTML', 'image/png')).toMatch(/^attachment/);
    expect(buildContentDisposition('photo.png', 'image/png')).toMatch(/^inline/);
    expect(buildContentDisposition('movie.mp4', 'video/mp4')).toMatch(/^inline/);
    expect(buildContentDisposition('doc.pdf', 'application/pdf')).toMatch(/^attachment/);
  });
});
