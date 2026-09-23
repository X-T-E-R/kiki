import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IAgentLoopService,
  IModelService,
  ensureMainAgent,
  resumeSessionById,
  type Scope,
} from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/http';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { registerKlientHttp } from '../src/transport/klient/registerKlientHttp';
import { TerminalHttpConnection } from '../src/transport/klient/terminalHttp';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { fixedTokenAuth } from './helpers/fixedAuth';

const TOKEN = 'test-token';

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

it('rejects every PTY control before resolving a session when exposure disables terminals', async () => {
  const get = vi.fn(() => { throw new Error('must not resolve a session'); });
  const send = vi.fn();
  const connection = new TerminalHttpConnection({ accessor: { get } } as unknown as Scope, false, send);
  for (const type of ['terminal_attach', 'terminal_input', 'terminal_resize', 'terminal_detach']) {
    expect(connection.receive({ type, id: type, data: { session_id: 's1', terminal_id: 't1', data: 'unsafe', cols: 80, rows: 24 } })).toBe(true);
  }
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
  expect(get).not.toHaveBeenCalled();
  for (const [frame] of send.mock.calls) expect(frame).toMatchObject({ type: 'terminal_ack', code: 40414, msg: 'terminal unavailable' });
  connection.dispose();
});

describe('klient HTTP host', () => {
  let homeDir: string;
  let server: RunningServer;
  let endpoint: string;

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kap-klient-http-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(TOKEN),
    });
    endpoint = `http://127.0.0.1:${server.port}`;
  }, 30_000);

  afterAll(async () => {
    await server.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }, 30_000);

  it('requires bearer auth and dispatches one procedure', async () => {
    const body = {
      procedure: { scope: 'core', service: 'bootstrapService', method: 'platform' },
      params: [],
    };
    const unauthorized = await fetch(`${endpoint}/api/klient/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({ code: 40101 });

    const response = await fetch(`${endpoint}/api/klient/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ code: 0, data: process.platform });
  });

  it('reads the real agent panel projection and rejects unregistered board workspaces', async () => {
    const klient = createKlient({ endpoint, token: TOKEN });
    try {
      const query = { session_id: 'session_missing', agent_id: 'main' };
      const panel = await klient.global.agentPanel.read(query);
      const legacy = await fetch(`${endpoint}/api/agents/capabilities?session_id=session_missing&agent_id=main`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).then((response) => response.json()) as { data: unknown };
      expect(panel).toEqual(legacy.data);
      expect(panel).toMatchObject({ context: 'live', available: false, targets: [] });
      const session = await klient.global.sessions.create({ workDir: homeDir, title: 'Panel projection' });
      await klient.session(session.id).agent('main').getUsage();
      const live = await klient.global.agentPanel.read({ session_id: session.id, agent_id: 'main' });
      const liveLegacy = await fetch(`${endpoint}/api/agents/capabilities?session_id=${encodeURIComponent(session.id)}&agent_id=main`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).then((response) => response.json()) as { data: unknown };
      expect(live).toEqual(liveLegacy.data);
      expect(live.profile?.name).toBeTypeOf('string');
      expect(live.tools?.length).toBeGreaterThan(0);
      expect(live.metrics?.['main']).toHaveProperty('totalCostUsd');
      await expect(klient.global.board.read({ action: 'preview', workspaceId: 'wd_missing' })).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
      await expect(klient.global.board.write({ action: 'create', workspaceId: 'wd_missing', requestKey: 'create-one', title: 'Example task' })).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
      await expect(klient.global.agentPanel.read({ profile: 'missing', workspace_id: 'wd_missing' })).rejects.toMatchObject({ code: 40410 });
    } finally {
      await klient.close();
    }
  });

  it('shares sessions between the typed REST surface and session facade on the unified host', async () => {
    const klient = createKlient({ endpoint, token: TOKEN });
    try {
      if (klient.rest === undefined) throw new Error('HTTP client must expose its REST facade');
      await expect(klient.rest.healthz()).resolves.toBe(true);
      const workspace = await klient.global.workspaces.createOrTouch({ root: homeDir });
      const created = await klient.rest.sessions.create({ workspace_id: workspace.id, title: 'Unified client session' });
      expect(created.workspace_id).toBe(workspace.id);
      const listed = await klient.rest.sessions.list({ workspace_id: workspace.id });
      expect(listed.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, title: 'Unified client session' })]));
      const snapshot = await klient.session(created.id).view.snapshot();
      expect(snapshot.session.id).toBe(created.id);
      await expect(klient.rest.sessions.create({ workspace_id: 'wd_missing_000000000000' })).rejects.toMatchObject({ code: 40410 });
    } finally {
      await klient.close();
    }
  });

  it('rebuilds main-agent context through the klient route, preserves history, and rejects busy sessions', async () => {
    const klient = createKlient({ endpoint, token: TOKEN });
    try {
      const created = await klient.global.sessions.create({ workDir: homeDir, title: 'Context rebuild' });
      const agent = klient.session(created.id).agent('main');
      await agent.getUsage();
      await agent.appendContext({ role: 'user', content: [{ type: 'text', text: 'keep me' }], toolCalls: [] });
      const before = await agent.getContext();
      await expect(agent.rebuildContext()).resolves.toMatchObject({
        rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'injections'],
      });
      await expect(agent.getContext()).resolves.toEqual(before);

      const session = await resumeSessionById(server.core.accessor, created.id);
      if (session === undefined) throw new Error('session must be live');
      const main = await ensureMainAgent(session);
      const quiescence = main.accessor.get(IAgentLoopService).tryAcquireQuiescence();
      if (quiescence === undefined) throw new Error('test must acquire quiescence');
      try {
        await expect(agent.rebuildContext()).rejects.toMatchObject({
          code: 40001,
          message: expect.stringContaining('session is busy'),
        });
      } finally {
        quiescence.dispose();
      }
    } finally {
      await klient.close();
    }
  });

  it('sets a subagent effort through the authenticated klient route and rejects unsupported values', async () => {
    const klient = createKlient({ endpoint, token: TOKEN });
    const modelId = 'effort-route-model';
    try {
      await klient.global.kosong.addProvider({
        id: modelId,
        model: modelId,
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:1',
        maxContextSize: 1000,
        auth: { method: 'api-key', apiKey: 'test-key' },
      });
      const models = server.core.accessor.get(IModelService);
      await models.set(modelId, {
        ...models.get(modelId),
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high'],
      });
      const created = await klient.global.sessions.create({ workDir: homeDir });
      const session = await resumeSessionById(server.core.accessor, created.id);
      if (session === undefined) throw new Error('session must be live');
      const child = await session.accessor.get(IAgentLifecycleService).create({
        agentId: 'effort-route-child',
        binding: { profile: 'agent', model: modelId, thinking: 'low' },
      });
      const agent = klient.session(created.id).agent(child.id);

      await expect(agent.setEffort('high')).resolves.toEqual({ effort: 'high' });
      await expect(agent.getThinking()).resolves.toBe('high');
      await expect(agent.setEffort('unsupported')).rejects.toThrow(/not supported/);
      await expect(agent.getThinking()).resolves.toBe('high');
    } finally {
      await klient.global.kosong.removeProvider(modelId);
      await klient.close();
    }
  });

  it('returns a public RPC error envelope for malformed procedures', async () => {
    const response = await fetch(`${endpoint}/api/klient/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ procedure: { scope: 'core' }, params: {} }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ code: 40001, data: null });
  });

  it.each([
    ['sessionManager', 'list', []],
    ['workspaceInstanceManager', 'getOrCreate', [{ workspaceId: 'wd_example' }]],
    ['bootstrapService', 'platform', ['unexpected']],
  ])('rejects raw procedure %s.%s outside the contract boundary', async (service, method, params) => {
    const response = await fetch(`${endpoint}/api/klient/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        procedure: { scope: 'core', service, method },
        params,
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ code: 40001, data: null });
  });

  it('delivers facade events over the authenticated websocket', async () => {
    const klient = createKlient({ endpoint, token: TOKEN });
    const changes: unknown[] = [];
    const subscription = klient.events.on('config.changed', (event) => changes.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = await klient.global.config.inspect('requestIdentity');
    try {
      await klient.global.config.replace({
        domain: 'requestIdentity',
        value: { overrides: { client: { userAgent: 'host' } } },
      });
      await vi.waitFor(() => {
        expect(changes.length).toBeGreaterThan(0);
      });
    } finally {
      await klient.global.config.replace({
        domain: 'requestIdentity',
        value: before.userValue,
      });
      subscription.dispose();
      await klient.close();
    }
  });

  it('shares a resumable session view across two authenticated clients', async () => {
    const clients = [0, 1].map(() => createKlient({ endpoint, token: TOKEN, WebSocket: WebSocket as unknown as typeof globalThis.WebSocket }));
    const subscriptions: Array<{ close(): void; restart(): void }> = [];
    try {
      const created = await clients[0]!.global.sessions.create({ workDir: homeDir, title: 'Shared view' });
      const snapshots = await Promise.all(clients.map((client) => client.session(created.id).view.snapshot()));
      expect(snapshots[0]!.session.id).toBe(created.id);
      expect(snapshots[1]!.epoch).toBe(snapshots[0]!.epoch);
      const page = await clients[0]!.session(created.id).view.transcript.page({ agentId: 'main', pageSize: 20 });
      expect(page).toMatchObject({ session_id: created.id, agent_id: 'main', coverage: { kind: 'full', hasMoreOlder: false } });
      expect(page.cursor?.epoch).toBeTruthy();
      const catchUp = await clients[1]!.session(created.id).view.transcript.catchUp({ agentId: 'main', since: page.cursor!, grade: 'delta' });
      expect(catchUp).toMatchObject({ session_id: created.id, complete: true, epoch: page.cursor!.epoch });
      const signals: Array<Array<{ type: string }>> = [[], []];
      clients.forEach((client, index) => {
        const snapshot = snapshots[index]!;
        subscriptions.push(client.session(created.id).view.subscribe({
          sessionCursor: { seq: snapshot.as_of_seq, epoch: snapshot.epoch },
          transcriptGrades: { '*': 'turn', main: 'delta' },
        }, (signal) => signals[index]!.push(signal)));
      });
      await vi.waitFor(() => { for (const received of signals) expect(received.some((signal) => signal.type === 'ready')).toBe(true); });
      for (const received of signals) expect(received.some((signal) => signal.type === 'transcript')).toBe(true);
      subscriptions[0]!.restart();
      await vi.waitFor(() => expect(signals[0]!.filter((signal) => signal.type === 'ready')).toHaveLength(2));
    } finally {
      for (const subscription of subscriptions) subscription.close();
      await Promise.all(clients.map((client) => client.close()));
    }
  });

  it('round-trips a file whose JSON request exceeds Fastify default bodyLimit', async () => {
    const klient = createKlient({ endpoint, token: TOKEN });
    const bytes = new Uint8Array(900 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    expect(Math.ceil(bytes.length / 3) * 4).toBeGreaterThan(1 << 20);
    let fileId: string | undefined;
    try {
      const meta = await klient.global.files.save({
        data: bytes,
        filename: 'large-conformance.bin',
        mimeType: 'application/octet-stream',
      });
      fileId = meta.id;
      expect(meta.size).toBe(bytes.length);
      const downloaded = await klient.global.files.get(meta.id);
      expect(downloaded.data.length).toBe(bytes.length);
      expect(Buffer.from(downloaded.data).equals(Buffer.from(bytes))).toBe(true);
    } finally {
      if (fileId !== undefined) await klient.global.files.delete(fileId);
      await klient.close();
    }
  });
});

describe('klient HTTP stream cancellation', () => {
  it.each(['stream_cancel', 'disconnect', 'server_close'] as const)(
    'calls iterator.return immediately on %s and drops late chunks',
    async (mode) => {
      let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined;
      const next = vi.fn(
        () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            resolveNext = resolve;
          }),
      );
      const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }));
      const iterator: AsyncIterator<unknown> = { next, return: returnIterator };
      const scope = {
        accessor: {
          get: <T>() =>
            ({
              getRequester: () => ({
                request: () => ({
                  [Symbol.asyncIterator]: () => iterator,
                }),
              }),
            }) as T,
        },
      } as unknown as Scope;
      const app = Fastify({ logger: false });
      const wss = registerKlientHttp(app, scope);
      app.server.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (upgraded) => {
          wss.emit('connection', upgraded, req);
        });
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (typeof address !== 'object' || address === null) throw new Error('missing address');
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/klient/events`);
      const messages: Record<string, unknown>[] = [];
      client.on('message', (data) => {
        messages.push(JSON.parse(rawToString(data)) as Record<string, unknown>);
      });
      let appClosed = false;
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('open', () => {
            resolve();
          });
          client.once('error', reject);
        });
        client.send(
          JSON.stringify({
            type: 'stream',
            id: 'stream-1',
            scope: 'core',
            service: 'modelResolver',
            method: 'generate',
            arg: ['test-model', { systemPrompt: '', messages: [] }],
          }),
        );
        await vi.waitFor(() => {
          expect(next).toHaveBeenCalledTimes(1);
        });
        if (mode === 'stream_cancel') {
          client.send(JSON.stringify({ type: 'stream_cancel', id: 'stream-1' }));
        } else if (mode === 'disconnect') {
          client.terminate();
        } else {
          await app.close();
          appClosed = true;
        }
        await vi.waitFor(() => {
          expect(returnIterator).toHaveBeenCalledTimes(1);
        });
        resolveNext?.({ done: false, value: { type: 'text', text: 'late' } });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(messages.some((frame) => frame['type'] === 'stream_data')).toBe(false);
      } finally {
        client.terminate();
        if (!appClosed) await app.close();
      }
    },
  );
});
