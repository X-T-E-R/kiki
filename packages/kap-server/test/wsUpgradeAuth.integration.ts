import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import {
  KLIENT_EVENTS_PATH,
  KLIENT_HTTP_MAX_PAYLOAD_BYTES,
} from '../src/transport/klient/registerKlientHttp';
import { WS_V1_MAX_PAYLOAD_BYTES } from '../src/transport/ws/v1/registerWsV1';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { fixedTokenAuth } from './helpers/fixedAuth';

const TOKEN = 'test-token';

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

interface ConnectOptions {
  readonly protocols?: string[];
  readonly headers?: Record<string, string>;
}

function openConn(url: string, opts?: ConnectOptions): Promise<{ ws: WebSocket; firstFrame: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
    ws.once('message', (data) => {
      try {
        resolve({ ws, firstFrame: JSON.parse(rawToString(data)) });
      } catch {
        resolve({ ws, firstFrame: null });
      }
    });
    ws.once('error', reject);
  });
}

function openSocket(url: string, opts?: ConnectOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
    ws.once('open', () => {
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function expectRejected(url: string, opts?: ConnectOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
    const done = (err?: Error): void => {
      clearTimeout(t);
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
      }
      if (err !== undefined) reject(err);
      else resolve();
    };
    const t = setTimeout(
      () => done(new Error('connection was not rejected within timeout')),
      1500,
    );
    ws.once('open', () => done(new Error('connection unexpectedly opened')));
    ws.once('error', () => done());
    ws.once('close', () => done());
  });
}

describe('WS upgrade auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let klientUrl: string;
  let v1Url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ws-upgrade-auth-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(TOKEN),
    });
    klientUrl = `ws://127.0.0.1:${server.port}${KLIENT_EVENTS_PATH}`;
    v1Url = `ws://127.0.0.1:${server.port}/api/ws`;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
      }
    }
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  describe('/api/ws', () => {
    const firstType = 'server_hello';
    const url = (): string => v1Url;

    it('accepts a valid bearer subprotocol and echoes it', async () => {
      const { ws, firstFrame } = await openConn(url(), {
        protocols: [`kimi-code.bearer.${TOKEN}`],
      });
      sockets.push(ws);
      expect(ws.protocol).toBe(`kimi-code.bearer.${TOKEN}`);
      expect(firstFrame).toMatchObject({ type: firstType });
    });

    it('accepts a valid Authorization bearer header', async () => {
      const { ws, firstFrame } = await openConn(url(), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      sockets.push(ws);
      expect(firstFrame).toMatchObject({ type: firstType });
    });

    it('closes an oversized message with 1009 and runs connection cleanup', async () => {
      const { ws } = await openConn(url(), {
        protocols: [`kimi-code.bearer.${TOKEN}`],
      });
      sockets.push(ws);
      expect((server as RunningServer).connectionRegistry.size()).toBe(1);
      const closed = new Promise<number>((resolve) => {
        ws.once('close', (code) => resolve(code));
      });

      ws.send(Buffer.alloc(WS_V1_MAX_PAYLOAD_BYTES + 1));

      await expect(closed).resolves.toBe(1009);
      await vi.waitFor(() =>
        expect((server as RunningServer).connectionRegistry.size()).toBe(0),
      );
    });

    it('rejects a wrong bearer token', async () => {
      await expectRejected(url(), { protocols: ['kimi-code.bearer.wrong'] });
    });

    it('rejects a connection with no token', async () => {
      await expectRejected(url());
    });
  });

  describe('/api/klient/events', () => {
    it('accepts a valid bearer subprotocol and echoes it', async () => {
      const ws = await openSocket(klientUrl, {
        protocols: [`kimi-code.bearer.${TOKEN}`],
      });
      sockets.push(ws);
      expect(ws.protocol).toBe(`kimi-code.bearer.${TOKEN}`);
    });

    it('accepts a valid Authorization bearer header', async () => {
      const ws = await openSocket(klientUrl, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      sockets.push(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('closes an oversized message with 1009', async () => {
      const ws = await openSocket(klientUrl, {
        protocols: [`kimi-code.bearer.${TOKEN}`],
      });
      sockets.push(ws);
      const closed = new Promise<number>((resolve) => {
        ws.once('close', (code) => {
          resolve(code);
        });
      });

      ws.send(Buffer.alloc(KLIENT_HTTP_MAX_PAYLOAD_BYTES + 1));

      await expect(closed).resolves.toBe(1009);
    });

    it('rejects a wrong bearer token', async () => {
      await expectRejected(klientUrl, { protocols: ['kimi-code.bearer.wrong'] });
    });

    it('rejects a connection with no token', async () => {
      await expectRejected(klientUrl);
    });
  });

  it('rejects upgrades to a non-WS path', async () => {
    const badUrl = `ws://127.0.0.1:${(server as RunningServer).port}/api/other`;
    await expectRejected(badUrl, { protocols: [`kimi-code.bearer.${TOKEN}`] });
  });
});
