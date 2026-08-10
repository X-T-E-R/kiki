/**
 * `threadCommunication` domain — MiniDb mailbox persistence backend.
 *
 * Uses a strict-recovery, fsync-on-every-write MiniDb under an
 * operation-scoped exclusive writer lock. Scope-agnostic.
 */

import { createHash, randomUUID } from 'node:crypto';

import { LockError, MiniDb, type BatchInputOp } from '@moonshot-ai/minidb';

import type { ThreadActivityKind, ThreadRef } from './threadCommunication';
import type {
  AcceptedThreadMessage,
  StoredThreadActivity,
  ThreadActivityPage,
  ThreadDeliveryAttempt,
  ThreadMessageAcceptance,
  ThreadMessageProducer,
} from './threadMailboxStore';
import { ThreadActivityCursorExpiredError, ThreadMailboxBacklogError } from './mailboxErrors';

const MAILBOX_BACKLOG_LIMIT = 512;
const ACTIVITY_BACKLOG_LIMIT = 256;
const LOCK_TIMEOUT_MS = 30_000;

interface MailboxMetaDoc {
  readonly kind: 'mailbox_meta';
  readonly target: ThreadRef;
  readonly epoch: string;
  readonly nextSeq: number;
  readonly minSeq: number;
  readonly pendingCount: number;
}

interface MessageEventDoc {
  readonly kind: 'message_event';
  readonly target: ThreadRef;
  readonly event: 'accepted' | 'delivery_attempt' | 'delivered' | 'undeliverable';
  readonly seq: number;
  readonly at: number;
  readonly messageId: string;
  readonly idempotencyStorageKey?: string;
  readonly attemptId?: string;
  readonly reason?: string;
}

interface IdempotencyDoc {
  readonly kind: 'idempotency';
  readonly producer?: ThreadMessageProducer;
  readonly source?: ThreadRef;
  readonly target: ThreadRef;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly messageId: string;
}

interface DeliveryDoc {
  readonly kind: 'delivery';
  readonly message: AcceptedThreadMessage;
  readonly idempotencyStorageKey: string;
  readonly state: 'pending' | 'delivering' | 'delivered' | 'undeliverable';
  readonly attempt: number;
  readonly activeAttemptId?: string;
}

interface ActivityMetaDoc {
  readonly kind: 'activity_meta';
  readonly target: ThreadRef;
  readonly epoch: string;
  readonly nextSeq: number;
  readonly minSeq: number;
}

interface ActivityEventDoc {
  readonly kind: 'activity_event';
  readonly target: ThreadRef;
  readonly activity: StoredThreadActivity;
}

interface WorkspaceOverrideDoc {
  readonly kind: 'workspace_override';
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

type StoredDoc =
  | MailboxMetaDoc
  | MessageEventDoc
  | IdempotencyDoc
  | DeliveryDoc
  | ActivityMetaDoc
  | ActivityEventDoc
  | WorkspaceOverrideDoc;

export class MiniDbMailboxBackend {
  private readonly mailboxBacklogLimit: number;
  private readonly activityBacklogLimit: number;
  private readonly pendingMessageLimit: number;

  constructor(
    private readonly dir: string,
    options: {
      readonly mailboxBacklogLimit?: number;
      readonly activityBacklogLimit?: number;
      readonly pendingMessageLimit?: number;
    } = {},
  ) {
    this.mailboxBacklogLimit = options.mailboxBacklogLimit ?? MAILBOX_BACKLOG_LIMIT;
    this.activityBacklogLimit = options.activityBacklogLimit ?? ACTIVITY_BACKLOG_LIMIT;
    this.pendingMessageLimit = options.pendingMessageLimit ?? MAILBOX_BACKLOG_LIMIT;
  }

  async acceptMessage(input: {
    readonly producer: ThreadMessageProducer;
    readonly target: ThreadRef;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<ThreadMessageAcceptance> {
    return this.withDb(async (db) => {
      const payloadHash = hashJson({ content: input.content });
      const idempotencyStorageKey = idempotencyKeyOf(input);
      const legacyStorageKey = input.producer.kind === 'peer_thread'
        ? legacyIdempotencyKeyOf({
            source: input.producer.source,
            target: input.target,
            idempotencyKey: input.idempotencyKey,
          })
        : undefined;
      const prior = asIdempotency(db.get(idempotencyStorageKey)) ??
        (legacyStorageKey === undefined ? undefined : asIdempotency(db.get(legacyStorageKey)));
      if (prior !== undefined) {
        assertIdempotencyIdentity(prior, input);
        const delivery = asDelivery(db.get(deliveryKey(prior.messageId)));
        if (delivery === undefined) {
          return {
            message: missingDeliveryMessage(input, prior.messageId),
            deduplicated: true,
            delivery: 'undeliverable',
            payloadConflict: prior.payloadHash !== payloadHash,
          };
        }
        return {
          message: delivery.message,
          deduplicated: true,
          delivery: publicDeliveryState(delivery.state),
          payloadConflict: prior.payloadHash !== payloadHash,
        };
      }

      const targetKey = threadKey(input.target);
      const metaKey = mailboxMetaKey(targetKey);
      const meta = mailboxMeta(db, metaKey, input.target);
      if (meta.pendingCount >= this.pendingMessageLimit) {
        throw new ThreadMailboxBacklogError(this.pendingMessageLimit);
      }
      const seq = meta.nextSeq;
      const acceptedAt = Date.now();
      const messageId = randomUUID();
      const message: AcceptedThreadMessage = {
        messageId,
        producer: input.producer,
        target: input.target,
        content: input.content,
        idempotencyKey: input.idempotencyKey,
        acceptedAt,
        targetSeq: seq,
      };
      const event: MessageEventDoc = {
        kind: 'message_event',
        target: input.target,
        event: 'accepted',
        seq,
        at: acceptedAt,
        messageId,
        idempotencyStorageKey,
      };
      const ops: BatchInputOp<StoredDoc>[] = [
        {
          op: 'set',
          key: metaKey,
          value: {
            ...advanceMeta(meta, this.mailboxBacklogLimit),
            pendingCount: meta.pendingCount + 1,
          },
        },
        { op: 'set', key: mailboxEventKey(targetKey, seq), value: event },
        {
          op: 'set',
          key: idempotencyStorageKey,
          value: {
            kind: 'idempotency',
            producer: input.producer,
            target: input.target,
            idempotencyKey: input.idempotencyKey,
            payloadHash,
            messageId,
          },
        },
        {
          op: 'set',
          key: deliveryKey(messageId),
          value: {
            kind: 'delivery',
            message,
            idempotencyStorageKey,
            state: 'pending',
            attempt: 0,
          },
        },
      ];
      this.addMailboxPruneOps(db, ops, targetKey, meta, seq);
      await db.batch(ops);
      return { message, deduplicated: false, delivery: 'pending', payloadConflict: false };
    });
  }

  async beginDelivery(messageId: string): Promise<ThreadDeliveryAttempt | undefined> {
    return this.withDb(async (db) => {
      const key = deliveryKey(messageId);
      const delivery = asDelivery(db.get(key));
      if (delivery === undefined || delivery.state === 'delivered' || delivery.state === 'undeliverable') {
        return undefined;
      }
      const attemptId = randomUUID();
      const attempt = delivery.attempt + 1;
      const next: DeliveryDoc = {
        ...delivery,
        state: 'delivering',
        attempt,
        activeAttemptId: attemptId,
      };
      const ops = this.mailboxEventOps(db, delivery.message.target, {
        event: 'delivery_attempt',
        messageId,
        attemptId,
        idempotencyStorageKey: delivery.idempotencyStorageKey,
      });
      ops.push({ op: 'set', key, value: next });
      await db.batch(ops);
      return { message: delivery.message, attemptId, attempt };
    });
  }

  async acknowledgeDelivery(messageId: string, attemptId: string): Promise<boolean> {
    return this.finishDelivery(messageId, attemptId, 'delivered');
  }

  async markUndeliverable(messageId: string, attemptId: string, reason: string): Promise<boolean> {
    return this.finishDelivery(messageId, attemptId, 'undeliverable', reason);
  }

  async listPendingDeliveries(): Promise<readonly AcceptedThreadMessage[]> {
    return this.withDb((db) =>
      db
        .prefix('delivery/', Number.POSITIVE_INFINITY)
        .map((entry) => asDelivery(entry.value))
        .filter((entry): entry is DeliveryDoc =>
          entry !== undefined && (entry.state === 'pending' || entry.state === 'delivering'),
        )
        .map((entry) => entry.message),
    );
  }

  async appendActivity(input: {
    readonly target: ThreadRef;
    readonly kind: ThreadActivityKind;
    readonly reason: string;
    readonly turnId?: number;
    readonly messageId?: string;
  }): Promise<StoredThreadActivity> {
    return this.withDb(async (db) => {
      const targetKey = threadKey(input.target);
      const metaKey = activityMetaKey(targetKey);
      const meta = asActivityMeta(db.get(metaKey)) ?? newActivityMeta(input.target);
      assertThreadIdentity(meta.target, input.target, metaKey);
      const activity: StoredThreadActivity = {
        seq: meta.nextSeq,
        epoch: meta.epoch,
        kind: input.kind,
        at: Date.now(),
        reason: input.reason,
        turnId: input.turnId,
        messageId: input.messageId,
      };
      const ops: BatchInputOp<StoredDoc>[] = [
        { op: 'set', key: metaKey, value: advanceActivityMeta(meta, this.activityBacklogLimit) },
        {
          op: 'set',
          key: activityEventKey(targetKey, activity.seq),
          value: { kind: 'activity_event', target: input.target, activity },
        },
      ];
      const pruneSeq = activity.seq - this.activityBacklogLimit;
      if (pruneSeq >= meta.minSeq) {
        ops.push({ op: 'del', key: activityEventKey(targetKey, pruneSeq) });
      }
      await db.batch(ops);
      return activity;
    });
  }

  async readActivity(target: ThreadRef, afterSeq: number, limit: number): Promise<ThreadActivityPage> {
    return this.withDb(async (db) => {
      const targetKey = threadKey(target);
      const metaKey = activityMetaKey(targetKey);
      let meta = asActivityMeta(db.get(metaKey));
      if (meta === undefined) {
        meta = newActivityMeta(target);
        await db.batch([{ op: 'set', key: metaKey, value: meta }]);
      }
      assertThreadIdentity(meta.target, target, metaKey);
      if (
        afterSeq !== Number.MAX_SAFE_INTEGER &&
        afterSeq < meta.minSeq - 1
      ) {
        throw new ThreadActivityCursorExpiredError(meta.epoch, meta.minSeq, meta.nextSeq - 1);
      }
      const start = Math.max(afterSeq + 1, meta.minSeq);
      const activities: StoredThreadActivity[] = [];
      for (let seq = start; seq < meta.nextSeq && activities.length < limit; seq++) {
        const event = asActivityEvent(db.get(activityEventKey(targetKey, seq)));
        if (event !== undefined) {
          assertThreadIdentity(event.target, target, activityEventKey(targetKey, seq));
          activities.push(event.activity);
        }
      }
      return { epoch: meta.epoch, latestSeq: meta.nextSeq - 1, activities };
    });
  }

  async getWorkspaceOverride(workspaceId: string): Promise<boolean | undefined> {
    return this.withDb((db) => {
      const key = workspaceOverrideKey(workspaceId);
      const override = asWorkspaceOverride(db.get(key));
      if (override !== undefined) assertWorkspaceIdentity(override.workspaceId, workspaceId, key);
      return override?.enabled;
    });
  }

  async setWorkspaceOverride(workspaceId: string, enabled: boolean): Promise<void> {
    await this.withDb(async (db) => {
      const key = workspaceOverrideKey(workspaceId);
      const prior = asWorkspaceOverride(db.get(key));
      if (prior !== undefined) assertWorkspaceIdentity(prior.workspaceId, workspaceId, key);
      await db.batch([
        {
          op: 'set',
          key,
          value: { kind: 'workspace_override', workspaceId, enabled, updatedAt: Date.now() },
        },
      ]);
    });
  }

  async clearWorkspaceOverride(workspaceId: string): Promise<void> {
    await this.withDb(async (db) => {
      const key = workspaceOverrideKey(workspaceId);
      const prior = asWorkspaceOverride(db.get(key));
      if (prior !== undefined) assertWorkspaceIdentity(prior.workspaceId, workspaceId, key);
      await db.batch([{ op: 'del', key }]);
    });
  }

  private async finishDelivery(
    messageId: string,
    attemptId: string,
    state: 'delivered' | 'undeliverable',
    reason?: string,
  ): Promise<boolean> {
    return this.withDb(async (db) => {
      const key = deliveryKey(messageId);
      const delivery = asDelivery(db.get(key));
      if (
        delivery === undefined ||
        delivery.state !== 'delivering' ||
        delivery.activeAttemptId !== attemptId
      ) {
        return false;
      }
      const next: DeliveryDoc = { ...delivery, state, activeAttemptId: undefined };
      const ops = this.mailboxEventOps(db, delivery.message.target, {
        event: state,
        messageId,
        attemptId,
        reason,
        idempotencyStorageKey: delivery.idempotencyStorageKey,
      }, -1);
      ops.push({ op: 'set', key, value: next });
      await db.batch(ops);
      return true;
    });
  }

  private mailboxEventOps(
    db: MiniDb<StoredDoc>,
    target: ThreadRef,
    input: {
      readonly event: MessageEventDoc['event'];
      readonly messageId: string;
      readonly attemptId?: string;
      readonly reason?: string;
      readonly idempotencyStorageKey?: string;
    },
    pendingDelta = 0,
  ): BatchInputOp<StoredDoc>[] {
    const targetKey = threadKey(target);
    const metaKey = mailboxMetaKey(targetKey);
    const meta = mailboxMeta(db, metaKey, target);
    const seq = meta.nextSeq;
    const event: MessageEventDoc = {
      kind: 'message_event',
      target,
      event: input.event,
      seq,
      at: Date.now(),
      messageId: input.messageId,
      idempotencyStorageKey: input.idempotencyStorageKey,
      attemptId: input.attemptId,
      reason: input.reason,
    };
    const ops: BatchInputOp<StoredDoc>[] = [
      {
        op: 'set',
        key: metaKey,
        value: {
          ...advanceMeta(meta, this.mailboxBacklogLimit),
          pendingCount: Math.max(0, meta.pendingCount + pendingDelta),
        },
      },
      { op: 'set', key: mailboxEventKey(targetKey, seq), value: event },
    ];
    this.addMailboxPruneOps(db, ops, targetKey, meta, seq);
    return ops;
  }

  private addMailboxPruneOps(
    db: MiniDb<StoredDoc>,
    ops: BatchInputOp<StoredDoc>[],
    targetKey: string,
    meta: MailboxMetaDoc,
    seq: number,
  ): void {
    const pruneSeq = seq - this.mailboxBacklogLimit;
    if (pruneSeq < meta.minSeq) return;
    const key = mailboxEventKey(targetKey, pruneSeq);
    const event = asMessageEvent(db.get(key));
    ops.push({ op: 'del', key });
    if (event?.idempotencyStorageKey !== undefined) {
      const delivery = asDelivery(db.get(deliveryKey(event.messageId)));
      if (delivery === undefined || delivery.state === 'pending' || delivery.state === 'delivering') {
        return;
      }
      ops.push({ op: 'del', key: event.idempotencyStorageKey });
      ops.push({ op: 'del', key: deliveryKey(event.messageId) });
    }
  }

  private async withDb<T>(run: (db: MiniDb<StoredDoc>) => T | Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      let db: MiniDb<StoredDoc> | undefined;
      try {
        db = await MiniDb.open<StoredDoc>({
          dir: this.dir,
          valueCodec: 'json',
          valueMode: 'memory',
          fsyncPolicy: 'always',
          recovery: 'strict',
          indexGenerations: false,
          activeExpireIntervalMs: 0,
        });
        return await run(db);
      } catch (error) {
        if (!isRetryableLockError(error) || Date.now() >= deadline) throw error;
        await sleep(10 + Math.floor(Math.random() * 31));
      } finally {
        await db?.close();
      }
    }
  }
}

function threadKey(ref: ThreadRef): string {
  return hashJson({ hostId: ref.hostId, workspaceId: ref.workspaceId, sessionId: ref.sessionId });
}

function idempotencyKeyOf(input: {
  readonly producer: ThreadMessageProducer;
  readonly target: ThreadRef;
  readonly idempotencyKey: string;
}): string {
  return `idem/${hashJson({
    producer: input.producer,
    target: input.target,
    key: input.idempotencyKey,
  })}`;
}

function legacyIdempotencyKeyOf(input: {
  readonly source: ThreadRef;
  readonly target: ThreadRef;
  readonly idempotencyKey: string;
}): string {
  return `idem/${hashJson({ source: input.source, target: input.target, key: input.idempotencyKey })}`;
}

function idempotencyKeyForMessage(message: AcceptedThreadMessage): string {
  return idempotencyKeyOf({
    producer: message.producer,
    target: message.target,
    idempotencyKey: message.idempotencyKey,
  });
}

function deliveryKey(messageId: string): string {
  return `delivery/${messageId}`;
}

function mailboxMetaKey(targetKey: string): string {
  return `mailbox/${targetKey}/meta`;
}

function mailboxEventKey(targetKey: string, seq: number): string {
  return `mailbox/${targetKey}/event/${seq.toString().padStart(16, '0')}`;
}

function activityMetaKey(targetKey: string): string {
  return `activity/${targetKey}/meta`;
}

function activityEventKey(targetKey: string, seq: number): string {
  return `activity/${targetKey}/event/${seq.toString().padStart(16, '0')}`;
}

function workspaceOverrideKey(workspaceId: string): string {
  return `workspace/${hashJson({ workspaceId })}/override`;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function assertIdempotencyIdentity(
  stored: IdempotencyDoc & { readonly producer: ThreadMessageProducer },
  input: {
    readonly producer: ThreadMessageProducer;
    readonly target: ThreadRef;
    readonly idempotencyKey: string;
  },
): void {
  if (
    sameProducer(stored.producer, input.producer) &&
    sameThread(stored.target, input.target) &&
    stored.idempotencyKey === input.idempotencyKey
  ) return;
  throw new Error('Thread mailbox key collision detected for an idempotency record.');
}

function assertThreadIdentity(stored: ThreadRef, expected: ThreadRef, key: string): void {
  if (sameThread(stored, expected)) return;
  throw new Error(`Thread mailbox key collision detected at "${key}".`);
}

function assertWorkspaceIdentity(stored: string, expected: string, key: string): void {
  if (stored === expected) return;
  throw new Error(`Thread mailbox key collision detected at "${key}".`);
}

function sameThread(left: ThreadRef, right: ThreadRef): boolean {
  return left.hostId === right.hostId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId;
}

function sameProducer(left: ThreadMessageProducer, right: ThreadMessageProducer): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'external_client') return true;
  return right.kind === 'peer_thread' && sameThread(left.source, right.source);
}

function newMailboxMeta(target: ThreadRef): MailboxMetaDoc {
  return {
    kind: 'mailbox_meta',
    target,
    epoch: randomUUID(),
    nextSeq: 1,
    minSeq: 1,
    pendingCount: 0,
  };
}

function mailboxMeta(
  db: MiniDb<StoredDoc>,
  key: string,
  target: ThreadRef,
): MailboxMetaDoc {
  const stored = asMailboxMeta(db.get(key));
  if (stored === undefined) return newMailboxMeta(target);
  assertThreadIdentity(stored.target, target, key);
  if (Number.isSafeInteger(stored.pendingCount) && stored.pendingCount >= 0) return stored;
  const pendingCount = db
    .prefix('delivery/', Number.POSITIVE_INFINITY)
    .map((entry) => asDelivery(entry.value))
    .filter((delivery): delivery is DeliveryDoc =>
      delivery !== undefined &&
      (delivery.state === 'pending' || delivery.state === 'delivering') &&
      sameThread(delivery.message.target, target),
    ).length;
  return { ...stored, pendingCount };
}

function advanceMeta(meta: MailboxMetaDoc, limit: number): MailboxMetaDoc {
  const nextSeq = meta.nextSeq + 1;
  return { ...meta, nextSeq, minSeq: Math.max(meta.minSeq, nextSeq - limit) };
}

function newActivityMeta(target: ThreadRef): ActivityMetaDoc {
  return { kind: 'activity_meta', target, epoch: randomUUID(), nextSeq: 1, minSeq: 1 };
}

function advanceActivityMeta(meta: ActivityMetaDoc, limit = ACTIVITY_BACKLOG_LIMIT): ActivityMetaDoc {
  const nextSeq = meta.nextSeq + 1;
  return {
    ...meta,
    nextSeq,
    minSeq: Math.max(meta.minSeq, nextSeq - limit),
  };
}

function publicDeliveryState(
  state: DeliveryDoc['state'],
): ThreadMessageAcceptance['delivery'] {
  if (state === 'delivered') return 'delivered';
  if (state === 'undeliverable') return 'undeliverable';
  return 'pending';
}

function missingDeliveryMessage(
  input: {
    readonly producer: ThreadMessageProducer;
    readonly target: ThreadRef;
    readonly content: string;
    readonly idempotencyKey: string;
  },
  messageId: string,
): AcceptedThreadMessage {
  return {
    messageId,
    producer: input.producer,
    target: input.target,
    content: input.content,
    idempotencyKey: input.idempotencyKey,
    acceptedAt: 0,
    targetSeq: 0,
  };
}

function asMailboxMeta(value: StoredDoc | undefined): MailboxMetaDoc | undefined {
  return value?.kind === 'mailbox_meta' ? value : undefined;
}

function asMessageEvent(value: StoredDoc | undefined): MessageEventDoc | undefined {
  return value?.kind === 'message_event' ? value : undefined;
}

function asIdempotency(
  value: StoredDoc | undefined,
): (IdempotencyDoc & { readonly producer: ThreadMessageProducer }) | undefined {
  if (value?.kind !== 'idempotency') return undefined;
  const producer = normalizeProducer(value.producer, value.source);
  return producer === undefined ? undefined : { ...value, producer };
}

function asDelivery(value: StoredDoc | undefined): DeliveryDoc | undefined {
  if (value?.kind !== 'delivery') return undefined;
  const legacySource = (value.message as AcceptedThreadMessage & { readonly source?: ThreadRef }).source;
  const message = normalizeAcceptedMessage(value.message);
  if (message === undefined) return undefined;
  const idempotencyStorageKey = typeof value.idempotencyStorageKey === 'string'
    ? value.idempotencyStorageKey
    : legacySource === undefined
      ? idempotencyKeyForMessage(message)
      : legacyIdempotencyKeyOf({
          source: legacySource,
          target: message.target,
          idempotencyKey: message.idempotencyKey,
        });
  return { ...value, message, idempotencyStorageKey };
}

function normalizeAcceptedMessage(value: AcceptedThreadMessage): AcceptedThreadMessage | undefined {
  const raw = value as AcceptedThreadMessage & { readonly source?: ThreadRef };
  const producer = normalizeProducer(raw.producer, raw.source);
  if (
    producer === undefined ||
    !isThreadRef(raw.target) ||
    typeof raw.content !== 'string' ||
    typeof raw.idempotencyKey !== 'string'
  ) return undefined;
  return {
    messageId: raw.messageId,
    producer,
    target: raw.target,
    content: raw.content,
    idempotencyKey: raw.idempotencyKey,
    acceptedAt: raw.acceptedAt,
    targetSeq: raw.targetSeq,
  };
}

function normalizeProducer(
  producer: ThreadMessageProducer | undefined,
  legacySource: ThreadRef | undefined,
): ThreadMessageProducer | undefined {
  if (producer?.kind === 'external_client') return { kind: 'external_client' };
  if (producer?.kind === 'peer_thread' && isThreadRef(producer.source)) {
    return { kind: 'peer_thread', source: producer.source };
  }
  if (isThreadRef(legacySource)) return { kind: 'peer_thread', source: legacySource };
  return undefined;
}

function isThreadRef(value: unknown): value is ThreadRef {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ThreadRef>;
  return typeof candidate.hostId === 'string' &&
    typeof candidate.workspaceId === 'string' &&
    typeof candidate.sessionId === 'string';
}

function asActivityMeta(value: StoredDoc | undefined): ActivityMetaDoc | undefined {
  return value?.kind === 'activity_meta' ? value : undefined;
}

function asActivityEvent(value: StoredDoc | undefined): ActivityEventDoc | undefined {
  return value?.kind === 'activity_event' ? value : undefined;
}

function asWorkspaceOverride(value: StoredDoc | undefined): WorkspaceOverrideDoc | undefined {
  return value?.kind === 'workspace_override' ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLockError(error: unknown): boolean {
  if (error instanceof LockError) return true;
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as NodeJS.ErrnoException;
  return (
    (candidate.code === 'EPERM' || candidate.code === 'EACCES') &&
    candidate.path?.endsWith('db.lock') === true
  );
}
