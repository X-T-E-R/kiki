import { createHash, randomUUID } from 'node:crypto';

import { LockError, MiniDb, type BatchInputOp } from '@moonshot-ai/minidb';
import { ClusterDb } from '@moonshot-ai/minidb/cluster';
import { join } from 'pathe';

import type { IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import { IHomeRuntimeService } from '#/app/runtimeHost/runtimeHost';
import type { RuntimeMethodContext, RuntimeRole } from '#/app/runtimeHost/messages';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import {
  ThreadActivityCursorExpiredError,
  ThreadMailboxBacklogError,
  ThreadMailboxLegacyWriterActiveError,
} from './mailboxErrors';
import type { ThreadActivityKind, ThreadRef } from './threadCommunication';
import {
  IThreadMailboxStore,
  type AcceptedThreadMessage,
  type StoredThreadActivity,
  type ThreadActivityPage,
  type ThreadDeliveryClaim,
  type ThreadMailboxMutationOptions,
  type ThreadMessageAcceptance,
  type ThreadMessageProducer,
} from './threadMailboxStore';

const STORE_DIR = 'thread-mailbox-v3';
const SHARD_COUNT = 16;
const MESSAGE_RETAINED_LIMIT = 512;
const PENDING_HARD_LIMIT = 100_000;
const ACTIVITY_RETAINED_LIMIT = 256;
const MAX_DELIVERY_LEASE_MS = 600_000;
const DELIVERY_HEAD_REPAIR_STEP_LIMIT = 32;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CALL_TIMEOUT_MS = 10_000;
const STARTUP_CALL_TIMEOUT_MS = 20_000;
const LEGACY_THREAD_DIR = 'thread-mailbox-v1';
const LEGACY_AGENT_DIR = 'agent-collaboration-mailbox-v2';
const SYSTEM_PARTITION = 's/thread-mailbox-v3';
const MIGRATION_MARKER_KEY = `${SYSTEM_PARTITION}/migration`;
const ACTIVE_BACKEND_KEY = `${SYSTEM_PARTITION}/active-backend`;
const METHOD_PREFIX = 'threadMailbox.v3';
const ACCEPT_MICROBATCH_LIMIT = 32;

export const THREAD_MAILBOX_RUNTIME_METHODS = {
  accept: `${METHOD_PREFIX}.accept`,
  claim: `${METHOD_PREFIX}.claim`,
  acknowledge: `${METHOD_PREFIX}.acknowledge`,
  undeliverable: `${METHOD_PREFIX}.undeliverable`,
  pendingTargets: `${METHOD_PREFIX}.pendingTargets`,
  appendActivity: `${METHOD_PREFIX}.appendActivity`,
  readActivity: `${METHOD_PREFIX}.readActivity`,
  getWorkspaceOverride: `${METHOD_PREFIX}.getWorkspaceOverride`,
  setWorkspaceOverride: `${METHOD_PREFIX}.setWorkspaceOverride`,
  clearWorkspaceOverride: `${METHOD_PREFIX}.clearWorkspaceOverride`,
} as const;

type RuntimeMethodName = typeof THREAD_MAILBOX_RUNTIME_METHODS[keyof typeof THREAD_MAILBOX_RUNTIME_METHODS];

type DeliveryState = 'pending' | 'delivering' | 'delivered' | 'undeliverable';

interface TargetMetaDoc {
  readonly kind: 'target_meta';
  readonly target: ThreadRef;
  readonly nextMessageSeq: number;
  readonly nextDeliverableSeq: number;
  readonly pendingCount: number;
  readonly activityEpoch: string;
  readonly nextActivitySeq: number;
  readonly minActivitySeq: number;
}

interface MessageDoc {
  readonly kind: 'message';
  readonly message: AcceptedThreadMessage;
  readonly idempotencyStorageKey: string;
  readonly payloadHash: string;
  readonly state: DeliveryState;
  readonly fence: number;
  readonly claim?: ThreadDeliveryClaim;
  readonly terminalClaim?: ThreadDeliveryClaim;
  readonly reason?: string;
}

interface IdempotencyDoc {
  readonly kind: 'idempotency';
  readonly producer: ThreadMessageProducer;
  readonly target: ThreadRef;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly messageKey: string;
}

interface ActivityDoc {
  readonly kind: 'activity';
  readonly target: ThreadRef;
  readonly activity: StoredThreadActivity;
  readonly legacyIdentity?: string;
}

interface WorkspaceOverrideDoc {
  readonly kind: 'workspace_override';
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

interface ReceiptDoc {
  readonly kind: 'receipt';
  readonly method: RuntimeMethodName;
  readonly requestId: string;
  readonly callerHostId: string;
  readonly epoch: number;
  readonly payloadHash: string;
  readonly result: unknown;
}

interface MigrationMarkerDoc {
  readonly kind: 'migration_marker';
  readonly version: 3;
  readonly migratedAt: number;
}

interface ActiveBackendDoc {
  readonly kind: 'active_backend';
  readonly version: 3;
  readonly ownerEpoch: number;
  readonly readyAt: number;
}

type StoredDoc =
  | TargetMetaDoc
  | MessageDoc
  | IdempotencyDoc
  | ActivityDoc
  | WorkspaceOverrideDoc
  | ReceiptDoc
  | MigrationMarkerDoc
  | ActiveBackendDoc;

interface AcceptPayload {
  readonly producer: ThreadMessageProducer;
  readonly target: ThreadRef;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly pendingLimit?: number;
}

interface ClaimPayload {
  readonly target: ThreadRef;
  readonly consumerId: string;
  readonly leaseMs: number;
}

interface UndeliverablePayload {
  readonly claim: ThreadDeliveryClaim;
  readonly reason: string;
}

interface ActivityPayload {
  readonly target: ThreadRef;
  readonly kind: ThreadActivityKind;
  readonly reason: string;
  readonly turnId?: number;
  readonly messageId?: string;
}

interface ReadActivityPayload {
  readonly target: ThreadRef;
  readonly afterSeq: number;
  readonly limit: number;
}

interface WorkspaceOverridePayload {
  readonly workspaceId: string;
  readonly enabled?: boolean;
}

interface LegacyDelivery {
  readonly message: AcceptedThreadMessage;
  readonly state: DeliveryState;
  readonly attempt: number;
}

interface LegacyActivityMeta {
  readonly target: ThreadRef;
  readonly epoch: string;
  readonly nextSeq: number;
  readonly minSeq: number;
}

interface LegacySnapshot {
  readonly deliveries: readonly LegacyDelivery[];
  readonly activityMeta: readonly LegacyActivityMeta[];
  readonly activities: readonly { readonly target: ThreadRef; readonly activity: StoredThreadActivity }[];
  readonly overrides: readonly WorkspaceOverrideDoc[];
}

type AcceptRpcResult =
  | { readonly ok: true; readonly value: ThreadMessageAcceptance }
  | { readonly ok: false; readonly error: 'backlog'; readonly limit: number };

type ReadActivityRpcResult =
  | { readonly ok: true; readonly value: ThreadActivityPage }
  | {
      readonly ok: false;
      readonly error: 'cursor_expired';
      readonly epoch: string;
      readonly minSeq: number;
      readonly latestSeq: number;
    };

interface PartitionOperation {
  readonly kind: 'operation';
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface AcceptPartitionOperation {
  readonly kind: 'accept';
  readonly input: AcceptPayload;
  readonly ctx: RuntimeMethodContext;
  readonly resolve: (value: ThreadMessageAcceptance) => void;
  readonly reject: (error: unknown) => void;
}

type PartitionQueueOperation = PartitionOperation | AcceptPartitionOperation;

interface PartitionQueue {
  readonly operations: PartitionQueueOperation[];
  running: boolean;
}

interface AcceptPlan {
  readonly result: ThreadMessageAcceptance;
  readonly ops: readonly BatchInputOp<StoredDoc>[];
}

export class RuntimeThreadMailboxStore implements IThreadMailboxStore {
  declare readonly _serviceBrand: undefined;

  private readonly storeDir: string;
  private readonly legacyDirs: readonly string[];
  private readonly registrations: IDisposable[];
  private readonly partitionQueues = new Map<string, PartitionQueue>();
  private readonly ownerOperations = new Map<Promise<unknown>, number>();
  private readonly quarantine: MiniDb<Record<string, unknown>>[] = [];
  private readonly closeController = new AbortController();
  private db: ClusterDb<StoredDoc> | undefined;
  private ownerEpoch = 0;
  private observedRuntimeRole: RuntimeRole = 'idle';
  private observedRuntimeEpoch = 0;
  private ownerReleaseFlight: Promise<void> = Promise.resolve();
  private readonly ownerReleaseErrors: unknown[] = [];
  private initialization: { readonly epoch: number; readonly promise: Promise<void> } | undefined;
  private closing = false;
  private closeFlight: Promise<void> | undefined;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IHomeRuntimeService private readonly runtime: IHomeRuntimeService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {
    this.storeDir = join(bootstrap.storeDir, STORE_DIR);
    this.legacyDirs = [
      join(bootstrap.storeDir, LEGACY_THREAD_DIR),
      join(bootstrap.storeDir, LEGACY_AGENT_DIR),
    ];
    this.registrations = [
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.accept, async (payload, ctx): Promise<AcceptRpcResult> => {
        try {
          return { ok: true, value: await this.acceptOwner(assertAcceptPayload(payload), ctx) };
        } catch (error) {
          if (error instanceof ThreadMailboxBacklogError) return { ok: false, error: 'backlog', limit: error.limit };
          throw error;
        }
      }),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.claim, (payload, ctx) =>
        this.claimOwner(assertClaimPayload(payload, MAX_DELIVERY_LEASE_MS), ctx)),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.acknowledge, (payload, ctx) => this.finishOwner(assertClaim(payload), 'delivered', undefined, ctx)),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.undeliverable, (payload, ctx) => {
        const input = assertUndeliverablePayload(payload);
        return this.finishOwner(input.claim, 'undeliverable', input.reason, ctx);
      }),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.pendingTargets, (_payload, ctx) => this.pendingTargetsOwner(ctx)),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.appendActivity, (payload, ctx) => this.appendActivityOwner(assertActivityPayload(payload), ctx)),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.readActivity, async (payload, ctx): Promise<ReadActivityRpcResult> => {
        try {
          return { ok: true, value: await this.readActivityOwner(assertReadActivityPayload(payload), ctx) };
        } catch (error) {
          if (error instanceof ThreadActivityCursorExpiredError) {
            return {
              ok: false,
              error: 'cursor_expired',
              epoch: error.epoch,
              minSeq: error.minSeq,
              latestSeq: error.latestSeq,
            };
          }
          throw error;
        }
      }),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.getWorkspaceOverride, (payload, ctx) => this.getWorkspaceOverrideOwner(assertWorkspacePayload(payload).workspaceId, ctx)),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.setWorkspaceOverride, (payload, ctx) => {
        const input = assertWorkspacePayload(payload, true);
        return this.setWorkspaceOverrideOwner(input.workspaceId, input.enabled!, ctx);
      }),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.clearWorkspaceOverride, (payload, ctx) => this.clearWorkspaceOverrideOwner(assertWorkspacePayload(payload).workspaceId, ctx)),
    ];
    const runtimeStatus = this.runtime.status();
    this.observedRuntimeRole = runtimeStatus.role;
    this.observedRuntimeEpoch = runtimeStatus.epoch;
    this.registrations.push(this.runtime.onDidChangeRoleStatus((status) => {
      const priorRole = this.observedRuntimeRole;
      const priorEpoch = this.observedRuntimeEpoch;
      const leftOwner = priorRole === 'owner' && (
        status.role !== 'owner' || status.epoch !== priorEpoch
      );
      this.observedRuntimeRole = status.role;
      this.observedRuntimeEpoch = status.epoch;
      if (leftOwner) void this.queueOwnerRelease(priorEpoch);
    }));
  }

  async acceptMessage(
    input: AcceptPayload,
    options?: ThreadMailboxMutationOptions,
  ): Promise<ThreadMessageAcceptance> {
    const result = await this.call(THREAD_MAILBOX_RUNTIME_METHODS.accept, input, options) as AcceptRpcResult;
    if (!result.ok) throw new ThreadMailboxBacklogError(result.limit);
    return result.value;
  }

  claimNext(
    input: ClaimPayload,
    options?: ThreadMailboxMutationOptions,
  ): Promise<ThreadDeliveryClaim | undefined> {
    return this.call(THREAD_MAILBOX_RUNTIME_METHODS.claim, input, options)
      .then((value) => value === null ? undefined : value as ThreadDeliveryClaim);
  }

  acknowledgeDelivery(
    claim: ThreadDeliveryClaim,
    options?: ThreadMailboxMutationOptions,
  ): Promise<boolean> {
    return this.call(THREAD_MAILBOX_RUNTIME_METHODS.acknowledge, claim, options) as Promise<boolean>;
  }

  markUndeliverable(
    claim: ThreadDeliveryClaim,
    reason: string,
    options?: ThreadMailboxMutationOptions,
  ): Promise<boolean> {
    return this.call(
      THREAD_MAILBOX_RUNTIME_METHODS.undeliverable,
      { claim, reason },
      options,
    ) as Promise<boolean>;
  }

  listPendingTargets(options?: ThreadMailboxMutationOptions): Promise<readonly ThreadRef[]> {
    return this.call(
      THREAD_MAILBOX_RUNTIME_METHODS.pendingTargets,
      null,
      options,
      STARTUP_CALL_TIMEOUT_MS,
    ) as Promise<readonly ThreadRef[]>;
  }

  appendActivity(
    input: ActivityPayload,
    options?: ThreadMailboxMutationOptions,
  ): Promise<StoredThreadActivity> {
    return this.call(THREAD_MAILBOX_RUNTIME_METHODS.appendActivity, input, options) as Promise<StoredThreadActivity>;
  }

  async readActivity(
    target: ThreadRef,
    afterSeq: number,
    limit: number,
    options?: ThreadMailboxMutationOptions,
  ): Promise<ThreadActivityPage> {
    const result = await this.call(
      THREAD_MAILBOX_RUNTIME_METHODS.readActivity,
      { target, afterSeq, limit },
      options,
    ) as ReadActivityRpcResult;
    if (!result.ok) {
      throw new ThreadActivityCursorExpiredError(result.epoch, result.minSeq, result.latestSeq);
    }
    return result.value;
  }

  getWorkspaceOverride(
    workspaceId: string,
    options?: ThreadMailboxMutationOptions,
  ): Promise<boolean | undefined> {
    return this.call(THREAD_MAILBOX_RUNTIME_METHODS.getWorkspaceOverride, { workspaceId }, options)
      .then((value) => value === null ? undefined : value as boolean);
  }

  setWorkspaceOverride(
    workspaceId: string,
    enabled: boolean,
    options?: ThreadMailboxMutationOptions,
  ): Promise<void> {
    return this.call(
      THREAD_MAILBOX_RUNTIME_METHODS.setWorkspaceOverride,
      { workspaceId, enabled },
      options,
    ).then(() => {});
  }

  clearWorkspaceOverride(
    workspaceId: string,
    options?: ThreadMailboxMutationOptions,
  ): Promise<void> {
    return this.call(
      THREAD_MAILBOX_RUNTIME_METHODS.clearWorkspaceOverride,
      { workspaceId },
      options,
    ).then(() => {});
  }

  close(): Promise<void> {
    this.closeFlight ??= this.doClose();
    return this.closeFlight;
  }

  private register(name: RuntimeMethodName, handler: (payload: unknown, ctx: RuntimeMethodContext) => Promise<unknown>): IDisposable {
    return this.runtime.registerMethod(name, (payload, ctx) => this.trackOwnerOperation(ctx, () => handler(payload, ctx)));
  }

  private trackOwnerOperation(ctx: RuntimeMethodContext, run: () => Promise<unknown>): Promise<unknown> {
    const status = this.runtime.status();
    if (status.role !== 'owner' || status.epoch !== ctx.epoch) {
      return Promise.reject(new HomeRuntimeError('runtime.owner_gone', 'runtime owner epoch is no longer active'));
    }
    const operation = Promise.resolve().then(run);
    this.ownerOperations.set(operation, ctx.epoch);
    void operation.finally(() => this.ownerOperations.delete(operation)).catch(() => {});
    return operation;
  }

  private async call(
    method: RuntimeMethodName,
    payload: unknown,
    options?: ThreadMailboxMutationOptions,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closing) throw new Error('Thread mailbox store is closed.');
    const requestId = options?.requestId ?? randomUUID();
    const signal = combineAbortSignals(this.closeController.signal, options?.signal);
    const invoke = async (): Promise<unknown> => {
      throwIfAborted(signal);
      await abortable(this.runtime.ready(), signal);
      return this.runtime.call(method, payload, { requestId, timeoutMs, signal });
    };
    try {
      return await invoke();
    } catch (error) {
      if (signal.aborted || !isAmbiguousRuntimeResponse(error)) throw error;
      return invoke();
    }
  }

  private async readyOwner(ctx: RuntimeMethodContext): Promise<ClusterDb<StoredDoc>> {
    throwIfAborted(ctx.signal);
    for (;;) {
      await abortable(this.ownerReleaseFlight, ctx.signal);
      if (this.closing) throw new Error('Thread mailbox store is closed.');
      this.assertOwnerContext(ctx);
      if (this.db !== undefined && this.ownerEpoch === ctx.epoch) return this.db;
      const current = this.initialization;
      if (current !== undefined) {
        try {
          await current.promise;
        } catch (error) {
          if (current.epoch === ctx.epoch) throw error;
        }
        throwIfAborted(ctx.signal);
        continue;
      }
      const promise = this.initializeOwner(ctx);
      const flight = { epoch: ctx.epoch, promise };
      this.initialization = flight;
      try {
        await promise;
      } finally {
        if (this.initialization === flight) this.initialization = undefined;
      }
      throwIfAborted(ctx.signal);
    }
  }

  private assertOwnerContext(ctx: RuntimeMethodContext): void {
    const status = this.runtime.status();
    if (status.role !== 'owner' || status.epoch !== ctx.epoch) {
      throw new HomeRuntimeError('runtime.owner_gone', 'runtime owner epoch is no longer active');
    }
  }

  private async initializeOwner(ctx: RuntimeMethodContext): Promise<void> {
    if (this.closing) throw new Error('Thread mailbox store is closed.');
    throwIfAborted(ctx.signal);
    this.assertOwnerContext(ctx);
    const epoch = ctx.epoch;
    if (this.db === undefined) {
      const openedQuarantine: MiniDb<Record<string, unknown>>[] = [];
      let openedDb: ClusterDb<StoredDoc> | undefined;
      try {
        const existingTopology = await this.hasPersistedTopology();
        openedDb = await ClusterDb.open<StoredDoc>({
          dir: this.storeDir,
          shardCount: existingTopology ? undefined : SHARD_COUNT,
          valueCodec: 'json',
          valueMode: 'memory',
          fsyncPolicy: 'always',
          recovery: 'strict',
          activeExpireIntervalMs: 0,
          lockHoldMs: 0,
          lockPoolMaxShards: SHARD_COUNT,
          crossShard: 'none',
        });
        for (const dir of this.legacyDirs) {
          const legacy = await this.openLegacyQuarantine(dir, ctx);
          if (legacy !== undefined) openedQuarantine.push(legacy);
        }
        const marker = asMigrationMarker(await openedDb.partitionGet(SYSTEM_PARTITION, MIGRATION_MARKER_KEY));
        if (marker === undefined) {
          const snapshots = openedQuarantine.map((legacy) => readLegacySnapshot(legacy));
          await this.migrate(openedDb, snapshots);
          await openedDb.partitionBatch(SYSTEM_PARTITION, [
            {
              op: 'set',
              key: MIGRATION_MARKER_KEY,
              value: { kind: 'migration_marker', version: 3, migratedAt: Date.now() },
            },
            {
              op: 'set',
              key: ACTIVE_BACKEND_KEY,
              value: { kind: 'active_backend', version: 3, ownerEpoch: epoch, readyAt: Date.now() },
            },
          ]);
        } else {
          await openedDb.partitionBatch(SYSTEM_PARTITION, [{
            op: 'set',
            key: ACTIVE_BACKEND_KEY,
            value: { kind: 'active_backend', version: 3, ownerEpoch: epoch, readyAt: Date.now() },
          }]);
        }
        this.db = openedDb;
        this.quarantine.push(...openedQuarantine);
      } catch (error) {
        await Promise.allSettled(openedQuarantine.map((legacy) => legacy.close()));
        await openedDb?.close().catch(() => {});
        throw error;
      }
    } else {
      await this.db.partitionBatch(SYSTEM_PARTITION, [{
        op: 'set',
        key: ACTIVE_BACKEND_KEY,
        value: { kind: 'active_backend', version: 3, ownerEpoch: epoch, readyAt: Date.now() },
      }]);
    }
    this.ownerEpoch = epoch;
  }

  private async hasPersistedTopology(): Promise<boolean> {
    try {
      const stat = await this.fs.stat(join(this.storeDir, 'cluster.meta.json'));
      return !stat.isDirectory;
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code;
      if (code === 'ENOENT' || code === 'os.fs.not_found') return false;
      throw error;
    }
  }

  private async openLegacyQuarantine(
    dir: string,
    ctx: RuntimeMethodContext,
  ): Promise<MiniDb<Record<string, unknown>> | undefined> {
    try {
      const stat = await this.fs.stat(dir);
      if (!stat.isDirectory) return undefined;
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code;
      if (code === 'ENOENT' || code === 'os.fs.not_found') return undefined;
      throw error;
    }
    throwIfAborted(ctx.signal);
    this.assertOwnerContext(ctx);
    try {
      return await MiniDb.open<Record<string, unknown>>({
        dir,
        valueCodec: 'json',
        valueMode: 'memory',
        fsyncPolicy: 'always',
        recovery: 'strict',
        indexGenerations: false,
        activeExpireIntervalMs: 0,
      });
    } catch (error) {
      if (error instanceof LockError) throw new ThreadMailboxLegacyWriterActiveError();
      throw error;
    }
  }

  private acceptOwner(input: AcceptPayload, ctx: RuntimeMethodContext): Promise<ThreadMessageAcceptance> {
    const partition = targetPartition(input.target);
    return new Promise<ThreadMessageAcceptance>((resolve, reject) => {
      this.enqueuePartitionOperation(partition, { kind: 'accept', input, ctx, resolve, reject });
    });
  }

  private async claimOwner(input: ClaimPayload, ctx: RuntimeMethodContext): Promise<ThreadDeliveryClaim | null> {
    const partition = targetPartition(input.target);
    return this.withPartition(partition, async () => {
      const db = await this.readyOwner(ctx);
      const method = THREAD_MAILBOX_RUNTIME_METHODS.claim;
      const receiptKey = requestReceiptKey(partition, method, ctx);
      const receipt = readReceipt(await db.partitionGet(partition, receiptKey), receiptKey, method, ctx, input);
      if (receipt !== undefined) return receipt.result as ThreadDeliveryClaim | null;
      const metaKey = targetMetaKey(partition);
      const storedMeta = asTargetMeta(await db.partitionGet(partition, metaKey));
      const meta = storedMeta ?? newTargetMeta(input.target);
      assertThreadIdentity(meta.target, input.target, metaKey);
      const head = await this.resolveDeliveryHead(
        db,
        partition,
        input.target,
        meta,
        finitePositiveInteger(meta.nextDeliverableSeq),
        1,
      );
      const metaChanged = storedMeta === undefined || meta.nextDeliverableSeq !== head.seq;
      const now = Date.now();
      if (
        head.message === undefined ||
        (
          head.message.state === 'delivering' &&
          head.message.claim !== undefined &&
          head.message.claim.hostEpoch === ctx.epoch &&
          head.message.claim.leaseUntil > now
        )
      ) {
        const ops: BatchInputOp<StoredDoc>[] = [this.receiptOp(receiptKey, method, ctx, input, null)];
        if (metaChanged) ops.unshift({ op: 'set', key: metaKey, value: { ...meta, nextDeliverableSeq: head.seq } });
        await db.partitionBatch(partition, ops);
        return null;
      }
      const claim: ThreadDeliveryClaim = {
        message: head.message.message,
        consumerId: input.consumerId,
        fence: head.message.fence + 1,
        leaseUntil: now + input.leaseMs,
        hostEpoch: ctx.epoch,
      };
      const ops: BatchInputOp<StoredDoc>[] = [
        {
          op: 'set',
          key: head.key!,
          value: { ...head.message, state: 'delivering', fence: claim.fence, claim },
        },
        this.receiptOp(receiptKey, method, ctx, input, claim),
      ];
      if (metaChanged) ops.unshift({ op: 'set', key: metaKey, value: { ...meta, nextDeliverableSeq: head.seq } });
      await db.partitionBatch(partition, ops);
      return claim;
    });
  }

  private async finishOwner(
    claim: ThreadDeliveryClaim,
    state: 'delivered' | 'undeliverable',
    reason: string | undefined,
    ctx: RuntimeMethodContext,
  ): Promise<boolean> {
    const method = state === 'delivered'
      ? THREAD_MAILBOX_RUNTIME_METHODS.acknowledge
      : THREAD_MAILBOX_RUNTIME_METHODS.undeliverable;
    const partition = targetPartition(claim.message.target);
    const input = state === 'delivered' ? claim : { claim, reason };
    return this.withPartition(partition, async () => {
      const db = await this.readyOwner(ctx);
      const receiptKey = requestReceiptKey(partition, method, ctx);
      const receipt = readReceipt(await db.partitionGet(partition, receiptKey), receiptKey, method, ctx, input);
      if (receipt !== undefined) return receipt.result as boolean;
      const key = targetMessageKey(partition, claim.message.targetSeq);
      const delivery = asMessage(await db.partitionGet(partition, key));
      let changed = false;
      let next = delivery;
      if (delivery !== undefined && sameMessage(delivery.message, claim.message)) {
        if (delivery.state === state && delivery.terminalClaim !== undefined && sameClaim(delivery.terminalClaim, claim)) {
          changed = true;
        } else if (delivery.state === 'delivering' && delivery.claim !== undefined && sameClaim(delivery.claim, claim)) {
          next = {
            ...delivery,
            state,
            claim: undefined,
            terminalClaim: claim,
            reason,
          };
          changed = true;
        }
      }
      const ops: BatchInputOp<StoredDoc>[] = [this.receiptOp(receiptKey, method, ctx, input, changed)];
      if (changed && next !== delivery && delivery !== undefined) {
        const metaKey = targetMetaKey(partition);
        const meta = asTargetMeta(await db.partitionGet(partition, metaKey));
        if (meta === undefined) throw new Error(`Thread mailbox metadata is missing at "${metaKey}".`);
        let nextDeliverableSeq = finitePositiveInteger(meta.nextDeliverableSeq);
        if (nextDeliverableSeq !== claim.message.targetSeq) {
          nextDeliverableSeq = (await this.resolveDeliveryHead(
            db,
            partition,
            claim.message.target,
            meta,
            nextDeliverableSeq,
            1,
          )).seq;
        }
        if (nextDeliverableSeq === claim.message.targetSeq) {
          nextDeliverableSeq = (await this.resolveDeliveryHead(
            db,
            partition,
            claim.message.target,
            meta,
            claim.message.targetSeq + 1,
            claim.message.targetSeq + 1,
          )).seq;
        }
        ops.unshift(
          { op: 'set', key, value: next! },
          {
            op: 'set',
            key: metaKey,
            value: {
              ...meta,
              nextDeliverableSeq,
              pendingCount: Math.max(0, meta.pendingCount - 1),
            },
          },
        );
      }
      await db.partitionBatch(partition, ops);
      return changed;
    });
  }

  private async resolveDeliveryHead(
    db: ClusterDb<StoredDoc>,
    partition: string,
    target: ThreadRef,
    meta: TargetMetaDoc,
    startSeq: number | undefined,
    fallbackMinSeq: number,
  ): Promise<{ readonly seq: number; readonly key?: string; readonly message?: MessageDoc }> {
    if (startSeq === undefined || startSeq < fallbackMinSeq || startSeq > meta.nextMessageSeq) {
      return this.scanDeliveryHead(db, partition, target, meta.nextMessageSeq, fallbackMinSeq);
    }
    let seq = startSeq;
    let steps = 0;
    while (seq < meta.nextMessageSeq && steps < DELIVERY_HEAD_REPAIR_STEP_LIMIT) {
      const key = targetMessageKey(partition, seq);
      const message = asMessage(await db.partitionGet(partition, key));
      if (message !== undefined) {
        assertThreadIdentity(message.message.target, target, key);
        if (!isTerminalState(message.state)) return { seq, key, message };
      }
      seq++;
      steps++;
    }
    if (seq >= meta.nextMessageSeq) return { seq: meta.nextMessageSeq };
    return this.scanDeliveryHead(db, partition, target, meta.nextMessageSeq, fallbackMinSeq);
  }

  private async scanDeliveryHead(
    db: ClusterDb<StoredDoc>,
    partition: string,
    target: ThreadRef,
    nextMessageSeq: number,
    minSeq: number,
  ): Promise<{ readonly seq: number; readonly key?: string; readonly message?: MessageDoc }> {
    let selected: { readonly seq: number; readonly key: string; readonly message: MessageDoc } | undefined;
    const entries = await db.partitionPrefix(partition, targetMessagePrefix(partition));
    for (const entry of entries) {
      const message = asMessage(entry.value);
      if (message === undefined || isTerminalState(message.state)) continue;
      assertThreadIdentity(message.message.target, target, entry.key);
      const seq = message.message.targetSeq;
      if (seq < minSeq || seq >= nextMessageSeq || selected !== undefined && selected.seq <= seq) continue;
      selected = { seq, key: entry.key, message };
    }
    return selected ?? { seq: nextMessageSeq };
  }

  private async pendingTargetsOwner(ctx: RuntimeMethodContext): Promise<readonly ThreadRef[]> {
    const db = await this.readyOwner(ctx);
    const entries = await db.prefix('t/');
    const targets = new Map<string, ThreadRef>();
    for (const entry of entries) {
      const meta = asTargetMeta(entry.value);
      if (meta === undefined || meta.pendingCount === 0) continue;
      targets.set(threadIdentity(meta.target), meta.target);
    }
    return [...targets.values()];
  }

  private async appendActivityOwner(input: ActivityPayload, ctx: RuntimeMethodContext): Promise<StoredThreadActivity> {
    const partition = targetPartition(input.target);
    return this.withPartition(partition, async () => {
      const db = await this.readyOwner(ctx);
      const method = THREAD_MAILBOX_RUNTIME_METHODS.appendActivity;
      const receiptKey = requestReceiptKey(partition, method, ctx);
      const receipt = readReceipt(await db.partitionGet(partition, receiptKey), receiptKey, method, ctx, input);
      if (receipt !== undefined) return receipt.result as StoredThreadActivity;
      const metaKey = targetMetaKey(partition);
      const meta = asTargetMeta(await db.partitionGet(partition, metaKey)) ?? newTargetMeta(input.target);
      assertThreadIdentity(meta.target, input.target, metaKey);
      const activity: StoredThreadActivity = {
        seq: meta.nextActivitySeq,
        epoch: meta.activityEpoch,
        kind: input.kind,
        at: Date.now(),
        reason: input.reason,
        turnId: input.turnId,
        messageId: input.messageId,
      };
      const nextSeq = meta.nextActivitySeq + 1;
      const ops: BatchInputOp<StoredDoc>[] = [
        {
          op: 'set',
          key: metaKey,
          value: {
            ...meta,
            nextActivitySeq: nextSeq,
            minActivitySeq: Math.max(meta.minActivitySeq, nextSeq - ACTIVITY_RETAINED_LIMIT),
          },
        },
        {
          op: 'set',
          key: targetActivityKey(partition, activity.seq),
          value: { kind: 'activity', target: input.target, activity },
        },
        this.receiptOp(receiptKey, method, ctx, input, activity),
      ];
      const pruneSeq = activity.seq - ACTIVITY_RETAINED_LIMIT;
      if (pruneSeq >= meta.minActivitySeq) ops.push({ op: 'del', key: targetActivityKey(partition, pruneSeq) });
      await db.partitionBatch(partition, ops);
      return activity;
    });
  }

  private async readActivityOwner(input: ReadActivityPayload, ctx: RuntimeMethodContext): Promise<ThreadActivityPage> {
    const partition = targetPartition(input.target);
    return this.withPartition(partition, async () => {
      const db = await this.readyOwner(ctx);
      const metaKey = targetMetaKey(partition);
      let meta = asTargetMeta(await db.partitionGet(partition, metaKey));
      if (meta === undefined) {
        const method = THREAD_MAILBOX_RUNTIME_METHODS.readActivity;
        const receiptKey = requestReceiptKey(partition, method, ctx);
        const receipt = readReceipt(await db.partitionGet(partition, receiptKey), receiptKey, method, ctx, input);
        if (receipt !== undefined) return receipt.result as ThreadActivityPage;
        meta = newTargetMeta(input.target);
        const result: ThreadActivityPage = { epoch: meta.activityEpoch, latestSeq: 0, activities: [] };
        await db.partitionBatch(partition, [
          { op: 'set', key: metaKey, value: meta },
          this.receiptOp(receiptKey, method, ctx, input, result),
        ]);
        return result;
      }
      assertThreadIdentity(meta.target, input.target, metaKey);
      if (input.afterSeq !== Number.MAX_SAFE_INTEGER && input.afterSeq < meta.minActivitySeq - 1) {
        throw new ThreadActivityCursorExpiredError(
          meta.activityEpoch,
          meta.minActivitySeq,
          meta.nextActivitySeq - 1,
        );
      }
      const start = Math.max(input.afterSeq + 1, meta.minActivitySeq);
      const activities: StoredThreadActivity[] = [];
      for (let seq = start; seq < meta.nextActivitySeq && activities.length < input.limit; seq++) {
        const entry = asActivity(await db.partitionGet(partition, targetActivityKey(partition, seq)));
        if (entry !== undefined) activities.push(entry.activity);
      }
      return { epoch: meta.activityEpoch, latestSeq: meta.nextActivitySeq - 1, activities };
    });
  }

  private async getWorkspaceOverrideOwner(workspaceId: string, ctx: RuntimeMethodContext): Promise<boolean | null> {
    const partition = workspacePartition(workspaceId);
    const db = await this.readyOwner(ctx);
    const key = workspaceOverrideKey(partition);
    const override = asWorkspaceOverride(await db.partitionGet(partition, key));
    if (override !== undefined && override.workspaceId !== workspaceId) throw new Error(`Workspace mailbox key collision at "${key}".`);
    return override?.enabled ?? null;
  }

  private async setWorkspaceOverrideOwner(workspaceId: string, enabled: boolean, ctx: RuntimeMethodContext): Promise<void> {
    const partition = workspacePartition(workspaceId);
    const method = THREAD_MAILBOX_RUNTIME_METHODS.setWorkspaceOverride;
    const input = { workspaceId, enabled };
    await this.withPartition(partition, async () => {
      const db = await this.readyOwner(ctx);
      const receiptKey = requestReceiptKey(partition, method, ctx);
      if (readReceipt(await db.partitionGet(partition, receiptKey), receiptKey, method, ctx, input) !== undefined) return;
      const key = workspaceOverrideKey(partition);
      const prior = asWorkspaceOverride(await db.partitionGet(partition, key));
      if (prior !== undefined && prior.workspaceId !== workspaceId) throw new Error(`Workspace mailbox key collision at "${key}".`);
      await db.partitionBatch(partition, [
        {
          op: 'set',
          key,
          value: { kind: 'workspace_override', workspaceId, enabled, updatedAt: Date.now() },
        },
        this.receiptOp(receiptKey, method, ctx, input, null),
      ]);
    });
  }

  private async clearWorkspaceOverrideOwner(workspaceId: string, ctx: RuntimeMethodContext): Promise<void> {
    const partition = workspacePartition(workspaceId);
    const method = THREAD_MAILBOX_RUNTIME_METHODS.clearWorkspaceOverride;
    const input = { workspaceId };
    await this.withPartition(partition, async () => {
      const db = await this.readyOwner(ctx);
      const receiptKey = requestReceiptKey(partition, method, ctx);
      if (readReceipt(await db.partitionGet(partition, receiptKey), receiptKey, method, ctx, input) !== undefined) return;
      const key = workspaceOverrideKey(partition);
      const prior = asWorkspaceOverride(await db.partitionGet(partition, key));
      if (prior !== undefined && prior.workspaceId !== workspaceId) throw new Error(`Workspace mailbox key collision at "${key}".`);
      await db.partitionBatch(partition, [
        { op: 'del', key },
        this.receiptOp(receiptKey, method, ctx, input, null),
      ]);
    });
  }

  private withPartition<T>(partition: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueuePartitionOperation(partition, {
        kind: 'operation',
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  private enqueuePartitionOperation(partition: string, operation: PartitionQueueOperation): void {
    let queue = this.partitionQueues.get(partition);
    if (queue === undefined) {
      queue = { operations: [], running: false };
      this.partitionQueues.set(partition, queue);
    }
    queue.operations.push(operation);
    if (queue.running) return;
    queue.running = true;
    void this.runPartitionQueue(partition, queue);
  }

  private async runPartitionQueue(partition: string, queue: PartitionQueue): Promise<void> {
    while (queue.operations.length > 0) {
      const operation = queue.operations.shift()!;
      if (operation.kind === 'operation') {
        try {
          operation.resolve(await operation.run());
        } catch (error) {
          operation.reject(error);
        }
        continue;
      }
      const batch = [operation];
      while (batch.length < ACCEPT_MICROBATCH_LIMIT) {
        const next = queue.operations[0];
        if (next?.kind !== 'accept' || next.ctx.epoch !== operation.ctx.epoch) break;
        batch.push(queue.operations.shift() as AcceptPartitionOperation);
      }
      await this.runAcceptBatch(partition, batch);
    }
    queue.running = false;
    if (this.partitionQueues.get(partition) === queue && queue.operations.length === 0) {
      this.partitionQueues.delete(partition);
    }
  }

  private async runAcceptBatch(partition: string, batch: readonly AcceptPartitionOperation[]): Promise<void> {
    const active = batch.filter((operation) => {
      if (!operation.ctx.signal.aborted) return true;
      operation.reject(operation.ctx.signal.reason);
      return false;
    });
    let db: ClusterDb<StoredDoc> | undefined;
    while (active.length > 0 && db === undefined) {
      const operation = active[0]!;
      try {
        db = await this.readyOwner(operation.ctx);
      } catch (error) {
        if (!operation.ctx.signal.aborted) {
          for (const item of active) item.reject(error);
          return;
        }
        operation.reject(error);
        active.shift();
      }
    }
    if (db === undefined) return;
    const staged = new Map<string, StoredDoc | undefined>();
    const ops: BatchInputOp<StoredDoc>[] = [];
    const completed: Array<{
      readonly operation: AcceptPartitionOperation;
      readonly result: ThreadMessageAcceptance;
    }> = [];
    for (const operation of active) {
      if (operation.ctx.signal.aborted) {
        operation.reject(operation.ctx.signal.reason);
        continue;
      }
      try {
        const plan = await this.planAccept(db, partition, operation.input, operation.ctx, staged);
        for (const op of plan.ops) {
          ops.push(op);
          staged.set(op.key, op.op === 'set' ? op.value : undefined);
        }
        completed.push({ operation, result: plan.result });
      } catch (error) {
        operation.reject(error);
      }
    }
    if (completed.length === 0) return;
    try {
      await db.partitionBatch(partition, ops);
      for (const item of completed) item.operation.resolve(item.result);
    } catch (error) {
      for (const item of completed) item.operation.reject(error);
    }
  }

  private async planAccept(
    db: ClusterDb<StoredDoc>,
    partition: string,
    input: AcceptPayload,
    ctx: RuntimeMethodContext,
    staged: ReadonlyMap<string, StoredDoc | undefined>,
  ): Promise<AcceptPlan> {
    const read = (key: string): Promise<StoredDoc | undefined> => staged.has(key)
      ? Promise.resolve(staged.get(key))
      : db.partitionGet(partition, key);
    const method = THREAD_MAILBOX_RUNTIME_METHODS.accept;
    const receiptKey = requestReceiptKey(partition, method, ctx);
    const receipt = readReceipt(await read(receiptKey), receiptKey, method, ctx, input);
    if (receipt !== undefined) {
      return { result: receipt.result as ThreadMessageAcceptance, ops: [] };
    }
    const idemKey = idempotencyKey(partition, input);
    const prior = asIdempotency(await read(idemKey));
    if (prior !== undefined) {
      assertThreadIdentity(prior.target, input.target, idemKey);
      const delivery = asMessage(await read(prior.messageKey));
      const result: ThreadMessageAcceptance = delivery === undefined
        ? {
            message: missingDeliveryMessage(input, prior.messageKey),
            deduplicated: true,
            delivery: 'undeliverable',
            payloadConflict: prior.payloadHash !== payloadHash(input.content),
          }
        : {
            message: delivery.message,
            deduplicated: true,
            delivery: publicDeliveryState(delivery.state),
            payloadConflict: prior.payloadHash !== payloadHash(input.content),
          };
      return { result, ops: [this.receiptOp(receiptKey, method, ctx, input, result)] };
    }
    const metaKey = targetMetaKey(partition);
    const meta = asTargetMeta(await read(metaKey)) ?? newTargetMeta(input.target);
    assertThreadIdentity(meta.target, input.target, metaKey);
    if (meta.pendingCount >= PENDING_HARD_LIMIT) throw new ThreadMailboxBacklogError(PENDING_HARD_LIMIT);
    const message: AcceptedThreadMessage = {
      messageId: randomUUID(),
      producer: input.producer,
      target: input.target,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
      acceptedAt: Date.now(),
      targetSeq: meta.nextMessageSeq,
    };
    const messageKey = targetMessageKey(partition, message.targetSeq);
    const hash = payloadHash(input.content);
    const result: ThreadMessageAcceptance = {
      message,
      deduplicated: false,
      delivery: 'pending',
      payloadConflict: false,
    };
    const ops: BatchInputOp<StoredDoc>[] = [
      {
        op: 'set',
        key: metaKey,
        value: { ...meta, nextMessageSeq: meta.nextMessageSeq + 1, pendingCount: meta.pendingCount + 1 },
      },
      {
        op: 'set',
        key: messageKey,
        value: {
          kind: 'message',
          message,
          idempotencyStorageKey: idemKey,
          payloadHash: hash,
          state: 'pending',
          fence: 0,
        },
      },
      {
        op: 'set',
        key: idemKey,
        value: {
          kind: 'idempotency',
          producer: input.producer,
          target: input.target,
          idempotencyKey: input.idempotencyKey,
          payloadHash: hash,
          messageKey,
        },
      },
      this.receiptOp(receiptKey, method, ctx, input, result),
    ];
    const pruneKey = targetMessageKey(partition, message.targetSeq - MESSAGE_RETAINED_LIMIT);
    const prune = asMessage(await read(pruneKey));
    if (prune !== undefined && isTerminalState(prune.state)) {
      ops.push({ op: 'del', key: pruneKey }, { op: 'del', key: prune.idempotencyStorageKey });
    }
    return { result, ops };
  }

  private async migrate(db: ClusterDb<StoredDoc>, snapshots: readonly LegacySnapshot[]): Promise<void> {
    const deliveries = snapshots.flatMap((snapshot) => snapshot.deliveries);
    const activities = snapshots.flatMap((snapshot) => snapshot.activities);
    const activityMeta = snapshots.flatMap((snapshot) => snapshot.activityMeta);
    const targets = new Map<string, ThreadRef>();
    for (const delivery of deliveries) targets.set(threadIdentity(delivery.message.target), delivery.message.target);
    for (const activity of activities) targets.set(threadIdentity(activity.target), activity.target);
    for (const meta of activityMeta) targets.set(threadIdentity(meta.target), meta.target);
    for (const target of targets.values()) {
      const partition = targetPartition(target);
      const existingMessages = (await db.partitionPrefix(partition, targetMessagePrefix(partition)))
        .map((entry) => ({ key: entry.key, value: asMessage(entry.value) }))
        .filter((entry): entry is { readonly key: string; readonly value: MessageDoc } => entry.value !== undefined);
      const existingActivities = (await db.partitionPrefix(partition, targetActivityPrefix(partition)))
        .map((entry) => ({ key: entry.key, value: asActivity(entry.value) }))
        .filter((entry): entry is { readonly key: string; readonly value: ActivityDoc } => entry.value !== undefined);
      const metaKey = targetMetaKey(partition);
      const storedMeta = asTargetMeta(await db.partitionGet(partition, metaKey));
      const legacyDeliveries = deliveries
        .filter((delivery) => sameThread(delivery.message.target, target))
        .toSorted((left, right) => left.message.targetSeq - right.message.targetSeq);
      const legacyActivities = activities
        .filter((activity) => sameThread(activity.target, target))
        .toSorted((left, right) => left.activity.seq - right.activity.seq);
      const knownMessageIds = new Set(existingMessages.map((entry) => entry.value.message.messageId));
      const usedMessageSeq = new Set(existingMessages.map((entry) => entry.value.message.targetSeq));
      const usedActivitySeq = new Set(existingActivities.map((entry) => entry.value.activity.seq));
      let nextMessageSeq = Math.max(storedMeta?.nextMessageSeq ?? 1, ...[...usedMessageSeq].map((seq) => seq + 1));
      let nextActivitySeq = Math.max(storedMeta?.nextActivitySeq ?? 1, ...[...usedActivitySeq].map((seq) => seq + 1));
      const ops: BatchInputOp<StoredDoc>[] = [];
      const migratedMessages = existingMessages.map((entry) => entry.value);
      for (const legacy of legacyDeliveries) {
        if (knownMessageIds.has(legacy.message.messageId)) continue;
        let seq = legacy.message.targetSeq;
        if (!Number.isSafeInteger(seq) || seq < 1 || usedMessageSeq.has(seq)) seq = nextMessageSeq;
        while (usedMessageSeq.has(seq)) seq++;
        usedMessageSeq.add(seq);
        nextMessageSeq = Math.max(nextMessageSeq, seq + 1);
        const message = { ...legacy.message, targetSeq: seq };
        const idemKey = idempotencyKey(partition, message);
        const state = legacy.state === 'delivering' ? 'pending' : legacy.state;
        const migrated: MessageDoc = {
          kind: 'message',
          message,
          idempotencyStorageKey: idemKey,
          payloadHash: payloadHash(message.content),
          state,
          fence: Math.max(0, legacy.attempt) + (legacy.state === 'delivering' ? 1 : 0),
        };
        const messageKey = targetMessageKey(partition, seq);
        ops.push(
          { op: 'set', key: messageKey, value: migrated },
          {
            op: 'set',
            key: idemKey,
            value: {
              kind: 'idempotency',
              producer: message.producer,
              target: message.target,
              idempotencyKey: message.idempotencyKey,
              payloadHash: migrated.payloadHash,
              messageKey,
            },
          },
        );
        migratedMessages.push(migrated);
        knownMessageIds.add(message.messageId);
      }
      const migratedActivities = existingActivities.map((entry) => entry.value);
      const knownActivityIds = new Set(existingActivities.map((entry) =>
        entry.value.legacyIdentity ?? hashJson({ target: entry.value.target, activity: entry.value.activity }),
      ));
      for (const legacy of legacyActivities) {
        const legacyIdentity = hashJson({ target: legacy.target, activity: legacy.activity });
        if (knownActivityIds.has(legacyIdentity)) continue;
        let seq = legacy.activity.seq;
        if (!Number.isSafeInteger(seq) || seq < 1 || usedActivitySeq.has(seq)) seq = nextActivitySeq;
        while (usedActivitySeq.has(seq)) seq++;
        usedActivitySeq.add(seq);
        nextActivitySeq = Math.max(nextActivitySeq, seq + 1);
        const activity = { ...legacy.activity, seq };
        const migrated: ActivityDoc = { kind: 'activity', target, activity, legacyIdentity };
        ops.push({ op: 'set', key: targetActivityKey(partition, seq), value: migrated });
        migratedActivities.push(migrated);
        knownActivityIds.add(legacyIdentity);
      }
      const legacyMeta = activityMeta.find((item) => sameThread(item.target, target));
      const activityEpoch = storedMeta?.activityEpoch ?? legacyMeta?.epoch ?? migratedActivities[0]?.activity.epoch ?? randomUUID();
      const minActivitySeq = migratedActivities.length === 0
        ? storedMeta?.minActivitySeq ?? legacyMeta?.minSeq ?? 1
        : Math.min(...migratedActivities.map((entry) => entry.activity.seq));
      const pendingMessages = migratedMessages.filter((message) => !isTerminalState(message.state));
      const meta: TargetMetaDoc = {
        kind: 'target_meta',
        target,
        nextMessageSeq,
        nextDeliverableSeq: pendingMessages.reduce(
          (seq, message) => Math.min(seq, message.message.targetSeq),
          nextMessageSeq,
        ),
        pendingCount: pendingMessages.length,
        activityEpoch,
        nextActivitySeq,
        minActivitySeq,
      };
      ops.push({ op: 'set', key: metaKey, value: meta });
      await db.partitionBatch(partition, ops);
    }
    const overrides = new Map<string, WorkspaceOverrideDoc>();
    for (const snapshot of snapshots) {
      for (const override of snapshot.overrides) {
        const existing = overrides.get(override.workspaceId);
        if (existing === undefined || existing.updatedAt <= override.updatedAt) overrides.set(override.workspaceId, override);
      }
    }
    for (const override of overrides.values()) {
      const partition = workspacePartition(override.workspaceId);
      const key = workspaceOverrideKey(partition);
      const existing = asWorkspaceOverride(await db.partitionGet(partition, key));
      if (existing === undefined || existing.updatedAt <= override.updatedAt) {
        await db.partitionBatch(partition, [{ op: 'set', key, value: override }]);
      }
    }
  }

  private receiptOp(
    key: string,
    method: RuntimeMethodName,
    ctx: RuntimeMethodContext,
    payload: unknown,
    result: unknown,
  ): BatchInputOp<StoredDoc> {
    return buildReceiptOp(
      key,
      method,
      ctx,
      payload,
      result,
      RECEIPT_TTL_MS,
    );
  }

  private queueOwnerRelease(epoch?: number): Promise<void> {
    const prior = this.ownerReleaseFlight;
    const next = prior.then(
      () => this.releaseOwnerResources(epoch),
      () => this.releaseOwnerResources(epoch),
    );
    this.ownerReleaseFlight = next;
    return next;
  }

  private async releaseOwnerResources(epoch?: number): Promise<void> {
    if (epoch === undefined || this.ownerEpoch === epoch) this.ownerEpoch = 0;
    const initialization = this.initialization;
    if (initialization !== undefined && (epoch === undefined || initialization.epoch === epoch)) {
      await Promise.allSettled([initialization.promise]);
    }
    const operations = [...this.ownerOperations]
      .filter(([, operationEpoch]) => epoch === undefined || operationEpoch === epoch)
      .map(([operation]) => operation);
    await Promise.allSettled(operations);
    if (epoch === undefined || this.ownerEpoch === epoch) this.ownerEpoch = 0;
    const db = this.db;
    this.db = undefined;
    const legacy = this.quarantine.splice(0);
    const closeResults = await Promise.allSettled([
      ...(db === undefined ? [] : [db.close()]),
      ...legacy.map((store) => store.close()),
    ]);
    for (const result of closeResults) {
      if (result.status === 'rejected') this.ownerReleaseErrors.push(result.reason);
    }
  }

  private async doClose(): Promise<void> {
    this.closing = true;
    this.closeController.abort(new Error('Thread mailbox store is closed.'));
    const errors: unknown[] = [];
    for (const registration of this.registrations.splice(0)) {
      try {
        registration.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    await this.queueOwnerRelease();
    errors.push(...this.ownerReleaseErrors.splice(0));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Thread mailbox close failed.');
  }
}

function buildReceiptOp(
  key: string,
  method: RuntimeMethodName,
  ctx: RuntimeMethodContext,
  payload: unknown,
  result: unknown,
  ttlMs: number,
): BatchInputOp<StoredDoc> {
  return {
    op: 'set',
    key,
    value: {
      kind: 'receipt',
      method,
      requestId: ctx.requestId,
      callerHostId: ctx.callerHostId,
      epoch: ctx.epoch,
      payloadHash: hashJson(payload),
      result,
    },
    ttl: ttlMs,
  };
}

function readLegacySnapshot(db: MiniDb<Record<string, unknown>>): LegacySnapshot {
  const deliveries: LegacyDelivery[] = [];
  const activityMeta: LegacyActivityMeta[] = [];
  const activities: Array<{ readonly target: ThreadRef; readonly activity: StoredThreadActivity }> = [];
  const overrides: WorkspaceOverrideDoc[] = [];
  for (const entry of db.prefix('', Number.POSITIVE_INFINITY)) {
    const value = entry.value;
    if (value['kind'] === 'delivery') {
      const message = normalizeLegacyMessage(value['message']);
      const state = normalizeDeliveryState(value['state']);
      if (message !== undefined && state !== undefined) {
        deliveries.push({
          message,
          state,
          attempt: finiteNonNegativeInteger(value['attempt']) ?? 0,
        });
      }
      continue;
    }
    if (value['kind'] === 'activity_meta') {
      const target = asThreadRef(value['target']);
      const epoch = value['epoch'];
      const nextSeq = finitePositiveInteger(value['nextSeq']);
      const minSeq = finitePositiveInteger(value['minSeq']);
      if (target !== undefined && typeof epoch === 'string' && nextSeq !== undefined && minSeq !== undefined) {
        activityMeta.push({ target, epoch, nextSeq, minSeq });
      }
      continue;
    }
    if (value['kind'] === 'activity_event') {
      const target = asThreadRef(value['target']);
      const activity = asStoredActivity(value['activity']);
      if (target !== undefined && activity !== undefined) activities.push({ target, activity });
      continue;
    }
    if (value['kind'] === 'workspace_override') {
      const workspaceId = value['workspaceId'];
      const enabled = value['enabled'];
      if (typeof workspaceId === 'string' && typeof enabled === 'boolean') {
        overrides.push({
          kind: 'workspace_override',
          workspaceId,
          enabled,
          updatedAt: finiteNonNegativeInteger(value['updatedAt']) ?? 0,
        });
      }
    }
  }
  return { deliveries, activityMeta, activities, overrides };
}

function normalizeLegacyMessage(value: unknown): AcceptedThreadMessage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const target = asThreadRef(raw['target']);
  const source = asThreadRef(raw['source']);
  const producer = asProducer(raw['producer']) ?? (source === undefined ? undefined : { kind: 'peer_thread' as const, source });
  if (
    producer === undefined ||
    target === undefined ||
    typeof raw['messageId'] !== 'string' ||
    typeof raw['content'] !== 'string' ||
    typeof raw['idempotencyKey'] !== 'string'
  ) return undefined;
  return {
    messageId: raw['messageId'],
    producer,
    target,
    content: raw['content'],
    idempotencyKey: raw['idempotencyKey'],
    acceptedAt: finiteNonNegativeInteger(raw['acceptedAt']) ?? 0,
    targetSeq: finitePositiveInteger(raw['targetSeq']) ?? 1,
  };
}

function asStoredActivity(value: unknown): StoredThreadActivity | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const seq = finitePositiveInteger(raw['seq']);
  const epoch = raw['epoch'];
  const kind = raw['kind'];
  const at = finiteNonNegativeInteger(raw['at']);
  const reason = raw['reason'];
  if (
    seq === undefined ||
    typeof epoch !== 'string' ||
    !isActivityKind(kind) ||
    at === undefined ||
    typeof reason !== 'string'
  ) return undefined;
  return {
    seq,
    epoch,
    kind,
    at,
    reason,
    turnId: finiteNonNegativeInteger(raw['turnId']),
    messageId: typeof raw['messageId'] === 'string' ? raw['messageId'] : undefined,
  };
}

function targetPartition(target: ThreadRef): string {
  return `t/${threadKey(target)}`;
}

function workspacePartition(workspaceId: string): string {
  return `w/${hashJson({ workspaceId })}`;
}

function targetMetaKey(partition: string): string {
  return `${partition}/meta`;
}

function targetMessagePrefix(partition: string): string {
  return `${partition}/message/`;
}

function targetMessageKey(partition: string, seq: number): string {
  return `${targetMessagePrefix(partition)}${padSeq(seq)}`;
}

function targetActivityPrefix(partition: string): string {
  return `${partition}/activity/`;
}

function targetActivityKey(partition: string, seq: number): string {
  return `${targetActivityPrefix(partition)}${padSeq(seq)}`;
}

function workspaceOverrideKey(partition: string): string {
  return `${partition}/override`;
}

function idempotencyKey(partition: string, input: {
  readonly producer: ThreadMessageProducer;
  readonly target: ThreadRef;
  readonly idempotencyKey: string;
}): string {
  return `${partition}/idempotency/${hashJson({ producer: input.producer, target: input.target, key: input.idempotencyKey })}`;
}

function requestReceiptKey(partition: string, method: RuntimeMethodName, ctx: RuntimeMethodContext): string {
  return `${partition}/receipt/${hashJson({ method, callerHostId: ctx.callerHostId, requestId: ctx.requestId })}`;
}

function threadKey(ref: ThreadRef): string {
  return hashJson({ hostId: ref.hostId, workspaceId: ref.workspaceId, sessionId: ref.sessionId });
}

function threadIdentity(ref: ThreadRef): string {
  return `${ref.hostId}\u0000${ref.workspaceId}\u0000${ref.sessionId}`;
}

function padSeq(seq: number): string {
  return Math.max(0, seq).toString().padStart(16, '0');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function payloadHash(content: string): string {
  return hashJson({ content });
}

function newTargetMeta(target: ThreadRef): TargetMetaDoc {
  return {
    kind: 'target_meta',
    target,
    nextMessageSeq: 1,
    nextDeliverableSeq: 1,
    pendingCount: 0,
    activityEpoch: randomUUID(),
    nextActivitySeq: 1,
    minActivitySeq: 1,
  };
}

function publicDeliveryState(state: DeliveryState): ThreadMessageAcceptance['delivery'] {
  if (state === 'delivered') return 'delivered';
  if (state === 'undeliverable') return 'undeliverable';
  return 'pending';
}

function isTerminalState(state: DeliveryState): boolean {
  return state === 'delivered' || state === 'undeliverable';
}

function sameThread(left: ThreadRef, right: ThreadRef): boolean {
  return left.hostId === right.hostId && left.workspaceId === right.workspaceId && left.sessionId === right.sessionId;
}

function sameProducer(left: ThreadMessageProducer, right: ThreadMessageProducer): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'external_client') return true;
  return right.kind === 'peer_thread' && sameThread(left.source, right.source);
}

function sameMessage(left: AcceptedThreadMessage, right: AcceptedThreadMessage): boolean {
  return left.messageId === right.messageId &&
    left.targetSeq === right.targetSeq &&
    sameThread(left.target, right.target) &&
    sameProducer(left.producer, right.producer);
}

function sameClaim(left: ThreadDeliveryClaim, right: ThreadDeliveryClaim): boolean {
  return sameMessage(left.message, right.message) &&
    left.consumerId === right.consumerId &&
    left.fence === right.fence &&
    left.leaseUntil === right.leaseUntil &&
    left.hostEpoch === right.hostEpoch;
}

function assertThreadIdentity(stored: ThreadRef, expected: ThreadRef, key: string): void {
  if (!sameThread(stored, expected)) throw new Error(`Thread mailbox key collision at "${key}".`);
}

function missingDeliveryMessage(input: AcceptPayload, messageKey: string): AcceptedThreadMessage {
  return {
    messageId: messageKey,
    producer: input.producer,
    target: input.target,
    content: input.content,
    idempotencyKey: input.idempotencyKey,
    acceptedAt: 0,
    targetSeq: 0,
  };
}

function asTargetMeta(value: StoredDoc | undefined): TargetMetaDoc | undefined {
  return value?.kind === 'target_meta' ? value : undefined;
}

function asMessage(value: StoredDoc | undefined): MessageDoc | undefined {
  return value?.kind === 'message' ? value : undefined;
}

function asIdempotency(value: StoredDoc | undefined): IdempotencyDoc | undefined {
  return value?.kind === 'idempotency' ? value : undefined;
}

function asActivity(value: StoredDoc | undefined): ActivityDoc | undefined {
  return value?.kind === 'activity' ? value : undefined;
}

function asWorkspaceOverride(value: StoredDoc | undefined): WorkspaceOverrideDoc | undefined {
  return value?.kind === 'workspace_override' ? value : undefined;
}

function readReceipt(
  value: StoredDoc | undefined,
  key: string,
  method: RuntimeMethodName,
  ctx: RuntimeMethodContext,
  payload: unknown,
): ReceiptDoc | undefined {
  if (value?.kind !== 'receipt') return undefined;
  if (
    value.method !== method ||
    value.requestId !== ctx.requestId ||
    value.callerHostId !== ctx.callerHostId ||
    value.payloadHash !== hashJson(payload)
  ) {
    throw new Error(`Thread mailbox request identity conflict at "${key}".`);
  }
  return value;
}

function asMigrationMarker(value: StoredDoc | undefined): MigrationMarkerDoc | undefined {
  return value?.kind === 'migration_marker' && value.version === 3 ? value : undefined;
}

function assertAcceptPayload(value: unknown): AcceptPayload {
  const input = assertRecord(value);
  const producer = asProducer(input['producer']);
  const target = asThreadRef(input['target']);
  if (producer === undefined || target === undefined || typeof input['content'] !== 'string' || typeof input['idempotencyKey'] !== 'string') {
    throw new TypeError('Invalid thread mailbox accept payload.');
  }
  const pendingLimit = input['pendingLimit'];
  if (pendingLimit !== undefined && finitePositiveInteger(pendingLimit) === undefined) throw new TypeError('Invalid pendingLimit.');
  return { producer, target, content: input['content'], idempotencyKey: input['idempotencyKey'], pendingLimit: pendingLimit as number | undefined };
}

function assertClaimPayload(value: unknown, maxDeliveryLeaseMs: number): ClaimPayload {
  const input = assertRecord(value);
  const target = asThreadRef(input['target']);
  const leaseMs = finitePositiveInteger(input['leaseMs']);
  if (
    target === undefined ||
    typeof input['consumerId'] !== 'string' ||
    input['consumerId'].length === 0 ||
    leaseMs === undefined ||
    leaseMs > maxDeliveryLeaseMs
  ) {
    throw new TypeError('Invalid thread mailbox claim payload.');
  }
  return { target, consumerId: input['consumerId'], leaseMs };
}

function assertClaim(value: unknown): ThreadDeliveryClaim {
  const input = assertRecord(value);
  const message = normalizeLegacyMessage(input['message']);
  const fence = finitePositiveInteger(input['fence']);
  const leaseUntil = finiteNonNegativeInteger(input['leaseUntil']);
  const hostEpoch = finiteNonNegativeInteger(input['hostEpoch']);
  if (message === undefined || typeof input['consumerId'] !== 'string' || fence === undefined || leaseUntil === undefined || hostEpoch === undefined) {
    throw new TypeError('Invalid thread mailbox delivery claim.');
  }
  return { message, consumerId: input['consumerId'], fence, leaseUntil, hostEpoch };
}

function assertUndeliverablePayload(value: unknown): UndeliverablePayload {
  const input = assertRecord(value);
  if (typeof input['reason'] !== 'string') throw new TypeError('Invalid undeliverable reason.');
  return { claim: assertClaim(input['claim']), reason: input['reason'] };
}

function assertActivityPayload(value: unknown): ActivityPayload {
  const input = assertRecord(value);
  const target = asThreadRef(input['target']);
  if (target === undefined || !isActivityKind(input['kind']) || typeof input['reason'] !== 'string') {
    throw new TypeError('Invalid thread activity payload.');
  }
  const turnId = input['turnId'];
  const messageId = input['messageId'];
  if (turnId !== undefined && finiteNonNegativeInteger(turnId) === undefined) throw new TypeError('Invalid activity turnId.');
  if (messageId !== undefined && typeof messageId !== 'string') throw new TypeError('Invalid activity messageId.');
  return { target, kind: input['kind'], reason: input['reason'], turnId: turnId as number | undefined, messageId: messageId as string | undefined };
}

function assertReadActivityPayload(value: unknown): ReadActivityPayload {
  const input = assertRecord(value);
  const target = asThreadRef(input['target']);
  const afterSeq = finiteNonNegativeInteger(input['afterSeq']);
  const limit = finitePositiveInteger(input['limit']);
  if (target === undefined || afterSeq === undefined || limit === undefined) throw new TypeError('Invalid read activity payload.');
  return { target, afterSeq, limit };
}

function assertWorkspacePayload(value: unknown, requireEnabled = false): WorkspaceOverridePayload {
  const input = assertRecord(value);
  if (typeof input['workspaceId'] !== 'string' || input['workspaceId'].length === 0) throw new TypeError('Invalid workspaceId.');
  if (requireEnabled && typeof input['enabled'] !== 'boolean') throw new TypeError('Invalid workspace override value.');
  return { workspaceId: input['workspaceId'], enabled: typeof input['enabled'] === 'boolean' ? input['enabled'] : undefined };
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object payload.');
  return value as Record<string, unknown>;
}

function asThreadRef(value: unknown): ThreadRef | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref['hostId'] !== 'string' || typeof ref['workspaceId'] !== 'string' || typeof ref['sessionId'] !== 'string') return undefined;
  return { hostId: ref['hostId'], workspaceId: ref['workspaceId'], sessionId: ref['sessionId'] };
}

function asProducer(value: unknown): ThreadMessageProducer | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const producer = value as Record<string, unknown>;
  if (producer['kind'] === 'external_client') return { kind: 'external_client' };
  if (producer['kind'] === 'peer_thread') {
    const source = asThreadRef(producer['source']);
    if (source !== undefined) return { kind: 'peer_thread', source };
  }
  return undefined;
}

function normalizeDeliveryState(value: unknown): DeliveryState | undefined {
  return value === 'pending' || value === 'delivering' || value === 'delivered' || value === 'undeliverable'
    ? value
    : undefined;
}

function isActivityKind(value: unknown): value is ThreadActivityKind {
  return value === 'terminal' || value === 'attention' || value === 'lifecycle' || value === 'message_undeliverable';
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Thread mailbox operation aborted.');
}

function combineAbortSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  return secondary === undefined ? primary : AbortSignal.any([primary, secondary]);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function isAmbiguousRuntimeResponse(error: unknown): boolean {
  return error instanceof HomeRuntimeError && (
    error.code === 'runtime.connection_failed' ||
    error.code === 'runtime.owner_gone' ||
    error.code === 'runtime.detached' ||
    error.code === 'runtime.timeout' ||
    error.code === 'runtime.epoch_stale' ||
    error.code === 'runtime.epoch_future'
  );
}

registerScopedService(
  LifecycleScope.App,
  IThreadMailboxStore,
  RuntimeThreadMailboxStore,
  ScopeActivation.OnScopeCreated,
  'threadCommunication',
);
