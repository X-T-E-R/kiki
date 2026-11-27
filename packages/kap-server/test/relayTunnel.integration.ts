import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createConnectionKlient, createKlient } from '@kiki/klient/http';
import {
  RELAY_WS_SUBPROTOCOL,
  formatPairingUri,
  parsePairingUri,
  relayStatusSchema,
  type RelayStatus,
} from '@kiki/protocol';
import { startServer, type RunningServer } from '../src/start';
import {
  startKikiRelayServer,
  type RunningKikiRelayServer,
  type StartKikiRelayServerOptions,
} from './fixtures/kiki-relay-server.mjs';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const servers: RunningServer[] = [];
const relays: RunningKikiRelayServer[] = [];
const httpServers: Server[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const srv of httpServers.splice(0)) {
    await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
  }
  for (const server of servers.splice(0).toReversed()) {
    await server.close();
  }
  for (const relay of relays.splice(0).toReversed()) {
    await relay.stop();
  }
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

async function bootServer(): Promise<{ readonly server: RunningServer; readonly home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-relay-e2e-'));
  homes.push(home);
  await mkdir(join(home, 'workspace'), { recursive: true });
  const server = await startServer({
    homeDir: home,
    port: 0,
    hostIdentity: TEST_HOST_IDENTITY,
    logLevel: 'silent',
  });
  servers.push(server);
  return { server, home };
}

async function bootRelay(options?: StartKikiRelayServerOptions): Promise<RunningKikiRelayServer> {
  const relay = await startKikiRelayServer({
    host: '127.0.0.1',
    port: 0,
    ...options,
  });
  relays.push(relay);
  return relay;
}

const serverOrigin = (server: RunningServer) => `http://127.0.0.1:${server.port}`;

async function ownerRelayApi<T = RelayStatus>(
  server: RunningServer,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<T> {
  const res = await fetch(`${serverOrigin(server)}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${server.localOwnerToken}`,
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  expect(res.status, `${init?.method ?? 'GET'} ${path}`).toBe(200);
  const json = (await res.json()) as { code: number; data: T };
  expect(json.code).toBe(0);
  return json.data;
}

describe('kiki-relay Pre-Warmed Reverse WSS Pool, Happy-Eyeballs & E2E SPKI TLS Pinning', () => {
  it('runs production kiki-relay-server.mjs, shrinks warm pool on Home->Standby demotion, pairs & brokers over E2E TLS, and fails over on Home outage', async () => {
    const fixturePath = resolve(__dirname, 'fixtures/kiki-relay-server.mjs');
    const siblingPluginServer = resolve(
      __dirname,
      '../../../../wt-kiki-relay-plugin/plugins/official/kiki-relay/server/kiki-relay-server.mjs',
    );
    if (existsSync(siblingPluginServer)) {
      const [fixtureBytes, pluginBytes] = await Promise.all([
        readFile(fixturePath),
        readFile(siblingPluginServer),
      ]);
      expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
        createHash('sha256').update(pluginBytes).digest('hex'),
      );
    }

    const homeRelay = await bootRelay({
      basePath: '/kiki-relay',
      hostToken: 'home-host-secret',
      secret: 'home-hmac-secret',
      label: 'Home Edge',
      probeDelayMs: 0,
    });
    const standbyRelay = await bootRelay({
      hostToken: 'standby-host-secret',
      secret: 'standby-hmac-secret',
      label: 'Standby Edge',
      probeDelayMs: 55,
    });

    const target = await bootServer();
    const source = await bootServer();
    const owner = createKlient({ endpoint: serverOrigin(target.server), token: target.server.localOwnerToken });
    const local = createKlient({ endpoint: serverOrigin(source.server), token: source.server.localOwnerToken });

    try {
      await ownerRelayApi(target.server, '/api/remote-connections/inbound', {
        method: 'PUT',
        body: { enabled: true },
      });

      await ownerRelayApi(target.server, '/api/remote-connections/relays/nodes', {
        method: 'POST',
        body: { uri: homeRelay.shareUri },
      });
      await ownerRelayApi(target.server, '/api/remote-connections/relays/nodes', {
        method: 'POST',
        body: { uri: standbyRelay.shareUri },
      });

      let status!: RelayStatus;
      await vi.waitFor(async () => {
        status = relayStatusSchema.parse(await ownerRelayApi(target.server, '/api/remote-connections/relays'));
        expect(status.nodes.every((n) => n.connected)).toBe(true);
        expect(homeRelay.stats().warmSockets).toBe(2);
        expect(standbyRelay.stats().warmSockets).toBe(1);
      }, { timeout: 10_000 });

      expect(JSON.stringify(status)).not.toContain('home-host-secret');
      expect(JSON.stringify(status)).not.toContain('standby-host-secret');
      const homeNode = status.nodes.find((n) => n.url === homeRelay.publicUrl)!;
      const standbyNode = status.nodes.find((n) => n.url === standbyRelay.publicUrl)!;
      expect(homeNode.slot).toBe('home');
      expect(standbyNode.slot).toBe('standby');

      homeRelay.setProbeDelayMs(90);
      standbyRelay.setProbeDelayMs(0);
      await ownerRelayApi(target.server, '/api/remote-connections/relays/probe', {
        method: 'POST',
        body: { url: homeRelay.publicUrl },
      });
      await ownerRelayApi(target.server, '/api/remote-connections/relays/probe', {
        method: 'POST',
        body: { url: standbyRelay.publicUrl },
      });

      await vi.waitFor(async () => {
        const flipped = relayStatusSchema.parse(await ownerRelayApi(target.server, '/api/remote-connections/relays'));
        expect(flipped.homeNodeId).toBe(standbyNode.id);
        expect(standbyRelay.stats().warmSockets).toBe(2);
        expect(homeRelay.stats().warmSockets).toBe(1);
      }, { timeout: 10_000 });

      homeRelay.setProbeDelayMs(0);
      standbyRelay.setProbeDelayMs(90);
      await ownerRelayApi(target.server, '/api/remote-connections/relays/probe', {
        method: 'POST',
        body: { url: standbyRelay.publicUrl },
      });
      await ownerRelayApi(target.server, '/api/remote-connections/relays/probe', {
        method: 'POST',
        body: { url: homeRelay.publicUrl },
      });

      await vi.waitFor(async () => {
        const restored = relayStatusSchema.parse(await ownerRelayApi(target.server, '/api/remote-connections/relays'));
        expect(restored.homeNodeId).toBe(homeNode.id);
        expect(homeRelay.stats().warmSockets).toBe(2);
        expect(standbyRelay.stats().warmSockets).toBe(1);
      }, { timeout: 10_000 });

      const issued = await owner.rest!.connections.createPairCode({ allowBridge: false });
      expect(issued.tlsFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(issued.relayEndpoints).toHaveLength(2);
      expect(issued.relayEndpoints![0]).toContain(`${homeRelay.publicUrl}/v1/stream?target=${issued.tlsFingerprint}&rt=p.`);
      expect(issued.relayEndpoints![1]).toContain(`${standbyRelay.publicUrl}/v1/stream?target=${issued.tlsFingerprint}&rt=p.`);

      const qrUri = formatPairingUri({
        endpoint: 'https://127.0.0.1:1',
        relayEndpoints: issued.relayEndpoints,
        code: issued.code,
        fingerprint: issued.tlsFingerprint,
      });
      const parsedQr = parsePairingUri(qrUri)!;
      expect(parsedQr.relayEndpoints).toEqual(issued.relayEndpoints);

      const paired = await local.rest!.connections.pair({
        endpoint: parsedQr.endpoint,
        relayEndpoints: parsedQr.relayEndpoints === undefined ? undefined : [...parsedQr.relayEndpoints],
        code: parsedQr.code,
        fingerprint: parsedQr.fingerprint,
        requestBridge: false,
        backgroundSummary: false,
      });

      expect(paired.state).toBe('online');
      expect(paired.relayEndpoints).toHaveLength(2);
      expect(paired.relayEndpoints![0]).toContain('&rt=g.');
      expect(paired.relayEndpoints![1]).toContain('&rt=g.');

      await vi.waitFor(() => {
        expect(homeRelay.stats().warmSockets).toBe(2);
      }, { timeout: 5_000 });

      await owner.global.sessions.create({ sessionId: 'relayed-session-1', workDir: join(target.home, 'workspace') });

      const remote = createConnectionKlient({
        endpoint: serverOrigin(source.server),
        token: source.server.localOwnerToken,
        connectionId: paired.id,
      });

      try {
        await remote.events.on('kosong.changed', () => {}).ready;
        const meta = await remote.rest!.meta();
        expect(typeof meta.capabilities).toBe('object');
        expect(meta.capabilities).not.toHaveProperty('terminal');
        const sessions = await remote.global.sessions.list({});
        expect(sessions.items.some((s) => s.id === 'relayed-session-1')).toBe(true);

        await homeRelay.stop();

        await local.rest!.connections.retry(paired.id);
        await vi.waitFor(async () => {
          const list = await local.rest!.connections.list();
          const refreshed = list.find((item) => item.id === paired.id);
          expect(refreshed?.state).toBe('online');
        }, { timeout: 10_000 });

        await owner.global.sessions.create({ sessionId: 'relayed-session-after-failover', workDir: join(target.home, 'workspace') });
        const sessionsAfterFailover = await remote.global.sessions.list({});
        expect(sessionsAfterFailover.items.some((s) => s.id === 'relayed-session-after-failover')).toBe(true);
      } finally {
        await remote.close();
      }
    } finally {
      await local.close();
      await owner.close();
    }
  }, 90_000);

  it('rejects public cleartext ws:// nodes & http:// subscriptions, rejects forged tickets & wrong SPKI pins, and syncs relays.json with ETag 304', async () => {
    const relay = await bootRelay({
      hostToken: 'strict-token',
      secret: 'strict-secret',
    });
    const target = await bootServer();
    const source = await bootServer();
    const owner = createKlient({ endpoint: serverOrigin(target.server), token: target.server.localOwnerToken });
    const local = createKlient({ endpoint: serverOrigin(source.server), token: source.server.localOwnerToken });

    try {
      await ownerRelayApi(target.server, '/api/remote-connections/inbound', {
        method: 'PUT',
        body: { enabled: true },
      });

      const cleartextNodeRes = await fetch(`${serverOrigin(target.server)}/api/remote-connections/relays/nodes`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.server.localOwnerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: 'ws://relay.example.com/kiki-relay' }),
      });
      expect(cleartextNodeRes.status).toBe(400);

      const cleartextShareRes = await fetch(`${serverOrigin(target.server)}/api/remote-connections/relays/nodes`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.server.localOwnerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ uri: 'kiki-relay://relay.example.com/kiki-relay?insecure=1&token=leak' }),
      });
      expect(cleartextShareRes.status).toBe(400);

      const cleartextSubRes = await fetch(`${serverOrigin(target.server)}/api/remote-connections/relays/subscriptions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.server.localOwnerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: 'http://team.example.com/relays.json' }),
      });
      expect([400, 200]).toContain(cleartextSubRes.status);
      const cleartextSubBody = (await cleartextSubRes.json()) as { code: number };
      expect(cleartextSubBody.code).not.toBe(0);

      let subHits = 0;
      const manifestServer = createHttpServer((req, res) => {
        subHits += 1;
        if (req.headers['if-none-match'] === '"etag-v1"') {
          res.writeHead(304);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"etag-v1"' });
        res.end(
          JSON.stringify({
            version: 1,
            title: 'Cluster Relays',
            nodes: [
              { id: 'primary', name: 'Primary', url: relay.publicUrl, token: 'strict-token' },
              { id: 'bad-cleartext', name: 'Bad Public WS', url: 'ws://relay.example.com/kiki-relay' },
            ],
          }),
        );
      });
      httpServers.push(manifestServer);
      await new Promise<void>((resolveListen) => manifestServer.listen(0, '127.0.0.1', () => resolveListen()));
      const manifestPort = (manifestServer.address() as { port: number }).port;

      const afterAdd = await ownerRelayApi(target.server, '/api/remote-connections/relays/subscriptions', {
        method: 'POST',
        body: { url: `http://127.0.0.1:${manifestPort}/relays.json` },
      });
      expect(afterAdd.subscriptions).toHaveLength(1);
      expect(afterAdd.subscriptions[0]?.etag).toBe('"etag-v1"');
      expect(afterAdd.subscriptions[0]?.lastError).toContain('ws://relay.example.com/kiki-relay');
      expect(afterAdd.nodes).toHaveLength(1);

      await vi.waitFor(async () => {
        const st = await ownerRelayApi(target.server, '/api/remote-connections/relays');
        expect(st.nodes[0]?.connected).toBe(true);
        expect(relay.stats().warmSockets).toBe(2);
      }, { timeout: 10_000 });

      await ownerRelayApi(
        target.server,
        `/api/remote-connections/relays/subscriptions/${encodeURIComponent(afterAdd.subscriptions[0]!.id)}/refresh`,
        { method: 'POST' },
      );
      expect(subHits).toBe(2);

      const issued = await owner.rest!.connections.createPairCode({ allowBridge: false });
      const fp = issued.tlsFingerprint!;

      await expect(
        new Promise<void>((resolveOpen, rejectOpen) => {
          const ws = new WebSocket(`${relay.publicUrl}/v1/stream?target=${fp}&rt=p.9999999999.${'0'.repeat(64)}`, [
            RELAY_WS_SUBPROTOCOL,
          ]);
          ws.on('open', () => resolveOpen());
          ws.on('unexpected-response', (_req, res) => {
            res.resume();
            rejectOpen(new Error(`HTTP_${res.statusCode}`));
          });
          ws.on('error', rejectOpen);
        }),
      ).rejects.toThrow('HTTP_403');
      expect(relay.stats().warmSockets).toBe(2);

      const wrongFp = fp.startsWith('0') ? `f${fp.slice(1)}` : `0${fp.slice(1)}`;
      await expect(
        local.rest!.connections.pair({
          endpoint: issued.relayEndpoints![0]!,
          code: issued.code,
          fingerprint: wrongFp,
          requestBridge: false,
          backgroundSummary: false,
        }),
      ).rejects.toThrow();
    } finally {
      await local.close();
      await owner.close();
    }
  }, 60_000);
});
