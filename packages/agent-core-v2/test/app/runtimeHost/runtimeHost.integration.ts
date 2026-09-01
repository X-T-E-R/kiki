import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IBootstrapService as IBootstrapServiceId } from '#/app/bootstrap/bootstrap';
import { createRuntimeClient } from '#/app/runtimeHost/client';
import { createFrameDecoder, encodeCall, encodeHello, encodeTokens } from '#/app/runtimeHost/codec';
import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import {
  RUNTIME_MAX_FRAME_BYTES,
  type RuntimeHostStatus,
  type RuntimeMethodContext,
} from '#/app/runtimeHost/messages';
import {
  bootstrapHomeIdentity,
  endpointPathFor,
  isEndpointLive,
  readPersistedOwner,
  type CommittedOwnerRecord,
} from '#/app/runtimeHost/paths';
import { IHomeRuntimeService } from '#/app/runtimeHost/runtimeHost';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import {
  createFenceTable,
  createRuntimeServer,
  FenceTable,
  type OwnershipCommitContext,
} from '#/app/runtimeHost/server';

function bootstrap(homeDir: string): IBootstrapService {
  return {
    _serviceBrand: undefined,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    osHomeDir: tmpdir(),
    homeDir,
    configPath: join(homeDir, 'config.toml'),
    configReadOnly: false,
    userAgentProfileHomeDir: homeDir,
    modelAccountHomeDir: homeDir,
    configKey: 'config.toml',
    clientIdentity: { productName: 'test', version: '0', platform: 'test' },
    args: { requestHeaders: {} },
    sessionsDir: join(homeDir, 'sessions'),
    blobsDir: join(homeDir, 'blobs'),
    storeDir: join(homeDir, 'store'),
    cacheDir: join(homeDir, 'cache'),
    logsDir: join(homeDir, 'logs'),
    getEnv: () => undefined,
    scope: (name) => name,
  };
}

function service(homeDir: string): { readonly ix: TestInstantiationService; readonly runtime: IHomeRuntimeService } {
  const ix = new TestInstantiationService();
  ix.set(IBootstrapServiceId, bootstrap(homeDir));
  ix.set(IHomeRuntimeService, new SyncDescriptor(HomeRuntimeHostService));
  return { ix, runtime: ix.get(IHomeRuntimeService) };
}

function callbacks(
  identity: Awaited<ReturnType<typeof bootstrapHomeIdentity>>,
  handlers: Record<string, (payload: unknown, ctx: RuntimeMethodContext) => unknown>,
  epoch = 5,
) {
  return {
    canonicalHomeDir: identity.canonicalHomeDir,
    localHostId: 'owner-host',
    token: identity.token,
    getCurrentEpoch: () => epoch,
    resolveHandler: (method: string) => handlers[method],
    listLocalMethods: () => Object.keys(handlers),
    persistOwnershipAfterBind: async () => {},
    onOwnerLost: () => {},
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForEndpoint(endpoint: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await isEndpointLive(endpoint))) {
    if (Date.now() >= deadline) throw new Error('waitForEndpoint timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function connectRaw(endpoint: string): Promise<ReturnType<typeof createConnection>> {
  const socket = createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

type WorkerEvent =
  | { readonly type: 'ready'; readonly status: RuntimeHostStatus }
  | { readonly type: 'status'; readonly status: RuntimeHostStatus }
  | { readonly type: 'handler-started'; readonly requestId: string }
  | { readonly type: 'call-result'; readonly id: string; readonly value: unknown }
  | { readonly type: 'call-error'; readonly id: string; readonly code?: string; readonly causeCode?: string; readonly message: string }
  | { readonly type: 'closed' };

interface RuntimeWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: WorkerEvent[];
  readonly stderr: string[];
}

const runtimeWorkerFixture = fileURLToPath(new URL('./fixtures/runtime-host-worker.mts', import.meta.url));

function spawnRuntimeWorker(homeDir: string): RuntimeWorker {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', runtimeWorkerFixture, homeDir],
    { cwd: join(import.meta.dirname, '../../..'), stdio: 'pipe' },
  );
  const events: WorkerEvent[] = [];
  const stderr: string[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => events.push(JSON.parse(line) as WorkerEvent));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  return { child, events, stderr };
}

function sendWorkerCommand(worker: RuntimeWorker, command: unknown): void {
  worker.child.stdin.write(`${JSON.stringify(command)}\n`);
}

async function waitForWorkerEvent<T extends WorkerEvent>(
  worker: RuntimeWorker,
  predicate: (event: WorkerEvent) => event is T,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const event = worker.events.find(predicate);
    if (event !== undefined) return event;
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`runtime worker exited before expected event: ${worker.stderr.join('')}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`runtime worker event timed out: ${worker.stderr.join('')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function killRuntimeWorker(worker: RuntimeWorker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => worker.child.once('exit', () => resolve()));
  if (!worker.child.kill('SIGKILL')) throw new Error('failed to kill runtime worker');
  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('runtime worker kill timed out')), 8_000)),
  ]);
}

async function closeRuntimeWorker(worker: RuntimeWorker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => worker.child.once('exit', () => resolve()));
  sendWorkerCommand(worker, { type: 'close' });
  await waitForWorkerEvent(worker, (event): event is Extract<WorkerEvent, { type: 'closed' }> => event.type === 'closed');
  worker.child.stdin.end();
  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('runtime worker close timed out')), 8_000)),
  ]);
}

describe('home runtime broker', () => {
  let homeDir: string;
  const runtimes: IHomeRuntimeService[] = [];
  const instantiations: TestInstantiationService[] = [];
  const workers: RuntimeWorker[] = [];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'runtime-host-'));
  });

  afterEach(async () => {
    await Promise.allSettled(workers.splice(0).map(killRuntimeWorker));
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const ix of instantiations.splice(0)) ix.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('elects one owner, routes RPC, and re-elects with a higher epoch', async () => {
    const first = service(homeDir);
    const second = service(homeDir);
    instantiations.push(first.ix, second.ix);
    runtimes.push(first.runtime, second.runtime);
    first.runtime.registerMethod('echo', (payload) => payload);
    second.runtime.registerMethod('echo', (payload) => payload);

    await Promise.all([first.runtime.ready(), second.runtime.ready()]);
    expect([first.runtime.status().role, second.runtime.status().role].toSorted()).toEqual(['client', 'owner']);
    const client = first.runtime.status().role === 'client' ? first.runtime : second.runtime;
    const owner = client === first.runtime ? second.runtime : first.runtime;
    const epoch = owner.status().epoch;
    await expect(client.call('echo', { value: 1 })).resolves.toEqual({ value: 1 });

    await owner.close();
    await waitUntil(() => client.status().role === 'owner' && client.status().ready);
    expect(client.status().epoch).toBeGreaterThan(epoch);
  });

  it('replaces a hard-killed owner with a higher epoch despite its stale endpoint record', async () => {
    const owner = spawnRuntimeWorker(homeDir);
    workers.push(owner);
    const original = await waitForWorkerEvent(
      owner,
      (event): event is Extract<WorkerEvent, { type: 'ready' }> => event.type === 'ready',
    );
    expect(original.status.role).toBe('owner');
    const identity = await bootstrapHomeIdentity(process.platform, homeDir);
    const endpoint = endpointPathFor(process.platform, identity.canonicalHomeDir);
    const committed = await readPersistedOwner(identity.canonicalHomeDir);
    expect(committed).toMatchObject({ ownerHostId: original.status.hostId, epoch: original.status.epoch });

    await killRuntimeWorker(owner);
    expect(await readPersistedOwner(identity.canonicalHomeDir)).toEqual(committed);
    expect(await isEndpointLive(endpoint)).toBe(false);
    if (process.platform !== 'win32') expect((await lstat(endpoint)).isSocket()).toBe(true);

    const successor = spawnRuntimeWorker(homeDir);
    workers.push(successor);
    const recovered = await waitForWorkerEvent(
      successor,
      (event): event is Extract<WorkerEvent, { type: 'ready' }> => event.type === 'ready',
    );
    expect(recovered.status).toMatchObject({ role: 'owner', ready: true });
    expect(recovered.status.hostId).not.toBe(original.status.hostId);
    expect(recovered.status.epoch).toBeGreaterThan(original.status.epoch);
    expect(await readPersistedOwner(identity.canonicalHomeDir)).toMatchObject({
      ownerHostId: recovered.status.hostId,
      epoch: recovered.status.epoch,
    });
    await closeRuntimeWorker(successor);
  }, 30_000);

  it('rejects a half-open call and lets the surviving client take over after owner SIGKILL', async () => {
    const owner = spawnRuntimeWorker(homeDir);
    workers.push(owner);
    const ownerReady = await waitForWorkerEvent(
      owner,
      (event): event is Extract<WorkerEvent, { type: 'ready' }> => event.type === 'ready',
    );
    expect(ownerReady.status.role).toBe('owner');

    const client = spawnRuntimeWorker(homeDir);
    workers.push(client);
    const clientReady = await waitForWorkerEvent(
      client,
      (event): event is Extract<WorkerEvent, { type: 'ready' }> => event.type === 'ready',
    );
    expect(clientReady.status).toMatchObject({ role: 'client', ready: true, epoch: ownerReady.status.epoch });

    sendWorkerCommand(client, { type: 'call', id: 'blocked-call', method: 'block', payload: null, timeoutMs: 20_000 });
    await waitForWorkerEvent(
      owner,
      (event): event is Extract<WorkerEvent, { type: 'handler-started' }> =>
        event.type === 'handler-started' && event.requestId === 'blocked-call',
    );
    await killRuntimeWorker(owner);

    const failure = await waitForWorkerEvent(
      client,
      (event): event is Extract<WorkerEvent, { type: 'call-error' }> =>
        event.type === 'call-error' && event.id === 'blocked-call',
    );
    expect(['runtime.connection_failed', 'runtime.owner_gone']).toContain(failure.code);
    const takeover = await waitForWorkerEvent(
      client,
      (event): event is Extract<WorkerEvent, { type: 'status' }> =>
        event.type === 'status' && event.status.role === 'owner' && event.status.ready,
    );
    expect(takeover.status.epoch).toBeGreaterThan(ownerReady.status.epoch);

    sendWorkerCommand(client, { type: 'call', id: 'after-kill', method: 'echo', payload: { recovered: true } });
    const result = await waitForWorkerEvent(
      client,
      (event): event is Extract<WorkerEvent, { type: 'call-result' }> =>
        event.type === 'call-result' && event.id === 'after-kill',
    );
    expect(result.value).toEqual({ recovered: true });
    const identity = await bootstrapHomeIdentity(process.platform, homeDir);
    expect(await readPersistedOwner(identity.canonicalHomeDir)).toMatchObject({
      ownerHostId: takeover.status.hostId,
      epoch: takeover.status.epoch,
    });
    await closeRuntimeWorker(client);
  }, 30_000);

  it('serves owner calls directly and keeps timed-out request fences until handler settlement', async () => {
    const created = service(homeDir);
    instantiations.push(created.ix);
    runtimes.push(created.runtime);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    created.runtime.registerMethod('slow', async () => {
      executions += 1;
      await gate;
      return 'done';
    });
    await created.runtime.ready();

    await expect(created.runtime.call('slow', null, { requestId: 'stable', timeoutMs: 20 })).rejects.toMatchObject({
      code: 'runtime.timeout',
    });
    await expect(created.runtime.call('slow', null, { requestId: 'stable' })).rejects.toMatchObject({
      code: 'runtime.duplicate_request',
    });
    expect(executions).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(created.runtime.call('slow', null, { requestId: 'stable' })).resolves.toBe('done');
  });

  it('destroys connections before ownership commit and becomes ready only after commit', async () => {
    const identity = await bootstrapHomeIdentity(process.platform, homeDir);
    const endpoint = endpointPathFor(process.platform, identity.canonicalHomeDir);
    let release!: () => void;
    const commit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let effects = 0;
    const server = createRuntimeServer(endpoint, {
      ...callbacks(identity, { mutate: () => ++effects }),
      persistOwnershipAfterBind: () => commit,
    }, { electionTimeoutMs: 2_000 }, createFenceTable());
    const listening = server.listen();
    await waitForEndpoint(endpoint);
    const socket = await connectRaw(endpoint);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write(encodeHello({
      v: 1,
      protocol: 'kimi-home-runtime',
      hostId: 'early-client',
      canonicalHomeDir: identity.canonicalHomeDir,
    }));
    socket.write(encodeTokens([identity.token]));
    socket.write(encodeCall({ requestId: 'early', method: 'mutate', epoch: 5, payload: null, timeoutMs: 500 }));
    await closed;
    expect(effects).toBe(0);
    expect(server.listening).toBe(false);

    release();
    await listening;
    expect(server.listening).toBe(true);
    const client = createRuntimeClient({
      hostId: 'client',
      canonicalHomeDir: identity.canonicalHomeDir,
      tokens: [identity.token],
      onConnected: () => {},
      onDisconnected: () => {},
    });
    await client.connect(endpoint);
    await expect(client.call('mutate', null)).resolves.toBe(1);
    client.disconnect();
    await server.detach();
  });

  it('rejects wrong tokens and wrong home identities', async () => {
    const identity = await bootstrapHomeIdentity(process.platform, homeDir);
    const endpoint = endpointPathFor(process.platform, identity.canonicalHomeDir);
    const server = createRuntimeServer(endpoint, callbacks(identity, {}), {}, createFenceTable());
    await server.listen();
    const wrongToken = createRuntimeClient({
      hostId: 'client',
      canonicalHomeDir: identity.canonicalHomeDir,
      tokens: ['wrong'],
      onConnected: () => {},
      onDisconnected: () => {},
    }, { handshakeTimeoutMs: 1_000 });
    await expect(wrongToken.connect(endpoint)).rejects.toMatchObject({ code: 'runtime.token_mismatch' });
    const wrongHome = createRuntimeClient({
      hostId: 'client',
      canonicalHomeDir: `${identity.canonicalHomeDir}-other`,
      tokens: [identity.token],
      onConnected: () => {},
      onDisconnected: () => {},
    }, { handshakeTimeoutMs: 1_000 });
    await expect(wrongHome.connect(endpoint)).rejects.toMatchObject({ code: 'runtime.identity_mismatch' });
    await server.detach();
  });

  it('enforces client and owner in-flight bounds', async () => {
    const identity = await bootstrapHomeIdentity(process.platform, homeDir);
    const endpoint = endpointPathFor(process.platform, identity.canonicalHomeDir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const limits = { maxInFlight: 1, callTimeoutMs: 2_000 };
    const server = createRuntimeServer(endpoint, callbacks(identity, { slow: () => gate }), limits, createFenceTable(limits));
    await server.listen();
    const client = createRuntimeClient({
      hostId: 'client',
      canonicalHomeDir: identity.canonicalHomeDir,
      tokens: [identity.token],
      onConnected: () => {},
      onDisconnected: () => {},
    }, limits);
    await client.connect(endpoint);
    const first = client.call('slow', null);
    await expect(client.call('slow', null)).rejects.toMatchObject({ code: 'runtime.pending_overflow' });
    release();
    await first;
    client.disconnect();
    await server.detach();
  });

  it('aborts handlers on caller cancel and connection close', async () => {
    const identity = await bootstrapHomeIdentity(process.platform, homeDir);
    const endpoint = endpointPathFor(process.platform, identity.canonicalHomeDir);
    const aborts: string[] = [];
    let started = 0;
    const server = createRuntimeServer(endpoint, callbacks(identity, {
      blocked: (_payload, ctx) => new Promise((_resolve, reject) => {
        started += 1;
        ctx.signal.addEventListener('abort', () => {
          aborts.push(String((ctx.signal.reason as Error).message));
          reject(ctx.signal.reason);
        }, { once: true });
      }),
    }), {}, createFenceTable());
    await server.listen();
    const client = createRuntimeClient({
      hostId: 'client',
      canonicalHomeDir: identity.canonicalHomeDir,
      tokens: [identity.token],
      onConnected: () => {},
      onDisconnected: () => {},
    });
    await client.connect(endpoint);
    const controller = new AbortController();
    const cancelled = client.call('blocked', null, { signal: controller.signal });
    await waitUntil(() => started === 1);
    controller.abort(new Error('caller cancelled'));
    await expect(cancelled).rejects.toThrow('caller cancelled');
    await waitUntil(() => aborts.length === 1);
    const disconnected = client.call('blocked', null);
    await waitUntil(() => started === 2);
    client.disconnect();
    await expect(disconnected).rejects.toBeInstanceOf(HomeRuntimeError);
    await waitUntil(() => aborts.length === 2);
    await server.detach();
  });

  it('rejects stale and future epochs without invoking the handler', async () => {
    const identity = await bootstrapHomeIdentity(process.platform, homeDir);
    const endpoint = endpointPathFor(process.platform, identity.canonicalHomeDir);
    let calls = 0;
    const server = createRuntimeServer(endpoint, callbacks(identity, { mutate: () => ++calls }), {}, createFenceTable());
    await server.listen();
    const socket = await connectRaw(endpoint);
    const decoder = createFrameDecoder(RUNTIME_MAX_FRAME_BYTES);
    const codes: string[] = [];
    socket.on('data', (chunk) => {
      for (const event of decoder.push(chunk)) {
        if (event.kind === 'frame' && event.frame.type === 'error') codes.push(event.frame.error.error.code);
      }
    });
    socket.write(encodeHello({
      v: 1,
      protocol: 'kimi-home-runtime',
      hostId: 'raw-client',
      canonicalHomeDir: identity.canonicalHomeDir,
    }));
    socket.write(encodeTokens([identity.token]));
    await waitUntil(() => decoder.bufferedBytes === 0);
    socket.write(encodeCall({ requestId: 'stale', method: 'mutate', epoch: 4, payload: null, timeoutMs: 500 }));
    socket.write(encodeCall({ requestId: 'future', method: 'mutate', epoch: 6, payload: null, timeoutMs: 500 }));
    await waitUntil(() => codes.length === 2);
    expect(codes.toSorted()).toEqual(['runtime.epoch_future', 'runtime.epoch_stale']);
    expect(calls).toBe(0);
    socket.destroy();
    await server.detach();
  });

  it('bounds frames by UTF-8 bytes and rejects malformed frames', () => {
    const decoder = createFrameDecoder(8);
    expect(decoder.push(Buffer.from('😀😀\n'))).toEqual([
      expect.objectContaining({ kind: 'invalid' }),
    ]);
    const overflow = createFrameDecoder(7).push(Buffer.from('😀😀\n'));
    expect(overflow).toEqual([expect.objectContaining({ kind: 'overflow' })]);
    expect(createFrameDecoder(128).push(Buffer.from('{bad}\n'))).toEqual([
      expect.objectContaining({ kind: 'invalid' }),
    ]);
  });

  it('keeps a minimal bounded request fence', () => {
    const fence = new FenceTable(1);
    const first = fence.claim('host-a', 'method', 'request');
    expect(first.kind).toBe('claimed');
    expect(fence.claim('host-a', 'method', 'request').kind).toBe('duplicate');
    expect(fence.claim('host-b', 'method', 'request').kind).toBe('conflict');
    expect(fence.claim('host-a', 'other', 'request').kind).toBe('full');
    if (first.kind === 'claimed') fence.release(first.token);
    expect(fence.size).toBe(0);
  });

  it('closes a provisional owner without waiting for a stuck commit', async () => {
    class HangingRuntime extends HomeRuntimeHostService {
      commitSignal: AbortSignal | undefined;
      protected override persistOwnership(
        _record: CommittedOwnerRecord,
        context: OwnershipCommitContext,
      ): Promise<void> {
        this.commitSignal = context.signal;
        return new Promise<void>(() => {});
      }
    }
    const ix = new TestInstantiationService();
    ix.set(IBootstrapServiceId, bootstrap(homeDir));
    ix.set(IHomeRuntimeService, new SyncDescriptor(HangingRuntime));
    const runtime = ix.get(IHomeRuntimeService) as HangingRuntime;
    instantiations.push(ix);
    runtimes.push(runtime);
    const ready = runtime.ready().catch((error: unknown) => error);
    await waitUntil(() => runtime.commitSignal !== undefined);
    await runtime.close();
    expect(await ready).toBeInstanceOf(Error);
    expect(runtime.commitSignal?.aborted).toBe(true);
    expect(await isEndpointLive(endpointPathFor(process.platform, (await bootstrapHomeIdentity(process.platform, homeDir)).canonicalHomeDir))).toBe(false);
  });
});
