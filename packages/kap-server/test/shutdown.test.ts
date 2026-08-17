/**
 * Shutdown route integration coverage — exercises the loopback HTTP success
 * path and waits for the real server lifecycle to release its listener and
 * instance registration.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IThreadCommunicationService } from '@moonshot-ai/agent-core-v2';
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
      const realThreadShutdown = threadService.shutdown.bind(threadService);
      const threadShutdown = vi.spyOn(threadService, 'shutdown').mockImplementation(async () => {
        await realThreadShutdown();
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
      expect(threadShutdown).toHaveBeenCalledOnce();
      expect(running.app.server.listening).toBe(false);
      expect(await listLiveServerInstances(home)).toEqual([]);
      server = undefined;
    } finally {
      if (!shutdownRequested) await server?.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
