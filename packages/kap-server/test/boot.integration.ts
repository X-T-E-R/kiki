import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IBootstrapService,
  IFileSystemStorageService,
  IHostRequestHeaders,
  InMemoryStorageService,
  IOAuthToolkit,
  ISessionIndex,
  IThreadCommunicationService,
  ITelemetryService,
  IWorkspaceService,
  noopTelemetryService,
  type SessionIndexStatus,
} from '@moonshot-ai/agent-core-v2';
import { Event } from '@moonshot-ai/agent-core-v2/_base/event';

import { listLiveServerInstances } from '../src/instanceRegistry';
import { IGlobalSearchService } from '../src/search/searchService';
import { createServerLogger } from '../src/services/pinoLoggerService';
import { listenWithPortRetry, type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stubSessionIndex(prepare: ISessionIndex['prepare']): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare,
    onDidChangeStatus: Event.None as ISessionIndex['onDidChangeStatus'],
    status: () => ({ source: 'read-model', state: 'uninitialized', degradedCount: 0 }),
    get: async () => undefined,
    listRecent: async () => ({ items: [] }),
    count: async () => 0,
    remove: async () => {},
  };
}

function stubWorkspaceService(list: IWorkspaceService['list']): IWorkspaceService {
  return {
    _serviceBrand: undefined,
    list,
    get: async () => undefined,
    createOrTouch: async () => {
      throw new Error('not used by boot test');
    },
    update: async () => undefined,
    delete: async () => {},
  };
}

function stubGlobalSearchService(
  setLiveTranscriptSource: IGlobalSearchService['setLiveTranscriptSource'],
): IGlobalSearchService {
  return {
    _serviceBrand: undefined,
    search: async () => {
      throw new Error('not used by boot test');
    },
    reindex: async () => ({ sessions: 0, documents: 0 }),
    status: async () => ({
      sessions: 0,
      documents: 0,
      lastIndexedAt: null,
      generation: 0,
      lifecycle: { state: 'stopped' },
    }),
    lifecycleReport: () => ({ state: 'stopped' }),
    setLiveTranscriptSource,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`server did not listen within ${String(timeoutMs)}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('server logger', () => {
  it('writes pino output to stderr for desktop log capture', () => {
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
    try {
      createServerLogger({ level: 'info' }).info({ probe: true }, 'stderr probe');
      const output = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('"name":"kimi-server-v2"');
      expect(output).toContain('"probe":true');
      expect(output).toContain('"msg":"stderr probe"');
    } finally {
      stderrWrite.mockRestore();
    }
  });
});

describe('server-v2 boot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  it('boots agent-core-v2 and serves the basic /api/v1 routes', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });

    const base = `http://127.0.0.1:${server.port}`;

    const healthz = await fetch(`${base}/api/v1/healthz`);
    expect(healthz.status).toBe(200);
    const healthBody = await healthz.json() as {
      code: number;
      data: { ok: boolean };
      request_id: string;
    };
    expect(healthBody.code).toBe(0);
    expect(healthBody.data.ok).toBe(true);
    expect(typeof healthBody.request_id).toBe('string');

    const meta = await authedFetch(server, base, '/api/v1/meta');
    expect(meta.status).toBe(200);
    const metaBody = await meta.json() as {
      code: number;
      data: { server_id: string; server_version: string; capabilities: Record<string, boolean> };
    };
    expect(metaBody.code).toBe(0);
    expect(typeof metaBody.data.server_id).toBe('string');
    expect(typeof metaBody.data.server_version).toBe('string');
    expect(metaBody.data.capabilities).toBeDefined();

    const auth = await authedFetch(server, base, '/api/v1/auth');
    expect(auth.status).toBe(200);
    const authBody = await auth.json() as {
      code: number;
      data: { ready: boolean; providers_count: number; default_model: string | null };
    };
    expect(authBody.code).toBe(0);
    expect(typeof authBody.data.ready).toBe('boolean');
    expect(authBody.data.providers_count).toBeGreaterThanOrEqual(0);

    const oauthPoll = await authedFetch(server, base, '/api/v1/oauth/login');
    expect(oauthPoll.status).toBe(200);
    const oauthBody = await oauthPoll.json() as { code: number; data: null };
    expect(oauthBody.code).toBe(0);
    expect(oauthBody.data).toBeNull();
  });

  it('warms session index, workspace catalog, then global search after listen', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-background-warmup-'));
    const workspaceSync = deferred<readonly []>();
    const prepareGate = deferred<SessionIndexStatus>();
    const order: string[] = [];
    const workspaceList = vi.fn(() => {
      order.push('workspace');
      return workspaceSync.promise;
    });
    const prepare = vi.fn(() => {
      order.push('index');
      return prepareGate.promise;
    });
    const setLiveTranscriptSource = vi.fn(() => {
      order.push('search');
    });

    try {
      server = await withTimeout(
        startServer({
          hostIdentity: TEST_HOST_IDENTITY,
          host: '127.0.0.1',
          port: 0,
          homeDir: home,
          logLevel: 'silent',
          seeds: [
            [IWorkspaceService, stubWorkspaceService(workspaceList)],
            [ISessionIndex, stubSessionIndex(prepare)],
            [IGlobalSearchService, stubGlobalSearchService(setLiveTranscriptSource)],
          ],
        }),
        2_000,
      );

      const base = `http://127.0.0.1:${server.port}`;
      expect(prepare).toHaveBeenCalledOnce();
      expect(workspaceList).not.toHaveBeenCalled();
      expect(setLiveTranscriptSource).not.toHaveBeenCalled();
      expect((await authedFetch(server, base, '/api/v1/meta')).status).toBe(200);

      prepareGate.resolve({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
      await vi.waitFor(() => expect(workspaceList).toHaveBeenCalledOnce());
      expect(setLiveTranscriptSource).not.toHaveBeenCalled();

      workspaceSync.resolve([]);
      await vi.waitFor(() => expect(setLiveTranscriptSource).toHaveBeenCalledOnce());
      expect(order).toEqual(['index', 'workspace', 'search']);
    } finally {
      prepareGate.resolve({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
      workspaceSync.resolve([]);
    }
  });

  it('keeps the listener available when background session-index prepare fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-background-prepare-failure-'));
    const prepareFailure = deferred<SessionIndexStatus>();
    const prepare = vi.fn(() => prepareFailure.promise);
    let prepareSettled = false;
    void prepareFailure.promise.then(
      () => {
        prepareSettled = true;
      },
      () => {
        prepareSettled = true;
      },
    );

    try {
      server = await withTimeout(
        startServer({
          hostIdentity: TEST_HOST_IDENTITY,
          host: '127.0.0.1',
          port: 0,
          homeDir: home,
          logLevel: 'silent',
          seeds: [
            [IWorkspaceService, stubWorkspaceService(async () => [])],
            [ISessionIndex, stubSessionIndex(prepare)],
          ],
        }),
        2_000,
      );

      const base = `http://127.0.0.1:${server.port}`;
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      expect((await authedFetch(server, base, '/api/v1/meta')).status).toBe(200);

      prepareFailure.reject(new Error('injected prepare failure'));
      await vi.waitFor(() => expect(prepareSettled).toBe(true));
      expect((await fetch(`${base}/api/v1/healthz`)).status).toBe(200);
    } finally {
      prepareFailure.resolve({
        source: 'read-model',
        state: 'degraded',
        reason: 'injected failure',
        degradedCount: 1,
      });
    }
  });

  it('reports opts.serverVersion as server_version instead of the package version', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-version-'));
    server = await startServer({
      hostIdentity: {
        productName: 'test-host',
        version: '9.9.9-host',
        platform: 'test_platform',
      },
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      serverVersion: '9.9.9-host',
    });

    const base = `http://127.0.0.1:${server.port}`;
    const meta = await authedFetch(server, base, '/api/v1/meta');
    const metaBody = await meta.json() as {
      code: number;
      data: { server_version: string };
    };
    expect(metaBody.data.server_version).toBe('9.9.9-host');

    const [instance] = await listLiveServerInstances(home);
    expect(instance?.serverVersion).toBe('9.9.9-host');

    const defaults = server.core.accessor.get(IHostRequestHeaders);
    expect(defaults.headers['User-Agent']).toBe('test-host/9.9.9-host');
    expect(server.core.accessor.get(IBootstrapService).clientIdentity).toEqual({
      productName: 'test-host',
      version: '9.9.9-host',
      platform: 'test_platform',
    });
  });

  it('seeds default Kimi identity headers from hostIdentity that opts.seeds can override', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ua-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const defaults = server.core.accessor.get(IHostRequestHeaders);
    expect(defaults.headers['User-Agent']).toBe('test-host/0.0.0-test');
    expect(defaults.headers['X-Msh-Version']).toBe('0.0.0-test');
    expect(defaults.headers['X-Msh-Platform']).toBe('test_platform');

    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IHostRequestHeaders, { headers: { 'User-Agent': 'custom-host/9.9' } }]],
    });
    const overridden = server.core.accessor.get(IHostRequestHeaders);
    expect(overridden.headers['User-Agent']).toBe('custom-host/9.9');
  });

  it('seeds explicit skill dirs into the core scope when skillDirs is provided', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-skills-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      skillDirs: ['/skills/explicit'],
    });
    expect(server.core.accessor.get(IBootstrapService).args.skillDirs).toEqual([
      '/skills/explicit',
    ]);

    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    expect(server.core.accessor.get(IBootstrapService).args.skillDirs).toBeUndefined();
  });

  it('does not shut down a host-injected telemetry service when server telemetry is disabled', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-host-telemetry-'));
    await writeFile(join(home, 'config.toml'), 'telemetry = false\n', 'utf8');
    const shutdown = vi.fn(async () => {});

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[ITelemetryService, { ...noopTelemetryService, shutdown }]],
    });

    await server.close();
    server = undefined;

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('completes server cleanup when owned telemetry shutdown fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-telemetry-failure-'));
    const storage = new InMemoryStorageService();
    const write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementation(async (scope, key, data, options) => {
      if (scope === 'telemetry') throw new Error('telemetry storage unavailable');
      await write(scope, key, data, options);
    });
    const auth = {
      _serviceBrand: undefined,
      getCachedAccessToken: async () => {
        throw new Error('telemetry auth unavailable');
      },
    } as unknown as IOAuthToolkit;

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      telemetry: true,
      seeds: [
        [IFileSystemStorageService, storage],
        [IOAuthToolkit, auth],
      ],
    });
    const core = server.core;
    core.accessor.get(ITelemetryService).track('server_probe');

    await server.close();
    server = undefined;

    expect(() => core.accessor.get(IBootstrapService)).toThrow();
    expect(await listLiveServerInstances(home)).toEqual([]);
  });

  it.each(['listener', 'thread'] as const)(
    'rejects close after cleanup when %s shutdown fails',
    async (failure) => {
      home = await mkdtemp(join(tmpdir(), `kimi-server-v2-${failure}-close-failure-`));
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      const running = server;
      const core = running.core;
      const boom = new Error(`injected ${failure} close failure`);
      if (failure === 'listener') {
        const closeApp = running.app.close.bind(running.app);
        vi.spyOn(running.app, 'close').mockImplementation((async () => {
          await closeApp();
          throw boom;
        }) as never);
      } else {
        const service = core.accessor.get(IThreadCommunicationService);
        const shutdown = service.shutdown.bind(service);
        vi.spyOn(service, 'shutdown').mockImplementation(async () => {
          await shutdown();
          throw boom;
        });
      }

      const closing = running.close();
      server = undefined;
      await expect(closing).rejects.toBe(boom);
      expect(() => core.accessor.get(IBootstrapService)).toThrow();
      expect(await listLiveServerInstances(home)).toEqual([]);
    },
  );
});

describe('server-v2 boot — external delegation fail-open', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  const originalPrincipal = process.env['KIKI_EXTERNAL_PRINCIPAL_ID'];
  const originalSession = process.env['KIKI_EXTERNAL_SESSION_ID'];
  const originalToken = process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'];

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
    if (originalPrincipal === undefined) delete process.env['KIKI_EXTERNAL_PRINCIPAL_ID'];
    else process.env['KIKI_EXTERNAL_PRINCIPAL_ID'] = originalPrincipal;
    if (originalSession === undefined) delete process.env['KIKI_EXTERNAL_SESSION_ID'];
    else process.env['KIKI_EXTERNAL_SESSION_ID'] = originalSession;
    if (originalToken === undefined) delete process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'];
    else process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'] = originalToken;
  });

  it('starts without the delegation edge when the env authority is incomplete', async () => {
    process.env['KIKI_EXTERNAL_PRINCIPAL_ID'] = 'example-principal';
    // SESSION_ID and TOKEN stay unset → the env authority is incomplete.
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-delegation-env-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });

    const healthz = await fetch(`http://127.0.0.1:${server.port}/api/v1/healthz`);
    expect(healthz.status).toBe(200);
  });

  it('starts without the delegation edge when the Session bootstrap fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-delegation-bootstrap-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      externalDelegation: {
        principalId: 'example-principal',
        sessionId: 'session-operator',
        token: 'DELEGATION_SECRET',
        sessionBootstrap: {
          workspacePath: 'relative/workspace', // non-absolute → bootstrap throws
          modelAlias: 'grok-4.6',
          thinkingEffort: 'high',
        },
      },
    });

    const healthz = await fetch(`http://127.0.0.1:${server.port}/api/v1/healthz`);
    expect(healthz.status).toBe(200);
  });
});

function silentLogger() {
  return pino({ level: 'silent' });
}

function addrInUse(): NodeJS.ErrnoException {
  const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
  err.code = 'EADDRINUSE';
  return err;
}

function listenOnPort(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host, port }, () => resolve(server));
  });
}

function closeNetServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function allocateAdjacentFreePair(
  host = '127.0.0.1',
): Promise<{ port: number; next: number }> {
  for (let i = 0; i < 30; i++) {
    const a = await listenOnPort(host, 0);
    const address = a.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await closeNetServer(a);
    if (port <= 0 || port >= 65535) continue;
    const probe = await listenOnPort(host, port + 1).catch(() => null);
    if (probe === null) continue;
    await closeNetServer(probe);
    return { port, next: port + 1 };
  }
  throw new Error('could not allocate an adjacent free port pair');
}

describe('listenWithPortRetry', () => {
  it('returns the requested port when the first listen succeeds', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        return `http://127.0.0.1:${String(port)}`;
      },
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5000);
    expect(attempts).toEqual([5000]);
  });

  it('retries with port+1 on EADDRINUSE until a bind succeeds', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        if (port < 5002) throw addrInUse();
        return `http://127.0.0.1:${String(port)}`;
      },
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5002);
    expect(result.address).toBe('http://127.0.0.1:5002');
    expect(attempts).toEqual([5000, 5001, 5002]);
  });

  it('does not retry on non-EADDRINUSE errors', async () => {
    const attempts: number[] = [];
    const boom = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    await expect(
      listenWithPortRetry({
        listen: async (_host, port) => {
          attempts.push(port);
          throw boom;
        },
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
      }),
    ).rejects.toBe(boom);
    expect(attempts).toEqual([5000]);
  });

  it('throws after exhausting maxRetries', async () => {
    const attempts: number[] = [];
    await expect(
      listenWithPortRetry({
        listen: async (_host, port) => {
          attempts.push(port);
          throw addrInUse();
        },
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(attempts).toEqual([5000, 5001, 5002, 5003]);
  });

  it('does not walk ports when the requested port is 0 (ephemeral)', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        return 'http://127.0.0.1:54321';
      },
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger(),
    });

    expect(result.port).toBe(0);
    expect(attempts).toEqual([0]);
  });
});

describe('server-v2 boot — port retry', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  it('retries on port+1 and advertises the bound port in the instance registry', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-port-retry-'));
    const { port, next } = await allocateAdjacentFreePair();
    const occupant = await listenOnPort('127.0.0.1', port);
    try {
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port,
        homeDir: home,
        logLevel: 'silent',
      });

      expect(server.port).toBeGreaterThanOrEqual(next);
      const [instance] = await listLiveServerInstances(home);
      expect(instance?.port).toBe(server.port);
    } finally {
      await closeNetServer(occupant);
    }
  });
});
