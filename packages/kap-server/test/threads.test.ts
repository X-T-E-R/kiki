import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Error2, ErrorCodes, IThreadCommunicationService, type Scope } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import {
  readThreadRequestSchema as publicReadThreadRequestSchema,
  sendThreadMessageRequestSchema as publicSendThreadMessageRequestSchema,
  waitThreadsRequestSchema as publicWaitThreadsRequestSchema,
} from '../../protocol/src/rest/thread';
import {
  readThreadRequestSchema as serverReadThreadRequestSchema,
  sendThreadMessageRequestSchema as serverSendThreadMessageRequestSchema,
  waitThreadsRequestSchema as serverWaitThreadsRequestSchema,
} from '../src/protocol/rest-thread';
import { registerThreadsRoutes } from '../src/routes/threads';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
  readonly options: unknown;
  readonly handler: (req: Record<string, unknown>, reply: Record<string, unknown>) => Promise<void>;
}

function setup(service: IThreadCommunicationService) {
  const routes: RegisteredRoute[] = [];
  const app = Object.fromEntries(
    ['get', 'post', 'put', 'delete'].map((method) => [
      method,
      (path: string, options: unknown, handler: RegisteredRoute['handler']) => {
        routes.push({ method, path, options, handler });
      },
    ]),
  );
  const core = { accessor: { get: () => service } } as unknown as Scope;
  registerThreadsRoutes(app as never, core);
  const route = (method: string, path: string): RegisteredRoute => {
    const found = routes.find((item) => item.method === method && item.path === path);
    if (found === undefined) throw new Error(`missing route ${method} ${path}`);
    return found;
  };
  return { routes, route };
}

function makeService(): IThreadCommunicationService {
  return {
    _serviceBrand: undefined,
    hostId: 'host-a',
    listThreads: vi.fn(async () => ({ threads: [] })),
    readThread: vi.fn(async (input) => ({ thread: input.thread, turns: [] })),
    sendMessage: vi.fn(async () => ({
      messageId: 'message-a',
      targetSeq: 1,
      acceptedAt: 2,
      deduplicated: false,
      delivery: 'pending' as const,
    })),
    waitThreads: vi.fn(async (input: Parameters<IThreadCommunicationService['waitThreads']>[0]) => ({
      threads: input.threads.map((item) => ({ thread: item.thread, cursor: 'cursor-a', activities: [] })),
      timedOut: true,
    })),
    shutdown: vi.fn(async () => {}),
    getWorkspaceOverride: vi.fn(async () => undefined),
    setWorkspaceOverride: vi.fn(async () => undefined),
    clearWorkspaceOverride: vi.fn(async () => undefined),
    isWorkspaceEnabled: vi.fn(async () => true),
  };
}

const targetWire = { host_id: 'host-a', workspace_id: 'workspace-b', session_id: 'session-b' };
const targetCore = { hostId: 'host-a', workspaceId: 'workspace-b', sessionId: 'session-b' };

function request(values: Record<string, unknown> = {}) {
  return { id: 'request-a', body: {}, query: {}, params: {}, ...values };
}

function reply() {
  return { send: vi.fn() };
}

describe('peer-thread routes', () => {
  it('keeps public and server schema mirrors behaviorally aligned', () => {
    const corpus = [
      { thread: targetWire, limit: 100 },
      { thread: { ...targetWire, host_id: '' } },
      { thread: targetWire, cursor: '' },
    ];
    for (const value of corpus) {
      expect(serverReadThreadRequestSchema.safeParse(value).success).toBe(
        publicReadThreadRequestSchema.safeParse(value).success,
      );
    }
    const waits = [
      { threads: [{ thread: targetWire }], timeout_ms: 0 },
      { threads: [{ thread: targetWire }, { thread: targetWire }] },
      { threads: [{ thread: targetWire }], timeout_ms: 60_001 },
    ];
    for (const value of waits) {
      expect(serverWaitThreadsRequestSchema.safeParse(value).success).toBe(
        publicWaitThreadsRequestSchema.safeParse(value).success,
      );
    }
    const sends = [
      { target: targetWire, content: 'message', idempotency_key: 'key' },
      {
        source: { ...targetWire, session_id: 'source' },
        target: targetWire,
        content: 'message',
        idempotency_key: 'key',
      },
    ];
    for (const value of sends) {
      expect(serverSendThreadMessageRequestSchema.safeParse(value).success).toBe(
        publicSendThreadMessageRequestSchema.safeParse(value).success,
      );
    }
  });

  it('registers all operations and preserves cross-workspace references', async () => {
    const service = makeService();
    vi.mocked(service.listThreads).mockResolvedValue({
      threads: [{ ref: targetCore, createdAt: 1, updatedAt: 2, state: 'cold' }],
    });
    const { routes, route } = setup(service);
    expect(routes.map((item) => `${item.method} ${item.path}`)).toEqual([
      'get /threads',
      'post /threads::read',
      'post /threads::send',
      'post /threads::wait',
      'get /workspaces/:workspace_id/thread-communication',
      'put /workspaces/:workspace_id/thread-communication',
      'delete /workspaces/:workspace_id/thread-communication',
    ]);

    const listReply = reply();
    await route('get', '/threads').handler(request({ query: { workspace_id: 'workspace-b' } }), listReply);
    expect(listReply.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: { threads: [expect.objectContaining({ ref: targetWire })], next_cursor: undefined } }),
    );

    const readReply = reply();
    await route('post', '/threads::read').handler(
      request({ body: { thread: targetWire, limit: 4 } }),
      readReply,
    );
    expect(service.readThread).toHaveBeenCalledWith({ thread: targetCore, cursor: undefined, limit: 4 });

    const sendReply = reply();
    await route('post', '/threads::send').handler(
      request({
        body: { target: targetWire, content: 'hello', idempotency_key: 'key-a' },
      }),
      sendReply,
    );
    expect(service.sendMessage).toHaveBeenCalledWith({
      target: targetCore,
      content: 'hello',
      idempotencyKey: 'key-a',
    });

    const waitReply = reply();
    await route('post', '/threads::wait').handler(
      request({ body: { threads: [{ thread: targetWire }], timeout_ms: 0 } }),
      waitReply,
    );
    expect(waitReply.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: { threads: [expect.objectContaining({ thread: targetWire })], timed_out: true } }),
    );
  });

  it('round-trips workspace override get, set, and clear', async () => {
    const service = makeService();
    vi.mocked(service.getWorkspaceOverride).mockResolvedValue(false);
    vi.mocked(service.isWorkspaceEnabled).mockResolvedValue(false);
    const { route } = setup(service);

    for (const [method, body] of [
      ['get', undefined],
      ['put', { enabled: false }],
      ['delete', undefined],
    ] as const) {
      const response = reply();
      await route(method, '/workspaces/:workspace_id/thread-communication').handler(
        request({ params: { workspace_id: 'workspace-b' }, body: body ?? {} }),
        response,
      );
      expect(response.send).toHaveBeenCalledWith(
        expect.objectContaining({ data: { override: false, effective_enabled: false } }),
      );
    }
    expect(service.setWorkspaceOverride).toHaveBeenCalledWith('workspace-b', false);
    expect(service.clearWorkspaceOverride).toHaveBeenCalledWith('workspace-b');
  });

  it.each([
    [ErrorCodes.THREAD_NOT_FOUND, ErrorCode.THREAD_NOT_FOUND],
    [ErrorCodes.THREAD_ARCHIVED, ErrorCode.THREAD_ARCHIVED],
    [ErrorCodes.THREAD_DISABLED, ErrorCode.THREAD_DISABLED],
    [ErrorCodes.THREAD_CROSS_HOST, ErrorCode.THREAD_CROSS_HOST],
    [ErrorCodes.THREAD_SELF_SEND, ErrorCode.THREAD_SELF_SEND],
    [ErrorCodes.THREAD_CURSOR_INVALID, ErrorCode.THREAD_CURSOR_INVALID],
    [ErrorCodes.THREAD_IDEMPOTENCY_CONFLICT, ErrorCode.THREAD_IDEMPOTENCY_CONFLICT],
    [ErrorCodes.THREAD_LIMIT_EXCEEDED, ErrorCode.THREAD_LIMIT_EXCEEDED],
    [ErrorCodes.THREAD_DELIVERY_FAILED, ErrorCode.THREAD_DELIVERY_FAILED],
  ])('maps %s to its public REST code', async (coreCode, publicCode) => {
    const service = makeService();
    vi.mocked(service.listThreads).mockRejectedValue(new Error2(coreCode, 'thread error'));
    const { route } = setup(service);
    const response = reply();
    await route('get', '/threads').handler(request(), response);
    expect(response.send).toHaveBeenCalledWith(expect.objectContaining({ code: publicCode }));
  });

  it('stops the long-poll response when the client disconnects', async () => {
    const service = makeService();
    vi.mocked(service.waitThreads).mockImplementation(() => new Promise(() => undefined));
    const { route } = setup(service);
    const raw = new EventEmitter() as EventEmitter & { destroyed: boolean };
    raw.destroyed = false;
    const response = { ...reply(), raw };
    const pending = route('post', '/threads::wait').handler(
      request({ body: { threads: [{ thread: targetWire }], timeout_ms: 60_000 } }),
      response,
    );
    raw.emit('close');
    await pending;
    expect(response.send).not.toHaveBeenCalled();
  });

  it('wakes a real 60s thread wait before listener close settles', { timeout: 15_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'kap-thread-close-wait-'));
    let server: RunningServer | undefined;
    let waitRequest: Promise<void> | undefined;
    try {
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      const base = `http://127.0.0.1:${server.port}`;
      const createdResponse = await fetch(`${base}/api/v1/sessions`, {
        method: 'POST',
        headers: authHeaders(server, {
          'content-type': 'application/json',
          connection: 'close',
        }),
        body: JSON.stringify({ metadata: { cwd: home } }),
      } as never);
      const created = (await createdResponse.json()) as {
        code: number;
        data: { id: string; workspace_id: string };
      };
      expect(created.code).toBe(0);

      const service = server.core.accessor.get(IThreadCommunicationService);
      const realShutdown = service.shutdown.bind(service);
      let shutdownSettled = false;
      const shutdown = vi.spyOn(service, 'shutdown').mockImplementation(async () => {
        await realShutdown();
        shutdownSettled = true;
      });
      const realWaitThreads = service.waitThreads.bind(service);
      let markWaitStarted!: () => void;
      const waitStarted = new Promise<void>((resolve) => {
        markWaitStarted = resolve;
      });
      vi.spyOn(service, 'waitThreads').mockImplementation((input) => {
        markWaitStarted();
        return realWaitThreads(input);
      });
      let waitSettled = false;
      waitRequest = fetch(`${base}/api/v1/threads:wait`, {
        method: 'POST',
        headers: authHeaders(server, {
          'content-type': 'application/json',
          connection: 'close',
        }),
        body: JSON.stringify({
          threads: [{
            thread: {
              host_id: service.hostId,
              workspace_id: created.data.workspace_id,
              session_id: created.data.id,
            },
          }],
          timeout_ms: 60_000,
        }),
      } as never).then(async (response) => {
        await response.arrayBuffer();
        waitSettled = true;
      }).catch(() => {
        waitSettled = true;
      });
      await waitStarted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(waitSettled).toBe(false);

      const running = server;
      server = undefined;
      const closeStartedAt = performance.now();
      const closing = running.close();
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closing,
          new Promise<never>((_resolve, reject) => {
            closeTimer = setTimeout(
              () => reject(new Error(
                `server close exceeded 5s (shutdownSettled=${String(shutdownSettled)}, waitSettled=${String(waitSettled)})`,
              )),
              5_000,
            );
          }),
        ]);
      } finally {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      }
      const closeElapsedMs = performance.now() - closeStartedAt;
      console.log(`[thread-close] ${closeElapsedMs.toFixed(1)}ms`);

      expect(closeElapsedMs).toBeLessThan(5_000);
      expect(shutdown).toHaveBeenCalledOnce();
      await waitRequest;
    } finally {
      await server?.close();
      await waitRequest;
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it('accepts target-only REST sends and rejects the legacy source field with 40001', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kap-thread-send-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
      });
      const base = `http://127.0.0.1:${server.port}`;
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: authHeaders(server!, { 'content-type': 'application/json' }),
          body: JSON.stringify(body),
        } as never);
        return response.json() as Promise<{
          code: number;
          data: Record<string, unknown> | null;
          details?: Array<{ path: string; message: string }>;
        }>;
      };
      const created = await post('/api/v1/sessions', { metadata: { cwd: home } });
      expect(created.code).toBe(0);
      const listResponse = await fetch(`${base}/api/v1/threads`, {
        headers: authHeaders(server),
      } as never);
      const listed = (await listResponse.json()) as {
        code: number;
        data: { threads: Array<{ ref: typeof targetWire }> };
      };
      expect(listed.code).toBe(0);
      const target = listed.data.threads[0]?.ref;
      expect(target).toBeDefined();

      const accepted = await post('/api/v1/threads:send', {
        target,
        content: 'external REST input',
        idempotency_key: 'rest-target-only',
      });
      expect(accepted.code).toBe(0);
      expect(accepted.data?.['message_id']).toEqual(expect.any(String));

      const rejected = await post('/api/v1/threads:send', {
        source: { ...target, session_id: 'forged-source' },
        target,
        content: 'legacy source must fail',
        idempotency_key: 'rest-legacy-source',
      });
      expect(rejected.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(rejected.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('source') })]),
      );
    } finally {
      await server?.close();
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });
});
