import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const EXTERNAL_DELEGATION_ENV_NAMES = [
  'KIKI_EXTERNAL_PRINCIPAL_ID',
  'KIKI_EXTERNAL_SESSION_ID',
  'KIKI_EXTERNAL_DELEGATION_TOKEN',
  'KIKI_EXTERNAL_WORKSPACE_PATH',
  'KIKI_EXTERNAL_MODEL_ALIAS',
  'KIKI_EXTERNAL_THINKING_EFFORT',
  'KIKI_EXTERNAL_PERMISSION_MODE',
  'KIKI_EXTERNAL_SESSION_TITLE',
] as const;

type ExternalDelegationEnvName = (typeof EXTERNAL_DELEGATION_ENV_NAMES)[number];
type ExternalDelegationEnv = Partial<Record<ExternalDelegationEnvName, string>>;

function takeExternalDelegationEnv(): ExternalDelegationEnv {
  const values: ExternalDelegationEnv = {};
  for (const name of EXTERNAL_DELEGATION_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) values[name] = value;
    delete process.env[name];
  }
  return values;
}

function restoreExternalDelegationEnv(values: ExternalDelegationEnv): void {
  for (const name of EXTERNAL_DELEGATION_ENV_NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

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
  let externalDelegationEnv: ExternalDelegationEnv;

  beforeEach(() => {
    externalDelegationEnv = takeExternalDelegationEnv();
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
    restoreExternalDelegationEnv(externalDelegationEnv);
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

  it('waits for the session index before bootstrapping external delegation', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-delegation-index-'));
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
      'utf8',
    );
    const prepareGate = deferred<SessionIndexStatus>();
    const prepare = vi.fn(() => prepareGate.promise);
    const index = stubSessionIndex(prepare);
    const get = vi.fn(index.get);

    const starting = startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[ISessionIndex, { ...index, get }]],
      externalDelegation: {
        principalId: 'example-principal',
        sessionId: 'session_index_ready',
        token: 'DELEGATION_SECRET',
        sessionBootstrap: {
          workspacePath: workspace,
          modelAlias: 'stub',
          thinkingEffort: 'high',
        },
      },
    });

    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(get).not.toHaveBeenCalled();
    prepareGate.resolve({
      source: 'read-model',
      state: 'ready',
      generation: 1,
      degradedCount: 0,
    });
    server = await starting;
    expect(get).toHaveBeenCalledWith('session_index_ready');
  });

  it('disables external delegation when session index preparation fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-delegation-index-failure-'));
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const prepare = vi.fn(async () => {
      throw new Error('injected index failure');
    });
    const index = stubSessionIndex(prepare);
    const get = vi.fn(index.get);

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[ISessionIndex, { ...index, get }]],
      externalDelegation: {
        principalId: 'example-principal',
        sessionId: 'session_index_unavailable',
        token: 'DELEGATION_SECRET',
        sessionBootstrap: {
          workspacePath: workspace,
          modelAlias: 'stub',
          thinkingEffort: 'high',
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    expect(prepare).toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    const metaResponse = await authedFetch(server, base, '/api/v1/meta');
    expect(await metaResponse.json()).toMatchObject({
      code: 0,
      data: {
        external_delegation: {
          state: 'disabled',
          reason: 'session_index_unavailable',
          message: expect.stringContaining('injected index failure'),
        },
      },
    });
    const edgeResponse = await authedFetch(
      server,
      base,
      '/api/v2/sessions/session_index_unavailable/external-delegation/list',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kiki-delegation-token': 'DELEGATION_SECRET',
        },
        body: '{}',
      },
    );
    expect(await edgeResponse.json()).toMatchObject({
      code: 40002,
      msg: expect.stringContaining('session_index_unavailable'),
    });
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
    await writeFile(join(home, 'config.toml'), '', 'utf8');
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

describe('server-v2 boot — external delegation startup', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let externalDelegationEnv: ExternalDelegationEnv;

  beforeEach(() => {
    externalDelegationEnv = takeExternalDelegationEnv();
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
    restoreExternalDelegationEnv(externalDelegationEnv);
  });

  it('rejects startup when the env authority is incomplete', async () => {
    process.env['KIKI_EXTERNAL_PRINCIPAL_ID'] = 'example-principal';
    delete process.env['KIKI_EXTERNAL_SESSION_ID'];
    delete process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'];
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-delegation-env-'));
    await expect(startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    })).rejects.toThrow(/authority configuration is incomplete/i);
    expect(await listLiveServerInstances(home)).toEqual([]);
  });

  it('rejects startup when the external permission mode is invalid', async () => {
    process.env['KIKI_EXTERNAL_PERMISSION_MODE'] = 'elevated';
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-delegation-permission-'));
    await expect(startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    })).rejects.toThrow(/permission mode is invalid/i);
    expect(await listLiveServerInstances(home)).toEqual([]);
  });

  it('keeps the server available and exposes disabled delegation when bootstrap fails', async () => {
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
          workspacePath: 'relative/workspace',
          modelAlias: 'grok-4.6',
          thinkingEffort: 'high',
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/api/v1/healthz`)).status).toBe(200);
    const metaResponse = await authedFetch(server, base, '/api/v1/meta');
    const meta = await metaResponse.json() as {
      code: number;
      data: {
        external_delegation: {
          state: string;
          reason?: string;
          message?: string;
        };
      };
    };
    expect(meta).toMatchObject({
      code: 0,
      data: {
        external_delegation: {
          state: 'disabled',
          reason: 'bootstrap_failed',
          message: expect.stringMatching(/workspace path must be absolute/i),
        },
      },
    });

    const edgeResponse = await authedFetch(
      server,
      base,
      '/api/v2/sessions/session-operator/external-delegation/list',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kiki-delegation-token': 'DELEGATION_SECRET',
        },
        body: '{}',
      },
    );
    expect(await edgeResponse.json()).toMatchObject({
      code: 40002,
      msg: expect.stringContaining('bootstrap_failed'),
    });
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
  let externalDelegationEnv: ExternalDelegationEnv;

  beforeEach(() => {
    externalDelegationEnv = takeExternalDelegationEnv();
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
    restoreExternalDelegationEnv(externalDelegationEnv);
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
