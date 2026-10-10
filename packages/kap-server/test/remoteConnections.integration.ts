import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Event2, IEventService, IEventBus, ISessionManager, ISessionMetadata, ISessionIndex, IModelService, IAgentLifecycleService, IAgentContextMemoryService, IFileService } from '@kiki/agent-core-v2';
import { writePrivateFile } from '../src/services/auth/privateFiles';
import { randomUUID } from 'node:crypto';
import { createKlient, createConnectionKlient } from '@kiki/klient/http';
import { startServer, type RunningServer } from '../src/start';
import { rotateServerToken } from '../src/services/auth/persistentToken';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const servers: RunningServer[] = []; const homes: string[] = []; const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0).toReversed()) {
    const started = performance.now();
    console.log(`[remote-close] port=${server.port} begin`);
    await server.close();
    console.log(`[remote-close] port=${server.port} complete elapsedMs=${Math.round(performance.now() - started)}`);
  }
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
async function boot(home?: string, disableAuth = false, port = 0): Promise<RunningServer> {
  const path = home ?? await mkdtemp(join(tmpdir(), 'kiki-admission-')); if (home === undefined) homes.push(path);
  const server = await startServer({ homeDir: path, port, hostIdentity: TEST_HOST_IDENTITY, logLevel: 'silent', disableAuth });
  servers.push(server); return server;
}
const endpoint = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
async function call(s: RunningServer, path: string, body?: unknown, token = s.localOwnerToken, grant?: string, method = body === undefined ? 'GET' : 'POST') {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...grant === undefined ? {} : { 'x-kiki-connection-grant': grant } };
  const options: RequestInit = { method, headers };
  if (method !== 'GET' && body !== undefined) options.body = JSON.stringify(body);
  return fetch(endpoint(s) + path, options);
}
async function connect(source: RunningServer, target: RunningServer) {
  const owner = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
  const local = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
  try {
    await owner.rest!.connections.setInbound(true);
    const invitation = await owner.rest!.connections.invite({ source: source.admission.identity, label: 'Source' });
    const record = await local.rest!.connections.add({ label: 'Target', endpoint: endpoint(target), target: target.admission.identity, ownerToken: target.authTokenService.getToken(), invitation: invitation.invitation, backgroundSummary: true });
    return { record, grantId: invitation.grant.id };
  } finally { await owner.close(); await local.close(); }
}
async function peerSocket(target: RunningServer, token: string, grant?: string, path = '/api/klient/events'): Promise<WebSocket> {
  const socket = new WebSocket(endpoint(target).replace('http:', 'ws:') + path, { headers: { authorization: `Bearer ${token}`, ...grant === undefined ? {} : { 'x-kiki-connection-grant': grant } } });
  sockets.push(socket); await once(socket, 'open'); return socket;
}
async function rejectedSocket(target: RunningServer, token: string, path: string, grant?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint(target).replace('http:', 'ws:') + path, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '127.0.0.1', ...grant === undefined ? {} : { 'x-kiki-connection-grant': grant } } });
    sockets.push(ws);
    ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode ?? 0); });
    ws.on('error', () => {}); ws.on('open', () => reject(new Error('Unauthorized socket opened')));
  });
}
describe('directed remote admission and source broker (real isolated KAP)', () => {
  it('defaults closed, keeps local attach and rejects naked bearer, fake-loopback, old REST/WS and peer management', async () => {
    const a = await boot(); const b = await boot();
    expect((await call(b, '/api/meta')).status).toBe(200);
    for (const path of ['/api/meta', '/api/sessions', '/api/config', '/api/debug/channels', '/api/remote-connections/inbound']) {
      expect((await call(b, path, undefined, b.authTokenService.getToken())).status).toBe(403);
    }
    const fake = await fetch(endpoint(b) + '/api/sessions', { headers: { authorization: `Bearer ${b.authTokenService.getToken()}`, 'x-forwarded-for': '127.0.0.1', 'x-kiki-client-kind': 'local-owner', host: `localhost:${b.port}` } });
    expect(fake.status).toBe(403);
    expect(await rejectedSocket(b, b.authTokenService.getToken(), '/api/ws')).toBe(403);
    expect(await rejectedSocket(b, b.authTokenService.getToken(), '/api/klient/events')).toBe(403);
    await b.admission.setEnabled(true);
    expect((await call(b, '/api/sessions', undefined, b.authTokenService.getToken())).status).toBe(401);
    const invitation = await b.admission.invite(a.admission.identity, 'A');
    expect((await call(b, '/api/remote-connections/claim', { invitation: invitation.invitation, source: b.admission.identity }, b.authTokenService.getToken())).status).toBe(403);
    const claimedResponse = await call(b, '/api/remote-connections/claim', { invitation: invitation.invitation, source: a.admission.identity }, b.authTokenService.getToken());
    const claimed = (await claimedResponse.json()).data as { grant: string };
    expect(claimedResponse.status).toBe(200);
    expect((await call(b, '/api/remote-connections/claim', { invitation: invitation.invitation, source: a.admission.identity }, b.authTokenService.getToken())).status).toBe(401);
    expect((await call(b, '/api/meta', undefined, b.authTokenService.getToken(), claimed.grant)).status).toBe(200);
    for (const path of ['/api/remote-connections/inbound', '/api/remote-connections', '/api/shutdown', '/api/debug/channels', '/api/secrets:reveal']) {
      expect((await call(b, path, undefined, b.authTokenService.getToken(), claimed.grant)).status).toBe(403);
    }
    const rpc = await call(b, '/api/klient/call', { procedure: { scope: 'core', service: 'configService', method: 'set' }, params: ['inbound', true] }, b.authTokenService.getToken(), claimed.grant);
    expect((await rpc.json()).code).toBe(40301);
    expect(await rejectedSocket(b, b.authTokenService.getToken(), '/api/ws', claimed.grant)).toBe(403);
    const ws = await peerSocket(b, b.authTokenService.getToken(), claimed.grant);
    const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'stream', id: 'forbidden', scope: 'core', service: 'configService', method: 'set' }));
    expect((await closed)[0]).toBe(1008);
  });
  it('isolates A/C grants, revokes only A and persists stable home identity over a restart', async () => {
    const a = await boot(); const b = await boot(); const c = await boot();
    const ab = await connect(a, b);
    const aView = createConnectionKlient({ endpoint: endpoint(a), token: a.localOwnerToken, connectionId: ab.record.id });
    expect((await aView.rest!.meta()).server_home_id).toBe(b.admission.identity.homeId);
    expect((await call(b, '/api/meta', undefined, b.authTokenService.getToken(), c.localOwnerToken)).status).toBe(401);
    const cb = await connect(c, b);
    const cView = createConnectionKlient({ endpoint: endpoint(c), token: c.localOwnerToken, connectionId: cb.record.id });
    const aWs = new WebSocket(endpoint(a).replace('http:', 'ws:') + `/api/remote-connections/${ab.record.id}/events`, [`kimi-code.bearer.${a.localOwnerToken}`]); sockets.push(aWs); await once(aWs, 'open');
    const cWs = new WebSocket(endpoint(c).replace('http:', 'ws:') + `/api/remote-connections/${cb.record.id}/events`, [`kimi-code.bearer.${c.localOwnerToken}`]); sockets.push(cWs); await once(cWs, 'open');
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const closedA = once(aWs, 'close'); await b.admission.revoke(ab.grantId); await closedA;
    expect(cWs.readyState).toBe(WebSocket.OPEN);
    expect((await cView.rest!.meta()).server_home_id).toBe(b.admission.identity.homeId);
    await expect(aView.rest!.meta()).rejects.toThrow();
    expect((await call(b, '/api/meta')).status).toBe(200);
    const oldHome = b.admission.identity; const oldServer = b.serverId;
    const home = homes[1]!; await b.close(); servers.splice(servers.indexOf(b), 1);
    const restarted = await boot(home);
    expect(restarted.admission.identity).toEqual(oldHome); expect(restarted.serverId).not.toBe(oldServer);
    expect(restarted.admission.status().grants.find((g) => g.id === ab.grantId)?.status).toBe('revoked');
    await aView.close(); await cView.close();
  });
  it('recovers an ordinary remote call after inbound is restored without reconnect approval', async () => {
    const a = await boot(); const b = await boot(); const { record } = await connect(a, b);
    const client = createConnectionKlient({ endpoint: endpoint(a), token: a.localOwnerToken, connectionId: record.id });
    try {
      await b.admission.setEnabled(false);
      await expect(client.rest!.meta()).rejects.toThrow('inbound_disabled');
      expect(a.remoteConnections.get(record.id)).toMatchObject({ state: 'offline', lastError: 'inbound_disabled' });
      expect(b.admission.status().enabled).toBe(false);
      await b.admission.setEnabled(true);
      expect((await client.rest!.meta()).server_home_id).toBe(b.admission.identity.homeId);
      expect(a.remoteConnections.get(record.id).state).toBe('online');
    } finally { await client.close(); }
  });
  it('still rejects a revoked grant on ordinary attempts and recovers when the stored grant is replaced', async () => {
    const a = await boot(); const b = await boot(); const { record, grantId } = await connect(a, b);
    const client = createConnectionKlient({ endpoint: endpoint(a), token: a.localOwnerToken, connectionId: record.id });
    try {
      await b.admission.revoke(grantId);
      await expect(client.rest!.meta()).rejects.toThrow('connection_not_approved');
      expect(a.remoteConnections.get(record.id).state).toBe('authentication_required');
      await expect(client.rest!.meta()).rejects.toThrow('connection_not_approved');
      const invitation = await b.admission.invite(a.admission.identity, 'Replacement');
      const credential = await b.admission.claim(invitation.invitation, a.admission.identity);
      await a.remoteConnections.secrets.write({ connectionId: record.credentialRef, purpose: 'gui' }, { ownerToken: b.authTokenService.getToken(), ...credential });
      expect((await client.rest!.meta()).server_home_id).toBe(b.admission.identity.homeId);
      expect(a.remoteConnections.get(record.id).state).toBe('online');
    } finally { await client.close(); }
  });
  it('keeps credentials out of the directory and pauses on token rotation, home drift, disable and removal', async () => {
    const a = await boot(); const b = await boot(); const { record } = await connect(a, b);
    await a.remoteConnections.pollSummaries();
    const list = a.remoteConnections.list(); expect(list[0]?.summary?.value.online).toBe(true);
    const disk = await readFile(join(homes[0]!, 'server', 'outbound-connections.json'), 'utf8');
    expect(disk).not.toContain(b.authTokenService.getToken()); expect(disk).not.toContain('"grant"');
    const client = createConnectionKlient({ endpoint: endpoint(a), token: a.localOwnerToken, connectionId: record.id });
    expect((await client.rest!.connections.list().catch(() => 'denied'))).toBe('denied');
    await rotateServerToken(homes[1]!);
    await expect(client.rest!.meta()).rejects.toThrow();
    expect(a.remoteConnections.get(record.id).state).toBe('authentication_required');
    expect(a.remoteConnections.get(record.id).summary?.stale).toBe(true);
    await a.remoteConnections.enable(record.id, false);
    expect(a.remoteConnections.get(record.id).state).toBe('disabled');
    await a.remoteConnections.remove(record.id);
    expect(a.remoteConnections.list()).toEqual([]);
    expect((await call(b, '/api/meta')).status).toBe(200);
    await client.close();
  });
  it('keeps D24 local-owner gates and persisted grants ineffective in dangerous legacy bypass mode', async () => {
    const a = await boot(); const b = await boot();
    await b.admission.setEnabled(true);
    const pending = await b.admission.invite(a.admission.identity, 'pending');
    const approved = await b.admission.invite(a.admission.identity, 'approved');
    const credential = await b.admission.claim(approved.invitation, a.admission.identity);
    const saved = await readFile(join(homes[1]!, 'server', 'inbound-connections.json'), 'utf8');
    await b.close(); servers.splice(servers.indexOf(b), 1);
    const dangerous = await boot(homes[1], true);
    expect((await fetch(endpoint(dangerous) + '/api/sessions')).status).toBe(200);
    const status = dangerous.admission.status();
    expect(status).toMatchObject({ enabled: false, configuredEnabled: true, unavailableReason: 'dangerous_auth_bypass' });
    expect(status.grants).toHaveLength(2);
    for (const path of ['/api/remote-connections', '/api/remote-connections/inbound', '/api/thread-bridges']) {
      expect((await fetch(endpoint(dangerous) + path)).status).toBe(401);
      expect((await call(dangerous, path, undefined, dangerous.authTokenService.getToken(), credential.grant)).status).toBe(403);
      expect((await call(dangerous, path)).status).toBe(200);
    }
    expect((await call(dangerous, '/api/remote-connections/inbound', { enabled: true }, dangerous.localOwnerToken, undefined, 'PUT')).status).toBe(403);
    expect((await call(dangerous, '/api/remote-connections/inbound/invitations', { source: a.admission.identity, label: 'new' })).status).toBe(403);
    expect((await call(dangerous, '/api/remote-connections/claim', { source: a.admission.identity, invitation: pending.invitation })).status).toBe(403);
    expect((await call(dangerous, '/api/meta', undefined, dangerous.authTokenService.getToken(), credential.grant)).status).toBe(403);
    for (const operation of ['list', 'read', 'send', 'wait']) {
      expect((await call(dangerous, `/api/thread-bridge/${operation}`, {}, dangerous.localOwnerToken)).status).toBe(403);
      expect((await call(dangerous, `/api/thread-bridge/${operation}`, {}, dangerous.authTokenService.getToken(), credential.grant)).status).toBe(403);
    }
    expect(await rejectedSocket(dangerous, dangerous.authTokenService.getToken(), '/api/klient/events', credential.grant)).toBe(403);
    expect(await rejectedSocket(dangerous, dangerous.authTokenService.getToken(), `/api/remote-connections/${approved.grant.id}/events`)).toBe(403);
    const local = await peerSocket(dangerous, dangerous.localOwnerToken); expect(local.readyState).toBe(WebSocket.OPEN); local.terminate();
    expect(await readFile(join(homes[1]!, 'server', 'inbound-connections.json'), 'utf8')).toBe(saved);
    await dangerous.close(); servers.splice(servers.indexOf(dangerous), 1);
    const restored = await boot(homes[1]);
    expect(restored.admission.status().enabled).toBe(true);
    expect((await call(restored, '/api/meta', undefined, restored.authTokenService.getToken(), credential.grant)).status).toBe(200);
  });
  it('streams explicit attachments above the JSON page budget through the fixed broker', async () => {
    const started = performance.now();
    const phase = (stage: string) => console.log(`[attachment-stream] ${stage} elapsedMs=${Math.round(performance.now() - started)}`);
    phase('boot-source'); const a = await boot();
    phase('boot-target'); const b = await boot();
    phase('connect'); const { record } = await connect(a, b);
    await a.remoteConnections.pollSummaries();
    expect(a.remoteConnections.list()[0]?.activeLeases).toBe(1);
    const bytes = Buffer.from('附件😀'.repeat(250000));
    const form = new FormData(); form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), 'large.bin');
    phase('upload');
    const uploaded = await fetch(endpoint(a) + `/api/remote-connections/${record.id}/upload`, { method: 'POST', headers: { authorization: `Bearer ${a.localOwnerToken}` }, body: form });
    phase('upload-headers');
    const envelope = await uploaded.json() as { code: number; data: { id: string; size: number } };
    expect(uploaded.status).toBe(200); expect(envelope.code).toBe(0); expect(envelope.data.size).toBe(bytes.length);
    phase('download');
    const downloaded = await call(a, `/api/remote-connections/${record.id}/download`, { operation: 'file', params: { fileId: envelope.data.id } });
    phase('download-headers'); expect(downloaded.status).toBe(200);
    const reader = downloaded.body!.getReader(); const chunks: Buffer[] = [];
    for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); }
    reader.releaseLock(); phase('download-read-complete');
    const downloadedBytes = Buffer.concat(chunks);
    expect(downloadedBytes.byteLength).toBe(bytes.byteLength);
    expect(downloadedBytes.equals(bytes), 'broker response must match every uploaded byte').toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    phase(`download-complete bytes=${bytes.length} chunks=${chunks.length}`);
    const direct = await call(b, `/api/files/${envelope.data.id}`);
    const directBytes = Buffer.from(await direct.arrayBuffer()); phase('direct-read-complete');
    expect(directBytes.byteLength).toBe(bytes.byteLength);
    expect(directBytes.equals(bytes), 'direct response must match every uploaded byte').toBe(true);
    phase('direct-complete');
    expect((await call(a, `/api/remote-connections/${record.id}/call`, { operation: 'file', params: { fileId: envelope.data.id } })).status).toBe(400);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(a.remoteConnections.list()[0]?.activeLeases).toBe(1);
    const store = b.core.accessor.get(IFileService); const get = store.get.bind(store);
    let returned = false;
    const reading = vi.spyOn(store, 'get').mockImplementation(async (id) => {
      const file = await get(id);
      return { ...file, stream: (range) => {
        const source = file.stream(range);
        return Readable.from((async function* () {
          try { for await (const chunk of source) { yield chunk; await delay(50); } }
          finally { source.destroy(); returned = true; }
        })());
      } };
    });
    try {
      phase('cancel-download');
      const cancelled = await call(a, `/api/remote-connections/${record.id}/download`, { operation: 'file', params: { fileId: envelope.data.id } });
      const cancelReader = cancelled.body!.getReader();
      const first = await cancelReader.read(); expect(first.done).toBe(false);
      expect(Buffer.from(first.value!)).toEqual(bytes.subarray(0, first.value!.byteLength));
      expect(returned).toBe(false);
      expect(a.remoteConnections.list()[0]?.activeLeases).toBe(2);
      await cancelReader.cancel(); cancelReader.releaseLock();
      await vi.waitFor(() => { expect(returned).toBe(true); expect(a.remoteConnections.list()[0]?.activeLeases).toBe(1); });
      phase('cancel-complete');
    } finally { reading.mockRestore(); }
    await a.remoteConnections.enable(record.id, false);
    expect(a.remoteConnections.list()[0]?.activeLeases).toBe(0);
    phase('disabled');
  });
  it('closes an empty TCP preconnection while preserving an active attachment response', async () => {
    const b = await boot(); const store = b.core.accessor.get(IFileService);
    const bytes = Buffer.from('valid-request-附件😀'.repeat(100000));
    const meta = await store.save(Readable.from([bytes]), 'active.bin');
    const get = store.get.bind(store); let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const reading = vi.spyOn(store, 'get').mockImplementation(async (id) => {
      const file = await get(id);
      return { ...file, stream: (range) => Readable.from((async function* () {
        let first = true;
        for await (const chunk of file.stream(range)) {
          yield chunk;
          if (first) { first = false; await released; }
        }
      })()) };
    });
    const accepted = once(b.app.server, 'connection');
    const empty = createConnection({ host: '127.0.0.1', port: b.port }); empty.on('error', () => {});
    const emptyClosed = new Promise<void>((resolve) => { empty.once('close', () => resolve()); });
    let closing: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.all([once(empty, 'connect'), accepted]);
      expect(empty.bytesWritten).toBe(0);
      const response = await call(b, `/api/files/${meta.id}`); expect(response.status).toBe(200);
      const reader = response.body!.getReader(); const first = await reader.read();
      expect(first.done).toBe(false);
      const chunks = [Buffer.from(first.value!)]; let closed = false;
      closing = b.close().then(() => { closed = true; });
      await delay(50); expect(closed).toBe(false);
      release();
      for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); }
      reader.releaseLock(); expect(Buffer.concat(chunks)).toEqual(bytes);
      await Promise.race([closing, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('empty TCP preconnection blocked listener close')), 3000); })]);
      await emptyClosed;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release(); empty.destroy(); await closing; await b.close(); reading.mockRestore();
      servers.splice(servers.indexOf(b), 1);
    }
  });

  it('keeps identical session ids in different target homes separate and pauses all purposes on home drift', async () => {
    const a = await boot(); const b = await boot(); const c = await boot(); const sessionId = randomUUID();
    const bs = await b.core.accessor.get(ISessionManager).create({ sessionId, workDir: homes[1]! });
    const cs = await c.core.accessor.get(ISessionManager).create({ sessionId, workDir: homes[2]! });
    await bs.accessor.get(ISessionMetadata).setTitle('Only B'); await cs.accessor.get(ISessionMetadata).setTitle('Only C');
    const ab = await connect(a, b); const ac = await connect(a, c);
    const bResult = await call(a, `/api/remote-connections/${ab.record.id}/call`, { operation: 'session', params: { sessionId } });
    const cResult = await call(a, `/api/remote-connections/${ac.record.id}/call`, { operation: 'session', params: { sessionId } });
    expect((await bResult.json()).data.title).toBe('Only B'); expect((await cResult.json()).data.title).toBe('Only C');
    const guiLease = a.remoteConnections.lease(ab.record.id); const bridgeLease = a.remoteConnections.lease(ab.record.id, undefined, 'bridge');
    const ownerToken = b.authTokenService.getToken(); const oldPort = b.port;
    await b.close(); servers.splice(servers.indexOf(b), 1);
    const otherHome = await mkdtemp(join(tmpdir(), 'kiki-drift-')); homes.push(otherHome);
    await writePrivateFile(join(otherHome, 'server.token'), ownerToken);
    const replacement = await boot(otherHome, false, oldPort);
    expect(replacement.admission.identity.homeId).not.toBe(ab.record.target.homeId);
    const drifted = await call(a, `/api/remote-connections/${ab.record.id}/call`, { operation: 'meta' });
    expect(drifted.status).toBe(409); expect(a.remoteConnections.get(ab.record.id).state).toBe('identity_changed');
    expect(guiLease.signal.aborted).toBe(true); expect(bridgeLease.signal.aborted).toBe(true); guiLease.release(); bridgeLease.release();
    expect((await (await call(a, `/api/remote-connections/${ac.record.id}/call`, { operation: 'session', params: { sessionId } })).json()).data.title).toBe('Only C');
  });
  it('provisions GUI credentials only under local owner with explicit inbound permission', async () => {
    const a = await boot(); const b = await boot();
    const input = { source: a.admission.identity, target: b.admission.identity, label: 'A', enableInbound: false };
    expect((await call(b, '/api/remote-connections/provision', input)).status).toBe(403);
    expect(b.admission.status().enabled).toBe(false); expect(b.admission.status().grants).toHaveLength(0);
    expect((await call(b, '/api/remote-connections/provision', { ...input, enableInbound: true, target: a.admission.identity })).status).toBe(409);
    expect(b.admission.status().enabled).toBe(false);
    const response = await call(b, '/api/remote-connections/provision', { ...input, enableInbound: true });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const result = (await response.json()).data as { ownerToken: string; grant: string; target: unknown };
    expect(result.target).toEqual(b.admission.identity); expect(result.ownerToken).toBe(b.authTokenService.getToken());
    expect((await call(b, '/api/meta', undefined, result.ownerToken, result.grant)).status).toBe(200);
    expect((await call(b, '/api/remote-connections/provision', { ...input, enableInbound: true }, result.ownerToken, result.grant)).status).toBe(403);
    expect((await call(a, `/api/remote-connections/${randomUUID()}/call`, { operation: 'provision', body: input })).status).toBeGreaterThanOrEqual(400);
  });
  it('rejects raw history before dispatch and fragmented peer messages before assembly while retaining local WS allowance', async () => {
    const a = await boot(); const b = await boot(); const connection = await connect(a, b);
    const credential = await a.remoteConnections.secrets.read<{ grant: string; ownerToken: string }>({ connectionId: connection.record.id, purpose: 'gui' });
    const session = await b.core.accessor.get(ISessionManager).create({ workDir: homes[1]! });
    const lifecycle = session.accessor.get(IAgentLifecycleService); const agent = lifecycle.get('main') ?? await lifecycle.create({ agentId: 'main' });
    const memory = agent.accessor.get(IAgentContextMemoryService);
    const raw = vi.spyOn(memory, 'get').mockReturnValue([{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(50 * 1024 * 1024) }], toolCalls: [] }]);
    try {
      const response = await call(b, '/api/klient/call', { procedure: { scope: 'agent', sessionId: session.id, agentId: agent.id, service: 'agentContextMemoryService', method: 'get' }, params: [] }, credential.ownerToken, credential.grant);
      expect((await response.json()).code).toBe(40301); expect(raw).not.toHaveBeenCalled();
    } finally { raw.mockRestore(); }
    const sourcePeer = await peerSocket(b, credential.ownerToken, credential.grant);
    const sourceClosed = once(sourcePeer, 'close'); sourcePeer.send('x'.repeat(80 * 1024), { fin: false }); sourcePeer.send('x'.repeat(80 * 1024), { fin: true });
    expect((await sourceClosed)[0]).toBe(1009);
    const broker = await peerSocket(a, a.localOwnerToken, undefined, `/api/remote-connections/${connection.record.id}/events`);
    const brokerClosed = once(broker, 'close'); broker.send('x'.repeat(80 * 1024), { fin: false }); broker.send('x'.repeat(80 * 1024), { fin: true });
    expect((await brokerClosed)[0]).toBe(1009);
    const local = await peerSocket(b, b.localOwnerToken); local.send('x'.repeat(160 * 1024));
    await new Promise<void>((resolve) => setTimeout(resolve, 30)); expect(local.readyState).toBe(WebSocket.OPEN);
  });

  it('admits a peer to the approved remote procedure surface and no further', async () => {
    const a = await boot(); const b = await boot();
    const connection = await connect(a, b);
    const credential = await a.remoteConnections.secrets.read<{ grant: string; ownerToken: string }>({ connectionId: connection.record.id, purpose: 'gui' });
    await b.core.accessor.get(ISessionIndex).prepare();
    await b.core.accessor.get(IModelService).set('synthetic-model', { apiKey: 'SYNTHETIC_SECRET', model: 'example-model', protocol: 'openai', baseUrl: 'https://example.test/v1', maxContextSize: 128_000 });
    const victim = await b.core.accessor.get(ISessionManager).create({ workDir: homes[1]! });
    const procedure = async (service: string, method: string, params: unknown[]) => {
      const response = await call(a, `/api/remote-connections/${connection.record.id}/call`, { operation: 'procedure', body: { procedure: { scope: 'core', service, method }, params } });
      return response.json() as Promise<{ code: number; msg: string }>;
    };
    expect((await procedure('sessionIndex', 'listRecent', [{}])).code).toBe(0);
    expect((await procedure('workspaceService', 'list', [])).code).toBe(0);
    expect((await procedure('personaStore', 'list', [])).code).toBe(0);
    expect((await procedure('modelResolver', 'listModels', [])).code).toBe(0);
    expect((await procedure('modelResolver', 'setDefaultModel', ['synthetic-model'])).code).toBe(0);
    const sessionRead = await call(b, '/api/klient/call', { procedure: { scope: 'session', sessionId: victim.id, service: 'sessionMetadata', method: 'read' }, params: [] }, credential.ownerToken, credential.grant);
    expect(await sessionRead.json() as Promise<{ code: number }>).toMatchObject({ code: 0 });
    for (const [service, method, params] of [
      ['modelService', 'list', []], ['modelService', 'get', ['synthetic-model']], ['modelService', 'set', ['synthetic-model', { apiKey: 'SYNTHETIC_REPLACED' }]],
      ['modelService', 'delete', ['synthetic-model']], ['providerService', 'get', ['synthetic-model']], ['providerService', 'list', []],
      ['providerDiscovery', 'refreshProviderModels', [{}]], ['modelCatalogMutation', 'createModel', [{}]],
      ['workspaceService', 'createOrTouch', [homes[1]!, 'Peer workspace']], ['workspaceService', 'delete', [homes[1]!]],
      ['personaStore', 'put', [{ id: 'peer' }]], ['personaStore', 'delete', ['peer']],
      ['sessionManager', 'delete', [victim.id]], ['sessionManager', 'create', [{ workDir: homes[1]! }]],
      ['configService', 'set', ['inbound', true]], ['mcpManagementService', 'listServers', []],
      ['taskBoardService', 'write', [{}]], ['fileService', 'save', [['', '']]],
    ] as [string, string, unknown[]][]) {
      expect((await procedure(service, method, params)).code, `${service}.${method}`).toBe(40101);
    }
    expect(b.core.accessor.get(IModelService).get('synthetic-model')?.apiKey).toBe('SYNTHETIC_SECRET');
    expect(await b.core.accessor.get(ISessionIndex).get(victim.id)).toBeDefined();
  });

  it('refuses a peer the raw-credential reads that REST already redacts', async () => {
    const a = await boot(); const b = await boot();
    const connection = await connect(a, b);
    const credential = await a.remoteConnections.secrets.read<{ grant: string; ownerToken: string }>({ connectionId: connection.record.id, purpose: 'gui' });
    await b.core.accessor.get(IModelService).set('synthetic-model', { apiKey: 'SYNTHETIC_SECRET', model: 'example-model', protocol: 'openai', baseUrl: 'https://example.test/v1', maxContextSize: 128_000 });
    const read = await call(b, '/api/klient/call', { procedure: { scope: 'core', service: 'modelResolver', method: 'listProviders' }, params: [] }, credential.ownerToken, credential.grant);
    const redacted = await read.json() as { code: number; data: unknown };
    expect(redacted.code).toBe(0);
    expect(JSON.stringify(redacted)).not.toContain('SYNTHETIC_SECRET');
    const raw = await call(b, '/api/klient/call', { procedure: { scope: 'core', service: 'modelService', method: 'get' }, params: ['synthetic-model'] }, credential.ownerToken, credential.grant);
    const body = await raw.json() as { code: number; msg: string };
    expect(body.code).toBe(40301);
    expect(JSON.stringify(body)).not.toContain('SYNTHETIC_SECRET');
  });

  it('projects only approved core and agent bus facts onto the broker socket without leaking private events', async () => {
    const a = await boot(); const b = await boot(); const { record } = await connect(a, b);
    const session = await b.core.accessor.get(ISessionManager).create({ workDir: homes[1]! });
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const agent = lifecycle.get('main') ?? await lifecycle.create({ agentId: 'main' });
    const peer = await peerSocket(a, a.localOwnerToken, undefined, `/api/remote-connections/${record.id}/events`);
    const local = await peerSocket(b, b.localOwnerToken);
    const frames = { peer: [] as Record<string, unknown>[], local: [] as Record<string, unknown>[] };
    for (const [name, socket] of [['peer', peer], ['local', local]] as const) {
      socket.on('message', (data) => {
        const text = (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString();
        frames[name].push(JSON.parse(text) as Record<string, unknown>);
      });
      socket.send(JSON.stringify({ type: 'subscribe', id: 'core', scope: 'core', event: 'events' }));
      socket.send(JSON.stringify({ type: 'subscribe', id: 'agent', scope: 'agent', sessionId: session.id, agentId: agent.id, event: 'events' }));
    }
    await vi.waitFor(() => {
      for (const list of Object.values(frames)) expect(list.filter((frame) => frame['type'] === 'subscribed')).toHaveLength(2);
    });
    class CatalogFact extends Event2<{ payload: unknown }> { static override readonly type = 'event.model_catalog.changed'; }
    class SearchFact extends Event2<{ payload: unknown }> { static override readonly type = 'event.search.index_state_changed'; }
    class PrivateFact extends Event2<{ payload: unknown }> { static override readonly type = 'event.credential.changed'; }
    class QueuedFact extends Event2<Record<string, unknown>> { static override readonly type = 'prompt.model_switch_queued'; }
    class StatusFact extends Event2<Record<string, unknown>> { static override readonly type = 'prompt.model_switch_status'; }
    class PrivateAgentFact extends Event2<{ payload: unknown }> { static override readonly type = 'context.append_message'; }
    const secret = 'SYNTHETIC_BUS_SECRET';
    const catalog = { changed: [{ provider_id: 'example', provider_name: 'Example', added: 1, removed: 0 }],
      unchanged: [], failed: [{ provider: 'example', reason: 'Provider quota exceeded.' }] };
    const search = { state: 'ready', indexed_sessions: 1, total_sessions: 1, documents: 2, stale: false };
    const events = b.core.accessor.get(IEventService);
    events.publish(new CatalogFact({ payload: { ...catalog, discovered: [{ apiKey: secret }] } }));
    events.publish(new PrivateFact({ payload: { apiKey: secret } }));
    events.publish(new CatalogFact({ payload: { apiKey: secret } }));
    events.publish(new SearchFact({ payload: { ...search, privatePath: secret } }));
    const receipt = { operationId: 'example-switch', agentId: agent.id, state: 'pending', fromModel: 'example-a', toModel: 'example-b', mode: 'direct' };
    const entry = { input: { operationId: 'example-switch', model: 'example-b', mode: 'direct' }, receipt, revision: 0,
      originalBinding: { model: 'example-a', thinking: 'off' } };
    const failed = { ...receipt, state: 'failed', error: { code: 'model_not_found', message: 'Model example-b was removed.' } };
    const bus = agent.accessor.get(IEventBus);
    bus.publish(new QueuedFact({ entry: { ...entry, apiKey: secret }, queueIndex: 0 }));
    bus.publish(new PrivateAgentFact({ payload: { text: secret } }));
    bus.publish(new StatusFact({ operationId: receipt.operationId, receipt: { ...failed, apiKey: secret } }));
    await vi.waitFor(() => {
      expect(frames.peer.filter((frame) => frame['type'] === 'event')).toHaveLength(4);
      expect(frames.local.filter((frame) => frame['type'] === 'event')).toHaveLength(7);
    });
    const peerEvents = frames.peer.filter((frame) => frame['type'] === 'event');
    expect(peerEvents.filter((frame) => frame['id'] === 'core').map((frame) => frame['data'])).toEqual([
      { type: 'event.model_catalog.changed', payload: catalog }, { type: 'event.search.index_state_changed', payload: search },
    ]);
    expect(peerEvents.filter((frame) => frame['id'] === 'agent').map((frame) => frame['data'])).toEqual([
      expect.objectContaining({ type: 'prompt.model_switch_queued', entry, queueIndex: 0 }),
      expect.objectContaining({ type: 'prompt.model_switch_status', operationId: receipt.operationId, receipt: failed }),
    ]);
    expect(JSON.stringify(peerEvents)).not.toContain(secret);
    expect(JSON.stringify(frames.local)).toContain(secret);
    expect(peer.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
});
