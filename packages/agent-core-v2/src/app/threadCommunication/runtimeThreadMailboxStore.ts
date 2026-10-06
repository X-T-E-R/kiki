import { createHash, randomUUID } from 'node:crypto';

import { LockError, MiniDb, type BatchInputOp } from '@kiki/minidb';
import { ClusterDb } from '@kiki/minidb/cluster';
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
import { THREAD_DELIVERY_REASON_CODES, type ThreadActivityKind, type ThreadDeliveryReasonCode, type ThreadRef } from './threadCommunication';
import {
  IThreadMailboxStore,
  type AcceptedThreadMessage,
  type ReadMailboxMessagesInput,
  type MailboxMessagesPage,
  type MailboxMessageRecord,
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
const THREAD_MAILBOX_TIMEOUT_ENV = 'KIKI_THREAD_MAILBOX_TIMEOUT_MS';
const MAX_CONFIGURED_TIMEOUT_MS = 10 * 60_000;
const CALL_RETRY_BACKOFF_MS = 25;
const CALL_TOTAL_TIMEOUT_MULTIPLIER = 2;
const LEGACY_THREAD_DIR = 'thread-mailbox-v1';
const LEGACY_AGENT_DIR = 'agent-collaboration-mailbox-v2';
const SYSTEM_PARTITION = 's/thread-mailbox-v3';
const MIGRATION_MARKER_KEY = `${SYSTEM_PARTITION}/migration`;
const ACTIVE_BACKEND_KEY = `${SYSTEM_PARTITION}/active-backend`;
const METHOD_PREFIX = 'threadMailbox.v3';
const ACCEPT_MICROBATCH_LIMIT = 32;

function resolveTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_CONFIGURED_TIMEOUT_MS
    ? parsed
    : fallback;
}

export const THREAD_MAILBOX_RUNTIME_METHODS = {
  readMessages: `${METHOD_PREFIX}.readMessages`,
  accept: `${METHOD_PREFIX}.accept`,
  claim: `${METHOD_PREFIX}.claim`,
  acknowledge: `${METHOD_PREFIX}.acknowledge`,
  undeliverable: `${METHOD_PREFIX}.undeliverable`,
  cancelProducer: `${METHOD_PREFIX}.cancelProducer`,
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
  readonly rates?: Readonly<Record<string, readonly number[]>>;
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
  readonly reasonCode?: ThreadDeliveryReasonCode;
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

interface PeerIndexDoc {
  readonly kind: 'peer_index';
  readonly peerGroup: string;
  readonly peerOrder: string;
  readonly partition: string;
  readonly messageKey: string;
}

interface PeerIndexMarkerDoc {
  readonly kind: 'peer_index_marker';
  readonly after: string;
  readonly complete: boolean;
  readonly generation?: string;
  readonly shard?: number;
  readonly shardAfter?: string;
  readonly processedMessages?: number;
  readonly peerComplete?: boolean;
  readonly inheritedPeerAfter?: string;
}

const PEER_INDEX_NAME = 'peer_history_v1';
const PEER_INDEX_MARKER = `${SYSTEM_PARTITION}/peer-index-v2`;
const PEER_INDEX_V1_MARKER = `${SYSTEM_PARTITION}/peer-index-v1`;

type StoredDoc =
  | PeerIndexDoc
  | PeerIndexMarkerDoc
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
  readonly rateLimit?: { readonly key: string; readonly count: number; readonly windowMs: number };
}

interface ClaimPayload {
  readonly target: ThreadRef;
  readonly consumerId: string;
  readonly leaseMs: number;
}

interface UndeliverablePayload {
  readonly claim: ThreadDeliveryClaim;
  readonly reason: string;
  readonly reasonCode?: ThreadDeliveryReasonCode;
}

interface CancelProducerPayload {
  readonly producer: Extract<ThreadMessageProducer, { readonly kind: 'room' }>;
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
  readonly ctx: RuntimeMethodContext;
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

interface OwnerInitialization {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export class RuntimeThreadMailboxStore implements IThreadMailboxStore {
  declare readonly _serviceBrand: undefined;

  private readonly storeDir: string;
  private readonly legacyDirs: readonly string[];
  private readonly registrations: IDisposable[];
  private readonly partitionQueues = new Map<string, PartitionQueue>();
  private readonly partitionAbortListeners = new WeakMap<PartitionQueueOperation, () => void>();
  private readonly ownerOperations = new Map<Promise<unknown>, number>();
  private readonly quarantine: MiniDb<Record<string, unknown>>[] = [];
  private readonly closeController = new AbortController();
  private readonly callTimeoutMs: number;
  private readonly startupCallTimeoutMs: number;
  private db: ClusterDb<StoredDoc> | undefined;
  private ownerEpoch = 0;
  private observedRuntimeRole: RuntimeRole = 'idle';
  private observedRuntimeEpoch = 0;
  private ownerReleaseFlight: Promise<void> = Promise.resolve();
  private readonly ownerReleaseErrors: unknown[] = [];
  private initializedCallEpoch: number | undefined;
  private initializedPeerReadCallEpoch: number | undefined;
  private initialization: OwnerInitialization | undefined;
  private peerIndexInitialization: OwnerInitialization | undefined;
  private peerCoverage: PeerIndexMarkerDoc | undefined;
  private peerIndexError: string | undefined;
  private closing = false;
  private closeFlight: Promise<void> | undefined;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IHomeRuntimeService private readonly runtime: IHomeRuntimeService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {
    this.callTimeoutMs = resolveTimeoutMs(bootstrap.getEnv(THREAD_MAILBOX_TIMEOUT_ENV), CALL_TIMEOUT_MS);
    this.startupCallTimeoutMs = resolveTimeoutMs(bootstrap.getEnv(THREAD_MAILBOX_TIMEOUT_ENV), STARTUP_CALL_TIMEOUT_MS);
    this.storeDir = join(bootstrap.storeDir, STORE_DIR);
    this.legacyDirs = [
      join(bootstrap.storeDir, LEGACY_THREAD_DIR),
      join(bootstrap.storeDir, LEGACY_AGENT_DIR),
    ];
    this.registrations = [
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.readMessages, (payload, ctx) => {
        const input = payload as ReadMailboxMessagesInput;
        if (input === null || typeof input !== 'object' || typeof input.group !== 'string' ||
            input.group.length === 0 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
            (input.before !== undefined && typeof input.before !== 'string') ||
            (input.peerOnly !== undefined && typeof input.peerOnly !== 'boolean') ||
            (input.generation !== undefined && typeof input.generation !== 'string')) {
          throw new Error('Invalid mailbox message query.');
        }
        return this.readMessagesOwner(input, ctx);
      }),
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
        return this.finishOwner(input.claim, 'undeliverable', input.reason, ctx, input.reasonCode);
      }),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.cancelProducer, (payload, ctx) =>
        this.cancelProducerOwner(assertCancelProducerPayload(payload), ctx)),
      this.register(THREAD_MAILBOX_RUNTIME_METHODS.pendingTargets, (payload, ctx) => {
        if (payload === null) return this.pendingTargetsOwner(ctx);
        if (!Array.isArray(payload) || payload.length > 1000) throw new TypeError('Invalid pending target selection.');
        const targets = payload.map((ref) => { const target = asThreadRef(ref); if (target === undefined) throw new TypeError('Invalid pending target.'); return target; });
        return this.pendingTargetsOwner(ctx, targets);
      }),
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

  readMessages(input: ReadMailboxMessagesInput, options?: ThreadMailboxMutationOptions): Promise<MailboxMessagesPage> {
    return this.call(THREAD_MAILBOX_RUNTIME_METHODS.readMessages, input, options) as Promise<MailboxMessagesPage>;
  }

  private async readMessagesOwner(input: ReadMailboxMessagesInput, ctx: RuntimeMethodContext): Promise<MailboxMessagesPage> {
    const db = await this.readyOwner(ctx);
    this.startPeerRepair(db, ctx);
    const history = this.historyCoverage(db, input.peerOnly);
    if (input.generation !== undefined && input.generation !== history.generation) {
      return { items: [], history, cursorExpired: true };
    }
    const rows = await db.compoundRange(PEER_INDEX_NAME, input.group, {
      lt: input.before, reverse: true, limit: input.limit + 1,
    });
    const items: MailboxMessageRecord[] = [];
    const pointers = rows.slice(0, input.limit).map((row) => row.value as PeerIndexDoc);
    const groups = new Map<string, PeerIndexDoc[]>();
    for (const pointer of pointers) {
      const group = groups.get(pointer.partition) ?? [];
      group.push(pointer);
      groups.set(pointer.partition, group);
    }
    const docs = new Map<string, StoredDoc | undefined>();
    for (const [partition, group] of groups) {
      throwIfAborted(ctx.signal);
      const values = await db.partitionMget(partition, group.map((pointer) => pointer.messageKey));
      group.forEach((pointer, i) => docs.set(pointer.messageKey, values[i]));
    }
    for (const pointer of pointers) {
      throwIfAborted(ctx.signal);
      const doc = asMessage(docs.get(pointer.messageKey));
      if (doc === undefined || doc.message.producer.kind === 'external_client') continue;
      items.push({ message: doc.message, delivery: publicDeliveryState(doc.state), reason: doc.reason, reasonCode: doc.reasonCode, order: pointer.peerOrder });
    }
    throwIfAborted(ctx.signal);
    this.assertOwnerContext(ctx);
    const latest = this.historyCoverage(db, input.peerOnly);
    if (latest.generation !== history.generation && input.generation !== undefined) {
      return { items: [], history: latest, cursorExpired: true };
    }
    return { items, history: latest.generation === history.generation ? latest : history,
      nextBefore: rows.length > input.limit ? rows[input.limit - 1]?.orderValue as string : undefined };
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
    reason: string | { readonly code: ThreadDeliveryReasonCode; readonly detail: string },
    options?: ThreadMailboxMutationOptions,
  ): Promise<boolean> {
    return this.call(
      THREAD_MAILBOX_RUNTIME_METHODS.undeliverable,
      { claim, reason: typeof reason === 'string' ? reason : reason.detail,
        reasonCode: typeof reason === 'string' ? undefined : reason.code },
      options,
    ) as Promise<boolean>;
  }

  cancelProducer(
    producer: Extract<ThreadMessageProducer, { readonly kind: 'room' }>,
    options?: ThreadMailboxMutationOptions,
  ): Promise<number> {
    return this.call(
      THREAD_MAILBOX_RUNTIME_METHODS.cancelProducer,
      { producer },
      options,
    ) as Promise<number>;
  }

  listPendingTargets(options?: ThreadMailboxMutationOptions & { readonly targets?: readonly ThreadRef[] }): Promise<readonly ThreadRef[]> {
    return this.call(
      THREAD_MAILBOX_RUNTIME_METHODS.pendingTargets,
      options?.targets ?? null,
      options,
      this.startupCallTimeoutMs,
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
    timeoutMs = (method === THREAD_MAILBOX_RUNTIME_METHODS.readMessages
      ? this.initializedPeerReadCallEpoch
      : this.initializedCallEpoch) === this.runtime.status().epoch
      ? this.callTimeoutMs
      : this.startupCallTimeoutMs,
  ): Promise<unknown> {
    if (this.closing) throw new Error('Thread mailbox store is closed.');
    const requestId = options?.requestId ?? randomUUID();
    const totalTimeoutMs = timeoutMs * CALL_TOTAL_TIMEOUT_MULTIPLIER;
    const deadlineAt = Date.now() + totalTimeoutMs;
    let phase = 'ready';
    let lastRetryError: unknown;
    const deadlineError = (): HomeRuntimeError => {
      const status = this.runtime.status();
      const lastCode = lastRetryError instanceof HomeRuntimeError ? lastRetryError.code : 'none';
      return new HomeRuntimeError('runtime.timeout',
        `thread mailbox call timed out after ${totalTimeoutMs}ms (method=${method}, phase=${phase}, role=${status.role}, ready=${status.ready}, epoch=${status.epoch}, lastRetry=${lastCode})`,
        { cause: lastRetryError });
    };
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError()), totalTimeoutMs);
    deadlineTimer.unref?.();
    const callerSignal = combineAbortSignals(this.closeController.signal, options?.signal);
    const signal = combineAbortSignals(callerSignal, deadlineController.signal);
    try {
      for (;;) {
        throwIfAborted(signal);
        const readyBudgetMs = deadlineAt - Date.now();
        if (readyBudgetMs <= 0) throw deadlineError();
        try {
          phase = 'ready';
          await abortable(this.runtime.ready(), signal);
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs <= 0) throw deadlineError();
          const epoch = this.runtime.status().epoch;
          phase = 'call';
          const result = await this.runtime.call(method, payload, {
            requestId,
            timeoutMs: Math.min(timeoutMs, remainingMs),
            signal,
          });
          this.initializedCallEpoch = epoch;
          if (method === THREAD_MAILBOX_RUNTIME_METHODS.readMessages) this.initializedPeerReadCallEpoch = epoch;
          return result;
        } catch (error) {
          throwIfAborted(signal);
          if (!isRetryableMailboxRuntimeResponse(error)) throw error;
          lastRetryError = error;
          phase = 'backoff';
          const backoffMs = Math.min(CALL_RETRY_BACKOFF_MS, deadlineAt - Date.now());
          if (backoffMs <= 0) throw deadlineError();
          await abortable(delay(backoffMs), signal);
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
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
          await abortable(current.promise, ctx.signal);
        } catch (error) {
          throwIfAborted(ctx.signal);
          if (current.epoch === ctx.epoch) throw error;
        }
        continue;
      }
      const controller = new AbortController();
      const signal = combineAbortSignals(this.closeController.signal, controller.signal);
      const promise = this.initializeOwner({ ...ctx, signal }).finally(() => {
        if (this.initialization === flight) this.initialization = undefined;
      });
      const flight = { epoch: ctx.epoch, controller, promise };
      this.initialization = flight;
      void promise.catch(() => {});
      await abortable(promise, ctx.signal);
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
          valueMode: 'disk',
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
        await this.ensurePeerIndex(openedDb);
        await this.loadPeerCoverage(openedDb, !existingTopology);
        throwIfAborted(ctx.signal);
        this.assertOwnerContext(ctx);
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

  private async ensurePeerIndex(db: ClusterDb<StoredDoc>): Promise<void> {
    if (!(await db.listCompoundIndexes()).some((index) => index.name === PEER_INDEX_NAME)) {
      await db.createCompoundIndex(PEER_INDEX_NAME, { groupBy: 'peerGroup', orderBy: 'peerOrder', orderType: 'string' });
    }
  }

  private async loadPeerCoverage(db: ClusterDb<StoredDoc>, fresh: boolean): Promise<void> {
    const v2 = await db.partitionGet(SYSTEM_PARTITION, PEER_INDEX_MARKER);
    const v1 = await db.partitionGet(SYSTEM_PARTITION, PEER_INDEX_V1_MARKER);
    const marker = v2?.kind === 'peer_index_marker' ? v2 : undefined;
    const prior = v1?.kind === 'peer_index_marker' ? v1 : undefined;
    this.peerIndexError = undefined;
    this.peerCoverage = {
      kind: 'peer_index_marker', after: marker?.after ?? 't/',
      complete: fresh || marker?.complete === true,
      generation: marker?.complete ? marker.generation ?? 'peer-index-v2-complete' : randomUUID(),
      shard: marker?.shard ?? 0, shardAfter: marker?.shardAfter,
      processedMessages: marker?.processedMessages ?? 0,
      peerComplete: marker?.peerComplete ?? prior?.complete === true,
      inheritedPeerAfter: marker?.inheritedPeerAfter ?? prior?.after,
    };
    if (marker?.complete !== true) {
      await db.partitionBatch(SYSTEM_PARTITION, [{ op: 'set', key: PEER_INDEX_MARKER, value: this.peerCoverage }]);
    }
  }

  private historyCoverage(db: ClusterDb<StoredDoc>, peerOnly = false): NonNullable<MailboxMessagesPage['history']> {
    const coverage = this.peerCoverage!;
    const complete = coverage.complete || peerOnly && coverage.peerComplete === true;
    return {
      generation: peerOnly && coverage.peerComplete ? 'peer-index-v1-complete' : coverage.generation!,
      state: complete ? 'complete' : this.peerIndexError === undefined ? 'preparing' : 'error',
      processedMessages: coverage.processedMessages ?? 0,
      completedShards: coverage.complete ? db.shardCount : coverage.shard ?? 0,
      totalShards: db.shardCount,
      pending: complete ? undefined : coverage.peerComplete ? 'room' : 'all',
      error: complete ? undefined : this.peerIndexError,
    };
  }

  private startPeerRepair(db: ClusterDb<StoredDoc>, ctx: RuntimeMethodContext): void {
    if (this.peerCoverage?.complete || this.peerIndexInitialization !== undefined || this.peerIndexError !== undefined) return;
    const controller = new AbortController();
    const signal = combineAbortSignals(this.closeController.signal, controller.signal);
    const promise = delay(0).then(() => this.preparePeerIndex(db, { ...ctx, signal })).catch((error: unknown) => {
      if (!signal.aborted) this.peerIndexError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (this.peerIndexInitialization === current) this.peerIndexInitialization = undefined;
    });
    const current = { epoch: ctx.epoch, controller, promise };
    this.peerIndexInitialization = current;
  }

  private async preparePeerIndex(db: ClusterDb<StoredDoc>, ctx: RuntimeMethodContext): Promise<void> {
    let checkpoint = this.peerCoverage!;
    let processedMessages = checkpoint.processedMessages ?? 0;
    let sinceCheckpoint = 0;
    let checkpointAt = Date.now();
    let sliceAt = Date.now();
    const publish = async (shard: number, shardAfter?: string, complete = false): Promise<void> => {
      throwIfAborted(ctx.signal);
      this.assertOwnerContext(ctx);
      checkpoint = { ...checkpoint, shard, shardAfter, processedMessages, complete,
        generation: complete ? randomUUID() : this.peerCoverage!.generation };
      await db.partitionBatch(SYSTEM_PARTITION, [{ op: 'set', key: PEER_INDEX_MARKER, value: checkpoint }]);
      this.peerCoverage = checkpoint;
      sinceCheckpoint = 0;
      checkpointAt = Date.now();
    };
    for (let shard = checkpoint.shard ?? 0; shard < db.shardCount; shard++) {
      let after = shard === checkpoint.shard ? checkpoint.shardAfter ?? checkpoint.after : checkpoint.after;
      for (;;) {
        throwIfAborted(ctx.signal);
        this.assertOwnerContext(ctx);
        const keys = await db.shardScanKeys(shard, { gt: after, lt: 't0', count: 2048 });
        if (keys.length === 0) break;
        const messages = new Map<string, string[]>();
        for (const key of keys) {
          if (!/^t\/[^/]+\/message\/\d+$/.test(key)) continue;
          const partition = key.slice(0, key.indexOf('/message/'));
          const list = messages.get(partition) ?? [];
          list.push(key);
          messages.set(partition, list);
        }
        for (const [partition, messageKeys] of messages) {
          await this.withPartition(partition, ctx, async () => {
            const ops: BatchInputOp<StoredDoc>[] = [];
            const values = await db.partitionMget(partition, messageKeys);
            for (const [i, key] of messageKeys.entries()) {
              if (Date.now() - sliceAt >= 8) { await delay(0); sliceAt = Date.now(); }
              throwIfAborted(ctx.signal);
              this.assertOwnerContext(ctx);
              const doc = asMessage(values[i]);
              if (doc === undefined) continue;
              processedMessages++;
              sinceCheckpoint++;
              if (doc.message.producer.kind === 'peer_thread' && (checkpoint.peerComplete ||
                  checkpoint.inheritedPeerAfter !== undefined && key <= checkpoint.inheritedPeerAfter)) continue;
              const expectedOps = peerIndexOps(partition, doc.message);
              const pointers = await db.partitionMget(partition, expectedOps.map((op) => op.key));
              for (const [j, op] of expectedOps.entries()) {
                if (op.op !== 'set') continue;
                const expected = op.value as PeerIndexDoc;
                const current = pointers[j];
                if (current?.kind !== 'peer_index' || current.peerGroup !== expected.peerGroup ||
                    current.peerOrder !== expected.peerOrder || current.partition !== expected.partition ||
                    current.messageKey !== expected.messageKey) ops.push(op);
              }
            }
            if (ops.length > 0) {
              throwIfAborted(ctx.signal);
              this.assertOwnerContext(ctx);
              await db.partitionBatch(partition, ops);
              this.peerCoverage = { ...this.peerCoverage!, generation: randomUUID() };
            }
          });
          if (Date.now() - sliceAt >= 8) { await delay(0); sliceAt = Date.now(); }
        }
        after = keys.at(-1)!;
        if (sinceCheckpoint >= 128 || sinceCheckpoint > 0 && Date.now() - checkpointAt >= 250) {
          await publish(shard, after);
        }
        if (Date.now() - sliceAt >= 8) { await delay(0); sliceAt = Date.now(); }
      }
      await publish(shard + 1);
    }
    await publish(db.shardCount, undefined, true);
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
    return this.withPartition(partition, ctx, async () => {
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
    reasonCode?: ThreadDeliveryReasonCode,
  ): Promise<boolean> {
    const method = state === 'delivered'
      ? THREAD_MAILBOX_RUNTIME_METHODS.acknowledge
      : THREAD_MAILBOX_RUNTIME_METHODS.undeliverable;
    const partition = targetPartition(claim.message.target);
    const input = state === 'delivered' ? claim : { claim, reason, reasonCode };
    return this.withPartition(partition, ctx, async () => {
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
            reasonCode,
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

  private async pendingTargetsOwner(ctx: RuntimeMethodContext, selected?: readonly ThreadRef[]): Promise<readonly ThreadRef[]> {
    const db = await this.readyOwner(ctx);
    if (selected !== undefined) {
      const pending: ThreadRef[] = [];
      for (const target of selected) {
        const partition = targetPartition(target);
        const meta = asTargetMeta(await db.partitionGet(partition, targetMetaKey(partition)));
        if (meta !== undefined && meta.pendingCount > 0) { assertThreadIdentity(meta.target, target, partition); pending.push(target); }
      }
      return pending;
    }
    const entries = await db.prefix('t/');
    const targets = new Map<string, ThreadRef>();
    for (const entry of entries) {
      const meta = asTargetMeta(entry.value);
      if (meta === undefined || meta.pendingCount === 0) continue;
      targets.set(threadIdentity(meta.target), meta.target);
    }
    return [...targets.values()];
  }

  private async cancelProducerOwner(
    input: CancelProducerPayload,
    ctx: RuntimeMethodContext,
  ): Promise<number> {
    const db = await this.readyOwner(ctx);
    const method = THREAD_MAILBOX_RUNTIME_METHODS.cancelProducer;
    const receiptKey = `${SYSTEM_PARTITION}/receipt/${hashJson({ method, callerHostId: ctx.callerHostId, requestId: ctx.requestId })}`;
    const receipt = readReceipt(await db.partitionGet(SYSTEM_PARTITION, receiptKey), receiptKey, method, ctx, input);
    if (receipt !== undefined) return receipt.result as number;
    let cancelled = 0;
    const metas = (await db.prefix('t/'))
      .map((entry) => asTargetMeta(entry.value))
      .filter((meta): meta is TargetMetaDoc => meta !== undefined);
    for (const meta of metas) {
      const partition = targetPartition(meta.target);
      await this.withPartition(partition, ctx, async () => {
        const messages = (await db.partitionPrefix(partition, targetMessagePrefix(partition)))
          .map((entry) => ({ key: entry.key, message: asMessage(entry.value) }))
          .filter((entry): entry is { readonly key: string; readonly message: MessageDoc } => entry.message !== undefined);
        const matching = messages.filter((entry) =>
          entry.message.state === 'pending' && sameProducer(entry.message.message.producer, input.producer),
        );
        if (matching.length === 0) return;
        const currentMeta = asTargetMeta(await db.partitionGet(partition, targetMetaKey(partition)));
        if (currentMeta === undefined) return;
        const ops: BatchInputOp<StoredDoc>[] = matching.map(({ key, message }) => ({
          op: 'set',
          key,
          value: { ...message, state: 'undeliverable', reason: 'room delivery cancelled' },
        }));
        ops.push({
          op: 'set',
          key: targetMetaKey(partition),
          value: { ...currentMeta, pendingCount: Math.max(0, currentMeta.pendingCount - matching.length) },
        });
        await db.partitionBatch(partition, ops);
        cancelled += matching.length;
      });
    }
    await db.partitionBatch(SYSTEM_PARTITION, [buildReceiptOp(receiptKey, method, ctx, input, cancelled, RECEIPT_TTL_MS)]);
    return cancelled;
  }

  private async appendActivityOwner(input: ActivityPayload, ctx: RuntimeMethodContext): Promise<StoredThreadActivity> {
    const partition = targetPartition(input.target);
    return this.withPartition(partition, ctx, async () => {
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
    return this.withPartition(partition, ctx, async () => {
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
    await this.withPartition(partition, ctx, async () => {
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
    await this.withPartition(partition, ctx, async () => {
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

  private withPartition<T>(partition: string, ctx: RuntimeMethodContext, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueuePartitionOperation(partition, {
        kind: 'operation',
        ctx,
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  private enqueuePartitionOperation(partition: string, operation: PartitionQueueOperation): void {
    if (operation.ctx.signal.aborted) {
      operation.reject(abortError(operation.ctx.signal));
      return;
    }
    let queue = this.partitionQueues.get(partition);
    if (queue === undefined) {
      queue = { operations: [], running: false };
      this.partitionQueues.set(partition, queue);
    }
    queue.operations.push(operation);
    const onAbort = (): void => {
      const index = queue.operations.indexOf(operation);
      if (index < 0) return;
      queue.operations.splice(index, 1);
      this.detachPartitionAbortListener(operation);
      operation.reject(abortError(operation.ctx.signal));
    };
    operation.ctx.signal.addEventListener('abort', onAbort, { once: true });
    this.partitionAbortListeners.set(operation, onAbort);
    if (queue.running) return;
    queue.running = true;
    void this.runPartitionQueue(partition, queue);
  }

  private takePartitionOperation(queue: PartitionQueue): PartitionQueueOperation {
    const operation = queue.operations.shift()!;
    this.detachPartitionAbortListener(operation);
    return operation;
  }

  private detachPartitionAbortListener(operation: PartitionQueueOperation): void {
    const listener = this.partitionAbortListeners.get(operation);
    if (listener === undefined) return;
    operation.ctx.signal.removeEventListener('abort', listener);
    this.partitionAbortListeners.delete(operation);
  }

  private async runPartitionQueue(partition: string, queue: PartitionQueue): Promise<void> {
    while (queue.operations.length > 0) {
      const operation = this.takePartitionOperation(queue);
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
        batch.push(this.takePartitionOperation(queue) as AcceptPartitionOperation);
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
            payloadConflict: prior.payloadHash !== payloadHash(input.content, input.producer),
          }
        : {
            message: delivery.message,
            deduplicated: true,
            delivery: publicDeliveryState(delivery.state),
            payloadConflict: prior.payloadHash !== payloadHash(input.content, input.producer),
          };
      return { result, ops: [this.receiptOp(receiptKey, method, ctx, input, result)] };
    }
    const metaKey = targetMetaKey(partition);
    const meta = asTargetMeta(await read(metaKey)) ?? newTargetMeta(input.target);
    assertThreadIdentity(meta.target, input.target, metaKey);
    const pendingLimit = Math.min(PENDING_HARD_LIMIT, input.pendingLimit ?? PENDING_HARD_LIMIT);
    if (meta.pendingCount >= pendingLimit) throw new ThreadMailboxBacklogError(pendingLimit);
    const rates = { ...meta.rates };
    if (input.rateLimit !== undefined) {
      const recent = (rates[input.rateLimit.key] ?? []).filter((at) => at > Date.now() - input.rateLimit!.windowMs);
      if (recent.length >= input.rateLimit.count) throw new ThreadMailboxBacklogError(input.rateLimit.count);
      rates[input.rateLimit.key] = [...recent, Date.now()];
    }
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
    const hash = payloadHash(input.content, input.producer);
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
        value: { ...meta, rates, nextMessageSeq: meta.nextMessageSeq + 1, pendingCount: meta.pendingCount + 1 },
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
      ...peerIndexOps(partition, message),
    ];
    const pruneKey = targetMessageKey(partition, message.targetSeq - MESSAGE_RETAINED_LIMIT);
    const prune = asMessage(await read(pruneKey));
    if (prune !== undefined && prune.message.producer.kind === 'external_client' && isTerminalState(prune.state)) {
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
      for (const entry of existingMessages) {
        for (const op of peerIndexOps(partition, entry.value.message)) {
          if (op.op !== 'set') continue;
          const expected = op.value as PeerIndexDoc;
          const current = await db.partitionGet(partition, op.key);
          if (current?.kind !== 'peer_index' || current.peerGroup !== expected.peerGroup ||
              current.peerOrder !== expected.peerOrder || current.partition !== expected.partition ||
              current.messageKey !== expected.messageKey) ops.push(op);
        }
      }
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
        ops.push(...peerIndexOps(partition, message));
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
    for (const initialization of [this.initialization, this.peerIndexInitialization]) {
      if (initialization !== undefined && (epoch === undefined || initialization.epoch === epoch)) {
        initialization.controller.abort(new HomeRuntimeError('runtime.owner_gone', 'runtime owner epoch is no longer active'));
      }
    }
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
    const initializations = [this.initialization, this.peerIndexInitialization]
      .filter((flight): flight is OwnerInitialization => flight !== undefined && (epoch === undefined || flight.epoch === epoch));
    await Promise.allSettled(initializations.map((flight) => flight.promise));
    const operations = [...this.ownerOperations]
      .filter(([, operationEpoch]) => epoch === undefined || operationEpoch === epoch)
      .map(([operation]) => operation);
    await Promise.allSettled(operations);
    this.peerCoverage = undefined;
    this.peerIndexError = undefined;
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
        await registration.dispose();
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
  const producer = input.producer.kind === 'bridged_peer' ? { kind: input.producer.kind,
    bridgeId: input.producer.bridgeId, sourceHomeId: input.producer.sourceHomeId, source: input.producer.source } : input.producer;
  return `${partition}/idempotency/${hashJson({ producer, target: input.target, key: input.idempotencyKey })}`;
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

function payloadHash(content: string, producer?: ThreadMessageProducer): string {
  return producer?.kind === 'bridged_peer' ? hashJson({ content, producer }) : hashJson({ content });
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
  if (left.kind === 'external_client' && right.kind === 'external_client') return true;
  if (left.kind === 'bridged_peer' && right.kind === 'bridged_peer') return JSON.stringify(left) === JSON.stringify(right);
  if (left.kind === 'peer_thread' && right.kind === 'peer_thread') return sameThread(left.source, right.source);
  return left.kind === 'room' && right.kind === 'room' && left.roomId === right.roomId && left.generation === right.generation;
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
  let rateLimit: AcceptPayload['rateLimit'];
  if (input['rateLimit'] !== undefined) {
    const raw = assertRecord(input['rateLimit']);
    const count = finitePositiveInteger(raw['count']); const windowMs = finitePositiveInteger(raw['windowMs']);
    if (typeof raw['key'] !== 'string' || raw['key'].length > 256 || count === undefined || count > 600 || windowMs === undefined || windowMs > 60000) throw new TypeError('Invalid rate limit.');
    rateLimit = { key: raw['key'], count, windowMs };
  }
  return { producer, target, content: input['content'], idempotencyKey: input['idempotencyKey'], pendingLimit: pendingLimit as number | undefined, rateLimit };
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
  const reasonCode = input['reasonCode'];
  if (reasonCode !== undefined && !THREAD_DELIVERY_REASON_CODES.includes(reasonCode as ThreadDeliveryReasonCode)) {
    throw new TypeError('Invalid undeliverable reason code.');
  }
  return { claim: assertClaim(input['claim']), reason: input['reason'], reasonCode: reasonCode as ThreadDeliveryReasonCode | undefined };
}

function assertCancelProducerPayload(value: unknown): CancelProducerPayload {
  const input = assertRecord(value);
  const producer = asProducer(input['producer']);
  if (producer === undefined || producer.kind !== 'room') throw new TypeError('Invalid room producer.');
  return { producer };
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
  return {
    hostId: ref['hostId'],
    workspaceId: ref['workspaceId'],
    sessionId: ref['sessionId'],
    personaId: typeof ref['personaId'] === 'string' ? ref['personaId'] : undefined,
    name: typeof ref['name'] === 'string' ? ref['name'] : undefined,
  };
}

function asProducer(value: unknown): ThreadMessageProducer | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const producer = value as Record<string, unknown>;
  if (producer['kind'] === 'external_client') return { kind: 'external_client' };
  if (producer['kind'] === 'bridged_peer') {
    const source = asThreadRef(producer['source']);
    if (source === undefined || !['sourceHomeId', 'targetHomeId', 'bridgeId', 'causeId'].every((key) => typeof producer[key] === 'string') ||
      !['revision', 'createdAt', 'expiresAt', 'sourceSeq', 'hop'].every((key) => finiteNonNegativeInteger(producer[key]) !== undefined) ||
      !['local', 'network'].includes(String(producer['location']))) return undefined;
    return { kind: 'bridged_peer', source, sourceHomeId: producer['sourceHomeId'] as string,
      targetHomeId: producer['targetHomeId'] as string, bridgeId: producer['bridgeId'] as string,
      revision: producer['revision'] as number, location: producer['location'] as 'local' | 'network',
      createdAt: producer['createdAt'] as number, expiresAt: producer['expiresAt'] as number,
      sourceSeq: producer['sourceSeq'] as number, causeId: producer['causeId'] as string, hop: producer['hop'] as number };
  }
  if (producer['kind'] === 'peer_thread') {
    const source = asThreadRef(producer['source']);
    if (source !== undefined) return {
      kind: 'peer_thread',
      source,
      sender: asSender(producer['sender']),
      allowWhenDisabled: producer['allowWhenDisabled'] === true,
    };
  }
  if (producer['kind'] === 'room' && typeof producer['roomId'] === 'string' && (producer['targeted'] === undefined || typeof producer['targeted'] === 'boolean')) {
    const generation = producer['generation'];
    if (generation === undefined || finiteNonNegativeInteger(generation) !== undefined) {
      return {
        kind: 'room',
        roomId: producer['roomId'],
        targeted: producer['targeted'] as boolean | undefined,
        queueWhenBusy: typeof producer['queueWhenBusy'] === 'boolean' ? producer['queueWhenBusy'] : undefined,
        requireCommunication: typeof producer['requireCommunication'] === 'boolean' ? producer['requireCommunication'] : undefined,
        generation: generation as number | undefined,
        sender: asSender(producer['sender']),
      };
    }
  }
  return undefined;
}

function asSender(value: unknown): { readonly sessionId: string; readonly personaId?: string; readonly name?: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const sender = value as Record<string, unknown>;
  if (typeof sender['sessionId'] !== 'string' || sender['sessionId'].length === 0) return undefined;
  return {
    sessionId: sender['sessionId'],
    personaId: typeof sender['personaId'] === 'string' ? sender['personaId'] : undefined,
    name: typeof sender['name'] === 'string' ? sender['name'] : undefined,
  };
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Thread mailbox operation aborted.');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function combineAbortSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  return secondary === undefined ? primary : AbortSignal.any([primary, secondary]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
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

function isRetryableMailboxRuntimeResponse(error: unknown): boolean {
  return error instanceof HomeRuntimeError && (
    error.code === 'runtime.connection_failed' ||
    error.code === 'runtime.owner_gone' ||
    error.code === 'runtime.detached' ||
    error.code === 'runtime.timeout' ||
    error.code === 'runtime.epoch_stale' ||
    error.code === 'runtime.epoch_future' ||
    error.code === 'runtime.duplicate_request'
  );
}

registerScopedService(
  LifecycleScope.App,
  IThreadMailboxStore,
  RuntimeThreadMailboxStore,
  ScopeActivation.OnScopeCreated,
  'threadCommunication',
);

function peerIndexOps(partition: string, message: AcceptedThreadMessage): BatchInputOp<StoredDoc>[] {
  if (message.producer.kind === 'external_client') return [];
  const groups = new Set(['all', `session:${message.target.sessionId}`, `workspace:${message.target.workspaceId}`]);
  if (message.producer.kind === 'peer_thread') {
    groups.add(`session:${message.producer.source.sessionId}`);
    groups.add(`workspace:${message.producer.source.workspaceId}`);
  }
  const order = `${message.acceptedAt.toString().padStart(16, '0')}/${message.messageId}`;
  return [...groups].map((group) => ({
    op: 'set',
    key: `${partition}/peer/${createHash('sha256').update(JSON.stringify([group, message.messageId])).digest('base64url')}`,
    value: { kind: 'peer_index', peerGroup: group, peerOrder: order, partition,
      messageKey: targetMessageKey(partition, message.targetSeq) },
  }));
}
