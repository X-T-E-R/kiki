import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { IConfigService } from '@kiki/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ExternalClientStore } from '../src/externalClients/store';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> { code: number; msg: string; data: T }
interface ApiResponse<T> { status: number; body: Envelope<T> }
interface Presence { close(): Promise<void> }
interface Ticket { ticket: string; expires_at: number }
interface TicketAndVerifier extends Ticket { verifier: string }
interface ConnectedSocket { socket: WebSocket; closed: Promise<void> }

const presenceGraceMs = 500;
const nonLoopbackAddress = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
  .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
const externalDelegationEnvNames = [
  'KIKI_EXTERNAL_PRINCIPAL_ID',
  'KIKI_EXTERNAL_SESSION_ID',
  'KIKI_EXTERNAL_DELEGATION_TOKEN',
  'KIKI_EXTERNAL_WORKSPACE_PATH',
  'KIKI_EXTERNAL_MODEL_ALIAS',
  'KIKI_EXTERNAL_THINKING_EFFORT',
  'KIKI_EXTERNAL_PERMISSION_MODE',
  'KIKI_EXTERNAL_SESSION_TITLE',
] as const;

let server: RunningServer;
let home: string;
let base: string;
let now: number;
const presences: Presence[] = [];
const sockets: WebSocket[] = [];
const additionalServers: RunningServer[] = [];
const additionalHomes: string[] = [];

async function requestAt<T = unknown>(
  endpoint: string,
  method: string,
  path: string,
  body?: unknown,
  options: { token?: string | null; headers?: HeadersInit } = {},
): Promise<ApiResponse<T>> {
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? server.localOwnerToken : options.token;
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Envelope<T> };
}

async function requestWithHost<T>(endpoint: string, method: string, path: string, body: unknown, host: string): Promise<ApiResponse<T>> {
  const target = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path,
      method,
      headers: { host, 'content-type': 'application/json' },
    }, (response) => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { content += chunk; });
      response.on('end', () => {
        let body: Envelope<T>;
        try { body = JSON.parse(content) as Envelope<T>; }
        catch (error) { reject(error); return; }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

function successful<T>(response: ApiResponse<T>): T {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.code, response.body.msg).toBe(0);
  return response.body.data;
}

function expectInvalidTicket(response: ApiResponse<unknown>): void {
  expect(response).toMatchObject({ status: 401, body: { code: 40101, msg: 'invalid_ticket' } });
}

async function createSession(endpoint = base, token = server.localOwnerToken): Promise<string> {
  const data = successful(await requestAt<{ id: string }>(endpoint, 'POST', '/api/sessions', { metadata: { cwd: home } }, { token }));
  return data.id;
}

function newVerifier(): string { return randomBytes(32).toString('base64url'); }
function challengeFor(verifier: string): string { return createHash('sha256').update(verifier, 'ascii').digest('base64url'); }
function newHolderId(): string { return `holder-${randomBytes(12).toString('hex')}`; }

async function openPresenceAt(endpoint: string, holder_id: string, token = server.localOwnerToken): Promise<Presence> {
  const response = await fetch(`${endpoint}/api/session-access/holders/${holder_id}/presence`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) throw new Error(`Presence request failed: ${response.status} ${await response.text()}`);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Presence stream has no response body');
  const decoder = new TextDecoder();
  let ready = '';
  while (!ready.includes('event: ready')) {
    const next = await reader.read();
    if (next.done) throw new Error('Presence stream ended before ready');
    ready += decoder.decode(next.value, { stream: true });
  }
  let closed = false;
  const presence: Presence = {
    close: async () => {
      if (closed) return;
      closed = true;
      await reader.cancel().catch(() => undefined);
    },
  };
  presences.push(presence);
  return presence;
}

async function issueTicketAt(endpoint: string, session_id: string, holder_id: string, verifier = newVerifier(), token = server.localOwnerToken): Promise<TicketAndVerifier> {
  const data = successful(await requestAt<Ticket>(endpoint, 'POST', '/api/session-access/tickets', {
    session_id, challenge: challengeFor(verifier), holder_id,
  }, { token }));
  return { ...data, verifier };
}

async function issueTicket(session_id: string, holder_id: string, verifier = newVerifier()): Promise<TicketAndVerifier> {
  return issueTicketAt(base, session_id, holder_id, verifier);
}

async function exchangeAt(endpoint: string, ticket: string, verifier: string, headers: HeadersInit = {}): Promise<ApiResponse<unknown>> {
  return requestAt(endpoint, 'POST', '/api/session-access/exchange', {
    ticket, verifier, client: { name: 'example-terminal', version: '1.2.3' },
  }, { token: null, headers });
}

async function exchange(ticket: string, verifier: string, headers: HeadersInit = {}): Promise<ApiResponse<unknown>> {
  return exchangeAt(base, ticket, verifier, headers);
}

async function issueOwnerToken(session_id: string): Promise<string> {
  const data = successful(await requestAt<{ token: string }>(base, 'POST', '/api/session-access/tokens', {
    session_id, scopes: ['read'], client: { name: 'example-owner' }, ttl_seconds: 60,
  }));
  return data.token;
}

async function connectSocket(token: string): Promise<ConnectedSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`, [`kimi-code.bearer.${token}`]);
  sockets.push(socket);
  socket.on('error', () => undefined);
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => { resolve(); }));
  await opened;
  return { socket, closed };
}

async function enterWeb(): Promise<{ origin: string; cookie: string }> {
  const status = successful(await requestAt(base, 'PUT', '/api/web-access', { mode: 'temporary', port: 0 }));
  expect(status).toBeDefined();
  const link = successful(await requestAt<{ url: string }>(base, 'POST', '/api/web-access/links', {}));
  const url = new URL(link.url);
  const code = url.hash.slice('#access='.length);
  const response = await fetch(`${url.origin}/api/web-access/exchange`, {
    method: 'POST',
    headers: { origin: url.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('Web exchange did not return a session cookie');
  return { origin: url.origin, cookie };
}

beforeEach(async () => {
  vi.stubEnv('KIKI_SEARCH_DISABLED', '1');
  vi.stubEnv('KIKI_EXPERIMENTAL_EXTERNAL_CLIENTS', 'true');
  for (const name of externalDelegationEnvNames) vi.stubEnv(name, undefined);
  home = await mkdtemp(join(tmpdir(), 'session-access-handoff-'));
  await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
  now = Date.now();
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    homeDir: home,
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    disableHostCheck: false,
    sessionAccessClock: () => now,
    sessionAccessPresenceGraceMs: presenceGraceMs,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  for (const presence of presences.splice(0)) await presence.close();
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }
  for (const running of additionalServers.splice(0)) await running.close();
  await server?.close();
  for (const path of [...additionalHomes.splice(0), home]) await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  vi.unstubAllEnvs();
});

describe('session access terminal hand-off over the real server', () => {
  it('requires the owner to request a ticket, then exchanges its S256 ticket without authentication', async () => {
    const session_id = await createSession();
    const holder_id = newHolderId();
    const ticketBody = { session_id, challenge: challengeFor(newVerifier()), holder_id };
    await expect(requestAt(base, 'POST', '/api/session-access/tickets', ticketBody, { token: null }))
      .resolves.toMatchObject({ status: 401, body: { code: 40101, msg: 'local_owner_required' } });
    await expect(requestAt(base, 'POST', '/api/session-access/tickets', ticketBody))
      .resolves.toMatchObject({ status: 409, body: { code: 40901, msg: 'holder_not_present' } });
    await openPresenceAt(base, holder_id);
    const { ticket, verifier, expires_at } = await issueTicket(session_id, holder_id);
    expect(expires_at).toBe(now + 60_000);
    const result = successful(await exchange(ticket, verifier)) as {
      token: string; expires_at: number; session_id: string; scopes: string[]; server_id: string; server_version: string; session_access: number;
    };
    expect(result).toMatchObject({
      expires_at: now + 3_600_000,
      session_id,
      scopes: ['read', 'prompt', 'abort'],
      server_id: server.serverId,
      server_version: expect.any(String),
      session_access: 1,
    });
    const listing = successful(await requestAt<{ tokens: Array<{ session_id: string; scopes: string[]; client: { name: string; version?: string }; channel: string }> }>(base, 'GET', '/api/session-access'));
    expect(listing.tokens).toContainEqual(expect.objectContaining({
      session_id,
      scopes: ['read', 'prompt', 'abort'],
      client: { name: 'example-terminal', version: '1.2.3' },
      channel: 'terminal',
    }));
    expect((await requestAt(base, 'GET', `/api/sessions/${session_id}`, undefined, { token: result.token })).status).toBe(200);
    expectInvalidTicket(await exchange(ticket, verifier));
  });

  it('returns the same exchange error and consumes tickets on a wrong verifier, strict-body failure, expiry, and Origin', async () => {
    const session_id = await createSession();
    const holder_id = newHolderId();
    await openPresenceAt(base, holder_id);
    const wrongVerifierTicket = await issueTicket(session_id, holder_id);
    const wrongVerifier = await exchange(wrongVerifierTicket.ticket, newVerifier());
    expectInvalidTicket(wrongVerifier);
    expectInvalidTicket(await exchange(wrongVerifierTicket.ticket, wrongVerifierTicket.verifier));

    const extraFieldTicket = await issueTicket(session_id, holder_id);
    const strictBody = await requestAt(base, 'POST', '/api/session-access/exchange', {
      ticket: extraFieldTicket.ticket,
      verifier: extraFieldTicket.verifier,
      client: { name: 'example-terminal' },
      extra: true,
    }, { token: null });
    expectInvalidTicket(strictBody);
    expectInvalidTicket(await exchange(extraFieldTicket.ticket, extraFieldTicket.verifier));

    const expiredTicket = await issueTicket(session_id, holder_id);
    now += 60_001;
    expectInvalidTicket(await exchange(expiredTicket.ticket, expiredTicket.verifier));

    for (const origin of [base, 'null', 'https://example.test', 'http://example.kiki-document.localhost']) {
      const originTicket = await issueTicket(session_id, holder_id);
      const originFailure = await exchange(originTicket.ticket, originTicket.verifier, { origin });
      expectInvalidTicket(originFailure);
      expectInvalidTicket(await exchange(originTicket.ticket, originTicket.verifier));
    }

    const invalidAuthorizationTicket = await issueTicket(session_id, holder_id);
    const invalidAuthorization = await requestAt(base, 'POST', '/api/session-access/exchange', {
      ticket: invalidAuthorizationTicket.ticket,
      verifier: newVerifier(),
      client: { name: 'example-terminal', version: '1.2.3' },
    }, { token: null, headers: { authorization: 'Bearer invalid' } });
    expectInvalidTicket(invalidAuthorization);
    expectInvalidTicket(await exchange(invalidAuthorizationTicket.ticket, invalidAuthorizationTicket.verifier));

    const invalidHostTicket = await issueTicket(session_id, holder_id);
    const invalidHost = await requestWithHost(base, 'POST', '/api/session-access/exchange', {
      ticket: invalidHostTicket.ticket,
      verifier: invalidHostTicket.verifier,
      client: { name: 'example-terminal', version: '1.2.3' },
    }, 'rejected.example.test');
    expectInvalidTicket(invalidHost);
    expectInvalidTicket(await exchange(invalidHostTicket.ticket, invalidHostTicket.verifier));
  });

  it.skipIf(nonLoopbackAddress === undefined)('returns the same error to a real non-loopback socket and consumes its ticket', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'session-access-handoff-lan-'));
    additionalHomes.push(remoteHome);
    const remote = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: remoteHome,
      host: '0.0.0.0',
      bindClass: 'lan',
      insecureNoTls: true,
      port: 0,
      logLevel: 'silent',
      sessionAccessClock: () => now,
      sessionAccessPresenceGraceMs: presenceGraceMs,
    });
    additionalServers.push(remote);
    const loopback = `http://127.0.0.1:${remote.port}`;
    const nonLoopback = `http://${nonLoopbackAddress}:${remote.port}`;
    const session_id = await createSession(loopback, remote.localOwnerToken);
    const holder_id = newHolderId();
    await openPresenceAt(loopback, holder_id, remote.localOwnerToken);
    const { ticket, verifier } = await issueTicketAt(loopback, session_id, holder_id, newVerifier(), remote.localOwnerToken);
    expectInvalidTicket(await exchangeAt(nonLoopback, ticket, verifier));
    expectInvalidTicket(await exchangeAt(loopback, ticket, verifier));
  });

  it('drops the oldest ticket once a holder has more than eight unexpired tickets', async () => {
    const session_id = await createSession();
    const holder_id = newHolderId();
    await openPresenceAt(base, holder_id);
    const tickets: TicketAndVerifier[] = [];
    for (let index = 0; index < 9; index += 1) tickets.push(await issueTicket(session_id, holder_id));
    expectInvalidTicket(await exchange(tickets[0]!.ticket, tickets[0]!.verifier));
    expect(successful(await exchange(tickets[8]!.ticket, tickets[8]!.verifier))).toMatchObject({ session_id, scopes: ['read', 'prompt', 'abort'] });
  });

  it('preserves tokens when the holder reconnects inside grace and revokes them after a later disconnect', async () => {
    const session_id = await createSession();
    const holder_id = newHolderId();
    const first = await openPresenceAt(base, holder_id);
    const firstTicket = await issueTicket(session_id, holder_id);
    const terminal = successful(await exchange(firstTicket.ticket, firstTicket.verifier)) as { token: string };
    await first.close();
    await delay(10);
    const reconnected = await openPresenceAt(base, holder_id);
    await delay(presenceGraceMs * 2);
    expect((await requestAt(base, 'GET', `/api/sessions/${session_id}`, undefined, { token: terminal.token })).status).toBe(200);

    const pendingTicket = await issueTicket(session_id, holder_id);
    await reconnected.close();
    await delay(presenceGraceMs * 2);
    expectInvalidTicket(await exchange(pendingTicket.ticket, pendingTicket.verifier));
    expect((await requestAt(base, 'GET', `/api/sessions/${session_id}`, undefined, { token: terminal.token })).status).toBe(401);
  });

  it('selectively and wholly releases tickets and tokens and closes attached WebSocket connections', async () => {
    const firstSession = await createSession();
    const secondSession = await createSession();
    const holder_id = newHolderId();
    await openPresenceAt(base, holder_id);
    const firstTicket = await issueTicket(firstSession, holder_id);
    const firstToken = successful(await exchange(firstTicket.ticket, firstTicket.verifier)) as { token: string };
    const firstSocket = await connectSocket(firstToken.token);
    const firstPending = await issueTicket(firstSession, holder_id);
    const secondTicket = await issueTicket(secondSession, holder_id);
    const secondToken = successful(await exchange(secondTicket.ticket, secondTicket.verifier)) as { token: string };
    const secondSocket = await connectSocket(secondToken.token);
    const secondPending = await issueTicket(secondSession, holder_id);

    const selective = successful(await requestAt<{ revoked: number }>(base, 'POST', '/api/session-access/release', { holder_id, session_id: firstSession }));
    expect(selective.revoked).toBe(2);
    await firstSocket.closed;
    expect((await requestAt(base, 'GET', `/api/sessions/${firstSession}`, undefined, { token: firstToken.token })).status).toBe(401);
    expect((await requestAt(base, 'GET', `/api/sessions/${secondSession}`, undefined, { token: secondToken.token })).status).toBe(200);
    expectInvalidTicket(await exchange(firstPending.ticket, firstPending.verifier));
    const secondPendingToken = successful(await exchange(secondPending.ticket, secondPending.verifier)) as { token: string };
    const allPending = await issueTicket(secondSession, holder_id);

    const all = successful(await requestAt<{ revoked: number }>(base, 'POST', '/api/session-access/release', { holder_id }));
    expect(all.revoked).toBe(3);
    await secondSocket.closed;
    for (const token of [secondToken.token, secondPendingToken.token]) {
      expect((await requestAt(base, 'GET', `/api/sessions/${secondSession}`, undefined, { token })).status).toBe(401);
    }
    expectInvalidTicket(await exchange(allPending.ticket, allPending.verifier));
  });

  it('gates terminal hand-off independently from owner-channel tokens', async () => {
    const session_id = await createSession();
    const holder_id = newHolderId();
    await openPresenceAt(base, holder_id);
    const ownerToken = await issueOwnerToken(session_id);
    const terminalTicket = await issueTicket(session_id, holder_id);
    const terminalToken = successful(await exchange(terminalTicket.ticket, terminalTicket.verifier)) as { token: string };
    const pendingTicket = await issueTicket(session_id, holder_id);

    await server.core.accessor.get(IConfigService).set('sessionAccess', { enabled: true, terminalHandoff: false });
    expect((await requestAt(base, 'POST', '/api/session-access/tickets', {
      session_id, challenge: challengeFor(newVerifier()), holder_id,
    })).status).toBe(403);
    expectInvalidTicket(await exchange(pendingTicket.ticket, pendingTicket.verifier));
    expect((await requestAt(base, 'GET', `/api/sessions/${session_id}`, undefined, { token: ownerToken })).status).toBe(200);
    expect((await requestAt(base, 'GET', `/api/sessions/${session_id}`, undefined, { token: terminalToken.token })).status).toBe(401);
  });

  it('disables tickets, presence, release, and exchange when session access is off', async () => {
    const session_id = await createSession();
    const holder_id = newHolderId();
    await openPresenceAt(base, holder_id);
    const pendingTicket = await issueTicket(session_id, holder_id);
    await server.core.accessor.get(IConfigService).set('sessionAccess', { enabled: false, terminalHandoff: true });
    expect((await requestAt(base, 'POST', '/api/session-access/tickets', {
      session_id, challenge: challengeFor(newVerifier()), holder_id,
    })).status).toBe(403);
    expect((await requestAt(base, 'GET', `/api/session-access/holders/${holder_id}/presence`)).status).toBe(403);
    expect((await requestAt(base, 'POST', '/api/session-access/release', { holder_id })).status).toBe(403);
    expectInvalidTicket(await exchange(pendingTicket.ticket, pendingTicket.verifier));
  });

  it('idle-exits while only a holder presence stream remains open', async () => {
    const idleHome = await mkdtemp(join(tmpdir(), 'session-access-handoff-idle-'));
    additionalHomes.push(idleHome);
    const idleServer = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: idleHome,
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      idleExitMs: 800,
      sessionAccessPresenceGraceMs: presenceGraceMs,
    });
    additionalServers.push(idleServer);
    const presence = await openPresenceAt(`http://127.0.0.1:${idleServer.port}`, newHolderId(), idleServer.localOwnerToken);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let didClose: boolean;
    try {
      didClose = await Promise.race([
        idleServer.closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => { resolve(false); }, 5_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await presence.close();
    }
    if (didClose) additionalServers.splice(additionalServers.indexOf(idleServer), 1);
    expect(didClose).toBe(true);
  });

  it('requires the local owner credential for ticket, presence, and release routes', async () => {
    const session_id = await createSession();
    const ownerToken = await issueOwnerToken(session_id);
    const externalConnection = successful(await requestAt<{ connection: { id: string } }>(base, 'POST', '/api/external-clients', {
      name: 'External fixture', workspace: home, mode: 'manual',
    }));
    const externalToken = await new ExternalClientStore(server.core).credential(externalConnection.connection.id);
    const seat = successful(await requestAt<{ delegationToken: string }>(base, 'POST', '/api/external-delegation/seats', {
      workspace: home, principal: 'fixture-principal', mode: 'auto',
    }));
    await server.admission.setEnabled(true);
    const sourceIdentity = { ...server.admission.identity, hostId: `${server.admission.identity.hostId}-peer` };
    const invitation = await server.admission.invite(sourceIdentity, 'Fixture peer');
    const peer = await server.admission.claim(invitation.invitation, sourceIdentity);
    const web = await enterWeb();
    const holder_id = newHolderId();
    const routes = [
      { method: 'POST', path: '/api/session-access/tickets', body: { session_id, challenge: challengeFor(newVerifier()), holder_id } },
      { method: 'GET', path: `/api/session-access/holders/${holder_id}/presence` },
      { method: 'POST', path: '/api/session-access/release', body: { holder_id } },
    ] as const;
    const credentials: Array<{ name: string; token: string | null; headers?: HeadersInit; endpoint?: string }> = [
      { name: 'peer', token: server.authTokenService.getToken(), headers: { 'x-kiki-connection-grant': peer.grant } },
      { name: 'web cookie', token: null, headers: { cookie: web.cookie, origin: web.origin }, endpoint: web.origin },
      { name: 'external client', token: externalToken.token },
      { name: 'seat delegation', token: seat.delegationToken },
      { name: 'session access', token: ownerToken },
    ];
    for (const credential of credentials) {
      for (const route of routes) {
        const endpoint = credential.endpoint ?? base;
        const response = await requestAt(endpoint, route.method, route.path, 'body' in route ? route.body : undefined, {
          token: credential.token,
          headers: credential.headers,
        });
        expect([401, 403], `${credential.name} on ${route.path}: ${JSON.stringify(response.body)}`).toContain(response.status);
        expect(response.body.code).not.toBe(0);
      }
    }
    const ownerThroughWeb = await requestAt(web.origin, 'POST', '/api/session-access/release', { holder_id }, {
      token: server.localOwnerToken,
      headers: { cookie: web.cookie, origin: web.origin },
    });
    expect(ownerThroughWeb.status).toBe(403);
  });
});
