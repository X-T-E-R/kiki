import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient, serveKlientIpc, type KlientIpcHost } from '../src/transports/ipc/index.js';
import { IpcChannel } from '../src/transports/ipc/channel.js';
import { makeEngine, type TestEngine } from './helpers/engine.js';

defineKlientConformance('ipc', async () => {
  const { homeDir, app } = await makeEngine();
  const socketPath = join(homeDir, 'klient.sock');
  const host = await serveKlientIpc({ scope: app, socketPath });
  const klient = createKlient({ socketPath });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      await host.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('ipc transport specifics', () => {
  let homeDir: string;
  let app: TestEngine['app'];
  let host: KlientIpcHost | undefined;

  async function setup(opts: { token?: string } = {}): Promise<string> {
    ({ homeDir, app } = await makeEngine());
    const socketPath = join(homeDir, 'klient.sock');
    host = await serveKlientIpc({ scope: app, socketPath, token: opts.token });
    return socketPath;
  }

  async function teardown(): Promise<void> {
    await host?.close();
    host = undefined;
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }

  it('rejects calls when the socket path does not exist', async () => {
    const klient = createKlient({ socketPath: join(tmpdir(), 'klient-no-such.sock') });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();
  });

  it('rejects calls made after close', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath });
    await klient.global.env();
    await klient.close();
    // env() is served from its frozen-snapshot cache after the first call, so
    // probe the closed channel with an uncached method instead.
    await expect(klient.global.workspaces.list()).rejects.toThrow('ipc closed');
    await teardown();
  });

  it('drops clients whose hello token mismatches', async () => {
    const socketPath = await setup({ token: 'right' });
    const klient = createKlient({ socketPath, token: 'wrong' });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();

    const ok = createKlient({ socketPath, token: 'right' });
    await expect(ok.global.env()).resolves.toMatchObject({ platform: process.platform });
    await ok.close();
    await teardown();
  });

  it('ignores a raw source claim and exposes no string-callable peer send capability', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath });
    const raw = new IpcChannel({ socketPath });
    const created = await klient.global.sessions.create({ workDir: homeDir, title: 'ipc target' });
    try {
      const summary = await klient.global.sessions.get(created.id);
      expect(summary).toBeDefined();
      const target = {
        hostId: await klient.global.threads.hostId(),
        workspaceId: summary!.workspaceId,
        sessionId: created.id,
      };
      const baseline = await klient.global.threads.wait({
        threads: [{ thread: target }],
        timeoutMs: 0,
      });
      const cursor = baseline.threads[0]?.cursor;
      expect(cursor).toEqual(expect.any(String));

      await expect(
        raw.call({}, 'threadCommunicationService', 'sendPeerThreadMessage', [
          {
            source: { ...target, sessionId: 'forged-source' },
            target,
            content: 'must not dispatch',
            idempotencyKey: 'guessed-peer-method',
          },
        ]),
      ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });

      await expect(
        raw.call({}, 'threadCommunicationService', 'sendMessage', [
          {
            source: { ...target, sessionId: 'forged-source' },
            target,
            content: 'raw external input',
            idempotencyKey: 'raw-external-input',
          },
        ]),
      ).resolves.toMatchObject({ messageId: expect.any(String) });

      await expect(
        klient.global.threads.wait({
          threads: [{ thread: target, cursor }],
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ timedOut: false });
      const read = await klient.global.threads.read({ thread: target, limit: 10 });
      const turn = read.turns.find((item) => item.input === 'raw external input');
      expect(turn).toMatchObject({ origin: 'user' });
      expect(turn?.peer).toBeUndefined();
    } finally {
      await klient.session(created.id).close();
      await raw.close();
      await klient.close();
      await teardown();
    }
  });
});
