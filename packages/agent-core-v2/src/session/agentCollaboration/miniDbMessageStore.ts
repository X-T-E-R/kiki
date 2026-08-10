/**
 * `agentCollaboration` domain — MiniDb named-agent message Store.
 *
 * Uses strict recovery, fsync-on-write, and one operation-scoped writer lock.
 */

import { createHash, randomUUID } from 'node:crypto';

import { LockError, MiniDb, type BatchInputOp } from '@moonshot-ai/minidb';
import { join } from 'pathe';

import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import {
  AGENT_MESSAGE_BACKLOG_LIMIT,
  AgentMessageMailboxFullError,
  IAgentCollaborationMessageStore,
  type AcceptedAgentMessage,
  type AgentMessageAcceptance,
} from './messageMailbox';

const RECEIPT_BACKLOG_LIMIT = 256;
const LOCK_TIMEOUT_MS = 30_000;

interface TargetMetaDoc {
  readonly kind: 'target_meta';
  readonly nextSeq: number;
  readonly minSeq: number;
  readonly queuedCount: number;
}

interface QueueDoc {
  readonly kind: 'queue';
  readonly messageId: string;
  readonly idempotencyStorageKey: string;
}

interface DeliveryDoc {
  readonly kind: 'delivery';
  readonly message: AcceptedAgentMessage;
  readonly state: 'queued' | 'delivered';
  readonly deliveredAt?: number;
}

interface IdempotencyDoc {
  readonly kind: 'idempotency';
  readonly messageId: string;
  readonly payloadHash: string;
}

type StoredDoc = TargetMetaDoc | QueueDoc | DeliveryDoc | IdempotencyDoc;

export class MiniDbAgentCollaborationMessageBackend implements IAgentCollaborationMessageStore {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly dir: string) {}

  async accept(input: {
    readonly sessionId: string;
    readonly sourceAgentId: string;
    readonly sourceTaskName: string;
    readonly targetAgentId: string;
    readonly targetTaskName: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<AgentMessageAcceptance> {
    return this.withDb(async (db) => {
      const idempotencyStorageKey = idempotencyKeyOf(input);
      const payloadHash = hashJson({ content: input.content });
      const prior = asIdempotency(db.get(idempotencyStorageKey));
      if (prior !== undefined) {
        const delivery = asDelivery(db.get(deliveryKey(prior.messageId)));
        if (delivery === undefined) throw new Error(`Agent message receipt "${prior.messageId}" is unavailable.`);
        return {
          message: delivery.message,
          deduplicated: true,
          delivery: delivery.state,
          payloadConflict: prior.payloadHash !== payloadHash,
        };
      }

      const targetKey = targetKeyOf(input.sessionId, input.targetAgentId);
      const metaKey = targetMetaKey(targetKey);
      const meta = asTargetMeta(db.get(metaKey)) ?? newTargetMeta();
      if (meta.queuedCount >= AGENT_MESSAGE_BACKLOG_LIMIT) throw new AgentMessageMailboxFullError();

      const messageId = randomUUID();
      const message: AcceptedAgentMessage = {
        messageId,
        sessionId: input.sessionId,
        sourceAgentId: input.sourceAgentId,
        sourceTaskName: input.sourceTaskName,
        targetAgentId: input.targetAgentId,
        targetTaskName: input.targetTaskName,
        content: input.content,
        acceptedAt: Date.now(),
        targetSeq: meta.nextSeq,
      };
      const ops: BatchInputOp<StoredDoc>[] = [
        {
          op: 'set',
          key: metaKey,
          value: {
            ...meta,
            nextSeq: meta.nextSeq + 1,
            minSeq: Math.max(meta.minSeq, meta.nextSeq + 1 - RECEIPT_BACKLOG_LIMIT),
            queuedCount: meta.queuedCount + 1,
          },
        },
        {
          op: 'set',
          key: queueKey(targetKey, meta.nextSeq),
          value: { kind: 'queue', messageId, idempotencyStorageKey },
        },
        { op: 'set', key: deliveryKey(messageId), value: { kind: 'delivery', message, state: 'queued' } },
        { op: 'set', key: idempotencyStorageKey, value: { kind: 'idempotency', messageId, payloadHash } },
      ];
      this.addPruneOps(db, ops, targetKey, meta.nextSeq - RECEIPT_BACKLOG_LIMIT);
      await db.batch(ops);
      return { message, deduplicated: false, delivery: 'queued', payloadConflict: false };
    });
  }

  async nextQueued(sessionId: string, targetAgentId: string): Promise<AcceptedAgentMessage | undefined> {
    return this.withDb((db) => {
      const targetKey = targetKeyOf(sessionId, targetAgentId);
      for (const entry of db.prefix(queuePrefix(targetKey), Number.POSITIVE_INFINITY)) {
        const queued = asQueue(entry.value);
        if (queued === undefined) continue;
        const delivery = asDelivery(db.get(deliveryKey(queued.messageId)));
        if (delivery?.state === 'queued') return delivery.message;
      }
      return undefined;
    });
  }

  async markDelivered(messageId: string): Promise<boolean> {
    return this.withDb(async (db) => {
      const key = deliveryKey(messageId);
      const delivery = asDelivery(db.get(key));
      if (delivery === undefined || delivery.state === 'delivered') return false;
      const targetKey = targetKeyOf(delivery.message.sessionId, delivery.message.targetAgentId);
      const metaKey = targetMetaKey(targetKey);
      const meta = asTargetMeta(db.get(metaKey));
      const ops: BatchInputOp<StoredDoc>[] = [
        { op: 'set', key, value: { ...delivery, state: 'delivered', deliveredAt: Date.now() } },
      ];
      if (meta !== undefined) {
        ops.push({ op: 'set', key: metaKey, value: { ...meta, queuedCount: Math.max(0, meta.queuedCount - 1) } });
      }
      await db.batch(ops);
      return true;
    });
  }

  private addPruneOps(
    db: MiniDb<StoredDoc>,
    ops: BatchInputOp<StoredDoc>[],
    targetKey: string,
    seq: number,
  ): void {
    if (seq < 1) return;
    const key = queueKey(targetKey, seq);
    const queued = asQueue(db.get(key));
    if (queued === undefined) return;
    const delivery = asDelivery(db.get(deliveryKey(queued.messageId)));
    if (delivery?.state !== 'delivered') return;
    ops.push(
      { op: 'del', key },
      { op: 'del', key: deliveryKey(queued.messageId) },
      { op: 'del', key: queued.idempotencyStorageKey },
    );
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

export class MiniDbAgentCollaborationMessageStore implements IAgentCollaborationMessageStore {
  declare readonly _serviceBrand: undefined;
  private readonly backend: MiniDbAgentCollaborationMessageBackend;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    this.backend = new MiniDbAgentCollaborationMessageBackend(join(bootstrap.storeDir, 'agent-collaboration-mailbox-v1'));
  }

  accept: IAgentCollaborationMessageStore['accept'] = (input) => this.backend.accept(input);
  nextQueued: IAgentCollaborationMessageStore['nextQueued'] = (sessionId, targetAgentId) =>
    this.backend.nextQueued(sessionId, targetAgentId);
  markDelivered: IAgentCollaborationMessageStore['markDelivered'] = (messageId) =>
    this.backend.markDelivered(messageId);
}

registerScopedService(
  LifecycleScope.App,
  IAgentCollaborationMessageStore,
  MiniDbAgentCollaborationMessageStore,
  ScopeActivation.OnScopeCreated,
  'agentCollaborationMessageStore',
);

function newTargetMeta(): TargetMetaDoc {
  return { kind: 'target_meta', nextSeq: 1, minSeq: 1, queuedCount: 0 };
}

function targetKeyOf(sessionId: string, targetAgentId: string): string {
  return encode(`${sessionId}\u0000${targetAgentId}`);
}

function targetMetaKey(targetKey: string): string {
  return `target/${targetKey}/meta`;
}

function queuePrefix(targetKey: string): string {
  return `target/${targetKey}/queue/`;
}

function queueKey(targetKey: string, seq: number): string {
  return `${queuePrefix(targetKey)}${seq.toString().padStart(16, '0')}`;
}

function deliveryKey(messageId: string): string {
  return `delivery/${messageId}`;
}

function idempotencyKeyOf(input: {
  readonly sessionId: string;
  readonly sourceAgentId: string;
  readonly targetAgentId: string;
  readonly idempotencyKey: string;
}): string {
  return `idem/${hashJson({
    sessionId: input.sessionId,
    sourceAgentId: input.sourceAgentId,
    targetAgentId: input.targetAgentId,
    key: input.idempotencyKey,
  })}`;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function asTargetMeta(value: StoredDoc | undefined): TargetMetaDoc | undefined {
  return value?.kind === 'target_meta' ? value : undefined;
}

function asQueue(value: StoredDoc | undefined): QueueDoc | undefined {
  return value?.kind === 'queue' ? value : undefined;
}

function asDelivery(value: StoredDoc | undefined): DeliveryDoc | undefined {
  return value?.kind === 'delivery' ? value : undefined;
}

function asIdempotency(value: StoredDoc | undefined): IdempotencyDoc | undefined {
  return value?.kind === 'idempotency' ? value : undefined;
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
