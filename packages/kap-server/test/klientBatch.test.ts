import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bootstrap, IConfigService, ISessionIndex, logSeed, resolveLoggingConfig } from '@kiki/agent-core-v2';
import { createKlient, HttpChannel } from '@kiki/klient/http';
import { describe, expect, it, vi } from 'vitest';

import { registerKlientHttp } from '../src/transport/klient/registerKlientHttp';
import { setWebPrincipal } from '../src/services/webAccess';

const TEST_IDENTITY = {
  productName: 'kap-batch-test',
  version: '0.0.0-test',
  platform: 'test',
} as const;

async function createTestScope(prefix: string) {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  const { app } = bootstrap({ homeDir, clientIdentity: TEST_IDENTITY }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  await app.accessor.get(IConfigService).ready;
  await app.accessor.get(ISessionIndex).prepare();
  return { homeDir, scope: app };
}

describe('POST /api/klient/batch end-to-end with HttpChannel', () => {
  it('coalesces 10 concurrent Promise.all RPC calls into 1 HTTP request and keeps single calls on /api/klient/call', async () => {
    const { homeDir, scope } = await createTestScope('kap-batch-coalesce-');
    const app = Fastify({ logger: false });
    registerKlientHttp(app, scope);
    const seenPaths: string[] = [];
    app.addHook('onRequest', async (req) => {
      seenPaths.push(req.url);
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as { port: number };
      const klient = createKlient({ endpoint: `http://127.0.0.1:${port}` });
      const channel = new HttpChannel({ endpoint: `http://127.0.0.1:${port}` });
      try {
        const single = await channel.call({}, 'bootstrapService', 'platform', []);
        expect(typeof single).toBe('string');
        expect(seenPaths).toEqual(['/api/klient/call']);

        seenPaths.length = 0;
        const startedAt = performance.now();
        const results = await Promise.all([
          channel.call({}, 'bootstrapService', 'platform', []),
          channel.call({}, 'bootstrapService', 'arch', []),
          channel.call({}, 'bootstrapService', 'cwd', []),
          channel.call({}, 'bootstrapService', 'homeDir', []),
          channel.call({}, 'bootstrapService', 'configPath', []),
          channel.call({}, 'bootstrapService', 'sessionsDir', []),
          channel.call({}, 'bootstrapService', 'blobsDir', []),
          channel.call({}, 'bootstrapService', 'storeDir', []),
          channel.call({}, 'bootstrapService', 'cacheDir', []),
          channel.call({}, 'bootstrapService', 'logsDir', []),
        ]);
        const elapsedMs = performance.now() - startedAt;

        expect(results).toHaveLength(10);
        for (const value of results) expect(typeof value).toBe('string');
        expect(seenPaths).toEqual(['/api/klient/batch']);

        seenPaths.length = 0;
        const envSnapshot = await klient.global.env();
        expect(typeof envSnapshot.platform).toBe('string');
        expect(seenPaths).toEqual(['/api/klient/batch']);

        process.stdout.write(
          `[klient-batch] coalesced 10 concurrent calls into ${seenPaths.length} HTTP request in ${elapsedMs.toFixed(2)}ms\n`,
        );
      } finally {
        await channel.close();
        await klient.close();
      }
    } finally {
      await app.close();
      await scope.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('streams NDJSON out-of-order so a 5ms fast call resolves before a 150ms slow sibling finishes', async () => {
    const { homeDir, scope } = await createTestScope('kap-batch-stream-');
    const sessionIndex = scope.accessor.get(ISessionIndex);
    const originalGet = sessionIndex.get.bind(sessionIndex);
    const spy = vi.spyOn(sessionIndex, 'get').mockImplementation(async (id: string) => {
      const delayMs = id === 'slow-session' ? 150 : 5;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return originalGet(id);
    });
    const app = Fastify({ logger: false });
    registerKlientHttp(app, scope);
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as { port: number };
      const channel = new HttpChannel({ endpoint: `http://127.0.0.1:${port}` });
      try {
        const startedAt = performance.now();
        let fastResolvedAt = 0;
        let slowResolvedAt = 0;

        const slowPromise = channel.call({}, 'sessionIndex', 'get', ['slow-session']).then((res) => {
          slowResolvedAt = performance.now() - startedAt;
          return res;
        });
        const fastPromise = channel.call({}, 'sessionIndex', 'get', ['fast-session']).then((res) => {
          fastResolvedAt = performance.now() - startedAt;
          return res;
        });

        await Promise.all([slowPromise, fastPromise]);
        expect(fastResolvedAt).toBeGreaterThan(0);
        expect(slowResolvedAt).toBeGreaterThan(fastResolvedAt + 75);

        process.stdout.write(
          `[klient-batch] out-of-order NDJSON: fast=${fastResolvedAt.toFixed(1)}ms slow=${slowResolvedAt.toFixed(1)}ms (delta=${(slowResolvedAt - fastResolvedAt).toFixed(1)}ms)\n`,
        );
      } finally {
        await channel.close();
      }
    } finally {
      spy.mockRestore();
      await app.close();
      await scope.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('enforces per-call web authorization without failing authorized sibling calls in the same batch', async () => {
    const { homeDir, scope } = await createTestScope('kap-batch-auth-');
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      if (req.headers['x-test-web'] === '1') {
        setWebPrincipal(req, { kind: 'web', sessionId: 'web-session-1' });
      }
    });
    registerKlientHttp(app, scope);
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as { port: number };
      const customFetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('x-test-web', '1');
        return fetch(input, { ...init, headers });
      };
      const channel = new HttpChannel({
        endpoint: `http://127.0.0.1:${port}`,
        fetch: customFetch,
      });
      try {
        const [allowed, denied, alsoAllowed] = await Promise.allSettled([
          channel.call({}, 'bootstrapService', 'platform', []),
          channel.call({}, 'authTokenService', 'getToken', []),
          channel.call({}, 'bootstrapService', 'arch', []),
        ]);
        expect(allowed.status).toBe('fulfilled');
        expect(alsoAllowed.status).toBe('fulfilled');
        expect(denied.status).toBe('rejected');
        if (denied.status === 'rejected') {
          expect(denied.reason).toMatchObject({ code: 40301, message: 'local_owner_required' });
        }
      } finally {
        await channel.close();
      }
    } finally {
      await app.close();
      await scope.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('handles per-call AbortSignal independently and aborts underlying fetch only when all callers abort', async () => {
    const { homeDir, scope } = await createTestScope('kap-batch-abort-');
    const sessionIndex = scope.accessor.get(ISessionIndex);
    const originalGet = sessionIndex.get.bind(sessionIndex);
    const spy = vi.spyOn(sessionIndex, 'get').mockImplementation(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, id === 'keep' ? 60 : 120));
      return originalGet(id);
    });
    const app = Fastify({ logger: false });
    registerKlientHttp(app, scope);
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as { port: number };

      const fetchSignals: AbortSignal[] = [];
      const observedFetch: typeof fetch = (input, init) => {
        if (init?.signal !== undefined && init.signal !== null) fetchSignals.push(init.signal);
        return fetch(input, init);
      };
      const channel = new HttpChannel({
        endpoint: `http://127.0.0.1:${port}`,
        fetch: observedFetch,
      });
      try {
        const abortOne = new AbortController();
        const pKeep = channel.call({}, 'sessionIndex', 'get', ['keep']);
        const pCancel = channel.call({}, 'sessionIndex', 'get', ['drop'], { signal: abortOne.signal });
        await new Promise((resolve) => setTimeout(resolve, 15));
        abortOne.abort(new Error('drop_one'));

        await expect(pCancel).rejects.toThrow('drop_one');
        expect(fetchSignals[0]?.aborted).toBe(false);
        await expect(pKeep).resolves.toBeUndefined();

        const abortA = new AbortController();
        const abortB = new AbortController();
        const pA = channel.call({}, 'sessionIndex', 'get', ['a'], { signal: abortA.signal });
        const pB = channel.call({}, 'sessionIndex', 'get', ['b'], { signal: abortB.signal });
        await new Promise((resolve) => setTimeout(resolve, 15));
        abortA.abort(new Error('cancel_a'));
        expect(fetchSignals[1]?.aborted).toBe(false);
        abortB.abort(new Error('cancel_b'));
        await expect(pA).rejects.toThrow('cancel_a');
        await expect(pB).rejects.toThrow('cancel_b');
        expect(fetchSignals[1]?.aborted).toBe(true);
      } finally {
        await channel.close();
      }
    } finally {
      spy.mockRestore();
      await app.close();
      await scope.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
