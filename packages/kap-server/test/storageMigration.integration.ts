import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as engine from '@kiki/agent-core-v2';
import { IPluginHostService } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import { createMailboxMigrationService } from '@kiki/agent-core-v2/persistence/backends/sqliteMailbox/migration';
import { migrationPath } from '@kiki/agent-core-v2/persistence/backends/sqliteMailbox/authority';
import { ClusterDb } from '../../minidb/src/cluster/index';
import { storageMigrationViewSchema, type StorageMigrationView } from '@kiki/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startServer, type RunningServer } from '../src/start';
import { StorageMigrationController } from '../src/routes/storageMigration';
import { UsageExportRuntime } from '../src/usage/export/runtime';
import { ImSessionBridge } from '../src/services/imSession/bridge';
import { FakeImAdapter, fakeAdapterFactory } from '../src/services/imSession/fakeAdapter';
import type { ImAdapterFactory } from '../src/services/imSession/adapter';
import type { ImSessionPorts } from '../src/services/imSession/ports';
import { IUserMessageRouter } from '@kiki/agent-core-v2/app/bot/messageRouting';
import { IImMessageHistoryReader } from '@kiki/agent-core-v2/app/bot/imMessageHistory';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

let home: string | undefined;
let server: RunningServer | undefined;
const owned: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    const closing = server; server = undefined;
    if (closing !== undefined) await closing.close();
    for (const handle of owned.splice(0).reverse()) await handle.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    home = undefined;
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

async function boot(): Promise<{ old: ClusterDb<Record<string, unknown>>; base: string }> {
  for (const key of Object.keys(process.env)) if (key.startsWith('KIKI_EXTERNAL_')) vi.stubEnv(key, undefined);
  vi.stubEnv('KIKI_SEARCH_DISABLED', '1');
  home = await mkdtemp(join(tmpdir(), 'kiki-storage-maintenance-'));
  const old = await ClusterDb.open<Record<string, unknown>>({ dir: join(home, 'store/thread-mailbox-v3'), shardCount: 2,
    valueCodec: 'json', recovery: 'strict', fsyncPolicy: 'always', activeExpireIntervalMs: 0, lockPoolMaxShards: 2, lockHoldMs: 0, crossShard: 'none' });
  owned.push(old);
  await old.partitionBatch('w/example', [{ op: 'set', key: 'w/example/override', value: { kind: 'workspace_override', workspaceId: 'example', enabled: true, updatedAt: 1 } }]);
  server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent', externalDelegation: undefined });
  return { old, base: `http://127.0.0.1:${server.port}` };
}

async function request(base: string, path: string, action?: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: action === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${server!.localOwnerToken}`, 'content-type': 'application/json' }, body: action === undefined ? undefined : JSON.stringify({ action }) });
}
async function view(base: string): Promise<StorageMigrationView> {
  const body = await (await request(base, '/api/storage')).json() as { code: number; data: unknown };
  expect(body.code).toBe(0);
  return storageMigrationViewSchema.parse(body.data);
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try { value = await read(); } catch (error) { if (Date.now() >= deadline) throw error; }
    if (value !== undefined && accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Storage transition deadline exceeded: ${JSON.stringify(value)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  }
}

describe('pre-core storage maintenance', () => {
  it('keeps status and writer waiting ahead of engine bootstrap, then starts normally with the same home, identity and listener', async () => {
    const originalBootstrap = engine.bootstrap;
    const bootstrap = vi.spyOn(engine, 'bootstrap');
    const { old, base } = await boot();
    expect(bootstrap).not.toHaveBeenCalled();
    expect((await fetch(`${base}/api/storage`)).status).toBe(401);
    const meta = await (await request(base, '/api/meta')).json() as { data: Record<string, unknown> };
    expect(meta.data).toMatchObject({ storage_mode: 'maintenance', storage_status_path: '/api/storage', capabilities: { websocket: false } });
    const identity = { server_id: meta.data['server_id'], server_home_id: meta.data['server_home_id'] };
    expect((await view(base)).actions).toContain('migrate');
    await expect(stat(join(home!, 'store/thread-mailbox-sqlite-v1'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await request(base, '/api/sessions')).status).toBe(503);
    expect((await (await request(base, '/api/storage', 'start')).json() as { code: number }).code).toBe(40901);
    await request(base, '/api/storage', 'migrate');
    const waiting = await until(() => view(base), (value) => value.status.state === 'waiting' && value.actions.includes('migrate'));
    expect(waiting.status.phase).toBe('waiting_for_writers');
    expect(waiting.actions).toContain('migrate');
    expect(bootstrap).not.toHaveBeenCalled();
    await old.close();
    await request(base, '/api/storage', 'migrate');
    const complete = await until(() => view(base), (value) => value.status.state === 'complete' && value.actions.includes('start'));
    expect(complete.actions).toContain('start');
    expect(bootstrap).not.toHaveBeenCalled();
    const port = server!.port;
    bootstrap.mockImplementationOnce(() => { throw new Error('example normal startup failure'); });
    const failedStart = await (await request(base, '/api/storage', 'start')).json() as { data: StorageMigrationView };
    expect(failedStart.data.transition.state).toBe('starting');
    const failed = await until(() => view(base), (value) => value.transition.state === 'failed' && value.actions.includes('start'));
    expect(failed.transition.failure?.message).toBe('example normal startup failure');
    expect((await (await request(base, '/api/meta')).json() as { data: unknown }).data).toMatchObject({ ...identity, storage_mode: 'maintenance' });
    expect(await readdir(join(home!, 'server/instances'))).toEqual([`${server!.serverId}.json`]);
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    bootstrap.mockImplementationOnce((...args) => {
      const result = originalBootstrap(...args);
      Object.defineProperty(result.app.accessor.get(IPluginHostService), 'ready', { value: blocked, configurable: true });
      entered();
      return result;
    });
    try {
      await request(base, '/api/storage', 'start');
      await preparing;
      expect((await view(base)).actions).toContain('cancel');
      await request(base, '/api/storage', 'cancel');
      const cancelled = await until(() => view(base), (value) => value.transition.state === 'failed' && value.actions.includes('start'));
      expect(cancelled.transition).toMatchObject({ failure: { code: 'mailbox.start_cancelled' }, cleanupPending: false });
      expect(cancelled.status.authority).toBe('sqlite');
      expect(server!.port).toBe(port);
      expect((await (await request(base, '/api/meta')).json() as { data: unknown }).data).toMatchObject({ ...identity, storage_mode: 'maintenance' });
    } finally { release(); }
    const started = await (await request(base, '/api/storage', 'start')).json() as { data: StorageMigrationView };
    expect(started.data.transition.state).toBe('starting');
    const normal = await until(async () => (await (await request(base, '/api/meta')).json() as { data: Record<string, unknown> }).data, (value) => value['storage_mode'] === 'normal');
    expect(normal).toMatchObject(identity);
    expect(server!.port).toBe(port);
    expect(bootstrap).toHaveBeenCalledTimes(3);
    expect((await view(base)).mode).toBe('normal');
  });

  it.each(['ready', 'plugins'] as const)('settles cancelled IM %s construction and bridge cleanup before allowing retry', async (phase) => {
    const { old, base } = await boot();
    await old.close();
    await request(base, '/api/storage', 'migrate');
    await until(() => view(base), (value) => value.actions.includes('start'));
    let entered!: () => void;
    const constructing = new Promise<void>((resolve) => { entered = resolve; });
    let releaseConstruction!: () => void;
    const constructionGate = new Promise<void>((resolve) => { releaseConstruction = resolve; });
    let closedBridge!: () => void;
    const bridgeClosed = new Promise<void>((resolve) => { closedBridge = resolve; });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeExport = vi.spyOn(UsageExportRuntime.prototype, 'close');
    const originalClose = ImSessionBridge.prototype.close;
    vi.spyOn(ImSessionBridge.prototype, 'close').mockImplementation(async function (this: ImSessionBridge) {
      await originalClose.call(this);
      closedBridge();
      await closeGate;
    });
    await writeFile(join(home!, 'im-session-bridge.json'), JSON.stringify({ policy: { allowed: true, defaultEnabled: true },
      instances: [{ id: 'example-listener', providerKind: 'telegram', listening: true }] }));
    const listener = new FakeImAdapter('telegram', 'example-account');
    const policy = vi.spyOn(ImSessionBridge.prototype, 'setPolicy');
    const adapters = vi.spyOn(ImSessionBridge.prototype, 'reconcileAdapters');
    const originalReady = ImSessionBridge.prototype.whenReady;
    vi.spyOn(ImSessionBridge.prototype, 'whenReady').mockImplementationOnce(async function (this: ImSessionBridge) {
      const internals = this as unknown as { ports: ImSessionPorts; factories: ImAdapterFactory[] };
      internals.ports.credentials.list = () => [{ id: 'example-listener', providerId: 'telegram', configured: true }];
      internals.ports.credentials.read = () => 'example-credential';
      internals.factories.splice(0, internals.factories.length, fakeAdapterFactory(listener));
      if (phase === 'ready') { entered(); await constructionGate; }
      await originalReady.call(this);
    });
    let core: engine.Scope | undefined;
    const originalBootstrap = engine.bootstrap;
    const bootstrap = vi.spyOn(engine, 'bootstrap').mockImplementationOnce((...args) => {
      const result = originalBootstrap(...args);
      core = result.app;
      if (phase === 'plugins') {
        const plugins = core.accessor.get(IPluginHostService);
        const attach = plugins.attachImAdapters.bind(plugins);
        vi.spyOn(plugins, 'attachImAdapters').mockImplementationOnce(async (...input) => {
          entered();
          await constructionGate;
          await attach(...input);
        });
      }
      return result;
    });
    try {
      await request(base, '/api/storage', 'start');
      await constructing;
      const dispose = vi.spyOn(core!, 'dispose');
      const provide = vi.spyOn(core!.instantiation, 'provide');
      await request(base, '/api/storage', 'cancel');
      const pending = await until(() => view(base), (value) => value.transition.state === 'failed');
      expect(pending.transition).toMatchObject({ cleanupPending: true, failure: { code: 'mailbox.start_cancelled' } });
      expect(pending.actions).toEqual([]);
      expect((await (await request(base, '/api/storage', 'start')).json() as { code: number }).code).toBe(40901);
      expect(dispose).not.toHaveBeenCalled();
      releaseConstruction();
      await bridgeClosed;
      expect((await view(base)).transition.cleanupPending).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      expect(policy).not.toHaveBeenCalled();
      expect(adapters).not.toHaveBeenCalled();
      expect(listener.started).toBe(0);
      expect(provide.mock.calls.filter(([id]) => id === IUserMessageRouter || id === IImMessageHistoryReader)).toEqual([]);
      releaseClose();
      const settled = await until(() => view(base), (value) => value.actions.includes('start'));
      expect(settled.transition.cleanupPending).toBe(false);
      expect(dispose).toHaveBeenCalledOnce();
      expect(closeExport).toHaveBeenCalledOnce();
      expect(bootstrap).toHaveBeenCalledOnce();
      expect((await (await request(base, '/api/meta')).json() as { data: unknown }).data).toMatchObject({ storage_mode: 'maintenance' });
    } finally { releaseConstruction(); releaseClose(); }
  });

  it.each(['partial', 'complete'] as const)('retains startup and %s cleanup failures and retries only unsettled owned cleanup', async (phase) => {
    const { old, base } = await boot();
    await old.close();
    await request(base, '/api/storage', 'migrate');
    await until(() => view(base), (value) => value.actions.includes('start'));
    let entered!: () => void;
    const constructing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let retryEntered!: () => void;
    const retrying = new Promise<void>((resolve) => { retryEntered = resolve; });
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    let core: engine.Scope | undefined;
    let attempts = 0;
    const originalBootstrap = engine.bootstrap;
    vi.spyOn(engine, 'bootstrap').mockImplementationOnce((...args) => {
      const result = originalBootstrap(...args);
      core = result.app;
      const runtime = core.accessor.get(engine.IHomeRuntimeService);
      const close = runtime.close.bind(runtime);
      vi.spyOn(runtime, 'close').mockImplementation(async () => {
        attempts++;
        if (attempts === 1) throw new Error('example cleanup failure one');
        if (attempts === 2) { retryEntered(); await retryGate; throw new Error('example cleanup failure two'); }
        await close();
      });
      if (phase === 'partial') {
        Object.defineProperty(core.accessor.get(IPluginHostService), 'ready', { value: gate, configurable: true });
        entered();
      }
      return result;
    });
    if (phase === 'complete') {
      const ready = ImSessionBridge.prototype.whenReady;
      vi.spyOn(ImSessionBridge.prototype, 'whenReady').mockImplementationOnce(async function (this: ImSessionBridge) {
        entered(); await gate; await ready.call(this);
      });
    }
    try {
      await request(base, '/api/storage', 'start');
      await constructing;
      const mailbox = core!.accessor.get(engine.IThreadMailboxStore);
      const closeMailbox = vi.spyOn(mailbox, 'close');
      const dispose = vi.spyOn(core!, 'dispose');
      await request(base, '/api/storage', 'cancel');
      release();
      const failed = await until(() => view(base), (value) => value.actions.includes('retry_cleanup'));
      expect(failed.transition).toMatchObject({ cleanupPending: true, failure: { code: 'mailbox.start_cancelled' },
        cleanupFailure: { code: 'mailbox.cleanup_failed', message: 'example cleanup failure one' } });
      expect(failed.actions).toEqual(['retry_cleanup']);
      expect(dispose).not.toHaveBeenCalled();
      expect((await (await request(base, '/api/storage', 'start')).json() as { code: number }).code).toBe(40901);
      const retry = request(base, '/api/storage', 'retry_cleanup');
      await retrying;
      expect((await view(base)).actions).toEqual([]);
      expect((await (await request(base, '/api/storage', 'retry_cleanup')).json() as { code: number }).code).toBe(40901);
      releaseRetry();
      expect((await (await retry).json() as { code: number }).code).toBe(0);
      const repeated = await until(() => view(base), (value) => value.actions.includes('retry_cleanup'));
      expect(repeated.transition).toMatchObject({ cleanupPending: true, failure: failed.transition.failure,
        cleanupFailure: { message: 'example cleanup failure two' } });
      await request(base, '/api/storage', 'retry_cleanup');
      const recovered = await until(() => view(base), (value) => value.actions.includes('start'));
      expect(recovered.transition).toMatchObject({ cleanupPending: false, failure: failed.transition.failure });
      expect(recovered.transition.cleanupFailure).toBeUndefined();
      expect(attempts).toBe(3);
      expect(closeMailbox).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    } finally { release(); releaseRetry(); }
  });

  it.each(['failure', 'cancel'] as const)('preserves the original IM factory %s alongside bridge cleanup failure until retry closes it', async (phase) => {
    const { old, base } = await boot();
    await old.close();
    await request(base, '/api/storage', 'migrate');
    await until(() => view(base), (value) => value.actions.includes('start'));
    let entered!: () => void;
    const constructing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let retryEntered!: () => void;
    const retrying = new Promise<void>((resolve) => { retryEntered = resolve; });
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const startupError = Object.assign(new Error('example IM factory startup failed'), { code: 'example.im_startup_failed' });
    const cleanupError = new Error('example IM bridge cleanup failed');
    const failures = phase === 'cancel' ? 2 : 1;
    let closeAttempts = 0;
    let core: engine.Scope | undefined;
    const originalBootstrap = engine.bootstrap;
    const bootstrap = vi.spyOn(engine, 'bootstrap').mockImplementationOnce((...args) => {
      const result = originalBootstrap(...args); core = result.app; return result;
    });
    const ready = ImSessionBridge.prototype.whenReady;
    vi.spyOn(ImSessionBridge.prototype, 'whenReady').mockImplementationOnce(async function (this: ImSessionBridge) {
      entered(); await gate; await ready.call(this);
      if (phase === 'failure') throw startupError;
    });
    const close = ImSessionBridge.prototype.close;
    vi.spyOn(ImSessionBridge.prototype, 'close').mockImplementation(async function (this: ImSessionBridge) {
      closeAttempts++;
      if (closeAttempts <= failures) throw cleanupError;
      retryEntered(); await retryGate; await close.call(this);
    });
    try {
      await request(base, '/api/storage', 'start');
      await constructing;
      const dispose = vi.spyOn(core!, 'dispose');
      const provide = vi.spyOn(core!.instantiation, 'provide');
      let cancelled: StorageMigrationView['transition']['failure'];
      if (phase === 'cancel') {
        await request(base, '/api/storage', 'cancel');
        cancelled = (await until(() => view(base), (value) => value.transition.state === 'failed')).transition.failure;
        expect(cancelled?.code).toBe('mailbox.start_cancelled');
      }
      release();
      const failed = await until(() => view(base), (value) => value.actions.includes('retry_cleanup'));
      expect(failed.transition).toMatchObject({ cleanupPending: true,
        failure: phase === 'cancel' ? cancelled : { code: startupError.code, message: startupError.message },
        cleanupFailure: { code: 'mailbox.cleanup_failed', message: cleanupError.message } });
      expect(failed.actions).toEqual(['retry_cleanup']);
      expect(closeAttempts).toBe(failures);
      expect(dispose).not.toHaveBeenCalled();
      expect(provide.mock.calls.filter(([id]) => id === IUserMessageRouter || id === IImMessageHistoryReader)).toEqual([]);
      expect((await (await request(base, '/api/storage', 'start')).json() as { code: number }).code).toBe(40901);
      const retry = request(base, '/api/storage', 'retry_cleanup');
      await retrying;
      expect((await view(base)).actions).toEqual([]);
      expect(dispose).not.toHaveBeenCalled();
      releaseRetry();
      expect((await (await retry).json() as { code: number }).code).toBe(0);
      const recovered = await until(() => view(base), (value) => value.actions.includes('start'));
      expect(recovered.transition).toMatchObject({ failure: failed.transition.failure, cleanupPending: false });
      expect(recovered.transition.cleanupFailure).toBeUndefined();
      expect(closeAttempts).toBe(failures + 1);
      expect(dispose).toHaveBeenCalledOnce();
      expect(bootstrap).toHaveBeenCalledOnce();
    } finally { release(); releaseRetry(); }
  });

  it('keeps a real rollback-commit crash in maintenance before ordinary bootstrap', async () => {
    const bootstrap = vi.spyOn(engine, 'bootstrap');
    const { old } = await boot();
    await old.close();
    await server!.close(); server = undefined;
    const service = createMailboxMigrationService(home!); owned.push(service);
    expect((await service.migrate()).state).toBe('complete');
    const crash = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--import', new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href,
        fileURLToPath(new URL('../../agent-core-v2/test/app/threadCommunication/fixtures/mailbox-migration-crash.mts', import.meta.url)), home!, 'rollback-authority'],
        { cwd: fileURLToPath(new URL('../../agent-core-v2', import.meta.url)), timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (part) => { stdout += part.toString(); }); child.stderr.on('data', (part) => { stderr += part.toString(); });
      child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(crash.stdout, crash.stderr).toContain('"boundary":"rollback-authority"');
    expect(crash.code).not.toBe(0);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const base = `http://127.0.0.1:${server.port}`;
    expect(bootstrap).not.toHaveBeenCalled();
    const recovery = await view(base);
    expect(recovery.status).toMatchObject({ phase: 'rolling_back', canRollback: true });
    expect(recovery.actions).toEqual(['rollback']);
    expect((await (await request(base, '/api/storage', 'start')).json() as { code: number }).code).toBe(40901);
    await request(base, '/api/storage', 'rollback');
    await until(() => view(base), (value) => value.status.authority === 'legacy' && value.actions.includes('migrate'));
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('offers start instead of migrate when only historical progress is damaged', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-storage-checkpoint-warning-'));
    const service = createMailboxMigrationService(home);
    owned.push(service);
    expect((await service.migrate()).state).toBe('complete');
    const path = migrationPath(home);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...manifest, copiedFiles: -1 }));
    const controller = new StorageMigrationController(service, 'maintenance');
    owned.push(controller);
    expect(await controller.view()).toMatchObject({ status: { authority: 'sqlite', state: 'complete', canRollback: false,
      warning: { code: 'mailbox.checkpoint_warning' } }, actions: ['start'] });
  });

  it('keeps normal startup available while preparation takes longer than 30 seconds', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-storage-start-slow-'));
    const service = createMailboxMigrationService(home);
    owned.push(service);
    expect((await service.migrate()).state).toBe('complete');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const controller = new StorageMigrationController(service, 'maintenance', async (signal) => { await blocked; signal.throwIfAborted(); });
    owned.push(controller);
    vi.useFakeTimers();
    try {
      expect(await controller.action('start')).toBe(true);
      controller.activateRequested();
      await vi.advanceTimersByTimeAsync(31_000);
      expect((await controller.view()).transition).toMatchObject({ state: 'starting' });
      expect((await controller.view()).actions).toEqual(['cancel']);
      expect(await controller.action('start')).toBe(false);
    } finally { vi.useRealTimers(); release(); }
    const settled = await until(() => controller.view(), (value) => value.transition.state === 'starting' && value.actions.length === 0);
    expect(settled.transition.failure).toBeUndefined();
  });

  it('waits for a cancelled startup attempt before allowing another start', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-storage-start-cancel-'));
    const service = createMailboxMigrationService(home);
    owned.push(service);
    expect((await service.migrate()).state).toBe('complete');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    const controller = new StorageMigrationController(service, 'maintenance', async (signal) => { attempts++; await blocked; signal.throwIfAborted(); });
    owned.push(controller);
    vi.useFakeTimers();
    try {
      expect(await controller.action('start')).toBe(true);
      controller.activateRequested();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await controller.action('cancel')).toBe(true);
      expect((await controller.view()).transition).toMatchObject({ state: 'failed', failure: { code: 'mailbox.start_cancelled' }, cleanupPending: true });
      expect((await controller.view()).actions).toEqual([]);
      expect(await controller.action('start')).toBe(false);
      expect(attempts).toBe(1);
    } finally { vi.useRealTimers(); release(); }
    const settled = await until(() => controller.view(), (value) => value.actions.includes('start'));
    expect(settled.transition).toMatchObject({ cleanupPending: false, failure: { code: 'mailbox.start_cancelled' } });
    expect(attempts).toBe(1);
  });
});
