import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Scope } from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/http';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { registerKlientHttp } from '../src/transport/klient/registerKlientHttp';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { fixedTokenAuth } from './helpers/fixedAuth';

const TOKEN = 'test-token';

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

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
