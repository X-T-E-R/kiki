import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { createConnectionKlient, createKlient } from '@kiki/klient/http';
import { formatPairingUri, MAX_PAIR_SOURCE_WORKSPACES, parsePairingUri, type ConnectionBrokerInput, type MetaResponse } from '@kiki/protocol';
import { IConfigService, IEventService, ISessionManager, IThreadCommunicationService, IThreadMailboxStore, IWorkspaceService } from '@kiki/agent-core-v2';
import { SEND_PEER_THREAD_MESSAGE, type IThreadPeerSendCapability } from '@kiki/agent-core-v2/app/threadCommunication/peerThreadCapability';
import { THREAD_COMMUNICATION_SECTION } from '@kiki/agent-core-v2/app/threadCommunication/configSection';
import { ModelCatalogChanged } from '@kiki/agent-core-v2/app/kosongConfig/discovery';
import { startServer, type RunningServer } from '../src/start';
import { rotateServerToken } from '../src/services/auth/persistentToken';
import { isPeerFrameAllowed } from '../src/services/connections/audience';
import { WS_BEARER_PROTOCOL_PREFIX } from '../src/transport/ws/bearerProtocol';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const servers: RunningServer[] = []; const homes: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0).toReversed()) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
async function boot(disableAuth = false): Promise<RunningServer> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-pair-')); homes.push(home);
  await mkdir(join(home, 'workspace'), { recursive: true });
  const server = await startServer({ homeDir: home, port: 0, hostIdentity: TEST_HOST_IDENTITY, logLevel: 'silent', disableAuth });
  servers.push(server); return server;
}
const endpoint = (server: RunningServer) => `http://127.0.0.1:${server.port}`;
async function claim(server: RunningServer, body: unknown, token?: string) {
  return fetch(endpoint(server) + '/api/remote-connections/pair/claim', {
    method: 'POST', headers: { 'content-type': 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } }, body: JSON.stringify(body),
  });
}

function brokerCall(origin: string, connectionId: string, headers: Record<string, string>, input: ConnectionBrokerInput): Promise<Response> {
  return fetch(`${origin}/api/remote-connections/${connectionId}/call`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
}

async function expectTerminalRestDenied(origin: string, connectionId: string, headers: Record<string, string>, sessionId: string, terminalId: string, reason: string) {
  for (const operation of ['terminals', 'terminalCreate', 'terminal', 'terminalClose']) {
    const params: Record<string, string> = operation === 'terminals' || operation === 'terminalCreate' ? { sessionId } : { sessionId, terminalId };
    const response = await brokerCall(origin, connectionId, headers, { operation, params, body: operation === 'terminalCreate' || operation === 'terminalClose' ? {} : undefined });
    expect(response.status, operation).toBe(403);
    expect(await response.json(), operation).toMatchObject({ msg: reason });
  }
}

describe('short-code pairing on two real servers', () => {
  it('brokers a real shell and evicts the live terminal attachment when execute is removed', async () => {
    const source = await boot(); const target = await boot();
    const owner = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const local = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    try {
      const sessionId = 'remote-pty';
      await owner.global.sessions.create({ sessionId, workDir: join(homes[1]!, 'workspace') });
      const issued = await owner.rest!.connections.createPairCode({ allowBridge: false, trustTier: 'trusted_personal', meshCapabilities: ['read', 'send', 'execute'] });
      const record = await local.rest!.connections.pair({ endpoint: issued.suggestedEndpoints[0]!, code: issued.code, requestBridge: false, backgroundSummary: false });
      const options = { endpoint: endpoint(source), token: source.localOwnerToken, connectionId: record.id };
      let disconnected = false;
      const remote = createConnectionKlient({ ...options, onSocketDiagnostic: (event) => { if (event.kind === 'close') disconnected = true; } });
      try {
        const terminal = remote.terminal;
        await Promise.all([remote.events.on('kosong.changed', () => {}).ready, owner.events.on('kosong.changed', () => {}).ready]);
        expect((await remote.rest!.meta()).capabilities.terminal).toBe(true);
        expect(await terminal.listTerminals(sessionId)).toEqual({ items: [] });
        const windows = process.platform === 'win32';
        const input = (expression: string) => windows ? `set /a ${expression}\r` : `echo $((${expression}))\r`;
        const { id } = await terminal.createTerminal(sessionId, { shell: windows ? 'cmd.exe' : '/bin/sh' });
        try {
          expect((await terminal.listTerminals(sessionId)).items.map((item) => item.id)).toEqual([id]);
          let output = '';
          terminal.onTerminalSignal((signal) => { if (signal.terminalId === id && signal.kind === 'output') output += signal.data; });
          await terminal.terminalAttach(sessionId, id);
          terminal.terminalResize(sessionId, id, 93, 27);
          await vi.waitFor(async () => expect(await terminal.getTerminal(sessionId, id)).toMatchObject({ status: 'running', cols: 93, rows: 27 }));
          terminal.terminalDetach(sessionId, id);
          await terminal.terminalAttach(sessionId, id);
          terminal.terminalInput(sessionId, id, input('19437+361'));
          await vi.waitFor(() => expect(output).toContain('19798'), { timeout: 10_000 });

          const { ownerToken, grantId } = await source.remoteConnections.secrets.read<{ ownerToken: string; grantId: string }>({ connectionId: record.credentialRef, purpose: 'gui' });
          const plaintext = record.endpoint.replace(/^https:/, 'http:');
          const headers = { authorization: `Bearer ${ownerToken}` };
          const plainMeta = await fetch(`${plaintext}/api/meta`, { headers });
          expect(plainMeta.status).toBe(200);
          expect((await plainMeta.json() as { data: MetaResponse }).data.capabilities).not.toHaveProperty('terminal');
          expect((await fetch(`${plaintext}/api/sessions/${sessionId}/terminals`, { headers })).status).toBe(403);

          let localOutput = '';
          owner.terminal.onTerminalSignal((signal) => { if (signal.terminalId === id && signal.kind === 'output') localOutput += signal.data; });
          await owner.terminal.terminalAttach(sessionId, id);
          await owner.rest!.connections.setGrantTrust(grantId, { trustTier: 'restricted_peer' });
          await vi.waitFor(() => expect(disconnected).toBe(true));
          terminal.terminalInput(sessionId, id, input('22717+469'));
          await expectTerminalRestDenied(options.endpoint, record.id, { authorization: `Bearer ${options.token}` }, sessionId, id, 'mesh_capability_denied');
          expect((await remote.rest!.meta()).capabilities).not.toHaveProperty('terminal');

          let socketRefusal: { code?: number; reason?: string } | undefined;
          const reconnected = createConnectionKlient({ ...options, onSocketDiagnostic: (event) => { if (event.kind === 'close') socketRefusal = event; } });
          try {
            await reconnected.events.on('kosong.changed', () => {}).ready;
            await expect(reconnected.terminal.terminalAttach(sessionId, id)).rejects.toThrow('http event socket disconnected');
            expect(socketRefusal).toMatchObject({ code: 1008, reason: 'local_owner_required' });
          } finally { await reconnected.close(); }

          expect(await owner.terminal.getTerminal(sessionId, id)).toMatchObject({ status: 'running' });
          owner.terminal.terminalInput(sessionId, id, input('32801+793'));
          await vi.waitFor(() => expect(localOutput).toContain('33594'), { timeout: 10_000 });
          expect(localOutput).not.toContain('23186');
        } finally { expect(await owner.terminal.closeTerminal(sessionId, id)).toEqual({ closed: true }); }
      } finally { await remote.close(); }
    } finally { await local.close(); await owner.close(); }
  }, 120_000);

  it('keeps shared trusted terminals and connection invalidations out of WebAccess', async () => {
    const source = await boot(); const target = await boot();
    const local = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    const owner = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const sockets: WebSocket[] = [];
    try {
      const sessionId = 'web-shared-pty';
      await owner.global.sessions.create({ sessionId, workDir: join(homes[1]!, 'workspace') });
      const issued = await owner.rest!.connections.createPairCode({ allowBridge: false, trustTier: 'trusted_personal', meshCapabilities: ['read', 'send', 'execute'] });
      const record = await local.rest!.connections.pair({ endpoint: issued.suggestedEndpoints[0]!, code: issued.code, requestBridge: false, backgroundSummary: false });
      const brokeredMeta = await brokerCall(endpoint(source), record.id, { authorization: `Bearer ${source.localOwnerToken}` }, { operation: 'meta' });
      expect((await brokeredMeta.json() as { data: MetaResponse }).data.capabilities.terminal).toBe(true);

      const status = await local.rest!.webAccess.enable({ mode: 'persistent', port: 0 });
      await local.rest!.webAccess.setSharedConnections([record.id]);
      const origin = status.url!;
      const link = await local.rest!.webAccess.issueLink();
      const exchange = await fetch(`${origin}/api/web-access/exchange`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ code: new URL(link.url).hash.slice('#access='.length) }),
      });
      expect(exchange.status).toBe(200);
      const headers = { origin, cookie: exchange.headers.get('set-cookie')!.split(';')[0]! };
      const open = (path: string) => {
        const ws = new WebSocket(origin.replace(/^http:/, 'ws:') + path, { headers });
        sockets.push(ws);
        return ws;
      };
      const meta = await brokerCall(origin, record.id, headers, { operation: 'meta' });
      expect(meta.status).toBe(200);
      const { data } = await meta.json() as { data: MetaResponse };
      expect(data.server_home_id).toBe(target.admission.identity.homeId);
      expect(data.capabilities).not.toHaveProperty('terminal');
      expect(data.capabilities.websocket).toBe(true);

      const terminal = await owner.terminal.createTerminal(sessionId, { shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' });
      try {
        await expectTerminalRestDenied(origin, record.id, headers, sessionId, terminal.id, 'local_owner_required');
        const broker = open(`/api/remote-connections/${record.id}/events`);
        await once(broker, 'open');
        const closed = once(broker, 'close');
        broker.send(JSON.stringify({ type: 'terminal_attach', id: 'web-attach', data: { session_id: sessionId, terminal_id: terminal.id } }));
        const [code, reason] = await closed;
        expect([code, reason.toString()]).toEqual([1008, 'operation not allowed']);
      } finally { await owner.terminal.closeTerminal(sessionId, terminal.id); }

      const klientSocket = open('/api/klient/events');
      const legacySocket = open('/api/ws');
      const klientEvents: string[] = []; const legacyEvents: string[] = [];
      const subscribed = Promise.withResolvers<void>();
      klientSocket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'subscribed' && frame.id === 'core-events') subscribed.resolve();
        if (frame.type === 'event' && frame.id === 'core-events') klientEvents.push(frame.data.type);
      });
      legacySocket.on('message', (raw) => legacyEvents.push(JSON.parse(raw.toString()).type));
      await Promise.all([once(klientSocket, 'open'), once(legacySocket, 'open')]);
      klientSocket.send(JSON.stringify({ type: 'subscribe', id: 'core-events', scope: 'core', event: 'events' }));
      await subscribed.promise;

      const invalidated = Promise.withResolvers<void>();
      const observer = local.events.on('connections.changed', () => invalidated.resolve());
      await observer.ready;
      await local.rest!.connections.setEnabled(record.id, false);
      await invalidated.promise;
      observer.dispose();
      source.core.accessor.get(IEventService).publish(new ModelCatalogChanged({ payload: { changed: [], unchanged: [], failed: [] } }));
      await vi.waitFor(() => {
        expect(klientEvents).toContain('event.model_catalog.changed');
        expect(legacyEvents).toContain('event.model_catalog.changed');
      });
      expect(klientEvents).not.toContain('event.remote_connections.changed');
      expect(legacyEvents).not.toContain('event.remote_connections.changed');
    } finally {
      for (const socket of sockets) socket.terminate();
      await local.close(); await owner.close();
    }
  }, 120_000);

  it('invalidates local connection and bridge views without forwarding the private event to peers', async () => {
    const source = await boot(); const target = await boot();
    const local = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    const owner = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const localEvents: { revision: number; at: number }[] = [];
    const targetEvents: { revision: number; at: number }[] = [];
    const localSub = local.events.on('connections.changed', (event) => localEvents.push(event));
    const targetSub = owner.events.on('connections.changed', (event) => targetEvents.push(event));
    const legacy = new WebSocket(`${endpoint(target).replace(/^http:/, 'ws:')}/api/ws`, `${WS_BEARER_PROTOCOL_PREFIX}${target.localOwnerToken}`);
    const legacyEvents: unknown[] = [];
    legacy.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'event.remote_connections.changed') legacyEvents.push(event.payload);
    });
    try {
      await Promise.all([localSub.ready, targetSub.ready, once(legacy, 'open')]);
      const code = await owner.rest!.connections.createPairCode({ allowBridge: false });
      await vi.waitFor(() => {
        expect(targetEvents).toHaveLength(1);
        expect(legacyEvents).toEqual([expect.objectContaining(targetEvents[0]!)]);
      });
      const record = await local.rest!.connections.pair({ endpoint: code.suggestedEndpoints[0]!, code: code.code, requestBridge: false, backgroundSummary: false });
      await vi.waitFor(() => { expect(localEvents).toHaveLength(1); expect(targetEvents).toHaveLength(2); });
      const remote = createConnectionKlient({ endpoint: endpoint(source), token: source.localOwnerToken, connectionId: record.id });
      const leaked: unknown[] = [];
      const peerSub = remote.events.on('connections.changed', (event) => leaked.push(event));
      const catalogReceived = Promise.withResolvers<void>();
      const catalogSub = remote.events.on('kosong.changed', () => catalogReceived.resolve());
      try {
        await Promise.all([peerSub.ready, catalogSub.ready]);
        const bridge = await owner.rest!.threadBridges.approve({
          label: 'Manual bridge', source: source.admission.identity, target: target.admission.identity,
          sourceScope: { workspaceId: '*' }, targetScope: { workspaceId: '*' },
          operations: ['read'], expiresAt: Date.now() + 60_000, pendingLimit: 10, messagesPerMinute: 10, location: 'network',
        });
        await vi.waitFor(() => expect(targetEvents).toHaveLength(3));
        await owner.rest!.threadBridges.setOperations(bridge.grant.id, ['read', 'send']);
        await vi.waitFor(() => expect(targetEvents).toHaveLength(4));
        await owner.rest!.threadBridges.revoke('inbound', bridge.grant.id);
        await vi.waitFor(() => expect(targetEvents).toHaveLength(5));
        target.core.accessor.get(IEventService).publish(new ModelCatalogChanged({ payload: { changed: [], unchanged: [], failed: [] } }));
        await catalogReceived.promise;
        expect(leaked).toEqual([]);
      } finally { catalogSub.dispose(); peerSub.dispose(); await remote.close(); }
      await local.rest!.connections.setEnabled(record.id, false);
      await vi.waitFor(() => expect(localEvents).toHaveLength(2));
      await local.rest!.connections.remove(record.id);
      await vi.waitFor(() => expect(localEvents).toHaveLength(3));
      for (const events of [localEvents, targetEvents]) {
        expect(events).toEqual(events.map((_, index) => ({ revision: index + 1, at: expect.any(Number) })));
      }
    } finally { legacy.terminate(); localSub.dispose(); targetSub.dispose(); await local.close(); await owner.close(); }
  }, 120_000);

  it('encrypts pairing, hello, broker HTTP and WS on the LAN wire and rotates the grant in place', async () => {
    const source = await boot(); const target = await boot();
    const client = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    const targetClient = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const issued = await targetClient.rest!.connections.createPairCode({ allowBridge: false });
    const lan = new URL(issued.suggestedEndpoints[0]!);
    const captured: Buffer[] = []; const firstBytes: number[] = []; const sockets = new Set<Socket>();
    const relay = createServer((socket) => {
      const upstream = connect({ host: lan.hostname, port: Number(lan.port) });
      for (const active of [socket, upstream]) { sockets.add(active); active.once('close', () => sockets.delete(active)); active.on('error', () => active.destroy()); }
      socket.once('data', (data: Buffer) => firstBytes.push(data[0]!));
      socket.on('data', (data: Buffer) => captured.push(Buffer.from(data)));
      upstream.on('data', (data: Buffer) => captured.push(Buffer.from(data)));
      socket.pipe(upstream); upstream.pipe(socket);
    });
    relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
    const address = relay.address(); if (address === null || typeof address === 'string') throw new Error('No relay address');
    const via = `http://127.0.0.1:${address.port}`;
    const body = 'unique encrypted broker message';
    let ws: WebSocket | undefined;
    try {
      const record = await client.rest!.connections.pair({ endpoint: formatPairingUri({ endpoint: via, code: issued.code, fingerprint: issued.tlsFingerprint }), code: issued.code, label: 'My target', backgroundSummary: false, requestBridge: false });
      expect(record.endpoint).toBe(via.replace(/^http:/, 'https:'));
      expect(record.pinnedFingerprint).toBe(issued.tlsFingerprint);
      const secret = await source.remoteConnections.secrets.read<{ ownerToken: string; grantId: string }>({ connectionId: record.credentialRef, purpose: 'gui' });
      const lease = source.remoteConnections.lease(record.id);
      try {
        const response = await source.remoteConnections.forward(record.id, { operation: 'sessionCreate', body: { work_dir: join(homes[1]!, 'workspace'), session_id: 'encrypted-session', title: body } }, lease.signal);
        expect(response.status).toBe(200); await response.body?.cancel();
      } finally { lease.release(); }
      ws = new WebSocket(`${endpoint(source).replace(/^http:/, 'ws:')}/api/remote-connections/${record.id}/events`, `${WS_BEARER_PROTOCOL_PREFIX}${source.localOwnerToken}`);
      ws.on('error', () => {});
      await once(ws, 'open');
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No broker subscription acknowledgement')), 15000);
        ws!.on('message', (raw) => { if (raw.toString().includes(body)) { clearTimeout(timer); resolve(); } });
      });
      ws.send(JSON.stringify({ type: 'subscribe', id: body, scope: 'core', service: 'modelService', event: 'onDidChangeModels' })); await ready;
      const oldClosed = once(ws, 'close');
      const next = await targetClient.rest!.connections.createPairCode({ allowBridge: false });
      const replacement = await client.rest!.connections.pair({ endpoint: via, fingerprint: next.tlsFingerprint, code: next.code, backgroundSummary: true, requestBridge: false });
      await oldClosed;
      expect(replacement).toMatchObject({ id: record.id, label: 'My target', backgroundSummary: false, enabled: true });
      expect(source.remoteConnections.list().filter((entry) => entry.purposes.includes('gui'))).toHaveLength(1);
      expect(target.admission.status().grants.filter((grant) => grant.status === 'approved')).toHaveLength(1);
      const oldToken = await fetch(lan.origin + '/api/meta', { headers: { authorization: `Bearer ${secret.ownerToken}` } });
      expect(oldToken.status).toBe(401);
      expect((await oldToken.json() as { msg: string }).msg).toBe('connection_not_approved');
      const bytes = Buffer.concat(captured);
      expect(firstBytes.length).toBeGreaterThanOrEqual(3);
      expect(firstBytes.every((byte) => byte === 0x16)).toBe(true);
      for (const sensitive of [issued.code, secret.ownerToken, body, 'Authorization:', 'kimi-code.bearer.']) expect(bytes.includes(Buffer.from(sensitive))).toBe(false);
    } finally {
      ws?.terminate(); for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await client.close(); await targetClient.close();
    }
  }, 120_000);
  it('sends the most recently active workspaces first and caps a real outbound pairing claim', async () => {
    const source = await boot();
    const sourceClient = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    const targetIdentity = { homeId: randomUUID(), hostId: 'pair-target', protocol: 1 as const };
    const workspaceService = source.core.accessor.get(IWorkspaceService);
    const workspaces = Array.from({ length: MAX_PAIR_SOURCE_WORKSPACES + 1 }, (_, index) => ({ id: `recent-${index}`, lastOpenedAt: 100_000 - index })) as unknown as Awaited<ReturnType<typeof workspaceService.list>>;
    const list = vi.spyOn(workspaceService, 'list').mockResolvedValue(workspaces);
    const received: string[][] = [];
    const peer = createHttpServer((request, response) => {
      void (async () => {
        let raw = '';
        for await (const chunk of request) raw += String(chunk);
        const body = JSON.parse(raw) as { sourceWorkspaces?: string[] };
        received.push(body.sourceWorkspaces ?? []);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ code: 0, msg: 'OK', data: { target: targetIdentity, targetLabel: 'Pair target', grantId: randomUUID(), revision: 1, peerToken: 'p'.repeat(43) } }));
      })().catch(() => { response.statusCode = 500; response.end(); });
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    const address = peer.address(); if (address === null || typeof address === 'string') throw new Error('No pair target address');
    try {
      const paired = await sourceClient.rest!.connections.pair({ endpoint: `http://127.0.0.1:${address.port}`, code: 'K9F2-7X4M', backgroundSummary: false, requestBridge: true });
      expect(paired.target).toEqual(targetIdentity);
      expect(received).toEqual([workspaces.slice(0, MAX_PAIR_SOURCE_WORKSPACES).map((workspace) => workspace.id)]);
    } finally {
      list.mockRestore();
      await sourceClient.close();
      peer.closeAllConnections();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  }, 120_000);
  it('pairs GUI and bridge over a real non-loopback endpoint, defers thread enablement until claim succeeds, and revokes only the paired bridge grant', async () => {
    const source = await boot(); const target = await boot();
    const sourceClient = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    const targetClient = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const sourceWorkDir = join(homes[0]!, 'workspace');
    const targetWorkDir = join(homes[1]!, 'workspace');
    const extraSourceWorkDir = join(homes[0]!, 'workspace-extra');
    await mkdir(extraSourceWorkDir, { recursive: true });
    try {
      await sourceClient.global.sessions.create({ sessionId: 'pair-source-extra', workDir: extraSourceWorkDir });
      await sourceClient.global.sessions.create({ sessionId: 'pair-source', workDir: sourceWorkDir });
      await targetClient.global.sessions.create({ sessionId: 'pair-target', workDir: targetWorkDir });
      await target.core.accessor.get(ISessionManager).close('pair-target');
      const sourceConfig = source.core.accessor.get(IConfigService);
      const targetConfig = target.core.accessor.get(IConfigService);
      expect(sourceConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      expect(targetConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      const created = await targetClient.rest!.connections.createPairCode({ bridgeOperations: ['read', 'send', 'wait', 'wake'] });
      expect(created.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
      expect(target.admission.status().enabled).toBe(true);
      expect(created.suggestedEndpoints.length).toBeGreaterThan(0);
      const nonLoopback = created.suggestedEndpoints[0]!;
      expect(['127.0.0.1', 'localhost', '::1', '[::1]']).not.toContain(new URL(nonLoopback).hostname);
      const pairUri = formatPairingUri({ endpoint: nonLoopback, code: created.code });
      expect(parsePairingUri(pairUri)).toEqual({ endpoint: nonLoopback, code: created.code });
      const unauthOwnerRoute = await fetch(`${nonLoopback}/api/remote-connections`);
      expect(unauthOwnerRoute.status).toBe(401);
      const nonLoopbackAnonHandshake = await fetch(`${nonLoopback}/api/remote-connections/handshake`, { headers: { accept: 'application/json' } });
      expect(nonLoopbackAnonHandshake.status).toBe(200);
      expect(nonLoopbackAnonHandshake.headers.get('cache-control')).toBe('no-store');
      const nonLoopbackAnonData = (await nonLoopbackAnonHandshake.json() as { data: { identity: { homeId: string; hostId: string; protocol: number }; targetLabel?: string; serverId: string; inboundEnabled: boolean } }).data;
      expect(nonLoopbackAnonData.identity).toEqual(target.admission.identity);
      expect(nonLoopbackAnonData.targetLabel).toBeUndefined();
      const nonLoopbackBadBearer = await fetch(`${nonLoopback}/api/remote-connections/handshake`, { headers: { accept: 'application/json', authorization: 'Bearer wrong-token' } });
      expect(nonLoopbackBadBearer.status).toBe(401);
      await expect(sourceClient.rest!.connections.pair({ endpoint: nonLoopback, code: 'BBBB-BBBB', backgroundSummary: true })).rejects.toThrow('invalid_pairing_code');
      expect(sourceConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      expect(targetConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      const record = await sourceClient.rest!.connections.pair({ endpoint: pairUri, code: created.code, backgroundSummary: true });
      expect(record.endpoint).toBe(nonLoopback.replace(/^http:/, 'https:'));
      expect(record.pinnedFingerprint).toBe(created.tlsFingerprint);
      expect(record.fingerprintToVerify).toBe(created.tlsFingerprint);
      expect(record.purposes).toEqual(['gui', 'bridge']);
      expect(record.label.length).toBeGreaterThan(0);
      expect(sourceConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).toBe(true);
      expect(targetConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).toBe(true);
      const secret = await source.remoteConnections.secrets.read<{ ownerToken: string; grant: string; grantId: string }>({ connectionId: record.credentialRef, purpose: 'gui' });
      expect(secret.ownerToken).toBe(secret.grant);
      expect(secret.ownerToken).not.toBe(target.authTokenService.getToken());
      expect(secret.ownerToken).not.toBe(target.localOwnerToken);
      const peerOwnerAttempt = await fetch(`${nonLoopback}/api/remote-connections`, { headers: { authorization: `Bearer ${secret.ownerToken}`, 'x-kiki-connection-grant': secret.grant } });
      expect(peerOwnerAttempt.status).toBe(403);
      const peerShutdownAttempt = await fetch(`${nonLoopback}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${target.localOwnerToken}` } });
      expect(peerShutdownAttempt.status).toBe(403);
      const targetBridgesBefore = await targetClient.rest!.threadBridges.status();
      expect(targetBridgesBefore.inbound).toHaveLength(1);
      expect(targetBridgesBefore.inbound[0]!.operations).toEqual(['read', 'send', 'wait', 'wake']);
      expect((await sourceClient.rest!.threadBridges.status()).outbound).toHaveLength(1);
      const mobileCreated = await targetClient.rest!.connections.createPairCode({});
      const mobileScanned = parsePairingUri(formatPairingUri({ endpoint: nonLoopback, code: mobileCreated.code }))!;
      const mobileClaimRes = await fetch(`${mobileScanned.endpoint}/api/remote-connections/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: mobileScanned.code, source: { homeId: '22222222-2222-4222-8222-222222222222', hostId: 'mobile-device', protocol: 1 }, sourceLabel: 'Mobile Phone', requestBridge: false }),
      });
      expect(mobileClaimRes.status).toBe(200);
      const mobileClaimed = (await mobileClaimRes.json() as { data: { peerToken: string; grantId: string; bridge?: unknown } }).data;
      expect(mobileClaimed.bridge).toBeUndefined();
      expect((await targetClient.rest!.threadBridges.status()).inbound).toHaveLength(1);
      const mobileMetaRes = await fetch(`${mobileScanned.endpoint}/api/meta`, { headers: { authorization: `Bearer ${mobileClaimed.peerToken}`, 'x-kiki-connection-grant': mobileClaimed.peerToken } });
      expect(mobileMetaRes.status).toBe(200);
      const mobileDirectClient = createKlient({ endpoint: mobileScanned.endpoint, token: mobileClaimed.peerToken });
      try {
        expect((await mobileDirectClient.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
        const catalogSubs = [
          mobileDirectClient.events.on('config.changed', () => undefined),
          mobileDirectClient.events.on('kosong.models.changed', () => undefined),
          mobileDirectClient.events.on('kosong.providers.changed', () => undefined),
          mobileDirectClient.events.on('plugins.reloaded', () => undefined),
          mobileDirectClient.session('pair-target').events.on('execution.changed', () => undefined),
        ];
        try {
          await Promise.all(catalogSubs.map((sub) => sub.ready));
          const mobileSnapshot = await new Promise<{ readonly session: { readonly id: string } }>((resolve, reject) => {
            const timeout = setTimeout(() => { sub.close(); reject(new Error('mobile peer WS view bootstrap timed out')); }, 10_000);
            const sub = mobileDirectClient.session('pair-target').view.bootstrap!({ transcriptGrades: { main: 'delta' } }, (signal) => {
              if (signal.type === 'snapshot') {
                clearTimeout(timeout);
                sub.close();
                resolve(signal.snapshot);
              } else if (signal.type === 'protocolError') {
                clearTimeout(timeout);
                sub.close();
                reject(new Error(signal.detail));
              }
            });
          });
          expect(mobileSnapshot.session.id).toBe('pair-target');
        } finally {
          for (const sub of catalogSubs) sub.dispose();
        }
      } finally {
        await mobileDirectClient.close();
      }
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 's-provider', scope: 'core', service: 'providerService', event: 'onDidChangeProviders' })).toBe(true);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 's-model', scope: 'core', service: 'modelService', event: 'onDidChangeModels' })).toBe(true);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 's-plugin', scope: 'core', service: 'pluginService', event: 'onDidReload' })).toBe(true);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 's-exec', scope: 'session', sessionId: 'pair-target', service: 'sessionExecutionControl', event: 'onDidChange' })).toBe(true);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 'bad-plugin-1', scope: 'core', service: 'pluginService', event: 'onWillChange' })).toBe(false);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 'bad-plugin-2', scope: 'core', service: 'pluginService', event: 'onDidMutate' })).toBe(false);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 'bad-provider-1', scope: 'core', service: 'providerService', event: 'onDidChangeDefaultProvider' })).toBe(false);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 'bad-provider-scope', scope: 'session', sessionId: 'pair-target', service: 'providerService', event: 'onDidChangeProviders' })).toBe(false);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 'bad-model-1', scope: 'core', service: 'modelService', event: 'onDidChangeDefaultModel' })).toBe(false);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 'bad-exec-scope', scope: 'core', service: 'sessionExecutionControl', event: 'onDidChange' })).toBe(false);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 'bad-exec-agent', scope: 'agent', sessionId: 'pair-target', agentId: 'main', service: 'sessionExecutionControl', event: 'onDidChange' })).toBe(false);
      expect(isPeerFrameAllowed({ type: 'subscribe', id: 'bad-exec-event', scope: 'session', sessionId: 'pair-target', service: 'sessionExecutionControl', event: 'onWillChange' })).toBe(false);
      const mobileWsUrl = `${mobileScanned.endpoint.replace(/^http/, 'ws')}/api/klient/events`;
      for (const badFrame of [
        { type: 'subscribe', id: 'raw-bad-plugin', scope: 'core', service: 'pluginService', event: 'onWillChange' },
        { type: 'subscribe', id: 'raw-bad-provider', scope: 'core', service: 'providerService', event: 'onDidChangeDefaultProvider' },
      ]) {
        const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
          const ws = new WebSocket(mobileWsUrl, `${WS_BEARER_PROTOCOL_PREFIX}${mobileClaimed.peerToken}`);
          ws.once('open', () => { ws.send(JSON.stringify(badFrame)); });
          ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
          ws.once('error', reject);
        });
        expect(closed).toEqual({ code: 1008, reason: 'local_owner_required' });
      }
      const mismatchedGrantClosed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const ws = new WebSocket(mobileWsUrl, `${WS_BEARER_PROTOCOL_PREFIX}${mobileClaimed.peerToken}`, {
          headers: { 'x-kiki-connection-grant': secret.grant },
        });
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.once('error', reject);
      });
      expect(mismatchedGrantClosed.code).toBe(4001);
      const sourceWorkspaces = await source.core.accessor.get(IWorkspaceService).list();
      const targetWorkspaces = await target.core.accessor.get(IWorkspaceService).list();
      const primarySourceWorkspace = sourceWorkspaces.find((ws) => ws.root === sourceWorkDir) ?? sourceWorkspaces[0]!;
      const extraSourceWorkspace = sourceWorkspaces.find((ws) => ws.root === extraSourceWorkDir) ?? sourceWorkspaces[1]!;
      const targetWorkspace = targetWorkspaces[0]!;
      const separateBridge = await targetClient.rest!.threadBridges.approve({
        source: source.admission.identity,
        target: target.admission.identity,
        sourceScope: { workspaceId: extraSourceWorkspace.id, sessionId: 'pair-source-extra' },
        targetScope: { workspaceId: targetWorkspace.id, sessionId: 'pair-target' },
        operations: ['read', 'send', 'wait'],
        expiresAt: Date.now() + 600_000,
        pendingLimit: 10,
        messagesPerMinute: 20,
        location: 'network',
        label: 'Same Identity Separate Grant',
      });
      await sourceClient.rest!.threadBridges.install({ connectionId: record.id, grant: separateBridge.grant, credential: separateBridge.credential });
      const sourceThreads = source.core.accessor.get(IThreadCommunicationService);
      const peerSend = sourceThreads as unknown as IThreadPeerSendCapability;
      const listed = await sourceThreads.listThreads({ caller: { workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' }, connectionId: record.id });
      const targetThread = listed.threads.find((item) => item.ref.sessionId === 'pair-target');
      expect(targetThread?.ref).toMatchObject({ hostId: target.admission.identity.hostId, workspaceId: targetWorkspace.id, sessionId: 'pair-target', connectionId: record.id });
      const sent = await peerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: source.admission.identity.hostId, workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' },
        target: targetThread!.ref,
        content: 'hello over non-loopback pair',
        idempotencyKey: 'pair-send-1',
      });
      expect(sent.delivery).toBe('delivered');
      const targetMailbox = target.core.accessor.get(IThreadMailboxStore);
      const mailboxBefore = await targetMailbox.readMessages({ group: 'session:pair-target', limit: 10 });
      expect(mailboxBefore.items).toHaveLength(1);
      expect(mailboxBefore.items[0]!.message.producer).toMatchObject({ kind: 'bridged_peer', sourceHomeId: source.admission.identity.homeId, bridgeId: targetBridgesBefore.inbound[0]!.id });
      const paired = createConnectionKlient({ endpoint: endpoint(source), token: source.localOwnerToken, connectionId: record.id });
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      const legacySource = await boot();
      const invitation = await targetClient.rest!.connections.invite({ source: legacySource.admission.identity, label: 'Legacy' });
      const legacy = await legacySource.remoteConnections.add({ label: 'Legacy', endpoint: nonLoopback, target: target.admission.identity, ownerToken: target.authTokenService.getToken(), invitation: invitation.invitation, backgroundSummary: false });
      const legacySecret = await legacySource.remoteConnections.secrets.read<{ ownerToken: string }>({ connectionId: legacy.credentialRef, purpose: 'gui' });
      expect(legacySecret.ownerToken).toBe(target.authTokenService.getToken());
      const legacyView = createConnectionKlient({ endpoint: endpoint(legacySource), token: legacySource.localOwnerToken, connectionId: legacy.id });
      expect((await legacyView.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      expect(legacy.endpoint).toBe(nonLoopback);
      expect(legacy.pinnedFingerprint).toBeUndefined();
      await rotateServerToken(homes[1]!);
      await expect(legacyView.rest!.meta()).rejects.toThrow();
      expect(legacySource.remoteConnections.get(legacy.id).state).toBe('authentication_required');
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      await target.admission.setEnabled(false);
      await expect(paired.rest!.meta()).rejects.toThrow('inbound_disabled');
      await expect(sourceThreads.listThreads({ caller: { workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' }, connectionId: record.id })).rejects.toThrow('inbound_disabled');
      expect(source.remoteConnections.get(record.id)).toMatchObject({ state: 'offline', lastError: 'inbound_disabled' });
      await target.admission.setEnabled(true);
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      const recoveredList = await sourceThreads.listThreads({ caller: { workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' }, connectionId: record.id });
      expect(recoveredList.threads.some((item) => item.ref.sessionId === 'pair-target')).toBe(true);
      expect((await targetMailbox.readMessages({ group: 'session:pair-target', limit: 10 })).items).toHaveLength(1);
      const legacyBridge = targetBridgesBefore.inbound[0]!;
      const legacyBridgeSecret = await source.remoteConnections.secrets.read<{ credential: string }>({ connectionId: legacyBridge.id, purpose: 'bridge' });
      await sourceClient.rest!.threadBridges.install({ connectionId: record.id, grant: { ...legacyBridge, revision: legacyBridge.revision + 1 }, credential: legacyBridgeSecret.credential });
      const reissue = await targetClient.rest!.connections.createPairCode({ allowBridge: false });
      const replacement = await sourceClient.rest!.connections.pair({ endpoint: nonLoopback, code: reissue.code, fingerprint: reissue.tlsFingerprint, backgroundSummary: false, requestBridge: false });
      expect(replacement).toMatchObject({ id: record.id, purposes: ['gui'], backgroundSummary: true, state: 'online' });
      expect(target.admission.status().grants.find((grant) => grant.id === secret.grantId)?.status).toBe('revoked');
      expect((await paired.rest!.meta()).server_home_id).toBe(target.admission.identity.homeId);
      expect((await sourceClient.rest!.threadBridges.status()).outbound.find((link) => link.grant.id === targetBridgesBefore.inbound[0]!.id)?.grant.revoked).toBe(true);
      await expect(sourceThreads.listThreads({ caller: { workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' }, bridgeId: targetBridgesBefore.inbound[0]!.id, connectionId: record.id })).rejects.toThrow('bridge_operation_denied');
      await expect(peerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: source.admission.identity.hostId, workspaceId: primarySourceWorkspace.id, sessionId: 'pair-source' },
        target: targetThread!.ref,
        content: 'after pair revoke',
        idempotencyKey: 'pair-send-revoked',
      })).rejects.toThrow('bridge_operation_denied');
      expect((await targetMailbox.readMessages({ group: 'session:pair-target', limit: 10 })).items).toHaveLength(1);
      const targetBridgesAfter = await targetClient.rest!.threadBridges.status();
      expect(targetBridgesAfter.inbound.find((g) => g.id === targetBridgesBefore.inbound[0]!.id)?.revoked).toBe(true);
      expect(targetBridgesAfter.inbound.find((g) => g.id === separateBridge.grant.id)?.revoked).toBe(false);
      const separateList = await sourceThreads.listThreads({ caller: { workspaceId: extraSourceWorkspace.id, sessionId: 'pair-source-extra' }, bridgeId: separateBridge.grant.id, connectionId: record.id });
      expect(separateList.threads.map((item) => item.ref.sessionId)).toEqual(['pair-target']);
      await paired.close(); await legacyView.close();
    } finally { await sourceClient.close(); await targetClient.close(); }
  }, 120_000);

  it('limits public claims, burns a code, and refuses pairing when authentication is bypassed', async () => {
    const target = await boot(); const stranger = { homeId: '11111111-1111-4111-8111-111111111111', hostId: 'stranger', protocol: 1 as const };
    const anonymousHandshake = await fetch(endpoint(target) + '/api/remote-connections/handshake', { headers: { accept: 'application/json' } });
    expect(anonymousHandshake.status).toBe(200);
    expect(anonymousHandshake.headers.get('cache-control')).toBe('no-store');
    const handshakeBody = await anonymousHandshake.json() as { code: number; data: { identity: { homeId: string; hostId: string; protocol: number }; targetLabel?: string; serverId: string; inboundEnabled: boolean } };
    expect(handshakeBody.code).toBe(0);
    expect(handshakeBody.data.identity).toEqual(target.admission.identity);
    expect(handshakeBody.data.targetLabel).toBeUndefined();
    const authHandshake = await fetch(endpoint(target) + '/api/remote-connections/handshake', { headers: { accept: 'application/json', authorization: `Bearer ${target.localOwnerToken}` } });
    expect(authHandshake.status).toBe(200);
    const authHandshakeBody = await authHandshake.json() as { code: number; data: { identity: { homeId: string; hostId: string; protocol: number }; targetLabel?: string; serverId: string; inboundEnabled: boolean } };
    expect(typeof authHandshakeBody.data.targetLabel).toBe('string');
    expect(authHandshakeBody.data.targetLabel!.length).toBeGreaterThan(0);
    const badBearerHandshake = await fetch(endpoint(target) + '/api/remote-connections/handshake', { headers: { accept: 'application/json', authorization: 'Bearer wrong-token' } });
    expect(badBearerHandshake.status).toBe(401);
    const created = await target.admission.createPairCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await claim(target, { code: 'BBBB-BBBB', source: stranger, sourceLabel: 'Stranger' });
      expect(response.status).toBe(401);
      expect((await response.json() as { msg: string }).msg).toBe('invalid_pairing_code');
    }
    const limited = await claim(target, { code: created.code, source: stranger, sourceLabel: 'Stranger' });
    expect(limited.status).toBe(429);
    expect((await limited.json() as { msg: string }).msg).toBe('pairing_rate_limited');
    const dangerous = await boot(true);
    const refused = await fetch(endpoint(dangerous) + '/api/remote-connections/inbound/pair-code', { method: 'POST', headers: { authorization: `Bearer ${dangerous.localOwnerToken}`, 'content-type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(403);
    expect((await refused.json() as { msg: string }).msg).toBe('dangerous_auth_bypass');
    const open = await claim(dangerous, { code: 'K9F2-7X4M', source: stranger, sourceLabel: 'Stranger' });
    expect(open.status).toBe(403);
  }, 120_000);

  it('narrows bridgeOperations on pair claim without escalating beyond server-approved operations, and routes reverse peer WS bridges with offline pending delivery', async () => {
    const target = await boot();
    const targetClient = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const targetWorkDir = join(homes[0]!, 'workspace');
    const phoneIdentity = { homeId: '33333333-3333-4333-8333-333333333333', hostId: 'mika-phone', protocol: 1 as const };
    const openSockets: WebSocket[] = [];
    try {
      await targetClient.global.sessions.create({ sessionId: 'desktop-main', workDir: targetWorkDir });
      const workspaces = await target.core.accessor.get(IWorkspaceService).list();
      const targetWorkspace = workspaces[0]!;

      const narrowCreated = await targetClient.rest!.connections.createPairCode({});
      const escalateClaim = await claim(target, {
        code: narrowCreated.code,
        source: phoneIdentity,
        sourceLabel: 'Mika Phone',
        requestBridge: true,
        bridgeOperations: ['read', 'send', 'wait', 'wake'],
        sourceWorkspaces: ['phone'],
      });
      expect(escalateClaim.status).toBe(200);
      const claimedData = (await escalateClaim.json() as {
        data: { peerToken: string; grantId: string; bridge?: { grant: { id: string; operations: string[] }; credential: string }[] };
      }).data;
      expect(claimedData.bridge).toHaveLength(1);
      expect(claimedData.bridge![0]!.grant.operations).toEqual(['read', 'send', 'wait']);
      expect(claimedData.bridge![0]!.grant.operations).not.toContain('wake');

      const wakeOnlyCode = await targetClient.rest!.connections.createPairCode({ bridgeOperations: ['read', 'send'] });
      const wakeOnlyClaim = await claim(target, {
        code: wakeOnlyCode.code,
        source: { homeId: '44444444-4444-4444-8444-444444444444', hostId: 'wake-attacker', protocol: 1 },
        sourceLabel: 'Wake Only',
        requestBridge: true,
        bridgeOperations: ['wake'],
        sourceWorkspaces: ['phone'],
      });
      expect(wakeOnlyClaim.status).toBe(403);
      expect((await wakeOnlyClaim.json() as { msg: string }).msg).toBe('bridge_operation_denied');

      const reverseCredential = 'reverse-credential-secret-at-least-32-chars-long';
      const reverseGrantId = '55555555-5555-4555-8555-555555555555';
      const forgedInstall = await fetch(endpoint(target) + '/api/thread-bridges/peer/outbound', {
        method: 'POST',
        headers: { authorization: `Bearer ${claimedData.peerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          grant: {
            id: reverseGrantId,
            revision: 1,
            enabled: true,
            revoked: false,
            createdAt: Date.now(),
            source: target.admission.identity,
            target: { homeId: '66666666-6666-4666-8666-666666666666', hostId: 'forged-phone', protocol: 1 },
            sourceScope: { workspaceId: targetWorkspace.id },
            targetScope: { workspaceId: 'phone' },
            operations: ['read', 'send', 'wait'],
            expiresAt: Date.now() + 600_000,
            pendingLimit: 20,
            messagesPerMinute: 60,
            location: 'network',
            label: 'Forged Phone Bridge',
          },
          credential: reverseCredential,
        }),
      });
      expect(forgedInstall.status).toBe(403);
      expect((await forgedInstall.json() as { msg: string }).msg).toBe('bridge_identity_mismatch');

      const installRes = await fetch(endpoint(target) + '/api/thread-bridges/peer/outbound', {
        method: 'POST',
        headers: { authorization: `Bearer ${claimedData.peerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          grant: {
            id: reverseGrantId,
            revision: 1,
            enabled: true,
            revoked: false,
            createdAt: Date.now(),
            source: target.admission.identity,
            target: phoneIdentity,
            sourceScope: { workspaceId: targetWorkspace.id },
            targetScope: { workspaceId: 'phone' },
            operations: ['read', 'send', 'wait'],
            expiresAt: Date.now() + 600_000,
            pendingLimit: 20,
            messagesPerMinute: 60,
            location: 'network',
            label: 'Mika Phone Reverse',
          },
          credential: reverseCredential,
        }),
      });
      expect(installRes.status).toBe(200);
      const installedLink = (await installRes.json() as { data: { connectionId: string; grant: { id: string } } }).data;
      expect(installedLink.grant.id).toBe(reverseGrantId);

      const wsUrl = `${endpoint(target).replace(/^http/, 'ws')}/api/klient/events`;
      const legacySocket = new WebSocket(wsUrl, `${WS_BEARER_PROTOCOL_PREFIX}${claimedData.peerToken}`);
      openSockets.push(legacySocket);
      await new Promise<void>((resolve, reject) => {
        legacySocket.once('open', () => resolve());
        legacySocket.once('error', reject);
      });

      const threads = target.core.accessor.get(IThreadCommunicationService);
      const peerSend = threads as unknown as IThreadPeerSendCapability;
      const phoneThreadRef = {
        hostId: phoneIdentity.hostId,
        workspaceId: 'phone',
        sessionId: 'phone-conv-1',
        bridgeId: reverseGrantId,
        connectionId: installedLink.connectionId,
      };
      const offlineQueued = await peerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: target.admission.identity.hostId, workspaceId: targetWorkspace.id, sessionId: 'desktop-main' },
        target: phoneThreadRef,
        content: 'Message while phone bridge not attached.',
        idempotencyKey: 'reverse-msg-1',
      });
      expect(offlineQueued.delivery).toBe('pending');
      const receiptsWhileOffline = await targetClient.rest!.threadBridges.receipts();
      expect(receiptsWhileOffline.items[0]).toMatchObject({ bridgeId: reverseGrantId, delivery: 'pending', reason: 'target_temporarily_unavailable' });

      const seenIdempotency = new Map<string, { content: string; messageId: string; targetSeq: number; acceptedAt: number }>();
      let seq = 0;
      const bridgeSocket = new WebSocket(wsUrl, `${WS_BEARER_PROTOCOL_PREFIX}${claimedData.peerToken}`);
      openSockets.push(bridgeSocket);
      const attached = new Promise<void>((resolve, reject) => {
        bridgeSocket.on('message', (raw) => {
          const frame = JSON.parse(String(raw)) as { type: string; id?: string; data?: Record<string, unknown> };
          if (frame.type === 'ping') {
            bridgeSocket.send(JSON.stringify({ type: 'pong', data: frame.data }));
            return;
          }
          if (frame.type === 'bridge_attached') {
            resolve();
            return;
          }
          if (frame.type === 'bridge_request' && typeof frame.id === 'string' && frame.data !== undefined) {
            const auth = frame.data['authorization'];
            const op = frame.data['operation'];
            const body = frame.data['body'] as Record<string, unknown>;
            if (auth !== `Bearer ${reverseCredential}`) {
              bridgeSocket.send(JSON.stringify({ type: 'bridge_response', id: frame.id, data: { status: 401, envelope: { code: 40101, msg: 'invalid_bridge_credential' } } }));
              return;
            }
            if (op === 'list') {
              bridgeSocket.send(JSON.stringify({
                type: 'bridge_response',
                id: frame.id,
                data: {
                  status: 200,
                  envelope: {
                    code: 0,
                    msg: 'OK',
                    data: {
                      identity: phoneIdentity,
                      result: {
                        threads: [{
                          ref: { hostId: phoneIdentity.hostId, workspaceId: 'phone', sessionId: 'phone-conv-1' },
                          title: 'Phone Daily Thread',
                          createdAt: 1000,
                          updatedAt: 2000,
                          state: 'idle',
                        }],
                      },
                    },
                  },
                },
              }));
              return;
            }
            if (op === 'send') {
              const key = String(body['idempotencyKey']);
              const content = String(body['content']);
              const prev = seenIdempotency.get(key);
              if (prev !== undefined && prev.content !== content) {
                bridgeSocket.send(JSON.stringify({ type: 'bridge_response', id: frame.id, data: { status: 409, envelope: { code: 40101, msg: 'bridge_idempotency_conflict' } } }));
                return;
              }
              const entry = prev ?? { content, messageId: `phone-msg-${++seq}`, targetSeq: seq, acceptedAt: Date.now() };
              seenIdempotency.set(key, entry);
              bridgeSocket.send(JSON.stringify({
                type: 'bridge_response',
                id: frame.id,
                data: {
                  status: 200,
                  envelope: {
                    code: 0,
                    msg: 'OK',
                    data: {
                      identity: phoneIdentity,
                      result: {
                        messageId: entry.messageId,
                        targetSeq: entry.targetSeq,
                        acceptedAt: entry.acceptedAt,
                        deduplicated: prev !== undefined,
                        delivery: 'pending',
                      },
                    },
                  },
                },
              }));
            }
          }
        });
        bridgeSocket.once('open', () => {
          bridgeSocket.send(JSON.stringify({ type: 'bridge_attach', id: 'attach-1', data: { operations: ['list', 'read', 'send', 'wait'] } }));
        });
        bridgeSocket.once('error', reject);
      });
      await attached;

      const listed = await threads.listThreads({ caller: { workspaceId: targetWorkspace.id, sessionId: 'desktop-main' }, bridgeId: reverseGrantId });
      expect(listed.threads.map((item) => item.title)).toEqual(['Phone Daily Thread']);

      const waitAccepted = async () => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const page = await targetClient.rest!.threadBridges.receipts();
          const item = page.items.find((entry) => entry.bridgeId === reverseGrantId);
          if (item?.delivery === 'accepted') return item;
          if (Date.now() >= deadline) throw new Error(`expected accepted receipt, got ${JSON.stringify(page.items)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const acceptedReceipt = await waitAccepted();
      expect(acceptedReceipt.messageId).toBe('phone-msg-1');
      expect(seenIdempotency.get('reverse-msg-1')?.content).toBe('Message while phone bridge not attached.');

      const duplicate = await peerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: target.admission.identity.hostId, workspaceId: targetWorkspace.id, sessionId: 'desktop-main' },
        target: phoneThreadRef,
        content: 'Message while phone bridge not attached.',
        idempotencyKey: 'reverse-msg-1',
      });
      expect(duplicate).toMatchObject({ deduplicated: true, messageId: 'phone-msg-1', delivery: 'pending' });
      await expect(peerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: target.admission.identity.hostId, workspaceId: targetWorkspace.id, sessionId: 'desktop-main' },
        target: phoneThreadRef,
        content: 'Changed payload.',
        idempotencyKey: 'reverse-msg-1',
      })).rejects.toThrow('bridge_idempotency_conflict');

      const revokeRes = await fetch(endpoint(target) + `/api/thread-bridges/peer/outbound/${reverseGrantId}/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${claimedData.peerToken}` },
      });
      expect(revokeRes.status).toBe(200);
      await expect(threads.listThreads({ caller: { workspaceId: targetWorkspace.id, sessionId: 'desktop-main' }, bridgeId: reverseGrantId })).rejects.toThrow('bridge_operation_denied');
    } finally {
      for (const ws of openSockets) ws.terminate();
      await targetClient.close();
    }
  }, 120_000);

  it('automatically establishes bidirectional Kiki Space bridges via OutboundPeerBridgeClient for a loopback-only mobile Kiki, supporting list/read/send/wait without implicit wake and reconnecting on notifyNetworkChange', async () => {
    const mobile = await boot();
    const desktop = await boot();
    const mobileClient = createKlient({ endpoint: endpoint(mobile), token: mobile.localOwnerToken });
    const desktopClient = createKlient({ endpoint: endpoint(desktop), token: desktop.localOwnerToken });
    const mobileWorkDir = join(homes[0]!, 'workspace');
    const desktopWorkDir = join(homes[1]!, 'workspace');
    try {
      await mobileClient.global.sessions.create({ sessionId: 'mobile-main', workDir: mobileWorkDir });
      await desktopClient.global.sessions.create({ sessionId: 'desktop-main', workDir: desktopWorkDir });
      await mobile.core.accessor.get(ISessionManager).close('mobile-main');
      await desktop.core.accessor.get(ISessionManager).close('desktop-main');

      const pairCode = await desktopClient.rest!.connections.createPairCode({});
      const nonLoopback = pairCode.suggestedEndpoints[0]!;
      const pairedRecord = await mobileClient.rest!.connections.pair({
        endpoint: formatPairingUri({ endpoint: nonLoopback, code: pairCode.code }),
        code: pairCode.code,
        backgroundSummary: true,
      });
      expect(pairedRecord.purposes).toEqual(['gui', 'bridge']);

      const waitForReverseBridge = async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const status = await desktopClient.rest!.threadBridges.status();
          const reverse = status.outbound.find((link) => link.grant.target.homeId === mobile.admission.identity.homeId && link.enabled && !link.grant.revoked);
          if (reverse !== undefined) return reverse;
          if (Date.now() >= deadline) throw new Error(`expected desktop outbound reverse bridge, got ${JSON.stringify(status)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const reverseLink = await waitForReverseBridge();
      expect(reverseLink.grant.operations).toEqual(['read', 'send', 'wait']);
      expect(reverseLink.grant.operations).not.toContain('wake');

      const desktopStatus = await desktopClient.rest!.threadBridges.status();
      expect(desktopStatus.inbound[0]?.operations).toEqual(['read', 'send', 'wait']);
      expect(desktopStatus.inbound[0]?.operations).not.toContain('wake');

      const mobileWorkspaces = await mobile.core.accessor.get(IWorkspaceService).list();
      const desktopWorkspaces = await desktop.core.accessor.get(IWorkspaceService).list();
      const mobileWorkspace = mobileWorkspaces[0]!;
      const desktopWorkspace = desktopWorkspaces[0]!;

      const desktopThreads = desktop.core.accessor.get(IThreadCommunicationService);
      const mobileThreads = mobile.core.accessor.get(IThreadCommunicationService);
      const desktopPeerSend = desktopThreads as unknown as IThreadPeerSendCapability;
      const mobilePeerSend = mobileThreads as unknown as IThreadPeerSendCapability;

      const waitMobileThreadsListed = async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          try {
            const listed = await desktopThreads.listThreads({
              caller: { workspaceId: desktopWorkspace.id, sessionId: 'desktop-main' },
              bridgeId: reverseLink.grant.id,
            });
            if (listed.threads.some((t) => t.ref.sessionId === 'mobile-main')) return listed;
          } catch {
          }
          if (Date.now() >= deadline) throw new Error('timed out waiting for reverse WS bridge_attach to serve listThreads');
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const mobileListed = await waitMobileThreadsListed();
      const mobileThreadRef = mobileListed.threads.find((t) => t.ref.sessionId === 'mobile-main')!.ref;
      expect(mobileThreadRef).toMatchObject({
        hostId: mobile.admission.identity.hostId,
        workspaceId: mobileWorkspace.id,
        sessionId: 'mobile-main',
        bridgeId: reverseLink.grant.id,
      });

      const readMobile = await desktopThreads.readThread({
        caller: { workspaceId: desktopWorkspace.id, sessionId: 'desktop-main' },
        thread: mobileThreadRef,
        limit: 10,
      });
      expect(readMobile.thread.sessionId).toBe('mobile-main');

      const waitBeforeSend = await desktopThreads.waitThreads({
        caller: { workspaceId: desktopWorkspace.id, sessionId: 'desktop-main' },
        threads: [{ thread: mobileThreadRef }],
        timeoutMs: 0,
      });
      expect(waitBeforeSend.threads).toHaveLength(1);
      expect(waitBeforeSend.timedOut).toBe(true);
      const baselineCursor = waitBeforeSend.threads[0]!.cursor;

      const toMobile = await desktopPeerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: desktop.admission.identity.hostId, workspaceId: desktopWorkspace.id, sessionId: 'desktop-main' },
        target: mobileThreadRef,
        content: 'Ping from desktop to NAT-ed phone over reverse WS',
        idempotencyKey: 'desk-to-phone-1',
      });
      expect(toMobile.delivery).toBe('pending');
      expect(mobile.core.accessor.get(ISessionManager).get('mobile-main')).toBeUndefined();
      const mobileMailbox = mobile.core.accessor.get(IThreadMailboxStore);
      const mobileInbox = await mobileMailbox.readMessages({ group: 'session:mobile-main', limit: 10 });
      expect(mobileInbox.items).toHaveLength(1);
      expect(mobileInbox.items[0]!.message.content).toBe('Ping from desktop to NAT-ed phone over reverse WS');

      await mobileMailbox.appendActivity({
        target: { hostId: mobile.admission.identity.hostId, workspaceId: mobileWorkspace.id, sessionId: 'mobile-main' },
        kind: 'terminal',
        reason: 'completed',
      });
      const waitAfterActivity = await desktopThreads.waitThreads({
        caller: { workspaceId: desktopWorkspace.id, sessionId: 'desktop-main' },
        threads: [{ thread: mobileThreadRef, cursor: baselineCursor }],
        timeoutMs: 2_000,
      });
      expect(waitAfterActivity.timedOut).toBe(false);
      expect(waitAfterActivity.threads[0]!.activities).toHaveLength(1);
      expect(waitAfterActivity.threads[0]!.activities[0]!.kind).toBe('terminal');

      const desktopListed = await mobileThreads.listThreads({
        caller: { workspaceId: mobileWorkspace.id, sessionId: 'mobile-main' },
        connectionId: pairedRecord.id,
      });
      const desktopThreadRef = desktopListed.threads.find((t) => t.ref.sessionId === 'desktop-main')!.ref;
      const toDesktop = await mobilePeerSend[SEND_PEER_THREAD_MESSAGE]({
        source: { hostId: mobile.admission.identity.hostId, workspaceId: mobileWorkspace.id, sessionId: 'mobile-main' },
        target: desktopThreadRef,
        content: 'Reply from phone to desktop',
        idempotencyKey: 'phone-to-desk-1',
      });
      expect(toDesktop.delivery).toBe('pending');
      expect(desktop.core.accessor.get(ISessionManager).get('desktop-main')).toBeUndefined();
      const desktopInbox = await desktop.core.accessor.get(IThreadMailboxStore).readMessages({ group: 'session:desktop-main', limit: 10 });
      expect(desktopInbox.items).toHaveLength(1);
      expect(desktopInbox.items[0]!.message.content).toBe('Reply from phone to desktop');

      mobile.notifyNetworkChange('lost');
      await expect(desktopThreads.listThreads({
        caller: { workspaceId: desktopWorkspace.id, sessionId: 'desktop-main' },
        bridgeId: reverseLink.grant.id,
      })).rejects.toThrow('peer_bridge_offline');

      mobile.notifyNetworkChange('available');
      const recoveredListed = await waitMobileThreadsListed();
      expect(recoveredListed.threads.some((t) => t.ref.sessionId === 'mobile-main')).toBe(true);
    } finally {
      await mobileClient.close();
      await desktopClient.close();
    }
  }, 120_000);

  it('respects requestBridge false and requestBridge true when pairing outbound', async () => {
    const source = await boot(); const target = await boot();
    const sourceClient = createKlient({ endpoint: endpoint(source), token: source.localOwnerToken });
    const targetClient = createKlient({ endpoint: endpoint(target), token: target.localOwnerToken });
    const sourceWorkDir = join(homes[0]!, 'workspace');
    const targetWorkDir = join(homes[1]!, 'workspace');
    try {
      await sourceClient.global.sessions.create({ sessionId: 'pair-source', workDir: sourceWorkDir });
      await targetClient.global.sessions.create({ sessionId: 'pair-target', workDir: targetWorkDir });
      await target.core.accessor.get(ISessionManager).close('pair-target');
      const sourceConfig = source.core.accessor.get(IConfigService);
      const targetConfig = target.core.accessor.get(IConfigService);

      const codeNoBridge = await targetClient.rest!.connections.createPairCode({});
      const targetEndpoint = codeNoBridge.suggestedEndpoints[0]!;

      const noBridgeRecord = await sourceClient.rest!.connections.pair({
        endpoint: targetEndpoint,
        code: codeNoBridge.code,
        requestBridge: false,
        backgroundSummary: true,
      });

      expect(noBridgeRecord.purposes).toEqual(['gui']);
      expect((await targetClient.rest!.threadBridges.status()).inbound).toHaveLength(0);
      expect((await sourceClient.rest!.threadBridges.status()).outbound).toHaveLength(0);
      expect(sourceConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);
      expect(targetConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).not.toBe(true);

      const codeWithBridge = await targetClient.rest!.connections.createPairCode({});
      const withBridgeRecord = await sourceClient.rest!.connections.pair({
        endpoint: targetEndpoint,
        code: codeWithBridge.code,
        requestBridge: true,
        backgroundSummary: true,
      });

      expect(withBridgeRecord.purposes).toEqual(['gui', 'bridge']);
      expect((await targetClient.rest!.threadBridges.status()).inbound).toHaveLength(1);
      expect((await sourceClient.rest!.threadBridges.status()).outbound).toHaveLength(1);
      expect(sourceConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).toBe(true);
      expect(targetConfig.get<{ enabled?: boolean }>(THREAD_COMMUNICATION_SECTION)?.enabled).toBe(true);
    } finally {
      await sourceClient.close();
      await targetClient.close();
    }
  }, 120_000);
});

function runCli(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const require = createRequire(import.meta.url);
  const cli = fileURLToPath(new URL('../../../apps/kimi-code/src/main.ts', import.meta.url));
  const loader = new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--import', loader, cli, ...args], {
      env: { ...process.env, KIKI_HOME: home, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../apps/kimi-code/tsconfig.dev.json', import.meta.url)) },
      cwd: home,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('kiki pair', () => {
  it('prints a code and connects another home with the same contract', async () => {
    const target = await boot(); const source = await boot();
    const issued = await runCli(homes[0]!, ['pair', '--home', homes[0]!]);
    expect(issued.code, issued.stderr).toBe(0);
    const code = /Pairing code: ([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4})/.exec(issued.stdout)?.[1];
    expect(code, issued.stdout).toBeTruthy();
    const connected = await runCli(homes[1]!, ['pair', endpoint(target), code!, '--home', homes[1]!]);
    expect(connected.code, connected.stderr + connected.stdout).toBe(0);
    expect(connected.stdout).toMatch(/^Connected to .+ at http:\/\/127\.0\.0\.1:\d+\.\r?\n$/);
    expect(source.remoteConnections.list().some((record) => record.endpoint === endpoint(target))).toBe(true);
    expect(target.admission.status().grants.some((grant) => grant.status === 'approved')).toBe(true);
  }, 180_000);
});
