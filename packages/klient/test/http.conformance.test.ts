import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigTarget,
  IConfigService,
  ISessionIndex,
} from '@kiki/agent-core-v2';
import { expect, it, vi } from 'vitest';
import { getLiveSessionById } from '@kiki/agent-core-v2/app/sessionManager/sessionLookup';
import { ISessionInteractionService } from '@kiki/agent-core-v2/session/interaction/interaction';

import { startServer } from '../../kap-server/src/start.js';
import { createKlient } from '../src/transports/http/index.js';
import { defineKlientConformance } from './helpers/conformance.js';
import { TEST_CLIENT_IDENTITY } from './helpers/engine.js';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

defineKlientConformance('http', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-conformance-http-'));
  const server = await startServer({
    hostIdentity: TEST_CLIENT_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir,
    logLevel: 'silent',
  });
  await server.core.accessor
    .get(IConfigService)
    .replace('threadCommunication', { enabled: true }, ConfigTarget.Memory);
  await server.core.accessor.get(ISessionIndex).prepare();
  const klient = createKlient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: server.authTokenService.getToken(),
  });
  return {
    klient,
    app: server.core,
    cleanup: async () => {
      await klient.close();
      await server.close();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    },
  };
});

it('converges interactions, metadata and providers changed in the HTTP black window without later events', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-recovery-http-'));
  const server = await startServer({
    hostIdentity: TEST_CLIENT_IDENTITY, host: '127.0.0.1', port: 0, homeDir, logLevel: 'silent',
  });
  const sockets: WebSocket[] = [];
  let reconnectBlocked = false;
  class ControlledWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: ConstructorParameters<typeof WebSocket>[1]) {
      if (reconnectBlocked) throw new Error('test reconnect held');
      super(url, protocols);
      sockets.push(this);
    }
  }
  const klient = createKlient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: server.authTokenService.getToken(), WebSocket: ControlledWebSocket,
  });
  try {
    const created = await klient.global.sessions.create({ workDir: process.cwd(), title: 'before disconnect' });
    const session = klient.session(created.id);
    const interactions = getLiveSessionById(server.core.accessor, created.id)!.accessor.get(ISessionInteractionService);
    const first = interactions.enqueue({ kind: 'question', payload: {} });
    const snapshots: Array<{ title: string | undefined; ids: string[] }> = [];
    const providers: string[][] = [];
    const ordinary: unknown[] = [];
    const errors: Error[] = [];
    session.events.onError((error) => errors.push(error));
    klient.events.onError((error) => errors.push(error));
    session.events.on('interactions.changed', (event) => ordinary.push(event));
    session.events.on('metadata.changed', (event) => ordinary.push(event));
    klient.events.on('kosong.providers.changed', (event) => ordinary.push(event));
    session.events.observe({
      events: ['metadata.changed', 'interactions.changed'],
      read: async () => {
        const [meta, pending] = await Promise.all([session.get(), session.interactions.list()]);
        return { title: meta.title, ids: pending.map((item) => item.id) };
      },
    }, (snapshot) => snapshots.push(snapshot));
    klient.events.observe({
      events: ['kosong.providers.changed'],
      read: async () => (await klient.global.kosong.listProviders()).map((provider) => provider.id),
    }, (snapshot) => providers.push(snapshot));
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual({ title: 'before disconnect', ids: [first.id] });
      expect(providers.length).toBeGreaterThan(0);
    });
    expect(ordinary).toEqual([]);
    reconnectBlocked = true;
    sockets.at(-1)!.close();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    interactions.respond(first.id, {});
    const second = interactions.enqueue({ kind: 'approval', payload: {} });
    await session.setTitle('changed while disconnected');
    await klient.global.kosong.addProvider('recovery-provider', {
      type: 'openai', baseUrl: 'http://127.0.0.1:1', auth: { method: 'api-key', apiKey: 'test-key' },
    });
    reconnectBlocked = false;
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual({ title: 'changed while disconnected', ids: [second.id] });
      expect(providers.at(-1)).toContain('recovery-provider');
    }, { timeout: 10_000 });
    expect(ordinary).toEqual([]);
    const beforeErrors = errors.length;
    reconnectBlocked = true;
    sockets.at(-1)!.close();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(beforeErrors));
    interactions.respond(second.id, {});
    await session.setTitle('resolved while disconnected');
    await klient.global.kosong.removeProvider('recovery-provider');
    reconnectBlocked = false;
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual({ title: 'resolved while disconnected', ids: [] });
      expect(providers.at(-1)).not.toContain('recovery-provider');
    }, { timeout: 10_000 });
    expect(ordinary).toEqual([]);
  } finally {
    await klient.close();
    await server.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
