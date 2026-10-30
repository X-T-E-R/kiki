import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { LockError, MiniDb } from '@kiki/minidb';
import { DatabaseSync } from 'node:sqlite';

import { CanonicalMailboxDatabase } from '#/persistence/backends/sqliteMailbox/database';
import { mailboxDirectory, openRuntimeMailbox, readMailboxAuthority } from '#/persistence/backends/sqliteMailbox/authority';
import { createMailboxMigrationService } from '#/persistence/backends/sqliteMailbox/migration';
import type { MailboxOwner } from '#/persistence/backends/sqliteMailbox/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHomeRuntimeService } from '#/app/runtimeHost/runtimeHost';
import { IThreadMailboxStore } from '#/app/threadCommunication/threadMailboxStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import {
  THREAD_MAILBOX_RUNTIME_METHODS,
  RuntimeThreadMailboxStore,
} from '#/app/threadCommunication/runtimeThreadMailboxStore';
import { ThreadMailboxBacklogError } from '#/app/threadCommunication/mailboxErrors';
import type { ThreadRef } from '#/app/threadCommunication/threadCommunication';
import type {
  AcceptedThreadMessage,
  ThreadDeliveryClaim,
  ThreadMailboxMutationOptions,
  ThreadMessageProducer,
} from '#/app/threadCommunication/threadMailboxStore';
import { threadMessageIdempotencyKey } from '#/app/threadCommunication/threadMessageIdentity';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

const source: ThreadRef = { hostId: 'host-a', workspaceId: 'workspace-a', sessionId: 'source' };
const target: ThreadRef = { hostId: 'host-a', workspaceId: 'workspace-b', sessionId: 'target' };
const execFileAsync = promisify(execFile);
const workerFixture = fileURLToPath(new URL('../runtimeHost/fixtures/runtime-mailbox-worker.mts', import.meta.url));

interface Harness {
  readonly runtime: HomeRuntimeHostService;
  readonly store: RuntimeThreadMailboxStore;
}

interface RuntimeMailboxCaller {
  call(
    method: string,
    payload: unknown,
    options: ThreadMailboxMutationOptions | undefined,
    timeoutMs: number,
  ): Promise<unknown>;
}

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

function harness(homeDir: string): Harness {
  const services = new ServiceCollection(
    [IBootstrapService, bootstrap(homeDir)],
    [IHostFileSystem, new SyncDescriptor(HostFileSystem)],
    [IHomeRuntimeService, new SyncDescriptor(HomeRuntimeHostService)],
    [IThreadMailboxStore, new SyncDescriptor(RuntimeThreadMailboxStore)],
  );
  const instantiation = new InstantiationService(services, true);
  return instantiation.invokeFunction((accessor) => ({
    runtime: accessor.get(IHomeRuntimeService) as HomeRuntimeHostService,
    store: accessor.get(IThreadMailboxStore) as RuntimeThreadMailboxStore,
  }));
}

async function closeHarnesses(items: readonly Harness[]): Promise<void> {
  await Promise.allSettled(items.map((item) => item.store.close()));
  await Promise.allSettled(items.map((item) => item.runtime.close()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function acceptInput(idempotencyKey: string, content = idempotencyKey) {
  return {
    producer: { kind: 'peer_thread' as const, source },
    target,
    content,
    idempotencyKey,
  };
}

async function closeHarness(item: Harness, items: Harness[]): Promise<void> {
  await item.store.close();
  await item.runtime.close();
  items.splice(items.indexOf(item), 1);
}

function mailboxPartition(ref: ThreadRef): string {
  const key = createHash('sha256').update(JSON.stringify({
    hostId: ref.hostId,
    workspaceId: ref.workspaceId,
    sessionId: ref.sessionId,
  })).digest('base64url');
  return `t/${key}`;
}

function mailboxMessageKey(partition: string, seq: number): string {
  return `${partition}/message/${seq.toString().padStart(16, '0')}`;
}

async function openMailboxDb(homeDir: string, incompleteHistory = false): Promise<CanonicalMailboxDatabase<Record<string, unknown>>> {
  const authority = await readMailboxAuthority(homeDir);
  const db = authority === undefined
    ? await openRuntimeMailbox<Record<string, unknown>>(homeDir, { epoch: 0, hostId: 'example-fixture' })
    : new CanonicalMailboxDatabase<Record<string, unknown>>(join(mailboxDirectory(homeDir), authority.database));
  try {
    const owner = await db.metadata<MailboxOwner>('owner');
    await db.claimOwner(owner ?? { epoch: 0, hostId: 'example-fixture' });
    if (incompleteHistory) {
      await db.metadata('peerHistoryComplete', false);
      await db.partitionBatch('s/thread-mailbox-v3', [{ op: 'set', key: 's/thread-mailbox-v3/active-backend',
        value: { kind: 'active_backend', version: 3, ownerEpoch: owner?.epoch ?? 0, readyAt: 1 } }]);
    }
    return db;
  } catch (error) { await db.close(); throw error; }
}

async function seedLegacyMailbox(homeDir: string, producer: ThreadMessageProducer): Promise<AcceptedThreadMessage> {
  const message: AcceptedThreadMessage = {
    ...acceptInput('legacy'),
    producer,
    messageId: 'legacy-message',
    acceptedAt: 1,
    targetSeq: 1,
  };
  const activity = {
    seq: 1,
    epoch: 'legacy-epoch',
    kind: 'terminal' as const,
    at: 2,
    reason: 'completed',
  };
  const db = await MiniDb.open<Record<string, unknown>>({
    dir: join(homeDir, 'store', 'thread-mailbox-v1'),
    valueCodec: 'json',
    valueMode: 'memory',
    fsyncPolicy: 'always',
    recovery: 'strict',
    indexGenerations: false,
    activeExpireIntervalMs: 0,
  });
  try {
    await db.batch([
      {
        op: 'set',
        key: `delivery/${message.messageId}`,
        value: {
          kind: 'delivery',
          message,
          idempotencyStorageKey: 'legacy-idempotency',
          state: 'pending',
          attempt: 0,
        },
      },
      {
        op: 'set',
        key: 'activity/meta',
        value: { kind: 'activity_meta', target, epoch: activity.epoch, nextSeq: 2, minSeq: 1 },
      },
      {
        op: 'set',
        key: 'activity/event/1',
        value: { kind: 'activity_event', target, activity },
      },
    ]);
  } finally {
    await db.close();
  }
  return message;
}

function blockFirstTargetBatch(): {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly restore: () => void;
  readonly count: () => number;
} {
  const original = CanonicalMailboxDatabase.prototype.partitionBatch;
  let markEntered!: () => void;
  let releaseBatch!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  let count = 0;
  CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args: Parameters<typeof original>) {
    const [partition] = args;
    if (partition.startsWith('t/')) {
      count++;
      if (count === 1) {
        markEntered();
        await blocked;
      }
    }
    return original.apply(this, args);
  };
  return {
    entered,
    release: releaseBatch,
    restore: () => {
      releaseBatch();
      CanonicalMailboxDatabase.prototype.partitionBatch = original;
    },
    count: () => count,
  };
}

function blockMailboxOpen() {
  const original = CanonicalMailboxDatabase.prototype.claimOwner;
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  CanonicalMailboxDatabase.prototype.claimOwner = async function (...args: Parameters<typeof original>) {
    count++;
    markEntered();
    await blocked;
    return original.apply(this, args);
  };
  return {
    entered,
    release,
    count: () => count,
    restore: () => { release(); CanonicalMailboxDatabase.prototype.claimOwner = original; },
  };
}

function setCallBudgets(store: RuntimeThreadMailboxStore, normalMs: number, startupMs: number): void {
  const budgets = store as unknown as { callTimeoutMs: number; startupCallTimeoutMs: number };
  budgets.callTimeoutMs = normalMs;
  budgets.startupCallTimeoutMs = startupMs;
}

describe('runtime thread mailbox', () => {
  let homeDir: string;
  const open: Harness[] = [];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'runtime-mailbox-'));
  });

  afterEach(async () => {
    await closeHarnesses(open.splice(0));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function seedHistory(room: boolean) {
    const item = harness(homeDir);
    open.push(item);
    await item.store.acceptMessage(acceptInput('old-peer'));
    if (room) await item.store.acceptMessage({ producer: { kind: 'room', roomId: 'example-room' },
      target, content: 'old room', idempotencyKey: 'old-room' });
    await closeHarness(item, open);
    const db = await openMailboxDb(homeDir, true);
    const partition = mailboxPartition(target);
    const pointers = (await db.partitionPrefix(partition, `${partition}/peer/`));
    return { db, partition, pointers };
  }

  async function finishRepair(item: Harness) {
    const flight = (item.store as unknown as { peerIndexInitialization?: { promise: Promise<void> } }).peerIndexInitialization;
    await flight?.promise;
    return item.store.readMessages({ group: 'all', limit: 100 });
  }

  it('reuses v2 complete with zero scans and zero pointer writes', async () => {
    const { db } = await seedHistory(false);
    await db.partitionBatch('s/thread-mailbox-v3', [{ op: 'set', key: 's/thread-mailbox-v3/peer-index-v2',
      value: { kind: 'peer_index_marker', complete: true, after: 't0' } }]);
    await db.close();
    const originalScan = CanonicalMailboxDatabase.prototype.shardScanKeys;
    const originalBatch = CanonicalMailboxDatabase.prototype.partitionBatch;
    let scans = 0;
    let pointerWrites = 0;
    CanonicalMailboxDatabase.prototype.shardScanKeys = async function (...args) { scans++; return originalScan.apply(this, args); };
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args) {
      pointerWrites += args[1].filter((op) => op.key.includes('/peer/')).length;
      return originalBatch.apply(this, args);
    };
    try {
      const item = harness(homeDir); open.push(item);
      expect(await item.store.readMessages({ group: 'all', limit: 100 })).toMatchObject({
        items: [{ message: { idempotencyKey: 'old-peer' } }], history: { state: 'complete' } });
      await finishRepair(item);
      expect(scans).toBe(0); expect(pointerWrites).toBe(0);
    } finally { CanonicalMailboxDatabase.prototype.shardScanKeys = originalScan; CanonicalMailboxDatabase.prototype.partitionBatch = originalBatch; }
  });

  it.each([false, true])('inherits v1 peer coverage and repairs only room gaps (room=%s)', async (room) => {
    const { db, partition, pointers } = await seedHistory(room);
    const system = 's/thread-mailbox-v3';
    await db.partitionBatch(system, [{ op: 'del', key: `${system}/peer-index-v2` },
      { op: 'set', key: `${system}/peer-index-v1`, value: { kind: 'peer_index_marker', complete: true, after: 't0' } }]);
    const roomKey = mailboxMessageKey(partition, 2);
    const roomPointers = pointers.filter((entry) => entry.value['messageKey'] === roomKey);
    await db.partitionBatch(partition, roomPointers.map((entry) => ({ op: 'del', key: entry.key })));
    await db.close();
    const original = CanonicalMailboxDatabase.prototype.partitionBatch;
    const written: string[] = [];
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args) {
      written.push(...args[1].filter((op) => op.key.includes('/peer/')).map((op) => op.key));
      return original.apply(this, args);
    };
    try {
      const item = harness(homeDir); open.push(item);
      const first = await item.store.readMessages({ group: 'all', limit: 100 });
      expect(first.history).toMatchObject({ state: 'preparing', pending: 'room' });
      expect(await item.store.readMessages({ group: 'all', limit: 100, peerOnly: true })).toMatchObject({ history: { state: 'complete' } });
      const completed = await finishRepair(item);
      expect(completed.history?.state).toBe('complete');
      expect(completed.items).toHaveLength(room ? 2 : 1);
      expect(written.toSorted()).toEqual(roomPointers.map((entry) => entry.key).toSorted());
      expect(completed.history?.generation).not.toBe(first.history?.generation);
      expect(await item.store.readMessages({ group: 'all', limit: 100, generation: first.history?.generation })).toMatchObject({ cursorExpired: true });
    } finally { CanonicalMailboxDatabase.prototype.partitionBatch = original; }
  });

  it.each(['none', 'v1-partial', 'v2-partial', 'shard-partial'] as const)('repairs missing/mismatched pointers from %s without decoding receipts', async (mode) => {
    const { db, partition, pointers } = await seedHistory(true);
    const system = 's/thread-mailbox-v3';
    await db.partitionBatch(system, [{ op: 'del', key: `${system}/peer-index-v2` }]);
    const roomKey = mailboxMessageKey(partition, 2);
    if (mode !== 'none') await db.partitionBatch(system, [{ op: 'set',
      key: `${system}/peer-index-${mode === 'v1-partial' ? 'v1' : 'v2'}`,
      value: { kind: 'peer_index_marker', complete: false, after: mailboxMessageKey(partition, 1),
        shard: mode === 'shard-partial' ? 0 : undefined,
        shardAfter: mode === 'shard-partial' ? mailboxMessageKey(partition, 1) : undefined } }]);
    const missing = pointers.filter((entry) => entry.value['messageKey'] === roomKey);
    await db.partitionBatch(partition, missing.map((entry, index) => index === 0
      ? { op: 'set', key: entry.key, value: { ...entry.value, peerOrder: 'wrong' } }
      : { op: 'del', key: entry.key }));
    await db.partitionBatch(partition, Array.from({ length: 10_000 }, (_, i) => ({ op: 'set', key: `${partition}/receipt/${i}`,
      value: { kind: 'receipt', body: 'not a message' } })));
    await db.close();
    const originalGet = CanonicalMailboxDatabase.prototype.partitionGet;
    const originalBatch = CanonicalMailboxDatabase.prototype.partitionBatch;
    const originalMget = CanonicalMailboxDatabase.prototype.partitionMget;
    let messageReads = 0; let unrelatedReads = 0; let pointerWrites = 0;
    CanonicalMailboxDatabase.prototype.partitionMget = async function (...args) {
      messageReads += args[1].filter((key) => key.includes('/message/')).length;
      unrelatedReads += args[1].filter((key) => /\/receipt\/\d+$/.test(key)).length;
      return originalMget.apply(this, args);
    };
    CanonicalMailboxDatabase.prototype.partitionGet = async function (...args) {
      if (args[1].includes('/message/')) messageReads++;
      if (/\/receipt\/\d+$/.test(args[1])) unrelatedReads++;
      return originalGet.apply(this, args);
    };
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args) {
      pointerWrites += args[1].filter((op) => op.key.includes('/peer/')).length;
      return originalBatch.apply(this, args);
    };
    try {
      const item = harness(homeDir); open.push(item);
      await item.store.readMessages({ group: 'all', limit: 100 });
      const concurrent = item.store.acceptMessage(acceptInput('new-peer'));
      const complete = await finishRepair(item);
      await concurrent;
      const final = await item.store.readMessages({ group: 'all', limit: 100 });
      expect(complete.history?.state).toBe('complete');
      expect(final.items.map((record) => record.message.idempotencyKey).toSorted()).toEqual(['new-peer', 'old-peer', 'old-room']);
      expect(unrelatedReads).toBe(0);
      expect(messageReads).toBeGreaterThanOrEqual(2);
      expect(messageReads).toBeLessThan(30);
      expect(pointerWrites).toBe(missing.length + 5);
    } finally {
      CanonicalMailboxDatabase.prototype.partitionGet = originalGet;
      CanonicalMailboxDatabase.prototype.partitionMget = originalMget;
      CanonicalMailboxDatabase.prototype.partitionBatch = originalBatch;
    }
  }, 15_000);

  it.each(['pointer', 'checkpoint'] as const)('keeps incomplete on %s failure and replays repair after reopen', async (failure) => {
    const { db, partition, pointers } = await seedHistory(false);
    const system = 's/thread-mailbox-v3';
    await db.partitionBatch(system, [{ op: 'del', key: `${system}/peer-index-v2` }]);
    await db.partitionBatch(partition, [{ op: 'del', key: pointers[0]!.key }]);
    await db.close();
    const original = CanonicalMailboxDatabase.prototype.partitionBatch;
    let armed = false;
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args) {
      if (armed && args[1].some((op) => failure === 'pointer' ? op.key.includes('/peer/') : op.key.endsWith('/peer-index-v2'))) {
        throw new Error('example repair failure');
      }
      return original.apply(this, args);
    };
    const item = harness(homeDir); open.push(item);
    let generation: string | undefined;
    try {
      await item.store.getWorkspaceOverride('example-workspace');
      armed = true;
      const first = await item.store.readMessages({ group: 'all', limit: 100 });
      generation = first.history?.generation;
      const failed = await finishRepair(item);
      expect(failed.history).toMatchObject({ state: 'error', error: 'example repair failure' });
      await closeHarness(item, open);
    } finally { CanonicalMailboxDatabase.prototype.partitionBatch = original; }
    const reopened = harness(homeDir); open.push(reopened);
    expect(await reopened.store.readMessages({ group: 'all', limit: 100, generation })).toMatchObject({ cursorExpired: true });
    const complete = await finishRepair(reopened);
    expect(complete.history?.state).toBe('complete'); expect(complete.items).toHaveLength(1);
  });

  it('gives the first workspace read a startup budget but keeps warm calls bounded', async () => {
    const item = harness(homeDir);
    open.push(item);
    await item.runtime.ready();
    setCallBudgets(item.store, 50, 2_000);
    const gate = blockMailboxOpen();
    try {
      const cold = item.store.getWorkspaceOverride('example-workspace');
      void cold.catch(() => {});
      await gate.entered;
      await new Promise((resolve) => setTimeout(resolve, 150));
      gate.release();
      await expect(cold).resolves.toBeUndefined();
      expect(gate.count()).toBe(1);
      item.runtime.call = () => Promise.reject(new HomeRuntimeError('runtime.timeout', 'blocked warm call'));
      await expect(item.store.getWorkspaceOverride('example-workspace')).rejects.toMatchObject({
        code: 'runtime.timeout',
        message: expect.stringContaining('after 300ms'),
      });
    } finally {
      gate.restore();
    }
  });

  it('does not cancel shared initialization when its first caller aborts', async () => {
    const item = harness(homeDir);
    open.push(item);
    await item.runtime.ready();
    const gate = blockMailboxOpen();
    const controller = new AbortController();
    const cancelled = new Error('caller cancelled');
    try {
      const first = item.store.getWorkspaceOverride('example-workspace', { signal: controller.signal });
      const failure = expect(first).rejects.toBe(cancelled);
      await gate.entered;
      controller.abort(cancelled);
      await failure;
      const second = item.store.getWorkspaceOverride('example-workspace');
      gate.release();
      await expect(second).resolves.toBeUndefined();
      expect(gate.count()).toBe(1);
    } finally {
      gate.restore();
    }
  });

  it('keeps initialization reusable after bounded RPC retries expire', async () => {
    const item = harness(homeDir);
    open.push(item);
    await item.runtime.ready();
    const gate = blockMailboxOpen();
    const internal = item.store as unknown as RuntimeMailboxCaller;
    try {
      const first = internal.call(THREAD_MAILBOX_RUNTIME_METHODS.getWorkspaceOverride,
        { workspaceId: 'example-workspace' }, undefined, 50);
      const failure = expect(first).rejects.toMatchObject({
        code: 'runtime.timeout',
        message: expect.stringContaining('method=threadMailbox.v3.getWorkspaceOverride'),
      });
      await gate.entered;
      await failure;
      const second = item.store.getWorkspaceOverride('example-workspace');
      gate.release();
      await expect(second).resolves.toBeUndefined();
      expect(gate.count()).toBe(1);
    } finally {
      gate.restore();
    }
  });

  it.each(['store', 'runtime'] as const)('cancels shared initialization when the %s closes', async (closing) => {
    const item = harness(homeDir);
    open.push(item);
    await item.runtime.ready();
    const gate = blockMailboxOpen();
    const controller = new AbortController();
    const cancelled = new Error('caller cancelled');
    try {
      const first = item.store.getWorkspaceOverride('example-workspace', { signal: controller.signal });
      void first.catch(() => {});
      await gate.entered;
      const initializing = (item.store as unknown as {
        initialization: { controller: AbortController };
      }).initialization;
      const closed = closing === 'store' ? item.store.close() : item.runtime.close();
      await vi.waitFor(() => expect(initializing.controller.signal.aborted).toBe(true));
      controller.abort(cancelled);
      await expect(first).rejects.toBeInstanceOf(Error);
      gate.release();
      await closed;
      await item.store.close();
      expect((item.store as unknown as { db: unknown }).db).toBeUndefined();
    } finally {
      gate.restore();
    }
  });

  it('serves existing history without waiting for repair and keeps repair alive after caller cancellation', async () => {
    await (await openMailboxDb(homeDir, true)).close();
    const item = harness(homeDir);
    open.push(item);
    await item.store.acceptMessage(acceptInput('backfill-message'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const internals = item.store as unknown as {
      preparePeerIndex(db: CanonicalMailboxDatabase<Record<string, unknown>>, ctx: { signal: AbortSignal }): Promise<void>;
    };
    const original = internals.preparePeerIndex.bind(item.store);
    let count = 0;
    let initializationSignal: AbortSignal | undefined;
    internals.preparePeerIndex = async (db, ctx) => {
      count++;
      initializationSignal = ctx.signal;
      entered();
      await gate;
      return original(db, ctx);
    };
    const controller = new AbortController();
    const cancelled = new Error('reader cancelled');
    try {
      const first = item.store.readMessages({ group: 'all', limit: 100 }, { signal: controller.signal });
      await expect(first).resolves.toMatchObject({ items: [{ message: { idempotencyKey: 'backfill-message' } }],
        history: { state: 'preparing' } });
      await started;
      await expect(item.store.getWorkspaceOverride('example-workspace')).resolves.toBeUndefined();
      controller.abort(cancelled);
      await expect(item.store.readMessages({ group: 'all', limit: 100 }, { signal: controller.signal })).rejects.toBe(cancelled);
      expect(initializationSignal?.aborted).toBe(false);
      await expect(item.store.readMessages({ group: 'all', limit: 100 })).resolves.toMatchObject({
        items: [{ message: { idempotencyKey: 'backfill-message' } }], history: { state: 'preparing' } });
      release();
      expect(count).toBe(1);
    } finally {
      release();
      internals.preparePeerIndex = original;
    }
  });

  it('cancels peer-history backfill before releasing a departed owner database', async () => {
    await (await openMailboxDb(homeDir, true)).close();
    const item = harness(homeDir);
    open.push(item);
    await item.store.getWorkspaceOverride('example-workspace');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const internals = item.store as unknown as {
      db: unknown;
      peerIndexInitialization: { controller: AbortController };
      preparePeerIndex(): Promise<void>;
    };
    const original = internals.preparePeerIndex.bind(item.store);
    internals.preparePeerIndex = async () => { entered(); await gate; };
    const controller = new AbortController();
    try {
      const first = item.store.readMessages({ group: 'all', limit: 100 }, { signal: controller.signal });
      await expect(first).resolves.toMatchObject({ history: { state: 'preparing' } });
      await started;
      const initialization = internals.peerIndexInitialization;
      await item.runtime.close();
      expect(initialization.controller.signal.aborted).toBe(true);
      expect(internals.db).toBeDefined();
      controller.abort(new Error('reader cancelled'));
      release();
      await item.store.close();
      expect(internals.db).toBeUndefined();
    } finally {
      release();
      internals.preparePeerIndex = original;
    }
  });

  it('uses one real cross-process owner and produces no MiniDb LockError', async () => {
    const outputs = await Promise.all(
      Array.from({ length: 3 }, async (_, writer) => {
        const result = await execFileAsync(
          process.execPath,
          ['--import', new URL('../../../../../build/register-raw-text-loader.mjs', import.meta.url).href,
            '--import', 'tsx', workerFixture, homeDir, String(writer), '5'],
          { cwd: join(import.meta.dirname, '../../..') },
        );
        return JSON.parse(result.stdout) as { readonly seqs: number[]; readonly lockErrors: number };
      }),
    );
    expect(outputs.reduce((total, item) => total + item.lockErrors, 0)).toBe(0);
    expect(outputs.flatMap((item) => item.seqs).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
  }, 30_000);

  it('microbatches 32 concurrent accepts for one target in FIFO sequence order', async () => {
    const item = harness(homeDir);
    open.push(item);
    const gate = blockFirstTargetBatch();
    try {
      const resultsPromise = Promise.all(
        Array.from({ length: 32 }, (_, index) => item.store.acceptMessage(acceptInput(`batch-${index}`))),
      );
      await gate.entered;
      await new Promise((resolve) => setTimeout(resolve, 25));
      gate.release();
      const results = await resultsPromise;
      expect(results.map((result) => result.message.targetSeq)).toEqual(
        Array.from({ length: 32 }, (_, index) => index + 1),
      );
      expect(results.every((result) => !result.deduplicated)).toBe(true);
      expect(gate.count()).toBe(2);
    } finally {
      gate.restore();
    }
  });

  it('deduplicates repeated idempotency keys inside one accept microbatch', async () => {
    const item = harness(homeDir);
    open.push(item);
    const gate = blockFirstTargetBatch();
    try {
      const seed = item.store.acceptMessage(acceptInput('seed'));
      await gate.entered;
      const original = item.store.acceptMessage(acceptInput('duplicate', 'first payload'));
      const duplicate = item.store.acceptMessage(acceptInput('duplicate', 'changed payload'));
      await new Promise((resolve) => setTimeout(resolve, 25));
      gate.release();
      const [seedResult, originalResult, duplicateResult] = await Promise.all([seed, original, duplicate]);
      expect(seedResult.message.targetSeq).toBe(1);
      expect(originalResult).toMatchObject({ deduplicated: false, payloadConflict: false, message: { targetSeq: 2 } });
      expect(duplicateResult).toMatchObject({
        deduplicated: true,
        payloadConflict: true,
        message: { messageId: originalResult.message.messageId, targetSeq: 2, content: 'first payload' },
      });
      expect(gate.count()).toBe(2);
    } finally {
      gate.restore();
    }
  });

  it('isolates an invalid accept payload from valid entries in the same microbatch window', async () => {
    const item = harness(homeDir);
    open.push(item);
    const gate = blockFirstTargetBatch();
    try {
      const resultsPromise = Promise.allSettled([
        item.store.acceptMessage(acceptInput('seed')),
        item.store.acceptMessage(acceptInput('valid-before')),
        item.store.acceptMessage({ ...acceptInput('invalid'), content: 42 } as never),
        item.store.acceptMessage(acceptInput('valid-after')),
      ]);
      await gate.entered;
      await new Promise((resolve) => setTimeout(resolve, 25));
      gate.release();
      const results = await resultsPromise;
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { message: { targetSeq: 1 } } });
      expect(results[1]).toMatchObject({ status: 'fulfilled', value: { message: { targetSeq: 2 } } });
      expect(results[2]?.status).toBe('rejected');
      expect(String((results[2] as PromiseRejectedResult).reason)).toContain('Invalid thread mailbox accept payload');
      expect(results[3]).toMatchObject({ status: 'fulfilled', value: { message: { targetSeq: 3 } } });
      expect(gate.count()).toBe(2);
    } finally {
      gate.restore();
    }
  });

  it('keeps reused legacy TTL identity valid through backup, restore and old external-message pruning', async () => {
    const input = { ...acceptInput('legacy-reused'), producer: { kind: 'external_client' as const } };
    const legacy = { ...input, content: 'previous payload', messageId: 'legacy-expiring-message', targetSeq: 1, acceptedAt: 1 };
    const old = await MiniDb.open<Record<string, unknown>>({ dir: join(homeDir, 'store/thread-mailbox-v1'),
      valueCodec: 'json', fsyncPolicy: 'always', indexGenerations: false, activeExpireIntervalMs: 0 });
    const expiry = Date.now() + 5_000;
    await old.batch([
      { op: 'set', key: 'delivery/legacy-expiring-message', value: { kind: 'delivery', message: legacy, state: 'delivered', attempt: 1, idempotencyStorageKey: 'idem/reused' } },
      { op: 'set', key: 'idem/reused', value: { kind: 'idempotency', ...input, messageId: legacy.messageId,
        payloadHash: createHash('sha256').update(JSON.stringify({ content: legacy.content })).digest('base64url') }, ttl: expiry - Date.now() },
    ]);
    const absoluteExpiry = old.store.getRecord('idem/reused')!.expireAt;
    await old.close();
    const migration = createMailboxMigrationService(homeDir);
    try {
      const migrated = await migration.migrate();
      expect(migrated).toMatchObject({ state: 'complete', authority: 'sqlite' });
      const before = await openMailboxDb(homeDir);
      const partition = mailboxPartition(target);
      const idem = (await before.prefix(`${partition}/idempotency/`))[0]!;
      expect(idem.expireAt).toBe(absoluteExpiry);
      await before.close();
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, absoluteExpiry - Date.now() + 20)));
      const item = harness(homeDir); open.push(item);
      const accepted = await item.store.acceptMessage(input, { requestId: 'reuse-after-expiry' });
      expect(accepted).toMatchObject({ deduplicated: false, message: { targetSeq: 2 } });
      expect(accepted.message.messageId).not.toBe(legacy.messageId);
      const backup = join(homeDir, 'ttl-reuse-backup.sqlite');
      await expect(migration.backup(backup)).resolves.toMatchObject({ destination: backup });
      const restored = new CanonicalMailboxDatabase<Record<string, unknown>>(backup);
      try {
        expect((await restored.prefix(`${partition}/message/`)).map((row) => (row.value['message'] as AcceptedThreadMessage).messageId).toSorted()).toEqual([legacy.messageId, accepted.message.messageId].toSorted());
        expect(await restored.partitionGet(partition, idem.key)).toMatchObject({ messageKey: mailboxMessageKey(partition, 2) });
        await expect(restored.verify()).resolves.toMatchObject({ counts: { message: 2 } });
      } finally { await restored.close(); }
      const db = (item.store as unknown as { db: CanonicalMailboxDatabase<Record<string, unknown>> }).db;
      const valid = (await db.prefix(`${partition}/idempotency/`)).find((row) => row.key === idem.key)!;
      expect(valid.expireAt).toBe(0);
      await db.partitionBatch(partition, [{ op: 'set', key: idem.key, value: { ...valid.value, messageKey: mailboxMessageKey(partition, 1) } }]);
      await expect(db.verify()).rejects.toThrow('Idempotency reference does not match');
      await db.partitionBatch(partition, [{ op: 'set', key: idem.key, value: valid.value }]);
      await Promise.all(Array.from({ length: 511 }, (_, index) => item.store.acceptMessage({ ...input, idempotencyKey: `retained-${index}` })));
      expect(await db.partitionGet(partition, mailboxMessageKey(partition, 1))).toBeUndefined();
      expect(await db.partitionGet(partition, idem.key)).toMatchObject({ messageKey: mailboxMessageKey(partition, 2) });
      expect(await item.store.acceptMessage(input, { requestId: 'retry-after-prune' })).toMatchObject({ deduplicated: true, message: { messageId: accepted.message.messageId } });
      await expect(db.verify()).resolves.toMatchObject({ counts: { message: 512 } });
    } finally { await migration.close(); }
  }, 15_000);

  it('honors an explicit pending limit without restoring the legacy default cap', async () => {
    const item = harness(homeDir);
    open.push(item);
    const input = (index: number) => ({ ...acceptInput(`explicit-capacity-${index}`), pendingLimit: 3 });
    for (let index = 0; index < 3; index += 1) await item.store.acceptMessage(input(index));
    await expect(item.store.acceptMessage(input(3))).rejects.toMatchObject({ limit: 3 });
    expect(await item.store.acceptMessage(input(0))).toMatchObject({ deduplicated: true });
  });

  it('enqueues beyond the legacy default pending limit and rejects at the hard guard', async () => {
    const item = harness(homeDir);
    open.push(item);
    const results = await Promise.all(
      Array.from({ length: 513 }, (_, index) => item.store.acceptMessage(acceptInput(`capacity-${index}`))),
    );
    expect(results.at(-1)?.message.targetSeq).toBe(513);
    await closeHarness(item, open);

    const partition = mailboxPartition(target);
    const db = await openMailboxDb(homeDir);
    try {
      const metaKey = `${partition}/meta`;
      const meta = await db.partitionGet(partition, metaKey);
      if (meta === undefined) throw new Error('mailbox metadata is missing');
      await db.partitionBatch(partition, [{
        op: 'set',
        key: metaKey,
        value: { ...meta, pendingCount: 100_000 },
      }]);
    } finally {
      await db.close();
    }

    const reopened = harness(homeDir);
    open.push(reopened);
    const failure = await reopened.store.acceptMessage(acceptInput('hard-limit')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ThreadMailboxBacklogError);
    expect(failure).toMatchObject({ limit: 100_000 });
  });

  it('drains FIFO by durable head without scanning the message backlog', async () => {
    const item = harness(homeDir);
    open.push(item);
    await Promise.all(Array.from({ length: 40 }, (_, index) => item.store.acceptMessage(acceptInput(`fifo-${index}`))));
    const originalPrefix = CanonicalMailboxDatabase.prototype.partitionPrefix;
    const originalBatch = CanonicalMailboxDatabase.prototype.partitionBatch;
    const claimed: number[] = [];
    const heads: number[] = [];
    let messageScans = 0;
    CanonicalMailboxDatabase.prototype.partitionPrefix = async function (...args: Parameters<typeof originalPrefix>) {
      if (args[1].endsWith('/message/')) messageScans++;
      return originalPrefix.apply(this, args);
    };
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
      for (const operation of args[1]) {
        if (operation.op !== 'set' || !operation.key.endsWith('/meta')) continue;
        const value = operation.value as Record<string, unknown>;
        if (value['kind'] === 'target_meta' && typeof value['nextDeliverableSeq'] === 'number') {
          heads.push(value['nextDeliverableSeq']);
        }
      }
      return originalBatch.apply(this, args);
    };
    try {
      for (let seq = 1; seq <= 40; seq++) {
        const claim = await item.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
        claimed.push(claim!.message.targetSeq);
        expect(await item.store.acknowledgeDelivery(claim!)).toBe(true);
      }
      expect(await item.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 })).toBeUndefined();
      expect(claimed).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      expect(heads.at(-1)).toBe(41);
      expect(messageScans).toBe(0);
    } finally {
      CanonicalMailboxDatabase.prototype.partitionPrefix = originalPrefix;
      CanonicalMailboxDatabase.prototype.partitionBatch = originalBatch;
    }
  });

  it('advances the head atomically across a terminal hole during finish', async () => {
    const item = harness(homeDir);
    open.push(item);
    await Promise.all([
      item.store.acceptMessage(acceptInput('finish-hole-1')),
      item.store.acceptMessage(acceptInput('finish-hole-2')),
      item.store.acceptMessage(acceptInput('finish-hole-3')),
    ]);
    await closeHarness(item, open);
    const partition = mailboxPartition(target);
    const db = await openMailboxDb(homeDir);
    try {
      const metaKey = `${partition}/meta`;
      const meta = await db.partitionGet(partition, metaKey);
      const holeKey = mailboxMessageKey(partition, 2);
      const hole = await db.partitionGet(partition, holeKey);
      if (meta === undefined || hole === undefined) throw new Error('mailbox fixture is incomplete');
      await db.partitionBatch(partition, [
        { op: 'set', key: holeKey, value: { ...hole, state: 'delivered' } },
        { op: 'set', key: metaKey, value: { ...meta, pendingCount: 2 } },
      ]);
    } finally {
      await db.close();
    }
    const reopened = harness(homeDir);
    open.push(reopened);
    const originalPrefix = CanonicalMailboxDatabase.prototype.partitionPrefix;
    let messageScans = 0;
    CanonicalMailboxDatabase.prototype.partitionPrefix = async function (...args: Parameters<typeof originalPrefix>) {
      if (args[1].endsWith('/message/')) messageScans++;
      return originalPrefix.apply(this, args);
    };
    try {
      const first = await reopened.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
      expect(first?.message.targetSeq).toBe(1);
      expect(await reopened.store.acknowledgeDelivery(first!)).toBe(true);
      const third = await reopened.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
      expect(third?.message.targetSeq).toBe(3);
      expect(messageScans).toBe(0);
    } finally {
      CanonicalMailboxDatabase.prototype.partitionPrefix = originalPrefix;
    }
  });

  it('repairs a stale head by bounded direct-key stepping', async () => {
    const item = harness(homeDir);
    open.push(item);
    await Promise.all([
      item.store.acceptMessage(acceptInput('step-hole-1')),
      item.store.acceptMessage(acceptInput('step-hole-2')),
    ]);
    const first = await item.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
    expect(await item.store.acknowledgeDelivery(first!)).toBe(true);
    await closeHarness(item, open);
    const partition = mailboxPartition(target);
    const db = await openMailboxDb(homeDir);
    try {
      const metaKey = `${partition}/meta`;
      const meta = await db.partitionGet(partition, metaKey);
      if (meta === undefined) throw new Error('mailbox metadata is missing');
      await db.partitionBatch(partition, [{ op: 'set', key: metaKey, value: { ...meta, nextDeliverableSeq: 1 } }]);
    } finally {
      await db.close();
    }
    const reopened = harness(homeDir);
    open.push(reopened);
    const originalPage = CanonicalMailboxDatabase.prototype.page;
    const originalBatch = CanonicalMailboxDatabase.prototype.partitionBatch;
    let repairedHead: number | undefined;
    let messageScans = 0;
    CanonicalMailboxDatabase.prototype.page = async function (...args: Parameters<typeof originalPage>) {
      if (args[0].endsWith('/message/')) { expect(args[2]).toBeLessThanOrEqual(128); expect(args[3]).toBe('message'); messageScans++; }
      return originalPage.apply(this, args);
    };
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
      for (const operation of args[1]) {
        if (operation.op !== 'set' || !operation.key.endsWith('/meta')) continue;
        const value = operation.value as Record<string, unknown>;
        if (typeof value['nextDeliverableSeq'] === 'number') repairedHead = value['nextDeliverableSeq'];
      }
      return originalBatch.apply(this, args);
    };
    try {
      const claim = await reopened.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
      expect(claim?.message.targetSeq).toBe(2);
      expect(repairedHead).toBe(2);
      expect(messageScans).toBe(0);
    } finally {
      CanonicalMailboxDatabase.prototype.page = originalPage;
      CanonicalMailboxDatabase.prototype.partitionBatch = originalBatch;
    }
  });

  it('falls back to one repair scan after the bounded head step limit', async () => {
    const item = harness(homeDir);
    open.push(item);
    await Promise.all(Array.from({ length: 34 }, (_, index) => item.store.acceptMessage(acceptInput(`fallback-${index}`))));
    await closeHarness(item, open);
    const partition = mailboxPartition(target);
    const db = await openMailboxDb(homeDir);
    try {
      const metaKey = `${partition}/meta`;
      const meta = await db.partitionGet(partition, metaKey);
      if (meta === undefined) throw new Error('mailbox metadata is missing');
      const operations = [];
      for (let seq = 1; seq <= 33; seq++) {
        const key = mailboxMessageKey(partition, seq);
        const message = await db.partitionGet(partition, key);
        if (message === undefined) throw new Error('mailbox message is missing');
        operations.push({ op: 'set' as const, key, value: { ...message, state: 'delivered' } });
      }
      operations.push({ op: 'set' as const, key: metaKey, value: { ...meta, pendingCount: 1 } });
      await db.partitionBatch(partition, operations);
    } finally {
      await db.close();
    }
    const reopened = harness(homeDir);
    open.push(reopened);
    const originalPage = CanonicalMailboxDatabase.prototype.page;
    const originalBatch = CanonicalMailboxDatabase.prototype.partitionBatch;
    let repairedHead: number | undefined;
    let messageScans = 0;
    CanonicalMailboxDatabase.prototype.page = async function (...args: Parameters<typeof originalPage>) {
      if (args[0].endsWith('/message/')) { expect(args[2]).toBeLessThanOrEqual(128); expect(args[3]).toBe('message'); messageScans++; }
      return originalPage.apply(this, args);
    };
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
      for (const operation of args[1]) {
        if (operation.op !== 'set' || !operation.key.endsWith('/meta')) continue;
        const value = operation.value as Record<string, unknown>;
        if (typeof value['nextDeliverableSeq'] === 'number') repairedHead = value['nextDeliverableSeq'];
      }
      return originalBatch.apply(this, args);
    };
    try {
      const claim = await reopened.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
      expect(claim?.message.targetSeq).toBe(34);
      expect(repairedHead).toBe(34);
      expect(messageScans).toBe(1);
    } finally {
      CanonicalMailboxDatabase.prototype.page = originalPage;
      CanonicalMailboxDatabase.prototype.partitionBatch = originalBatch;
    }
  });

  it('lazily migrates an old target meta with one repair scan', async () => {
    const item = harness(homeDir);
    open.push(item);
    await Promise.all([
      item.store.acceptMessage(acceptInput('legacy-head-1')),
      item.store.acceptMessage(acceptInput('legacy-head-2')),
    ]);
    await closeHarness(item, open);
    const partition = mailboxPartition(target);
    const db = await openMailboxDb(homeDir);
    try {
      const metaKey = `${partition}/meta`;
      const meta = await db.partitionGet(partition, metaKey);
      if (meta === undefined) throw new Error('mailbox metadata is missing');
      const legacyMeta = { ...meta };
      delete legacyMeta['nextDeliverableSeq'];
      await db.partitionBatch(partition, [{ op: 'set', key: metaKey, value: legacyMeta }]);
    } finally {
      await db.close();
    }
    const reopened = harness(homeDir);
    open.push(reopened);
    const originalPage = CanonicalMailboxDatabase.prototype.page;
    const originalBatch = CanonicalMailboxDatabase.prototype.partitionBatch;
    let persistedHead: number | undefined;
    let messageScans = 0;
    CanonicalMailboxDatabase.prototype.page = async function (...args: Parameters<typeof originalPage>) {
      if (args[0].endsWith('/message/')) { expect(args[2]).toBeLessThanOrEqual(128); expect(args[3]).toBe('message'); messageScans++; }
      return originalPage.apply(this, args);
    };
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
      for (const operation of args[1]) {
        if (operation.op !== 'set' || !operation.key.endsWith('/meta')) continue;
        const value = operation.value as Record<string, unknown>;
        if (typeof value['nextDeliverableSeq'] === 'number') persistedHead = value['nextDeliverableSeq'];
      }
      return originalBatch.apply(this, args);
    };
    try {
      const claim = await reopened.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
      expect(claim?.message.targetSeq).toBe(1);
      expect(await reopened.store.claimNext({ target, consumerId: 'other', leaseMs: 10_000 })).toBeUndefined();
      expect(persistedHead).toBe(1);
      expect(messageScans).toBe(1);
    } finally {
      CanonicalMailboxDatabase.prototype.page = originalPage;
      CanonicalMailboxDatabase.prototype.partitionBatch = originalBatch;
    }
  });

  it('recovers lost mutation responses once with the same request id and durable receipts', async () => {
    const first = harness(homeDir);
    const second = harness(homeDir);
    open.push(first, second);
    await Promise.all([first.runtime.ready(), second.runtime.ready()]);
    const client = first.runtime.status().role === 'client' ? first : second;
    const requestIds = new Map<string, string[]>();
    const drop = new Set<string>([
      THREAD_MAILBOX_RUNTIME_METHODS.accept,
      THREAD_MAILBOX_RUNTIME_METHODS.claim,
      THREAD_MAILBOX_RUNTIME_METHODS.acknowledge,
      THREAD_MAILBOX_RUNTIME_METHODS.undeliverable,
    ]);
    const originalCall = client.runtime.call.bind(client.runtime);
    client.runtime.call = async (method, payload, options) => {
      const ids = requestIds.get(method) ?? [];
      ids.push(options?.requestId ?? '');
      requestIds.set(method, ids);
      const result = await originalCall(method, payload, options);
      if (drop.delete(method)) throw new HomeRuntimeError('runtime.owner_gone', 'response lost after commit');
      return result;
    };

    const accepted = await client.store.acceptMessage(acceptInput('lost-accept'));
    const claim = await client.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
    expect(claim?.message.messageId).toBe(accepted.message.messageId);
    expect(await client.store.acknowledgeDelivery(claim!)).toBe(true);
    const undeliverable = await client.store.acceptMessage(acceptInput('lost-undeliverable'));
    const secondClaim = await client.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
    expect(secondClaim?.message.messageId).toBe(undeliverable.message.messageId);
    expect(await client.store.markUndeliverable(secondClaim!, 'failed')).toBe(true);

    expect(drop.size).toBe(0);
    for (const method of [
      THREAD_MAILBOX_RUNTIME_METHODS.accept,
      THREAD_MAILBOX_RUNTIME_METHODS.claim,
      THREAD_MAILBOX_RUNTIME_METHODS.acknowledge,
      THREAD_MAILBOX_RUNTIME_METHODS.undeliverable,
    ]) {
      const ids = requestIds.get(method)!;
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(ids[0]).toBe(ids[1]);
    }
    const retry = await client.store.acceptMessage(acceptInput('lost-accept'));
    expect(retry).toMatchObject({ deduplicated: true, message: { messageId: accepted.message.messageId } });
  });

  it.each(['timeout', 'duplicate'] as const)('waits for an in-flight owner after %s and recovers one durable claim receipt', async (failure) => {
    const item = harness(homeDir);
    open.push(item);
    const accepted = await item.store.acceptMessage(acceptInput('in-flight-receipt'));
    const gate = blockFirstTargetBatch();
    const calls = vi.spyOn(item.runtime, 'call');
    const input = { target, consumerId: 'consumer', leaseMs: 10_000 };
    const options = { requestId: 'in-flight-claim' };
    const internal = item.store as unknown as RuntimeMailboxCaller;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      if (failure === 'duplicate') {
        const original = item.runtime.call(THREAD_MAILBOX_RUNTIME_METHODS.claim, input, { ...options, timeoutMs: 100 });
        const rejected = expect(original).rejects.toMatchObject({ code: 'runtime.timeout' });
        await gate.entered;
        await vi.advanceTimersByTimeAsync(100);
        await rejected;
        calls.mockClear();
      }
      const claimPromise = internal.call(THREAD_MAILBOX_RUNTIME_METHODS.claim, input, options, 100) as Promise<ThreadDeliveryClaim>;
      const settled = vi.fn();
      void claimPromise.then(settled, settled);
      await gate.entered;
      await vi.advanceTimersByTimeAsync(350);
      expect(settled).not.toHaveBeenCalled();
      expect(calls).toHaveBeenCalledTimes(1);
      gate.release();
      vi.useRealTimers();
      const claim = await claimPromise;
      expect(claim).toMatchObject({ message: { messageId: accepted.message.messageId }, fence: 1 });
      expect(calls.mock.calls.map(([, , callOptions]) => callOptions?.requestId)).toEqual(['in-flight-claim', 'in-flight-claim']);
      expect(gate.count()).toBe(1);
      expect(await item.store.acknowledgeDelivery(claim)).toBe(true);
      expect(await item.store.claimNext(input)).toBeUndefined();
    } finally {
      vi.useRealTimers();
      gate.restore();
      calls.mockRestore();
    }
  });

  it('backs off remote guarded retries and recovers the original committed claim receipt', async () => {
    const first = harness(homeDir); const second = harness(homeDir); open.push(first, second);
    await Promise.all([first.runtime.ready(), second.runtime.ready()]);
    const client = first.runtime.status().role === 'client' ? first : second;
    const accepted = await client.store.acceptMessage(acceptInput('remote-in-flight'));
    const originalCall = client.runtime.call.bind(client.runtime);
    const attempts: Array<{ at: number; requestId?: string }> = [];
    const failures: string[] = [];
    client.runtime.call = async (method, payload, options) => {
      if (method === THREAD_MAILBOX_RUNTIME_METHODS.claim) attempts.push({ at: Date.now(), requestId: options?.requestId });
      try { return await originalCall(method, payload, options); }
      catch (error) {
        if (error instanceof HomeRuntimeError) failures.push(error.code);
        throw error;
      }
    };
    const gate = blockFirstTargetBatch();
    const input = { target, consumerId: 'consumer', leaseMs: 10_000 };
    const internal = client.store as unknown as RuntimeMailboxCaller;
    try {
      const result = internal.call(THREAD_MAILBOX_RUNTIME_METHODS.claim, input, { requestId: 'remote-in-flight' }, 500) as Promise<ThreadDeliveryClaim>;
      void result.catch(() => {});
      await gate.entered;
      await waitUntil(() => failures.includes('runtime.duplicate_request'));
      gate.release();
      const claim = await result;
      expect(claim).toMatchObject({ message: { messageId: accepted.message.messageId }, fence: 1 });
      expect(attempts).toHaveLength(3);
      expect(attempts[2]!.at - attempts[1]!.at).toBeGreaterThanOrEqual(450);
      expect(new Set(attempts.map((attempt) => attempt.requestId))).toEqual(new Set(['remote-in-flight']));
      expect(gate.count()).toBe(1);
      expect(await client.store.acknowledgeDelivery(claim)).toBe(true);
      expect(await client.store.claimNext(input)).toBeUndefined();
    } finally { gate.restore(); client.runtime.call = originalCall; }
  });

  it('cancels a wait for an in-flight owner without waiting for storage or replaying its commit', async () => {
    const item = harness(homeDir); open.push(item);
    await item.store.acceptMessage(acceptInput('cancel-in-flight'));
    const gate = blockFirstTargetBatch();
    const controller = new AbortController();
    const cancellation = new Error('cancel owner wait');
    const input = { target, consumerId: 'consumer', leaseMs: 10_000 };
    const internal = item.store as unknown as RuntimeMailboxCaller;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const result = internal.call(THREAD_MAILBOX_RUNTIME_METHODS.claim, input,
        { requestId: 'cancel-in-flight', signal: controller.signal }, 100);
      const rejected = expect(result).rejects.toBe(cancellation);
      await gate.entered;
      await vi.advanceTimersByTimeAsync(150);
      controller.abort(cancellation);
      await rejected;
      expect(gate.count()).toBe(1);
    } finally { vi.useRealTimers(); gate.restore(); }
    const claim = await item.store.claimNext(input, { requestId: 'cancel-in-flight' });
    expect(claim?.fence).toBe(1);
    expect(await item.store.acknowledgeDelivery(claim!)).toBe(true);
  });

  it('bounds retries while the original same-id handler stays in flight', async () => {
    const item = harness(homeDir);
    open.push(item);
    await item.store.acceptMessage(acceptInput('stuck-handler'));
    const gate = blockFirstTargetBatch();
    const requestIds: string[] = [];
    const originalCall = item.runtime.call.bind(item.runtime);
    item.runtime.call = (method, payload, options) => {
      if (method === THREAD_MAILBOX_RUNTIME_METHODS.claim) requestIds.push(options?.requestId ?? '');
      return originalCall(method, payload, options);
    };
    const internal = item.store as unknown as RuntimeMailboxCaller;
    try {
      const claimPromise = internal.call(
        THREAD_MAILBOX_RUNTIME_METHODS.claim,
        { target, consumerId: 'consumer', leaseMs: 10_000 },
        { requestId: 'stuck-claim' },
        75,
      );
      await gate.entered;
      await expect(claimPromise).rejects.toMatchObject({
        code: 'runtime.timeout',
        message: expect.stringMatching(/firstTimeout=.*ownerPhase=claim_commit.*lockWaits=0/),
      });
      expect(requestIds).toEqual(['stuck-claim']);
      expect(gate.count()).toBe(1);
    } finally {
      gate.restore();
    }
  });

  it('distinguishes queued claim timeout from the active storage operation', async () => {
    const item = harness(homeDir); open.push(item);
    await item.store.acceptMessage(acceptInput('queued-timeout'));
    const gate = blockFirstTargetBatch();
    try {
      const first = item.store.claimNext({ target, consumerId: 'first', leaseMs: 10_000 });
      await gate.entered;
      const caller = item.store as unknown as RuntimeMailboxCaller;
      await expect(caller.call(THREAD_MAILBOX_RUNTIME_METHODS.claim,
        { target, consumerId: 'queued', leaseMs: 10_000 }, { requestId: 'queued-timeout' }, 75)).rejects.toMatchObject({
        code: 'runtime.timeout', message: expect.stringMatching(/firstTimeout=.*ownerPhase=partition_queue.*lockWaits=0/),
      });
      gate.release();
      expect((await first)?.consumerId).toBe('first');
      expect(gate.count()).toBe(1);
    } finally { gate.restore(); }
  });

  it('reports initialization rather than shard contention before storage opens', async () => {
    const item = harness(homeDir); open.push(item);
    await item.runtime.ready();
    const gate = blockMailboxOpen();
    const caller = item.store as unknown as RuntimeMailboxCaller;
    try {
      const result = caller.call(THREAD_MAILBOX_RUNTIME_METHODS.claim,
        { target, consumerId: 'consumer', leaseMs: 10_000 }, { requestId: 'initializing-claim' }, 100)
        .catch((error: unknown) => error);
      await gate.entered;
      const error = await result;
      expect(error).toMatchObject({ code: 'runtime.timeout' });
      expect((error as Error).message).toMatch(/firstTimeout=.*ownerPhase=initialization.*lockWaits=0/);
      expect(gate.count()).toBe(1);
    } finally { gate.restore(); }
    await expect(item.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 },
      { requestId: 'initializing-claim' })).resolves.toBeUndefined();
  });

  it('bounds SQLite writer contention and recovers the same claim receipt after release', async () => {
    const item = harness(homeDir); open.push(item);
    const accepted = await item.store.acceptMessage(acceptInput('locked-claim-message'));
    const db = (item.store as unknown as { db: CanonicalMailboxDatabase<unknown> }).db;
    const lock = new DatabaseSync(db.database);
    lock.exec('BEGIN IMMEDIATE');
    const input = { target, consumerId: 'consumer', leaseMs: 10_000 };
    try {
      const started = Date.now();
      await expect(item.store.claimNext(input, { requestId: 'locked-claim' })).rejects.toMatchObject({
        code: 'ERR_SQLITE_ERROR', message: expect.stringMatching(/locked|busy/),
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    const claim = await item.store.claimNext(input, { requestId: 'locked-claim' });
    expect(claim).toMatchObject({ message: { messageId: accepted.message.messageId }, consumerId: 'consumer', fence: 1 });
    expect(await item.store.claimNext(input, { requestId: 'locked-claim' })).toEqual(claim);
    expect(await item.store.claimNext({ ...input, consumerId: 'other' })).toBeUndefined();
    expect(await item.store.acknowledgeDelivery(claim!)).toBe(true);
    expect(await item.store.claimNext(input)).toBeUndefined();
  });

  it('enforces an elapsed direct-call deadline after synchronous handler blocking', async () => {
    const item = harness(homeDir); open.push(item);
    await item.runtime.ready();
    const registration = item.runtime.registerMethod('example.blocking', (_payload, ctx) => {
      ctx.setTimeoutDiagnostic?.(() => 'ownerPhase=example_sync');
      const until = Date.now() + 60;
      while (Date.now() < until) {}
      return 'late result';
    });
    try {
      await expect(item.runtime.call('example.blocking', null, { timeoutMs: 20 })).rejects.toMatchObject({
        code: 'runtime.timeout', message: expect.stringMatching(/timerLagMs=[1-9]\d*.*ownerPhase=example_sync/),
      });
    } finally { await registration.dispose(); }
  });

  it('removes aborted operations before they start in a partition queue', async () => {
    const item = harness(homeDir);
    open.push(item);
    await item.store.acceptMessage(acceptInput('queued-abort'));
    const gate = blockFirstTargetBatch();
    const queues = (item.store as unknown as {
      readonly partitionQueues: Map<string, { readonly operations: readonly unknown[] }>;
    }).partitionQueues;
    const interruption = new Error('queued claim aborted');
    const controller = new AbortController();
    try {
      const first = item.store.claimNext({ target, consumerId: 'first', leaseMs: 10_000 });
      await gate.entered;
      const second = item.store.claimNext(
        { target, consumerId: 'second', leaseMs: 10_000 },
        { requestId: 'queued-abort-claim', signal: controller.signal },
      ).catch((error: unknown) => error);
      await waitUntil(() => [...queues.values()].some((queue) => queue.operations.length === 1));
      controller.abort(interruption);
      expect(await second).toBe(interruption);
      expect([...queues.values()].every((queue) => queue.operations.length === 0)).toBe(true);
      gate.release();
      await expect(first).resolves.toMatchObject({ message: { messageId: expect.any(String) } });
    } finally {
      gate.restore();
    }
  });

  it('reclaims expired and prior-epoch claims while fencing stale finishes', async () => {
    const first = harness(homeDir);
    const second = harness(homeDir);
    open.push(first, second);
    await Promise.all([first.runtime.ready(), second.runtime.ready()]);
    const owner = first.runtime.status().role === 'owner' ? first : second;
    const client = owner === first ? second : first;
    const accepted = await client.store.acceptMessage(acceptInput('lease'));
    const oldClaim = await client.store.claimNext({ target, consumerId: 'old', leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = await client.store.claimNext({ target, consumerId: 'new', leaseMs: 60_000 });
    expect(renewed).toMatchObject({ message: { messageId: accepted.message.messageId }, fence: oldClaim!.fence + 1 });
    expect(await client.store.acknowledgeDelivery(oldClaim!)).toBe(false);

    await owner.runtime.close();
    await waitUntil(() => client.runtime.status().role === 'owner');
    const newEpoch = await client.store.claimNext({ target, consumerId: 'new-owner', leaseMs: 60_000 });
    expect(newEpoch?.hostEpoch).toBe(client.runtime.status().epoch);
    expect(newEpoch!.hostEpoch).toBeGreaterThan(renewed!.hostEpoch);
    expect(await client.store.acknowledgeDelivery(renewed!)).toBe(false);
    expect(await client.store.acknowledgeDelivery(newEpoch!)).toBe(true);
  });

  it('renews the same request after owner replacement without replaying a terminal message', async () => {
    const first = harness(homeDir); const second = harness(homeDir); open.push(first, second);
    await Promise.all([first.runtime.ready(), second.runtime.ready()]);
    const owner = first.runtime.status().role === 'owner' ? first : second;
    const client = owner === first ? second : first;
    await client.store.acceptMessage(acceptInput('owner-recovery'));
    const input = { target, consumerId: 'consumer', leaseMs: 60_000 };
    const options = { requestId: 'same-claim-after-owner-recovery' };
    const prior = await client.store.claimNext(input, options);
    await owner.runtime.close();
    await waitUntil(() => client.runtime.status().role === 'owner');
    expect(await client.store.acknowledgeDelivery(prior!)).toBe(false);
    const recovered = await client.store.claimNext(input, options);
    expect(recovered).toMatchObject({ fence: prior!.fence + 1, message: { messageId: prior!.message.messageId } });
    expect(recovered!.hostEpoch).toBeGreaterThan(prior!.hostEpoch);
    expect(await client.store.acknowledgeDelivery(recovered!)).toBe(true);
    await client.store.acceptMessage(acceptInput('next-message'));
    expect(await client.store.claimNext(input, options)).toBeUndefined();
    expect((await client.store.claimNext(input))?.message.idempotencyKey).toBe('next-message');
  });

  it('records pending targets, activity, overrides, ack, and undeliverable terminal states', async () => {
    const item = harness(homeDir);
    open.push(item);
    const delivered = await item.store.acceptMessage(acceptInput('delivered'));
    const failed = await item.store.acceptMessage(acceptInput('failed'));
    expect(await item.store.listPendingTargets()).toEqual([target]);
    const deliveredClaim = await item.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
    expect(deliveredClaim?.message.messageId).toBe(delivered.message.messageId);
    expect(await item.store.acknowledgeDelivery(deliveredClaim!)).toBe(true);
    const failedClaim = await item.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
    expect(failedClaim?.message.messageId).toBe(failed.message.messageId);
    expect(await item.store.markUndeliverable(failedClaim!, 'not found')).toBe(true);
    expect(await item.store.listPendingTargets()).toEqual([]);
    await closeHarness(item, open);
    const reopened = harness(homeDir);
    open.push(reopened);
    const page1 = await reopened.store.readMessages({ group: `workspace:${source.workspaceId}`, limit: 1 });
    const page2 = await reopened.store.readMessages({ group: `workspace:${source.workspaceId}`, before: page1.nextBefore, limit: 1 });
    expect([...page1.items, ...page2.items]).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: delivered.message, delivery: 'delivered' }),
      expect.objectContaining({ message: failed.message, delivery: 'undeliverable', reason: 'not found' }),
    ]));
    expect(page2.nextBefore).toBeUndefined();
    expect((await reopened.store.readMessages({ group: 'workspace:unrelated', limit: 100 })).items).toEqual([]);
    await closeHarness(reopened, open);
    const current = harness(homeDir);
    open.push(current);

    const baseline = await current.store.readActivity(target, Number.MAX_SAFE_INTEGER, 1);
    const activity = await current.store.appendActivity({ target, kind: 'message_undeliverable', reason: 'not found' });
    expect(await current.store.readActivity(target, baseline.latestSeq, 8)).toMatchObject({
      activities: [expect.objectContaining({ seq: activity.seq, epoch: activity.epoch, kind: activity.kind, reason: activity.reason })],
    });
    expect(await current.store.getWorkspaceOverride(target.workspaceId)).toBeUndefined();
    await current.store.setWorkspaceOverride(target.workspaceId, false);
    expect(await current.store.getWorkspaceOverride(target.workspaceId)).toBe(false);
    await current.store.clearWorkspaceOverride(target.workspaceId);
    expect(await current.store.getWorkspaceOverride(target.workspaceId)).toBeUndefined();
  });

  it('retains delivered peer history beyond 512 messages and pages equal-time messages once', async () => {
    const item = harness(homeDir);
    open.push(item);
    const first = await item.store.acceptMessage(acceptInput('retained-first'));
    const claim = await item.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
    await item.store.acknowledgeDelivery(claim!);
    const accepted = await Promise.all(Array.from({ length: 512 }, (_, index) => item.store.acceptMessage(acceptInput(`retained-${index}`))));
    const expected = [first, ...accepted].map((result) => result.message).toSorted((left, right) =>
      right.acceptedAt - left.acceptedAt || (left.messageId < right.messageId ? 1 : -1));
    const observed: string[] = [];
    let before: string | undefined;
    do {
      const page = await item.store.readMessages({ group: `session:${source.sessionId}`, before, limit: 100 });
      observed.push(...page.items.map((row) => row.message.messageId));
      before = page.nextBefore;
    } while (before !== undefined);
    expect(observed).toEqual(expected.map((message) => message.messageId));
    const retry = await item.store.acceptMessage(acceptInput('retained-first'));
    expect(retry).toMatchObject({ deduplicated: true, delivery: 'delivered', message: { messageId: first.message.messageId } });
  }, 30_000);

  it('requires explicit migration and waits for the legacy writer without creating a mailbox', async () => {
    const lock = await MiniDb.open<Record<string, unknown>>({
      dir: join(homeDir, 'store', 'thread-mailbox-v1'),
      valueCodec: 'json', valueMode: 'memory', fsyncPolicy: 'always', recovery: 'strict',
      indexGenerations: false, activeExpireIntervalMs: 0,
    });
    const item = harness(homeDir); open.push(item);
    const migration = createMailboxMigrationService(homeDir);
    try {
      const startedAt = Date.now();
      await expect(item.store.acceptMessage(acceptInput('locked'))).rejects.toMatchObject({ code: 'mailbox.migration_required' });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(await readMailboxAuthority(homeDir)).toBeUndefined();
      await closeHarness(item, open);
      expect(await migration.migrate()).toMatchObject({ state: 'waiting', phase: 'waiting_for_writers' });
    } finally { await lock.close(); await migration.close(); }
    const resumed = createMailboxMigrationService(homeDir);
    try { expect(await resumed.migrate()).toMatchObject({ state: 'complete', authority: 'sqlite' }); }
    finally { await resumed.close(); }
    const reopened = harness(homeDir); open.push(reopened);
    await expect(reopened.store.acceptMessage(acceptInput('locked'))).resolves.toMatchObject({ deduplicated: false });
  });

  it('keeps the existing runtime idempotency keys for every producer kind', () => {
    const producers: ThreadMessageProducer[] = [
      { kind: 'external_client' },
      { kind: 'peer_thread', source, sender: { sessionId: 'source', personaId: 'example-persona', name: 'Example' }, allowWhenDisabled: false },
      { kind: 'room', roomId: 'example-room', targeted: true, queueWhenBusy: false, requireCommunication: true, generation: 2,
        sender: { sessionId: 'source', personaId: 'example-persona', name: 'Example' } },
      { kind: 'bridged_peer', source, sourceHomeId: 'source-home', targetHomeId: 'target-home', bridgeId: 'example-bridge',
        revision: 1, location: 'local', createdAt: 1, expiresAt: 2, sourceSeq: 3, causeId: 'example-cause', hop: 0 },
    ];
    const partition = mailboxPartition(target);
    for (const producer of producers) {
      const storedProducer = producer.kind === 'bridged_peer' ? { kind: producer.kind, bridgeId: producer.bridgeId,
        sourceHomeId: producer.sourceHomeId, source: producer.source } : producer;
      const digest = createHash('sha256').update(JSON.stringify({ producer: storedProducer, target, key: 'existing-key' })).digest('base64url');
      expect(threadMessageIdempotencyKey(partition, { producer, target, idempotencyKey: 'existing-key' })).toBe(`${partition}/idempotency/${digest}`);
    }
  });

  it.each([
    { label: 'peer defaults', producer: { kind: 'peer_thread', source } },
    { label: 'peer metadata', producer: { allowWhenDisabled: true,
      sender: { name: 'Example sender', sessionId: source.sessionId },
      source: { sessionId: source.sessionId, workspaceId: source.workspaceId, hostId: source.hostId }, kind: 'peer_thread' } },
    { label: 'room metadata', producer: { sender: { name: 'Example sender', sessionId: source.sessionId },
      generation: 1, requireCommunication: true, queueWhenBusy: true, targeted: true, roomId: 'example-room', kind: 'room' } },
  ] satisfies readonly { label: string; producer: ThreadMessageProducer }[])(
    'resumes explicit legacy migration without duplicating messages, history or activity ($label)', async ({ producer }) => {
    const accepted = await seedLegacyMailbox(homeDir, producer);
    const migration = createMailboxMigrationService(homeDir);
    const controller = new AbortController();
    try {
      const stopped = await migration.migrate({ signal: controller.signal, onProgress: (status) => {
        if (status.phase === 'importing' && status.progress.items > 0) controller.abort();
      } });
      expect(stopped.state).toBe('cancelled');
      expect(stopped.progress.items).toBeGreaterThan(0);
      expect(await readMailboxAuthority(homeDir)).toBeUndefined();
      const resumed = await migration.migrate();
      expect(resumed).toMatchObject({ state: 'complete', authority: 'sqlite', migrationId: stopped.migrationId });
      const db = await openMailboxDb(homeDir);
      try { expect(await db.partitionPrefix(mailboxPartition(target), `${mailboxPartition(target)}/peer/`)).toHaveLength(producer.kind === 'room' ? 3 : 5); }
      finally { await db.close(); }
    } finally { await migration.close(); }

    const reopened = harness(homeDir);
    open.push(reopened);
    const input = { ...acceptInput('legacy'), producer };
    const migrated = await reopened.store.acceptMessage(input);
    expect(migrated).toMatchObject({ deduplicated: true, payloadConflict: false, message: accepted });
    expect(await reopened.store.acceptMessage(input)).toEqual(migrated);
    expect(await reopened.store.acceptMessage({ ...input, content: 'changed payload' })).toMatchObject({
      deduplicated: true, payloadConflict: true, message: accepted,
    });
    const claim = await reopened.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
    expect(claim?.message.messageId).toBe(accepted.messageId);
    const page = await reopened.store.readActivity(target, 0, 8);
    expect(page.activities).toHaveLength(1);
    expect((await reopened.store.readMessages({ group: 'all', limit: 100 })).items).toMatchObject([
      { message: { messageId: accepted.messageId, content: accepted.content }, delivery: 'pending' },
    ]);
  });

  it('scans mailbox kinds in bounded pages and resumes a cancelled room after a committed page', async () => {
    const item = harness(homeDir);
    open.push(item);
    const producer = { kind: 'room' as const, roomId: 'example-room' };
    await Promise.all(Array.from({ length: 270 }, (_, index) => item.store.acceptMessage({ producer, target,
      content: `room-${index}`, idempotencyKey: `room-${index}` })));
    const other = { ...target, sessionId: 'second-target' };
    await item.store.acceptMessage({ producer, target: other, content: 'second', idempotencyKey: 'second' });
    const originalPage = CanonicalMailboxDatabase.prototype.page;
    const originalBatch = CanonicalMailboxDatabase.prototype.partitionBatch;
    const scanned: Array<{ prefix: string; limit: number; kind?: string }> = [];
    const controller = new AbortController();
    let stopped = false;
    CanonicalMailboxDatabase.prototype.page = async function (...args: Parameters<typeof originalPage>) {
      if (args[0] === 't/' || args[0].endsWith('/message/')) scanned.push({ prefix: args[0], limit: args[2] ?? 256, kind: args[3] });
      return originalPage.apply(this, args);
    };
    CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
      const result = await originalBatch.apply(this, args);
      if (!stopped && args[1].some((op) => {
        const checkpoint = op.op === 'set' && op.value.kind === 'receipt' ? op.value.result : undefined;
        return typeof checkpoint === 'object' && checkpoint !== null && 'after' in checkpoint &&
          'cancelled' in checkpoint && typeof checkpoint.cancelled === 'number' && checkpoint.cancelled > 0;
      })) { stopped = true; controller.abort(); }
      return result;
    };
    try {
      await expect(item.store.cancelProducer(producer, { requestId: 'paged-room-cancel', signal: controller.signal })).rejects.toBeDefined();
      expect(stopped).toBe(true);
      expect(await item.store.cancelProducer(producer, { requestId: 'paged-room-cancel' })).toBe(271);
      expect(await item.store.cancelProducer(producer, { requestId: 'paged-room-cancel' })).toBe(271);
      expect(await item.store.listPendingTargets()).toEqual([]);
      expect(scanned.filter((entry) => entry.kind === 'message').length).toBeGreaterThan(2);
      expect(scanned.some((entry) => entry.kind === 'target_meta')).toBe(true);
      expect(scanned.every((entry) => entry.limit <= 128 && (entry.kind === 'target_meta' || entry.kind === 'message'))).toBe(true);
      const db = await openMailboxDb(homeDir);
      try {
        expect((await db.verify()).counts['message']).toBe(271);
        expect((await db.partitionGet(mailboxPartition(target), `${mailboxPartition(target)}/meta`))?.['pendingCount']).toBe(0);
      } finally { await db.close(); }
    } finally {
      CanonicalMailboxDatabase.prototype.page = originalPage;
      CanonicalMailboxDatabase.prototype.partitionBatch = originalBatch;
    }
  }, 30_000);

  it('preserves full prefix enumeration for a caller with more than 512 rows', async () => {
    const db = await openMailboxDb(homeDir);
    try {
      const prefix = 'fixture/prefix/';
      await db.partitionBatch('fixture', Array.from({ length: 513 }, (_, index) => ({
        op: 'set' as const,
        key: `${prefix}${index.toString().padStart(4, '0')}`,
        value: { kind: 'fixture', index },
      })));
      const rows = await db.prefix(prefix);
      expect(rows).toHaveLength(513);
      expect(rows[0]?.key).toBe(`${prefix}0000`);
      expect(rows.at(-1)?.key).toBe(`${prefix}0512`);
      expect(await db.partitionPrefix('fixture', prefix)).toHaveLength(513);
    } finally { await db.close(); }
  });

  it('never exposes MiniDb lock failures through the broker', async () => {
    const first = harness(homeDir);
    const second = harness(homeDir);
    open.push(first, second);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first.store : second.store).acceptMessage(acceptInput(`parallel-${index}`)),
      ),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(failures.some((result) => result.reason instanceof LockError)).toBe(false);
    expect(failures).toEqual([]);
    expect(results.map((result) => result.status === 'fulfilled' ? result.value.message.targetSeq : 0).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });
});
