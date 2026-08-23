import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IHomeRuntimeService,
  IThreadCommunicationService,
  IThreadMailboxStore,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import { listLiveServerInstances } from '../src/instanceRegistry';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

async function waitForShutdown(server: RunningServer, homeDir: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!server.app.server.listening && (await listLiveServerInstances(homeDir)).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('shutdown did not release the listener and instance registration within 10s');
}

describe('POST /api/v1/shutdown', () => {
  it('returns 200 before gracefully closing the real server', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kap-shutdown-route-'));
    let server: RunningServer | undefined;
    let shutdownRequested = false;
    try {
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      const running = server;
      const threadService = running.core.accessor.get(IThreadCommunicationService);
      const mailbox = running.core.accessor.get(IThreadMailboxStore);
      const runtime = running.core.accessor.get(IHomeRuntimeService);
      const closeOrder: string[] = [];
      const realThreadShutdown = threadService.shutdown.bind(threadService);
      const realMailboxClose = mailbox.close.bind(mailbox);
      const realRuntimeClose = runtime.close.bind(runtime);
      const threadShutdown = vi.spyOn(threadService, 'shutdown').mockImplementation(async () => {
        closeOrder.push('thread');
        await realThreadShutdown();
      });
      const mailboxClose = vi.spyOn(mailbox, 'close').mockImplementation(async () => {
        closeOrder.push('mailbox');
        await realMailboxClose();
      });
      const runtimeClose = vi.spyOn(runtime, 'close').mockImplementation(async () => {
        closeOrder.push('runtime');
        await realRuntimeClose();
      });

      const response = await authedFetch(
        running,
        `http://127.0.0.1:${running.port}`,
        '/api/v1/shutdown',
        { method: 'POST' },
      );
      shutdownRequested = true;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        code: 0,
        data: { ok: true },
        request_id: expect.any(String),
      });

      await waitForShutdown(running, home);
      await running.close();
      expect(threadShutdown).toHaveBeenCalledOnce();
      expect(mailboxClose).toHaveBeenCalledOnce();
      expect(runtimeClose).toHaveBeenCalledOnce();
      expect(closeOrder).toEqual(['thread', 'mailbox', 'runtime']);
      expect(runtime.status()).toMatchObject({ role: 'idle', ready: false });
      expect(running.app.server.listening).toBe(false);
      expect(await listLiveServerInstances(home)).toEqual([]);
      server = undefined;
    } finally {
      if (!shutdownRequested) await server?.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('keeps close idempotent and releases later resources after earlier close failures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kap-shutdown-errors-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      const running = server;
      const threadService = running.core.accessor.get(IThreadCommunicationService);
      const mailbox = running.core.accessor.get(IThreadMailboxStore);
      const runtime = running.core.accessor.get(IHomeRuntimeService);
      const closeOrder: string[] = [];
      const realThreadShutdown = threadService.shutdown.bind(threadService);
      const realMailboxClose = mailbox.close.bind(mailbox);
      const realRuntimeClose = runtime.close.bind(runtime);
      const threadShutdown = vi.spyOn(threadService, 'shutdown').mockImplementation(async () => {
        closeOrder.push('thread');
        await realThreadShutdown();
        throw new Error('simulated thread shutdown failure');
      });
      const mailboxClose = vi.spyOn(mailbox, 'close').mockImplementation(async () => {
        closeOrder.push('mailbox');
        await realMailboxClose();
        throw new Error('simulated mailbox close failure');
      });
      const runtimeClose = vi.spyOn(runtime, 'close').mockImplementation(async () => {
        closeOrder.push('runtime');
        await realRuntimeClose();
      });

      const firstClose = running.close();
      expect(running.close()).toBe(firstClose);
      await expect(firstClose).rejects.toBeInstanceOf(AggregateError);
      expect(threadShutdown).toHaveBeenCalledOnce();
      expect(mailboxClose).toHaveBeenCalledOnce();
      expect(runtimeClose).toHaveBeenCalledOnce();
      expect(closeOrder).toEqual(['thread', 'mailbox', 'runtime']);
      expect(runtime.status()).toMatchObject({ role: 'idle', ready: false });
      expect(running.app.server.listening).toBe(false);
      expect(await listLiveServerInstances(home)).toEqual([]);
      server = undefined;
    } finally {
      await server?.close().catch(() => {});
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
