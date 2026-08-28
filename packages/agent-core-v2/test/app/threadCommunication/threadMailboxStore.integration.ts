import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { LockError, MiniDb } from '@moonshot-ai/minidb';
import { ClusterDb } from '@moonshot-ai/minidb/cluster';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import {
  THREAD_MAILBOX_RUNTIME_METHODS,
  RuntimeThreadMailboxStore,
} from '#/app/threadCommunication/runtimeThreadMailboxStore';
import {
  ThreadMailboxBacklogError,
  ThreadMailboxLegacyWriterActiveError,
} from '#/app/threadCommunication/mailboxErrors';
import type { ThreadRef } from '#/app/threadCommunication/threadCommunication';
import type { AcceptedThreadMessage } from '#/app/threadCommunication/threadMailboxStore';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

const source: ThreadRef = { hostId: 'host-a', workspaceId: 'workspace-a', sessionId: 'source' };
const target: ThreadRef = { hostId: 'host-a', workspaceId: 'workspace-b', sessionId: 'target' };
const execFileAsync = promisify(execFile);
const workerFixture = fileURLToPath(new URL('../runtimeHost/fixtures/runtime-mailbox-worker.mts', import.meta.url));

interface Harness {
  readonly runtime: HomeRuntimeHostService;
  readonly store: RuntimeThreadMailboxStore;
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
  const seed = bootstrap(homeDir);
  const runtime = new HomeRuntimeHostService(seed);
  return {
    runtime,
    store: new RuntimeThreadMailboxStore(seed, runtime, new HostFileSystem()),
  };
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

function openMailboxDb(homeDir: string): Promise<ClusterDb<Record<string, unknown>>> {
  return ClusterDb.open<Record<string, unknown>>({
    dir: join(homeDir, 'store', 'thread-mailbox-v3'),
    valueCodec: 'json',
    valueMode: 'memory',
    fsyncPolicy: 'always',
    recovery: 'strict',
    activeExpireIntervalMs: 0,
    lockHoldMs: 0,
    lockPoolMaxShards: 16,
    crossShard: 'none',
  });
}

async function seedLegacyMailbox(homeDir: string): Promise<AcceptedThreadMessage> {
  const message: AcceptedThreadMessage = {
    ...acceptInput('legacy'),
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
  const original = ClusterDb.prototype.partitionBatch;
  let markEntered!: () => void;
  let releaseBatch!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  let count = 0;
  ClusterDb.prototype.partitionBatch = async function (...args: Parameters<typeof original>) {
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
      ClusterDb.prototype.partitionBatch = original;
    },
    count: () => count,
  };
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

  it('uses one real cross-process owner and produces no MiniDb LockError', async () => {
    const outputs = await Promise.all(
      Array.from({ length: 3 }, async (_, writer) => {
        const result = await execFileAsync(
          process.execPath,
          ['--import', 'tsx', workerFixture, homeDir, String(writer), '5'],
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

  it('enqueues beyond the legacy pending limit and rejects only at the hard guard', async () => {
    const item = harness(homeDir);
    open.push(item);
    const results = await Promise.all(
      Array.from({ length: 513 }, (_, index) => item.store.acceptMessage({
        ...acceptInput(`capacity-${index}`),
        pendingLimit: 3,
      })),
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
    const originalPrefix = ClusterDb.prototype.partitionPrefix;
    const originalBatch = ClusterDb.prototype.partitionBatch;
    const claimed: number[] = [];
    const heads: number[] = [];
    let messageScans = 0;
    ClusterDb.prototype.partitionPrefix = async function (...args: Parameters<typeof originalPrefix>) {
      if (args[1].endsWith('/message/')) messageScans++;
      return originalPrefix.apply(this, args);
    };
    ClusterDb.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
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
      ClusterDb.prototype.partitionPrefix = originalPrefix;
      ClusterDb.prototype.partitionBatch = originalBatch;
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
    const originalPrefix = ClusterDb.prototype.partitionPrefix;
    let messageScans = 0;
    ClusterDb.prototype.partitionPrefix = async function (...args: Parameters<typeof originalPrefix>) {
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
      ClusterDb.prototype.partitionPrefix = originalPrefix;
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
    const originalPrefix = ClusterDb.prototype.partitionPrefix;
    const originalBatch = ClusterDb.prototype.partitionBatch;
    let repairedHead: number | undefined;
    let messageScans = 0;
    ClusterDb.prototype.partitionPrefix = async function (...args: Parameters<typeof originalPrefix>) {
      if (args[1].endsWith('/message/')) messageScans++;
      return originalPrefix.apply(this, args);
    };
    ClusterDb.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
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
      ClusterDb.prototype.partitionPrefix = originalPrefix;
      ClusterDb.prototype.partitionBatch = originalBatch;
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
    const originalPrefix = ClusterDb.prototype.partitionPrefix;
    const originalBatch = ClusterDb.prototype.partitionBatch;
    let repairedHead: number | undefined;
    let messageScans = 0;
    ClusterDb.prototype.partitionPrefix = async function (...args: Parameters<typeof originalPrefix>) {
      if (args[1].endsWith('/message/')) messageScans++;
      return originalPrefix.apply(this, args);
    };
    ClusterDb.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
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
      ClusterDb.prototype.partitionPrefix = originalPrefix;
      ClusterDb.prototype.partitionBatch = originalBatch;
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
    const originalPrefix = ClusterDb.prototype.partitionPrefix;
    const originalBatch = ClusterDb.prototype.partitionBatch;
    let persistedHead: number | undefined;
    let messageScans = 0;
    ClusterDb.prototype.partitionPrefix = async function (...args: Parameters<typeof originalPrefix>) {
      if (args[1].endsWith('/message/')) messageScans++;
      return originalPrefix.apply(this, args);
    };
    ClusterDb.prototype.partitionBatch = async function (...args: Parameters<typeof originalBatch>) {
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
      ClusterDb.prototype.partitionPrefix = originalPrefix;
      ClusterDb.prototype.partitionBatch = originalBatch;
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

    const baseline = await item.store.readActivity(target, Number.MAX_SAFE_INTEGER, 1);
    const activity = await item.store.appendActivity({ target, kind: 'message_undeliverable', reason: 'not found' });
    expect(await item.store.readActivity(target, baseline.latestSeq, 8)).toMatchObject({
      activities: [expect.objectContaining({ seq: activity.seq, epoch: activity.epoch, kind: activity.kind, reason: activity.reason })],
    });
    expect(await item.store.getWorkspaceOverride(target.workspaceId)).toBeUndefined();
    await item.store.setWorkspaceOverride(target.workspaceId, false);
    expect(await item.store.getWorkspaceOverride(target.workspaceId)).toBe(false);
    await item.store.clearWorkspaceOverride(target.workspaceId);
    expect(await item.store.getWorkspaceOverride(target.workspaceId)).toBeUndefined();
  });

  it('returns a stable path-free legacy-writer error immediately and retries initialization', async () => {
    const legacyDir = join(homeDir, 'store', 'thread-mailbox-v1');
    const lock = await MiniDb.open<Record<string, unknown>>({
      dir: legacyDir,
      valueCodec: 'json',
      valueMode: 'memory',
      fsyncPolicy: 'always',
      recovery: 'strict',
      indexGenerations: false,
      activeExpireIntervalMs: 0,
    });
    const item = harness(homeDir);
    open.push(item);
    const startedAt = Date.now();
    const failure = await item.store.acceptMessage(acceptInput('locked')).catch((error: unknown) => error);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(failure).toBeInstanceOf(ThreadMailboxLegacyWriterActiveError);
    expect(failure).toMatchObject({ code: 'mailbox.legacy_writer_active' });
    expect(String((failure as Error).message)).not.toContain(homeDir);
    await lock.close();
    await expect(item.store.acceptMessage(acceptInput('locked'))).resolves.toMatchObject({ deduplicated: false });
  });

  it('reopens an interrupted one-time legacy migration without duplicating records', async () => {
    const accepted = await seedLegacyMailbox(homeDir);
    const original = ClusterDb.prototype.partitionBatch;
    let interrupted = false;
    ClusterDb.prototype.partitionBatch = async function (...args: Parameters<typeof original>) {
      const [partition, operations] = args;
      if (
        !interrupted &&
        partition === 's/thread-mailbox-v3' &&
        operations.some((operation) => operation.op === 'set' && operation.key.endsWith('/migration'))
      ) {
        interrupted = true;
        throw new Error('migration interrupted');
      }
      return original.apply(this, args);
    };
    const first = harness(homeDir);
    open.push(first);
    await expect(first.store.acceptMessage(acceptInput('legacy'))).rejects.toThrow('migration interrupted');
    ClusterDb.prototype.partitionBatch = original;
    await first.store.close();
    await first.runtime.close();
    open.splice(open.indexOf(first), 1);

    const reopened = harness(homeDir);
    open.push(reopened);
    const migrated = await reopened.store.acceptMessage(acceptInput('legacy'));
    expect(migrated).toMatchObject({
      deduplicated: true,
      message: { messageId: accepted.messageId },
    });
    const claim = await reopened.store.claimNext({ target, consumerId: 'consumer', leaseMs: 10_000 });
    expect(claim?.message.messageId).toBe(accepted.messageId);
    const page = await reopened.store.readActivity(target, 0, 8);
    expect(page.activities).toHaveLength(1);
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
