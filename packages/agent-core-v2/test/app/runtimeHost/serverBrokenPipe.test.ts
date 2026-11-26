import { randomUUID } from 'node:crypto';
import { createConnection, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeHello, encodeTokens } from '#/app/runtimeHost/codec';
import { RUNTIME_PROTOCOL_NAME, RUNTIME_PROTOCOL_VERSION } from '#/app/runtimeHost/messages';
import { createFenceTable, createRuntimeServer } from '#/app/runtimeHost/server';

function testEndpoint(): string {
  const id = randomUUID().slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\kiki-runtime-epipe-${process.pid}-${id}`
    : join(tmpdir(), `kiki-runtime-epipe-${process.pid}-${id}.sock`);
}

describe('runtimeHost broken-pipe write guard', () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
    uncaught.length = 0;
  });

  it('tears down a dead socket without uncaughtException when socket.write throws synchronous EPIPE inside data handling', async () => {
    process.on('uncaughtException', onUncaught);
    const endpoint = testEndpoint();
    let capturedServer: Server | undefined;
    const server = createRuntimeServer(
      endpoint,
      {
        canonicalHomeDir: '/home/example',
        localHostId: 'host-server',
        token: 'secret-token',
        getCurrentEpoch: () => 1,
        resolveHandler: () => undefined,
        listLocalMethods: () => [],
        persistOwnershipAfterBind: async (bound) => {
          capturedServer = bound;
        },
        onOwnerLost: () => {},
      },
      {},
      createFenceTable(),
    );

    await server.listen();
    let client: Socket | undefined;
    try {
      const serverSocketReady = new Promise<Socket>((resolve) => {
        capturedServer!.once('connection', (sock) => resolve(sock));
      });
      client = createConnection(endpoint);
      client.on('error', () => {});
      await new Promise<void>((resolve) => client!.once('connect', resolve));
      const serverSocket = await serverSocketReady;
      serverSocket.write = (() => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      }) as typeof serverSocket.write;

      client.write(
        encodeHello({
          v: RUNTIME_PROTOCOL_VERSION,
          protocol: RUNTIME_PROTOCOL_NAME,
          hostId: 'host-client',
          canonicalHomeDir: '/home/example',
        }) + encodeTokens(['secret-token']),
      );

      await vi.waitFor(() => {
        expect(serverSocket.destroyed).toBe(true);
        expect(server.connectionCount).toBe(0);
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(uncaught).toEqual([]);
      expect(server.listening).toBe(true);
    } finally {
      client?.destroy();
      await server.detach();
    }
  });
});
