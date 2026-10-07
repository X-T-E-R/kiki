import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  isEndpointPathRecognized,
  runtimeDirFor,
  runtimeTokenPath,
  tryRemoveStaleEndpoint,
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
    credentialsHomeDir: homeDir,
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
    ['--import', 'tsx', '--import', new URL('../../../../../build/register-raw-text-loader.mjs', import.meta.url).href, runtimeWorkerFixture, homeDir],
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

describe('runtime endpoint paths (platform-injected structure)', () => {
  it.each(['darwin', 'linux'] as const)('uses a short home-local socket on %s', (platform) => {
    for (const home of ['/tmp/kiki', '/Users/alice/.kiki', '/home/alice/.kiki']) {
      const endpoint = endpointPathFor(platform, home);
      expect(endpoint).toBe(join(runtimeDirFor(home), 'runtime.sock'));
      expect(Buffer.byteLength(endpoint)).toBe(Buffer.byteLength(home) + 32);
      expect(endpointPathFor(platform, home)).toBe(endpoint);
      expect(endpointPathFor(platform, `${home}-other`)).not.toBe(endpoint);
    }
  });

  it.each([['darwin', 103], ['linux', 107]] as const)('checks the UTF-8 byte budget on %s', (platform, limit) => {
    const asciiHome = `/${'a'.repeat(limit - 33)}`;
    expect(Buffer.byteLength(endpointPathFor(platform, asciiHome))).toBe(limit);
    expect(() => endpointPathFor(platform, `${asciiHome}a`)).toThrow(expect.objectContaining({ code: 'runtime.invalid_config' }));
    const unicodeHome = `/${'中'.repeat(23)}a`;
    expect(Buffer.byteLength(endpointPathFor(platform, unicodeHome))).toBe(103);
    expect(() => endpointPathFor(platform, `${unicodeHome}😀a`)).toThrow(expect.objectContaining({ code: 'runtime.invalid_config' }));
  });

  it('retains the Windows pipe home hash independently of the executing platform', () => {
    const home = 'c:\\example\\.kiki';
    const digest = createHash('sha256').update(home).digest('hex').slice(0, 40);
    expect(endpointPathFor('win32', home)).toBe(`\\\\.\\pipe\\kimi-home-runtime-${digest}`);
    expect(endpointPathFor('win32', `${home}-other`)).not.toBe(endpointPathFor('win32', home));
  });

  it('recognizes only the exact local socket and legacy hash socket', () => {
    const home = '/tmp/kiki';
    const directory = runtimeDirFor(home);
    const digest = createHash('sha256').update(home).digest('hex');
    expect(isEndpointPathRecognized(home, join(directory, 'runtime.sock'))).toBe(true);
    expect(isEndpointPathRecognized(home, join(directory, `kimi-home-runtime-${digest}.sock`))).toBe(true);
    for (const path of [
      join(directory, 'kimi-home-runtime-unrelated.sock'),
      join(directory, 'nested', 'runtime.sock'),
      join(runtimeDirFor(`${home}-other`), 'runtime.sock'),
      join(directory, 'token'),
    ]) expect(isEndpointPathRecognized(home, path)).toBe(false);
  });
});

describe('home runtime broker', () => {
  let homeDir: string;
  const runtimes: IHomeRuntimeService[] = [];
  const instantiations: TestInstantiationService[] = [];
  const workers: RuntimeWorker[] = [];

  beforeEach(async () => {
    const scratch = fileURLToPath(new URL('../../../../../.tmp/', import.meta.url));
    await mkdir(scratch, { recursive: true });
    homeDir = await mkdtemp(join(scratch, 'rh-'));
  });

  afterEach(async () => {
    await Promise.allSettled(workers.splice(0).map(killRuntimeWorker));
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const ix of instantiations.splice(0)) await ix.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('finishes owner-loss cleanup when server detach rejects', async () => {
    const fixture = service(homeDir);
    instantiations.push(fixture.ix);
    runtimes.push(fixture.runtime);
    const internal = fixture.runtime as unknown as {
      role: 'owner';
      readyState: boolean;
      server?: { detach(): Promise<void> };
      fence: FenceTable;
      bootstrapError: unknown;
      roleLostWaiters: Array<() => void>;
      onServerLost(error: Error): Promise<void>;
    };
    const detachError = new Error('test detach failed');
    const ownerError = new HomeRuntimeError('runtime.connection_fatal', 'test owner lost');
    let awakened = false;
    let operationSignal: AbortSignal | undefined;
    fixture.runtime.registerMethod('test.pending', (_payload, ctx) => {
      operationSignal = ctx.signal;
      return new Promise<never>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
      });
    });
    internal.role = 'owner';
    internal.readyState = true;
    internal.server = { detach: async () => { throw detachError; } };
    internal.roleLostWaiters.push(() => { awakened = true; });
    expect(internal.fence.claim('test-host', 'test.method', 'test-request').kind).toBe('claimed');

    const pending = fixture.runtime.call('test.pending', undefined, { requestId: 'test-pending' }).catch((error: unknown) => error);
    await expect(internal.onServerLost(ownerError)).rejects.toBe(detachError);

    expect(await pending).toMatchObject({ code: 'runtime.owner_gone', cause: ownerError });
    expect(operationSignal?.aborted).toBe(true);
    expect(fixture.runtime.status()).toMatchObject({ role: 'idle', ready: false });
    expect(internal.server).toBeUndefined();
    expect(internal.bootstrapError).toBe(ownerError);
    expect(awakened).toBe(true);
    expect(internal.roleLostWaiters).toEqual([]);
    expect(internal.fence.claim('test-host', 'test.method', 'test-request').kind).toBe('claimed');
  });

  it('reports asynchronous owner-loss detach failure without an unhandled rejection', async () => {
    const fixture = service(homeDir);
    instantiations.push(fixture.ix);
    runtimes.push(fixture.runtime);
    const internal = fixture.runtime as unknown as {
      role: 'owner';
      readyState: boolean;
      server?: { detach(): Promise<void> };
      serverCallbacks(): { onOwnerLost(error: Error): void };
    };
    const detachError = new Error('test detach failed');
    internal.role = 'owner';
    internal.readyState = true;
    internal.server = { detach: async () => { throw detachError; } };
    const reported: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { reported.push(...args); };
    try {
      internal.serverCallbacks().onOwnerLost(new HomeRuntimeError('runtime.connection_fatal', 'test owner lost'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reported).toContain(detachError);
    } finally {
      console.error = original;
    }
  });

  it('keeps different homes independently owned and routes only within each home', async () => {
    const first = service(join(homeDir, 'a'));
    const second = service(join(homeDir, 'b'));
    instantiations.push(first.ix, second.ix);
    runtimes.push(first.runtime, second.runtime);
    first.runtime.registerMethod('home', () => 'a');
    second.runtime.registerMethod('home', () => 'b');
    await Promise.all([first.runtime.ready(), second.runtime.ready()]);
    expect(first.runtime.status().role).toBe('owner');
    expect(second.runtime.status().role).toBe('owner');
    await expect(first.runtime.call('home', null)).resolves.toBe('a');
    await expect(second.runtime.call('home', null)).resolves.toBe('b');
  });

  it.skipIf(process.platform === 'win32')('shares canonical home identity through an alias and keeps private permissions', async () => {
    const canonical = join(homeDir, 'home');
    const alias = join(homeDir, 'alias');
    await mkdir(canonical);
    await symlink(canonical, alias, 'dir');
    const first = await bootstrapHomeIdentity(process.platform, canonical);
    const second = await bootstrapHomeIdentity(process.platform, alias);
    expect(second.canonicalHomeDir).toBe(first.canonicalHomeDir);
    expect(second.token).toBe(first.token);
    expect((await lstat(first.runtimeDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(runtimeTokenPath(first.canonicalHomeDir))).mode & 0o777).toBe(0o600);
    const owner = service(canonical);
    const client = service(alias);
    instantiations.push(owner.ix, client.ix);
    runtimes.push(owner.runtime, client.runtime);
    owner.runtime.registerMethod('echo', (payload) => payload);
    await owner.runtime.ready();
    await client.runtime.ready();
    expect(client.runtime.status().role).toBe('client');
    await expect(client.runtime.call('echo', 'alias')).resolves.toBe('alias');
  });

  it.skipIf(process.platform === 'win32')('removes only stale recognized socket files', async () => {
    const identity = await bootstrapHomeIdentity(process.platform, homeDir);
    const endpoint = endpointPathFor(process.platform, identity.canonicalHomeDir);
    const foreign = join(identity.runtimeDir, 'kimi-home-runtime-unrelated.sock');
    await writeFile(endpoint, 'stale');
    await writeFile(foreign, 'keep');
    expect(await tryRemoveStaleEndpoint(process.platform, identity.canonicalHomeDir, foreign)).toBe('foreign');
    expect(await tryRemoveStaleEndpoint(process.platform, identity.canonicalHomeDir, endpoint)).toBe('removed');
    expect((await lstat(foreign)).isFile()).toBe(true);
    const runtime = service(homeDir);
    instantiations.push(runtime.ix);
    runtimes.push(runtime.runtime);
    await runtime.runtime.ready();
    expect(await tryRemoveStaleEndpoint(process.platform, identity.canonicalHomeDir, endpoint)).toBe('live');
  });

  it.skipIf(process.platform === 'win32')('fails an over-budget home immediately instead of retrying election', async () => {
    const runtime = service(join(homeDir, 'x'.repeat(108)));
    instantiations.push(runtime.ix);
    runtimes.push(runtime.runtime);
    await expect(runtime.runtime.ready()).rejects.toMatchObject({ code: 'runtime.invalid_config' });
  }, 2_000);

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
