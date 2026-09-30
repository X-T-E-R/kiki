import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKlient } from '@kiki/klient/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

describe('Antigravity install progress over the shared WebSocket', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-agy-progress-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
    server = undefined;
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    home = undefined;
  });

  it('pushes the install steps of a real install request to a subscribed client, ending in one failure', { timeout: 30_000 }, async () => {
    const base = `http://127.0.0.1:${server!.port}`;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://dl.google.com/')) return new Response('missing', { status: 404 });
      return realFetch(input, init);
    });
    const client = createKlient({ endpoint: base, token: server!.authTokenService.getToken() });
    const received: { stage: string; installId: string; version: string }[] = [];
    const subscription = client.events.on('executors.antigravityInstallProgress', (progress) => received.push(progress));
    try {
      await subscription.ready;
      const response = await authedFetch(server!, base, '/api/executors/antigravity-acp/binaries/install', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '1.2.1' }),
      });
      expect((await response.json() as { code: number }).code).not.toBe(0);
      for (let n = 0; received.length === 0 && n < 100; n++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received).toEqual([expect.objectContaining({ stage: 'failed', version: '1.2.1', timedOut: false,
        error: 'Binary download failed (HTTP 404)' })]);
      expect(received[0]?.installId.length).toBeGreaterThan(0);
    } finally { subscription.dispose(); await client.close(); }
  });
});
