import { randomUUID } from 'node:crypto';

import { createKimiDeviceId } from '@kiki/oauth';

import { Disposable, DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { IThreadTurnStore, type ThreadTurnSource } from './threadTurnStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IInstantiationService } from '#/_base/di/instantiation';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentPromptService, type PromptHandle } from '#/agent/prompt/prompt';
import { type PeerThreadOrigin, type PromptOrigin } from '#/agent/contextMemory/types';
import { Error2, ErrorCodes, fromErrorPayload, isError2, toErrorPayload, type ErrorPayload } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
} from '#/workspace/sessionLifecycle/internal/addressing';
import { IWireService } from '#/wire/wire';

import {
  IThreadCommunicationService,
  type ListThreadMessagesInput,
  type ListThreadMessagesResult,
  type ThreadCommunicationMessage,
  type ThreadMessageEndpoint,
  type ListThreadsInput,
  type ListThreadsResult,
  type ReadThreadInput,
  type ReadThreadResult,
  type SendRoomMessageInput,
  type CancelRoomDeliveriesInput,
  type WaitRoomDeliveryInput,
  type SendThreadMessageInput,
  type SendThreadMessageResult,
  type ThreadActivity,
  type ThreadActivityKind,
  type ThreadCaller,
  type ThreadRef,
  type ThreadSummary,
  type WaitThreadResult,
  type WaitThreadsInput,
  type WaitThreadsResult,
} from './threadCommunication';
import {
  IThreadMailboxStore,
  threadMailboxClaimRequestId,
  type AcceptedThreadMessage,
  type ThreadDeliveryClaim,
  type ThreadMessageAcceptance,
  type ThreadMessageProducer,
} from './threadMailboxStore';
import { ThreadActivityCursorExpiredError, ThreadMailboxBacklogError } from './mailboxErrors';
import { threadDeliveryReasonCode } from './deliveryFailure';
import {
  SEND_PEER_THREAD_MESSAGE,
  SPACE_THREAD_ROUTER,
  RECHECK_BRIDGED_THREADS,
  ACCEPT_BRIDGED_THREAD_MESSAGE,
  type SpaceThreadConnector,
  type IThreadPeerSendCapability,
  type SendPeerThreadMessageInput,
} from './peerThreadCapability';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 100;
const MAX_WAIT_THREADS = 8;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const WAIT_POLL_MS = 200;
const WAIT_ACTIVITY_LIMIT = 64;
const DELIVERY_LEASE_MS = 30_000;
const FAST_DELIVERY_TIMEOUT_MS = 5_000;
const MAX_BACKGROUND_TARGET_DRAINS = 4;
const ROOM_DELIVERY_RECEIPT_TTL_MS = 5 * 60_000;
const ROOM_DELIVERY_RECEIPT_SCOPE = 'thread-communication';

type CursorPayload = ListCursor | ReadCursor | ActivityCursor;

interface ListCursor {
  readonly v: 1;
  readonly kind: 'list';
  readonly before: string;
  readonly workspaceId?: string;
}

interface ReadCursor {
  readonly v: 1;
  readonly kind: 'read';
  readonly beforeTurnId: number;
  readonly thread: string;
  readonly source?: ThreadTurnSource;
}

interface ActivityCursor {
  readonly v: 1;
  readonly kind: 'activity';
  readonly epoch: string;
  readonly seq: number;
  readonly thread: string;
}

interface TargetDrainState {
  readonly target: ThreadRef;
  requested: boolean;
  running?: Promise<SendThreadMessageResult['delivery']>;
}

interface RoomDeliveryTarget {
  readonly target: ThreadRef;
  readonly roomId: string;
  readonly generation?: number;
}

interface PersistedRoomDeliveryReceipt {
  readonly target: RoomDeliveryTarget;
  readonly status: 'pending' | 'completed' | 'failed';
  readonly error?: string;
  readonly errorPayload?: ErrorPayload;
}

interface RoomDeliveryReceipt {
  readonly target: RoomDeliveryTarget;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  cancelPending?: () => void;
}

export class ThreadCommunicationService extends Disposable implements IThreadCommunicationService, IThreadPeerSendCapability {
  declare readonly _serviceBrand: undefined;
  readonly hostId: string;

  private connector?: SpaceThreadConnector;
  private readonly pendingBridgeClaims = new Map<string, ThreadDeliveryClaim>();
  private bridgeRecheckFlight?: Promise<void>;

  [RECHECK_BRIDGED_THREADS](targets: readonly ThreadRef[]): Promise<void> {
    if (this.bridgeRecheckFlight !== undefined) return this.bridgeRecheckFlight;
    const flight = this.recheckBridgedThreads(targets); this.bridgeRecheckFlight = flight;
    void flight.finally(() => { if (this.bridgeRecheckFlight === flight) this.bridgeRecheckFlight = undefined; }).catch(() => {});
    return flight;
  }

  private async recheckBridgedThreads(targets: readonly ThreadRef[]): Promise<void> {
    for (const claim of this.pendingBridgeClaims.values()) {
      if (claim.leaseUntil <= Date.now()) { this.pendingBridgeClaims.delete(claim.message.messageId); continue; }
      const delivery = await this.deliverClaim(claim);
      if (delivery !== 'pending') this.pendingBridgeClaims.delete(claim.message.messageId);
    }
    for (const target of targets) await this.requestTargetDrain(target);
  }

  [SPACE_THREAD_ROUTER](connector: SpaceThreadConnector | undefined): void {
    this.connector = connector;
  }

  async [ACCEPT_BRIDGED_THREAD_MESSAGE](input: {
    producer: Extract<ThreadMessageProducer, { kind: 'bridged_peer' }>;
    target: ThreadRef;
    content: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    deliveryTimeoutMs?: number;
  }): Promise<SendThreadMessageResult> {
    if (this.connector === undefined) throw new Error2(ErrorCodes.THREAD_CROSS_HOST, 'No space bridge is installed.');
    await this.connector.beforeDelivery({ ...input, messageId: '', acceptedAt: Date.now(), targetSeq: 0 });
    return this.sendProducedMessage(input);
  }

  private needsBridge(ref: ThreadRef): boolean {
    return ref.bridgeId !== undefined || ref.connectionId !== undefined || !['local', '', this.hostId].includes(ref.hostId);
  }

  private requireConnector(): SpaceThreadConnector {
    if (this.connector === undefined) throw new Error2(ErrorCodes.THREAD_CROSS_HOST, 'An approved space bridge is required.');
    return this.connector;
  }

  private readonly observedSessions = new Map<string, DisposableStore>();
  private recovery: Promise<void> | undefined;
  private readonly detached = new Set<Promise<void>>();
  private readonly targetDrains = new Map<string, TargetDrainState>();
  private readonly backgroundTargets = new Map<string, ThreadRef>();
  private backgroundDrains = 0;
  private readonly claimRequestIds = new Map<string, string>();
  private readonly roomDeliveryTargets = new Map<string, RoomDeliveryTarget>();
  private readonly roomDeliveryReceipts = new Map<string, RoomDeliveryReceipt>();
  private readonly mailboxController = new AbortController();
  private readonly shutdownSignal: Promise<void>;
  private resolveShutdown!: () => void;
  private closing = false;
  private shutdownFlight: Promise<void> | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ICapabilitySnapshotService private readonly capabilities: ICapabilitySnapshotService,
    @ISessionIndex private readonly sessions: ISessionIndex,
    @ISessionManager private readonly sessionManager: ISessionManager,
    @IThreadMailboxStore private readonly mailbox: IThreadMailboxStore,
    @IThreadTurnStore private readonly turns: IThreadTurnStore,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.hostId = createKimiDeviceId(bootstrap.homeDir);
    this.shutdownSignal = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
    this._register(toDisposable(async () => {
      for (const store of this.observedSessions.values()) await store.dispose();
      this.observedSessions.clear();
    }));
    this._register(this.followLifecycle(this.sessionManager));
  }

  shutdown(): Promise<void> {
    this.shutdownFlight ??= this.doShutdown();
    return this.shutdownFlight;
  }

  private async doShutdown(): Promise<void> {
    this.closing = true;
    for (const receipt of this.roomDeliveryReceipts.values()) {
      if (receipt.timer !== undefined) clearTimeout(receipt.timer);
      receipt.reject(new Error('Thread communication is shutting down.'));
    }
    this.roomDeliveryReceipts.clear();
    this.roomDeliveryTargets.clear();
    this.mailboxController.abort(new Error('Thread communication is shutting down.'));
    this.resolveShutdown();
    await this.dispose();
    await this.recovery?.catch(() => {});
    while (this.detached.size > 0) {
      await Promise.all(this.detached);
    }
  }

  async listMessages(input: ListThreadMessagesInput = {}): Promise<ListThreadMessagesResult> {
    const limit = boundedLimit(input.limit, 50, 100);
    if (input.peerSessionId !== undefined && input.sessionId === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'peerSessionId requires sessionId.');
    }
    const conditions = JSON.stringify([input.workspaceId ?? null, input.sessionId ?? null, input.peerSessionId ?? null]);
    let before: string | undefined;
    let generation: string | undefined;
    let history: ListThreadMessagesResult['history'];
    if (input.cursor !== undefined) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (cursor['v'] !== 2 || cursor['kind'] !== 'messages' || cursor['conditions'] !== conditions ||
            typeof cursor['generation'] !== 'string' ||
            typeof cursor['before'] !== 'string' || !/^\d{16}\/[^/]+$/.test(cursor['before'])) throw new Error('invalid');
        before = cursor['before'];
        generation = cursor['generation'];
      } catch { throw cursorError('Communication cursor is invalid or does not match the filters.'); }
    }
    if (input.sessionId !== undefined) {
      const summary = await this.sessions.get(input.sessionId);
      if (summary === undefined || input.workspaceId !== undefined && summary.workspaceId !== input.workspaceId) {
        throw new Error2(ErrorCodes.THREAD_NOT_FOUND, 'Thread not found in the requested workspace.');
      }
    }
    const summaries = new Map<string, Promise<SessionSummary | undefined>>();
    const endpoint = async (ref: ThreadRef): Promise<ThreadMessageEndpoint> => {
      let pending = summaries.get(ref.sessionId);
      if (pending === undefined) {
        pending = this.sessions.get(ref.sessionId);
        summaries.set(ref.sessionId, pending);
      }
      const summary = await pending;
      const exists = ref.hostId === this.hostId && summary?.workspaceId === ref.workspaceId;
      return { ref, title: exists ? summary.title : undefined, deleted: !exists, archived: exists && summary.archived };
    };
    const group = input.sessionId !== undefined ? `session:${input.sessionId}` :
      input.workspaceId !== undefined ? `workspace:${input.workspaceId}` : 'all';
    const items: ThreadCommunicationMessage[] = [];
    let scanned = 0;
    let bytes = 0;
    let hasMore = false;
    while (items.length < limit && scanned < 500 && bytes < (2 << 20)) {
      const page = await this.mailbox.readMessages({ group, before, generation, peerOnly: input.peerSessionId !== undefined,
        limit: Math.min(20, limit - items.length) });
      if (page.cursorExpired || generation !== undefined && page.history !== undefined && page.history.generation !== generation) {
        throw cursorError('Communication history coverage changed. Refresh from the first page.');
      }
      history = page.history;
      generation = history?.generation ?? 'unversioned';
      hasMore = page.nextBefore !== undefined;
      scanned += Math.max(1, page.items.length);
      for (const record of page.items) {
        bytes += Buffer.byteLength(record.message.content);
        before = record.order;
        const message = record.message;
        if (message.target.hostId !== this.hostId || message.producer.kind === 'external_client') continue;
        if (message.producer.kind === 'room') {
          if (input.peerSessionId !== undefined) continue;
          const target = await endpoint(message.target);
          if (target.deleted || input.workspaceId !== undefined && target.ref.workspaceId !== input.workspaceId) continue;
          items.push({ messageId: message.messageId, source: { kind: 'room', roomId: message.producer.roomId }, target,
            content: message.content, acceptedAt: message.acceptedAt, targetSeq: message.targetSeq, delivery: record.delivery,
            reason: record.reason, reasonDetail: record.reason,
            reasonCode: record.delivery === 'undeliverable' ? record.reasonCode ?? 'delivery_failed' : undefined });
          continue;
        }
        const [source, target] = await Promise.all([endpoint(message.producer.source), endpoint(message.target)]);
        if (source.deleted && target.deleted) continue;
        if (input.workspaceId !== undefined && ![source, target].some((side) => !side.deleted && side.ref.workspaceId === input.workspaceId)) continue;
        if (input.peerSessionId !== undefined && ![source, target].some((side) => side.ref.sessionId === input.peerSessionId)) continue;
        items.push({ messageId: message.messageId, source: { kind: 'thread', thread: source }, target,
          content: message.content, acceptedAt: message.acceptedAt, targetSeq: message.targetSeq,
          delivery: record.delivery, reason: record.reason, reasonDetail: record.reason,
          reasonCode: record.delivery === 'undeliverable' ? record.reasonCode ?? 'delivery_failed' : undefined });
      }
      if (page.nextBefore !== undefined) before = page.nextBefore;
      if (!hasMore || history !== undefined && history.state !== 'complete') break;
    }
    const scanBudget = hasMore && items.length < limit && (scanned >= 500 || bytes >= (2 << 20));
    const incomplete = history !== undefined && history.state !== 'complete' ? 'history_preparing' as const :
      scanBudget ? 'scan_budget' as const : undefined;
    if (scanBudget) this.log.warn('Communication history scan budget reached', { scanned, bytes });
    return { items, incomplete, history, nextCursor: hasMore && before !== undefined ? Buffer.from(JSON.stringify({
      v: 2, kind: 'messages', conditions, before, generation,
    })).toString('base64url') : undefined };
  }

  async listThreads(input: ListThreadsInput = {}): Promise<ListThreadsResult> {
    input.signal?.throwIfAborted();
    return waitWithSignal(this.doListThreads(input), input.signal);
  }

  private async doListThreads(input: ListThreadsInput): Promise<ListThreadsResult> {
    await this.ensureRecovery();
    if (!(await this.globalEnabled(input.caller))) return { threads: [] };
    if (input.bridgeId !== undefined || input.connectionId !== undefined) {
      await this.requireBridgeCaller(input.caller);
      return this.requireConnector().list(input);
    }
    const limit = boundedLimit(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const decoded = input.cursor === undefined ? undefined : decodeCursor(input.cursor, 'list');
    if (decoded !== undefined && decoded.workspaceId !== input.workspaceId) {
      throw cursorError('List cursor does not match the requested workspace.');
    }

    const threads: ThreadSummary[] = [];
    const workspaceAdmission = new Map<string, boolean>();
    let before = decoded?.before;
    let terminal = false;
    let lastScanned: string | undefined;
    let hasMore = false;
    while (threads.length < limit && !terminal) {
      const page = await this.sessions.listRecent({
        workspaceIds: input.workspaceId === undefined ? undefined : [input.workspaceId],
        includeArchived: false,
        before,
        limit: MAX_LIST_LIMIT,
      });
      if (page.items.length === 0) break;
      for (const [index, summary] of page.items.entries()) {
        lastScanned = summary.id;
        let enabled = workspaceAdmission.get(summary.workspaceId);
        if (enabled === undefined) {
          enabled = await this.workspaceEnabled(summary.workspaceId);
          workspaceAdmission.set(summary.workspaceId, enabled);
        }
        if (!enabled) continue;
        threads.push(this.toThreadSummary(summary));
        if (threads.length >= limit) {
          hasMore = index < page.items.length - 1 || page.nextCursor !== undefined;
          break;
        }
      }
      if (threads.length >= limit) break;
      terminal = page.nextCursor === undefined;
      before = lastScanned ?? page.nextCursor;
    }

    return {
      threads,
      nextCursor:
        hasMore && lastScanned !== undefined
          ? encodeCursor({ v: 1, kind: 'list', before: lastScanned, workspaceId: input.workspaceId })
          : undefined,
    };
  }

  async readThread(input: ReadThreadInput): Promise<ReadThreadResult> {
    input.signal?.throwIfAborted();
    return waitWithSignal(this.doReadThread(input), input.signal);
  }

  private async doReadThread(input: ReadThreadInput): Promise<ReadThreadResult> {
    await this.ensureRecovery();
    if (this.needsBridge(input.thread)) {
      const connector = this.requireConnector();
      await this.requireBridgeCaller(input.caller);
      return connector.read(input);
    }
    input = { ...input, thread: this.requireLocalHost(input.thread) };
    const summary = await this.requireThread(input.thread, input.caller);
    const limit = boundedLimit(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    const decoded = input.cursor === undefined ? undefined : decodeCursor(input.cursor, 'read');
    const identity = threadIdentity(input.thread);
    if (decoded !== undefined && decoded.thread !== identity) {
      throw cursorError('Read cursor does not match the requested thread.');
    }
    const handlerScope = workspacePersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId);
    const wireScope = agentScopeOf(sessionScopeOf(handlerScope, summary.id), MAIN_AGENT_ID);
    if (input.contentRef !== undefined) return { thread: input.thread, turns: [], view: { segment: await this.turns.content(wireScope, input.contentRef, input.signal) } };
    await waitWithSignal(this.flushLiveMain(summary.id), input.signal);
    const beforeTurnId = decoded?.beforeTurnId ?? Number.MAX_SAFE_INTEGER;
    const page = await this.turns.read(wireScope, beforeTurnId, limit, decoded?.source, input.signal);
    const nextBefore = page.preparing ? beforeTurnId : page.turns[0]?.turnId;
    return {
      thread: input.thread,
      turns: page.turns,
      incomplete: page.preparing ? 'history_preparing' : undefined,
      nextCursor: page.hasMore && nextBefore !== undefined
        ? encodeCursor({ v: 1, kind: 'read', beforeTurnId: nextBefore, thread: identity, source: page.source })
        : undefined,
    };
  }

  async sendMessage(input: SendThreadMessageInput): Promise<SendThreadMessageResult> {
    return this.sendProducedMessage({
      producer: { kind: 'external_client' },
      caller: input.caller,
      target: input.target,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
      deliveryTimeoutMs: input.deliveryTimeoutMs,
    });
  }

  async sendRoomMessage(input: SendRoomMessageInput): Promise<SendThreadMessageResult> {
    validateSendInput(input);
    return this.sendProducedMessage({
      producer: { kind: 'room', roomId: input.roomId, targeted: input.targeted, generation: input.generation, queueWhenBusy: input.queueWhenBusy, requireCommunication: input.requireCommunication },
      caller: input.requireCommunication === true ? input.target : undefined,
      target: input.target,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
      deliveryTimeoutMs: input.deliveryTimeoutMs,
    }, input.requireCommunication === true);
  }

  async cancelRoomDeliveries(input: CancelRoomDeliveriesInput): Promise<void> {
    await this.ensureRecovery();
    requireNonEmpty(input.roomId, 'roomId');
    await this.mailbox.cancelProducer({ kind: 'room', roomId: input.roomId, generation: input.generation }, {
      signal: this.mailboxController.signal,
    });
    for (const [messageId, target] of this.roomDeliveryTargets) {
      if (target.roomId !== input.roomId || (input.generation !== undefined && target.generation !== input.generation)) continue;
      const receipt = this.roomDeliveryReceipts.get(messageId);
      receipt?.cancelPending?.();
      if (receipt === undefined) this.roomDeliveryTargets.delete(messageId);
    }
  }

  async waitRoomDelivery(input: WaitRoomDeliveryInput): Promise<void> {
    input.signal?.throwIfAborted();
    return waitWithSignal(this.doWaitRoomDelivery(input), input.signal);
  }

  private async doWaitRoomDelivery(input: WaitRoomDeliveryInput): Promise<void> {
    await this.ensureRecovery();
    this.requireLocalHost(input.target);
    requireNonEmpty(input.messageId, 'messageId');
    let target = this.roomDeliveryTargets.get(input.messageId);
    const persisted = await this.readRoomDeliveryReceipt(input.messageId);
    if (persisted?.status === 'completed') return;
    if (persisted?.status === 'failed') {
      throw persisted.errorPayload === undefined
        ? new Error2(ErrorCodes.THREAD_DELIVERY_FAILED, persisted.error ?? 'Room delivery failed.')
        : fromErrorPayload(persisted.errorPayload);
    }
    if (target === undefined) {
      if (persisted === undefined) return;
      target = persisted.target;
      this.roomDeliveryTargets.set(input.messageId, target);
    }
    if (this.roomDeliveryReceipts.get(input.messageId) === undefined) {
      this.ensureRoomDeliveryReceipt(input.messageId, target);
    }
    await this.requestTargetDrain(target.target, input.messageId);
    const receipt = this.roomDeliveryReceipts.get(input.messageId);
    if (receipt === undefined) return;
    await waitWithSignal(receipt.promise, input.signal);
  }

  async [SEND_PEER_THREAD_MESSAGE](input: SendPeerThreadMessageInput): Promise<SendThreadMessageResult> {
    const deadline = Date.now() + (input.deliveryTimeoutMs ?? FAST_DELIVERY_TIMEOUT_MS);
    input.signal?.throwIfAborted();
    await waitWithSignal(this.ensureRecovery(), input.signal);
    validateSendInput(input);
    const source = this.requireLocalHost(input.source);
    const caller: ThreadCaller = {
      sessionId: source.sessionId,
      workspaceId: source.workspaceId,
      ...(input.executingAgentId === undefined ? {} : { agentId: input.executingAgentId }),
    };
    const peer: SendPeerThreadMessageInput = {
      signal: input.signal,
      deliveryTimeoutMs: input.deliveryTimeoutMs,
      cause: input.cause,
      source,
      target: input.target,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
      sender: input.sender,
      allowWhenDisabled: input.allowWhenDisabled,
    };
    await waitWithSignal(this.requireThread(peer.source, caller, this.needsBridge(peer.target) || peer.allowWhenDisabled !== true), input.signal);
    input.signal?.throwIfAborted();
    if (this.needsBridge(peer.target)) return this.requireConnector().send({ ...peer, deliveryTimeoutMs: Math.max(0, deadline - Date.now()) });
    const target = this.requireLocalHost(peer.target);
    if (sameThread(peer.source, target)) {
      throw new Error2(ErrorCodes.THREAD_SELF_SEND, 'A thread cannot send a message to itself.');
    }
    return this.sendProducedMessage({
      producer: {
        kind: 'peer_thread',
        source: peer.source,
        sender: peer.sender,
        allowWhenDisabled: peer.allowWhenDisabled,
      },
      caller,
      target,
      content: peer.content,
      idempotencyKey: peer.idempotencyKey,
      signal: peer.signal,
      deliveryTimeoutMs: Math.max(0, deadline - Date.now()),
    }, peer.allowWhenDisabled !== true);
  }

  private async sendProducedMessage(input: {
    readonly producer: ThreadMessageProducer;
    readonly caller?: ThreadCaller;
    readonly target: ThreadRef;
    readonly content: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
    readonly deliveryTimeoutMs?: number;
  }, requireCommunication = true): Promise<SendThreadMessageResult> {
    const deadline = Date.now() + (input.deliveryTimeoutMs ?? FAST_DELIVERY_TIMEOUT_MS);
    input.signal?.throwIfAborted();
    await waitWithSignal(this.ensureRecovery(), input.signal);
    validateSendInput(input);
    input = { ...input, target: this.requireLocalHost(input.target) };
    await waitWithSignal(this.requireThread(input.target, input.caller, requireCommunication), input.signal);
    input.signal?.throwIfAborted();
    const storedInput = {
      producer: input.producer,
      target: input.target,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
    };
    let accepted: ThreadMessageAcceptance;
    try {
      accepted = await this.mailbox.acceptMessage(storedInput, {
        signal: this.mailboxController.signal,
      });
    } catch (error) {
      if (error instanceof ThreadMailboxBacklogError) {
        throw new Error2(ErrorCodes.THREAD_LIMIT_EXCEEDED, error.message, {
          details: { limit: error.limit },
        });
      }
      throw error;
    }
    if (accepted.payloadConflict) {
      throw new Error2(
        ErrorCodes.THREAD_IDEMPOTENCY_CONFLICT,
        'The idempotency key was already used with different message content.',
        { details: { idempotencyKey: input.idempotencyKey } },
      );
    }
    let delivery = accepted.delivery;
    if (input.producer.kind === 'room') {
      const target = {
        target: accepted.message.target,
        roomId: input.producer.roomId,
        generation: input.producer.generation,
      } satisfies RoomDeliveryTarget;
      this.roomDeliveryTargets.set(accepted.message.messageId, target);
      if (!accepted.deduplicated) {
        await this.persistRoomDeliveryReceipt(accepted.message.messageId, {
          target,
          status: 'pending',
        });
      }
      if (delivery === 'undeliverable') this.roomDeliveryTargets.delete(accepted.message.messageId);
    }
    if (delivery === 'pending') {
      delivery = await waitBoundedDelivery(
        this.deliverMessage(accepted.message),
        input.signal,
        Math.max(0, deadline - Date.now()),
      );
    }
    return {
      messageId: accepted.message.messageId,
      targetSeq: accepted.message.targetSeq,
      acceptedAt: accepted.message.acceptedAt,
      deduplicated: accepted.deduplicated,
      delivery,
    };
  }

  async waitThreads(input: WaitThreadsInput): Promise<WaitThreadsResult> {
    input.signal?.throwIfAborted();
    const deadline = Date.now() + boundedTimeout(input.timeoutMs);
    return waitWithSignal(this.doWaitThreads(input, deadline), input.signal);
  }

  private async doWaitThreads(input: WaitThreadsInput, deadline: number): Promise<WaitThreadsResult> {
    await this.ensureRecovery();
    if (input.threads.length === 0 || input.threads.length > MAX_WAIT_THREADS) {
      throw new Error2(
        ErrorCodes.THREAD_LIMIT_EXCEEDED,
        `ThreadWait accepts between 1 and ${MAX_WAIT_THREADS} threads.`,
      );
    }
    input.signal?.throwIfAborted();
    const timeoutMs = boundedTimeout(input.timeoutMs);
    const seen = new Set<string>();
    for (const item of input.threads) {
      const key = threadIdentity({ ...item.thread, hostId: ['local', ''].includes(item.thread.hostId) ? this.hostId : item.thread.hostId });
      if (seen.has(key)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'ThreadWait contains duplicate threads.');
      seen.add(key);
    }
    if (input.threads.some((item) => this.needsBridge(item.thread))) {
      const connector = this.requireConnector();
      await this.requireBridgeCaller(input.caller);
      return connector.wait({ ...input, timeoutMs });
    }
    input = { ...input, threads: input.threads.map((item) => ({ ...item, thread: this.requireLocalHost(item.thread) })) };
    for (const item of input.threads) {
      if (!(await this.globalEnabled(input.caller)) || !(await this.workspaceEnabled(item.thread.workspaceId))) throw threadDisabled(item.thread.workspaceId);
    }
    const baselines = await Promise.all(
      input.threads.map(async (item) => {
        if (item.cursor !== undefined) {
          const cursor = decodeCursor(item.cursor, 'activity');
          if (cursor.thread !== threadIdentity(item.thread)) {
            throw cursorError('Activity cursor does not match the requested thread.');
          }
          return cursor;
        }
        const page = await this.mailbox.readActivity(item.thread, Number.MAX_SAFE_INTEGER, 1, {
          signal: this.mailboxController.signal,
        });
        return {
          v: 1,
          kind: 'activity',
          epoch: page.epoch,
          seq: page.latestSeq,
          thread: threadIdentity(item.thread),
        } satisfies ActivityCursor;
      }),
    );

    for (;;) {
      await this.recordTerminalLifecycleChanges(input.threads.map((item) => item.thread));
      const results = await Promise.all(
        input.threads.map((item, index) => this.readWaitResult(item.thread, baselines[index]!)),
      );
      if (results.some((result) => result.activities.length > 0)) {
        return { threads: results, timedOut: false };
      }
      if (this.closing || Date.now() >= deadline) return { threads: results, timedOut: true };
      await waitWithSignal(Promise.race([
        sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now()))),
        this.shutdownSignal,
      ]), input.signal);
    }
  }

  async getWorkspaceOverride(workspaceId: string): Promise<boolean | undefined> {
    await this.ensureRecovery();
    requireNonEmpty(workspaceId, 'workspaceId');
    return this.mailbox.getWorkspaceOverride(workspaceId, {
      signal: this.mailboxController.signal,
    });
  }

  async setWorkspaceOverride(workspaceId: string, enabled: boolean): Promise<void> {
    await this.ensureRecovery();
    requireNonEmpty(workspaceId, 'workspaceId');
    await this.mailbox.setWorkspaceOverride(workspaceId, enabled, {
      signal: this.mailboxController.signal,
    });
  }

  async clearWorkspaceOverride(workspaceId: string): Promise<void> {
    await this.ensureRecovery();
    requireNonEmpty(workspaceId, 'workspaceId');
    await this.mailbox.clearWorkspaceOverride(workspaceId, {
      signal: this.mailboxController.signal,
    });
  }

  async isWorkspaceEnabled(workspaceId: string, caller?: ThreadCaller): Promise<boolean> {
    return this.globalEnabled(caller).then(async (enabled) => enabled && this.workspaceEnabled(workspaceId));
  }

  private async globalEnabled(caller?: ThreadCaller): Promise<boolean> {
    await this.capabilities.ready;
    const policy = this.optionalPolicy();
    if (policy !== undefined && caller?.sessionId !== undefined) {
      await policy.load(caller.sessionId);
      return policy.admit('thread', { sessionId: caller.sessionId, workspaceId: caller.workspaceId, agentId: caller.agentId }).admitted;
    }
    if (policy !== undefined) return policy.anyMayUse('thread');
    return this.capabilities.threadEnabled(caller?.workspaceId, caller?.sessionId);
  }

  private optionalPolicy(): IOptionalCapabilityPolicy | undefined {
    try {
      return this.instantiation.invokeFunction((accessor) => accessor.get(IOptionalCapabilityPolicy)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async workspaceEnabled(workspaceId: string): Promise<boolean> {
    return (await this.mailbox.getWorkspaceOverride(workspaceId, {
      signal: this.mailboxController.signal,
    })) !== false;
  }

  private requireLocalHost(ref: ThreadRef): ThreadRef {
    const hostId = ref.hostId === 'local' || ref.hostId === '' || ref.hostId === undefined ? this.hostId : ref.hostId;
    if (hostId !== this.hostId || ref.bridgeId !== undefined || ref.connectionId !== undefined) {
      throw new Error2(ErrorCodes.THREAD_CROSS_HOST, 'The local mailbox accepts only this home; peer tools need an approved space bridge for another home.', {
        details: { hostId: ref.hostId },
      });
    }
    return { ...ref, hostId };
  }

  private async requireBridgeCaller(caller?: ThreadCaller): Promise<void> {
    if (caller === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Space thread operations require an executing thread.');
    await this.requireThread({ ...caller, hostId: this.hostId }, caller);
  }

  private async requireThread(ref: ThreadRef, caller?: ThreadCaller, requireCommunication = true): Promise<SessionSummary> {
    this.requireLocalHost(ref);
    if (requireCommunication && (!(await this.globalEnabled(caller)) || !(await this.workspaceEnabled(ref.workspaceId)))) {
      throw threadDisabled(ref.workspaceId);
    }
    const summary = await this.sessions.get(ref.sessionId);
    if (summary === undefined || summary.workspaceId !== ref.workspaceId) {
      throw new Error2(ErrorCodes.THREAD_NOT_FOUND, `Thread "${ref.sessionId}" does not exist.`);
    }
    if (summary.archived) {
      throw new Error2(ErrorCodes.THREAD_ARCHIVED, `Thread "${ref.sessionId}" is archived.`);
    }
    return summary;
  }

  private toThreadSummary(summary: SessionSummary): ThreadSummary {
    const live = this.liveSession(summary.id);
    let state: ThreadSummary['state'] = 'cold';
    if (live !== undefined) {
      state = live.accessor.get(ISessionActivityView).state().busy ? 'running' : 'idle';
    }
    return {
      ref: {
        hostId: this.hostId,
        workspaceId: summary.workspaceId,
        sessionId: summary.id,
      },
      title: summary.title,
      updatedAt: summary.updatedAt,
      createdAt: summary.createdAt,
      state,
    };
  }

  private deliverMessage(
    message: AcceptedThreadMessage,
  ): Promise<SendThreadMessageResult['delivery']> {
    return this.requestTargetDrain(message.target, message.messageId);
  }

  private async threadLabel(ref: ThreadRef): Promise<string> {
    const summary = await this.sessions.get(ref.sessionId).catch(() => undefined);
    const title = summary?.workspaceId === ref.workspaceId ? summary.title : undefined;
    return title === undefined || title === '' ? ref.sessionId : `"${title}" (${ref.sessionId})`;
  }

  private scheduleTargetDrain(target: ThreadRef): void {
    this.backgroundTargets.set(threadIdentity(target), target);
    this.pumpBackgroundTargets();
  }

  private pumpBackgroundTargets(): void {
    while (!this.closing && this.backgroundDrains < MAX_BACKGROUND_TARGET_DRAINS) {
      const target = this.backgroundTargets.values().next().value;
      if (target === undefined) return;
      this.backgroundDrains += 1;
      this.detach(this.requestTargetDrain(target).finally(() => {
        this.backgroundDrains -= 1;
        this.pumpBackgroundTargets();
      }));
    }
  }

  private requestTargetDrain(
    target: ThreadRef,
    observedMessageId?: string,
  ): Promise<SendThreadMessageResult['delivery']> {
    if (this.closing) return Promise.resolve('pending');
    const key = threadIdentity(target);
    this.backgroundTargets.delete(key);
    let state = this.targetDrains.get(key);
    if (state === undefined) {
      state = { target, requested: false };
      this.targetDrains.set(key, state);
    }
    state.requested = true;
    if (state.running !== undefined) {
      return state.running.then(() => 'pending');
    }
    const running = this.runTargetDrain(state, observedMessageId);
    state.running = running;
    void running.finally(() => {
      if (state.running === running) state.running = undefined;
      if (!state.requested || this.closing) this.targetDrains.delete(key);
    }).catch(() => {});
    return running;
  }

  private async runTargetDrain(
    state: TargetDrainState,
    observedMessageId?: string,
  ): Promise<SendThreadMessageResult['delivery']> {
    let observed: SendThreadMessageResult['delivery'] = 'pending';
    do {
      state.requested = false;
      const delivery = await this.drainTarget(state.target, observedMessageId);
      if (delivery !== 'pending') observed = delivery;
    } while (state.requested && !this.closing);
    return observed;
  }

  private async drainTarget(
    target: ThreadRef,
    observedMessageId?: string,
  ): Promise<SendThreadMessageResult['delivery']> {
    let observed: SendThreadMessageResult['delivery'] = 'pending';
    for (;;) {
      if (this.closing) return observed;
      const key = threadIdentity(target);
      const requestId = this.claimRequestIds.get(key) ?? randomUUID();
      this.claimRequestIds.set(key, requestId);
      const claim = await this.mailbox.claimNext({
        target,
        consumerId: `thread-communication/${this.hostId}`,
        leaseMs: DELIVERY_LEASE_MS,
      }, {
        requestId,
        signal: this.mailboxController.signal,
      });
      this.claimRequestIds.delete(key);
      if (claim === undefined || this.closing) return observed;
      const delivery = await this.deliverClaim(claim);
      if (claim.message.messageId === observedMessageId) observed = delivery;
      if (delivery === 'pending') return observed;
    }
  }

  private ensureRoomDeliveryReceipt(
    messageId: string,
    target: RoomDeliveryTarget,
  ): RoomDeliveryReceipt {
    const existing = this.roomDeliveryReceipts.get(messageId);
    if (existing !== undefined) return existing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const receipt: RoomDeliveryReceipt = { target, promise, resolve, reject };
    const retire = (): void => {
      if (this.closing) return;
      receipt.timer = setTimeout(() => {
        if (this.roomDeliveryReceipts.get(messageId) !== receipt) return;
        this.roomDeliveryReceipts.delete(messageId);
        this.roomDeliveryTargets.delete(messageId);
        void this.documents.delete(ROOM_DELIVERY_RECEIPT_SCOPE, messageId).catch(() => {});
      }, ROOM_DELIVERY_RECEIPT_TTL_MS);
      receipt.timer.unref?.();
    };
    void promise.then(retire, retire);
    this.roomDeliveryReceipts.set(messageId, receipt);
    return receipt;
  }

  private async persistRoomDeliveryReceipt(
    messageId: string,
    receipt: PersistedRoomDeliveryReceipt,
  ): Promise<void> {
    await this.documents.set(ROOM_DELIVERY_RECEIPT_SCOPE, messageId, receipt);
  }

  private readRoomDeliveryReceipt(messageId: string): Promise<PersistedRoomDeliveryReceipt | undefined> {
    return this.documents.get<PersistedRoomDeliveryReceipt>(ROOM_DELIVERY_RECEIPT_SCOPE, messageId);
  }

  private resolveRoomDelivery(messageId: string): void {
    const receipt = this.roomDeliveryReceipts.get(messageId);
    const target = receipt?.target ?? this.roomDeliveryTargets.get(messageId);
    if (target !== undefined) {
      void this.persistRoomDeliveryReceipt(messageId, { target, status: 'completed' }).catch(() => {});
    }
    receipt?.resolve();
  }

  private rejectRoomDelivery(messageId: string, error: unknown): void {
    const receipt = this.roomDeliveryReceipts.get(messageId);
    const target = receipt?.target ?? this.roomDeliveryTargets.get(messageId);
    if (target !== undefined) {
      void this.persistRoomDeliveryReceipt(messageId, {
        target,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        errorPayload: toErrorPayload(error),
      }).catch(() => {});
    }
    receipt?.reject(error);
  }

  private trackRoomPromptOutcome(messageId: string, handle: PromptHandle): void {
    void handle.completion.then((completion) => {
      if (completion.state === 'completed') this.resolveRoomDelivery(messageId);
      else if (completion.result?.type === 'failed') {
        this.rejectRoomDelivery(messageId, completion.result.error);
      } else {
        this.rejectRoomDelivery(messageId, new Error2(
          completion.state === 'cancelled' ? ErrorCodes.EXECUTOR_CANCELLED : ErrorCodes.THREAD_DELIVERY_FAILED,
          `Room prompt ${completion.state}.`,
        ));
      }
    }, (error: unknown) => {
      this.rejectRoomDelivery(messageId, error);
    });
  }

  private async deliverClaim(
    claim: ThreadDeliveryClaim,
  ): Promise<SendThreadMessageResult['delivery']> {
    const message = claim.message;
    const roomReceipt = message.producer.kind === 'room'
      ? this.ensureRoomDeliveryReceipt(message.messageId, {
          target: message.target,
          roomId: message.producer.roomId,
          generation: message.producer.generation,
        })
      : undefined;
    let prompt: IAgentPromptService;
    let handle: PromptHandle | undefined;
    try {
      if (message.producer.kind === 'bridged_peer') {
        if (await this.requireConnector().beforeDelivery(message) === 'pending') {
          this.pendingBridgeClaims.set(message.messageId, claim);
          return 'pending';
        }
        this.pendingBridgeClaims.delete(message.messageId);
        await this.requireThread(message.target, message.target);
      }
      const allowWhenDisabled = message.producer.kind === 'peer_thread' && message.producer.allowWhenDisabled === true;
      const requireCommunication = message.producer.kind === 'room' ? message.producer.requireCommunication === true : !allowWhenDisabled;
      if (requireCommunication && !(await this.globalEnabled(message.target))) return 'pending';
      await this.requireThread(message.target, message.target, requireCommunication);
      const session = await waitWithSignal(this.sessionManager.resume(message.target.sessionId), this.mailboxController.signal);
      if (session === undefined) {
        throw new Error2(ErrorCodes.THREAD_NOT_FOUND, `Thread "${message.target.sessionId}" does not exist.`);
      }
      this.mailboxController.signal.throwIfAborted();
      const main = await waitWithSignal(ensureMainAgent(session), this.mailboxController.signal);
      this.mailboxController.signal.throwIfAborted();
      prompt = main.accessor.get(IAgentPromptService);
      const origin: PromptOrigin = message.producer.kind === 'bridged_peer'
        ? { ...message.producer, messageId: message.messageId, acceptedAt: message.acceptedAt }
        : message.producer.kind === 'peer_thread'
        ? {
            kind: 'peer_thread',
            source: {
              ...message.producer.source,
              personaId: message.producer.sender?.personaId ?? message.producer.source.personaId,
              name: message.producer.sender?.name ?? message.producer.source.name,
            },
            messageId: message.messageId,
            acceptedAt: message.acceptedAt,
          } satisfies PeerThreadOrigin
        : message.producer.kind === 'room'
          ? {
              kind: 'room_message',
              roomId: message.producer.roomId,
              messageId: message.messageId,
              targeted: message.producer.targeted === true,
              generation: message.producer.generation,
            }
          : { kind: 'external_thread', messageId: message.messageId, acceptedAt: message.acceptedAt };
      const text = message.producer.kind === 'bridged_peer'
        ? `Verified message from space ${message.producer.sourceHomeId} · thread ${message.producer.source.sessionId} (${message.producer.location}):\n\n${message.content}`
        : message.producer.kind === 'peer_thread'
          ? `Message from thread ${await this.threadLabel(message.producer.source)}:\n\n${message.content}`
          : message.content;
      const input = { id: message.messageId, message: { id: message.messageId, role: 'user' as const,
        content: [{ type: 'text' as const, text, presentation: text === message.content ? undefined : {
          spans: [{ start: 0, end: text.length - message.content.length, kind: 'source' as const }],
        } }], toolCalls: [], origin } };
      const prior = prompt.lookup(message.messageId, input);
      if (prior === undefined || prior.phase === 'pending') handle = await prompt.enqueue(input);
    } catch (error) {
      if (roomReceipt !== undefined) this.rejectRoomDelivery(message.messageId, error);
      if (this.closing) return 'pending';
      return this.recordUndeliverable(claim, error);
    }
    if (handle === undefined) return this.acknowledgeClaim(claim);
    const enqueued = handle;
    if (roomReceipt !== undefined) {
      roomReceipt.cancelPending = () => {
        if (enqueued.state === 'pending') prompt.abort(enqueued.id, new Error('Queued room delivery cancelled.'));
      };
      this.trackRoomPromptOutcome(message.messageId, handle);
    }
    if (handle.state === 'running' || handle.state === 'steered' || isTerminalPromptState(handle.state)) {
      return this.acknowledgeClaim(claim);
    }
    if (handle.state === 'pending' && message.producer.kind === 'room' && message.producer.queueWhenBusy === true) {
      this.detach(this.observePromptOutcome(claim, handle));
      return 'pending';
    }
    if (handle.state === 'pending') {
      try {
        await prompt.steer([message.messageId]);
      } catch (error) {
        if (!(isError2(error) && error.code === ErrorCodes.PROMPT_NOT_FOUND)) {
          if (this.closing) return 'pending';
          return this.recordUndeliverable(claim, error);
        }
        this.detach(this.observePromptOutcome(claim, handle));
        return 'pending';
      }
      if (this.closing) return 'pending';
      return this.acknowledgeClaim(claim);
    }
    this.detach(this.observePromptOutcome(claim, handle));
    return 'pending';
  }

  private async observePromptOutcome(
    claim: ThreadDeliveryClaim,
    handle: PromptHandle,
  ): Promise<void> {
    try {
      const outcome = await Promise.race([
        Promise.race([handle.launched, handle.completion]).then(() => 'launched' as const),
        this.shutdownSignal.then(() => 'shutdown' as const),
      ]);
      if (outcome === 'shutdown' || this.closing) return;
      await this.acknowledgeClaim(claim);
    } catch (error) {
      if (this.closing) return;
      await this.recordUndeliverable(claim, error);
    }
    await this.requestTargetDrain(claim.message.target);
  }

  private async acknowledgeClaim(
    claim: ThreadDeliveryClaim,
  ): Promise<SendThreadMessageResult['delivery']> {
    try {
      const changed = await this.mailbox.acknowledgeDelivery(claim, {
        requestId: threadMailboxClaimRequestId('thread-ack', claim),
        signal: this.mailboxController.signal,
      });
      return changed ? 'delivered' : 'pending';
    } catch (error) {
      if (claim.message.producer.kind !== 'bridged_peer') throw error;
      if (!this.closing) this.pendingBridgeClaims.set(claim.message.messageId, claim);
      this.log.warn('Bridge prompt is durable; mailbox acknowledgement will retry', { messageId: claim.message.messageId });
      return 'pending';
    }
  }

  private async recordUndeliverable(
    claim: ThreadDeliveryClaim,
    error: unknown,
  ): Promise<SendThreadMessageResult['delivery']> {
    const reason = error instanceof Error ? error.message : String(error);
    const changed = await this.mailbox.markUndeliverable(claim, { code: threadDeliveryReasonCode(error), detail: reason }, {
      requestId: threadMailboxClaimRequestId('thread-undeliverable', claim),
      signal: this.mailboxController.signal,
    });
    if (!changed) return 'pending';
    if (claim.message.producer.kind === 'room') {
      this.rejectRoomDelivery(claim.message.messageId, new Error(reason));
    }
    await this.mailbox.appendActivity({
      target: claim.message.target,
      kind: 'message_undeliverable',
      reason,
      messageId: claim.message.messageId,
    }, {
      requestId: threadMailboxClaimRequestId('thread-undeliverable-activity', claim),
      signal: this.mailboxController.signal,
    });
    return 'undeliverable';
  }

  private ensureRecovery(): Promise<void> {
    if (this.recovery !== undefined) return this.recovery;
    const flight = this.recoverPendingDeliveries().then((completed) => {
      if (!completed && this.recovery === flight) this.recovery = undefined;
    }).catch((error) => {
      if (this.recovery === flight) this.recovery = undefined;
      throw error;
    });
    this.recovery = flight;
    return flight;
  }

  private async recoverPendingDeliveries(): Promise<boolean> {
    if (this.bootstrap.interactive === false) return false;
    await this.config.ready;
    if (this.closing || (!(await this.globalEnabled()) && !this.capabilities.anySessionThreadEnabled())) return false;
    const targets = await this.mailbox.listPendingTargets({
      signal: this.mailboxController.signal,
    });
    for (const target of targets) {
      if (this.closing) return false;
      if (target.hostId !== this.hostId) continue;
      this.scheduleTargetDrain(target);
    }
    return true;
  }

  private async flushLiveMain(sessionId: string): Promise<void> {
    const live = this.liveSession(sessionId);
    const main = live?.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
    await main?.accessor.get(IWireService).flush();
  }

  private followLifecycle(lifecycle: ISessionManager): DisposableStore {
    const store = new DisposableStore();
    for (const session of lifecycle.list()) this.observeSession(session);
    if (lifecycle.onDidCreateSession !== undefined) {
      store.add(lifecycle.onDidCreateSession((event) => this.observeSession(event.handle)));
    }
    if (lifecycle.onDidForkSession !== undefined) {
      store.add(lifecycle.onDidForkSession((event) => this.observeSession(event.handle)));
    }
    if (lifecycle.onDidArchiveSession !== undefined) {
      store.add(
        lifecycle.onDidArchiveSession((event) => {
          const ref = this.refForLifecycleSession(lifecycle, event.sessionId);
          this.detachObservedSession(event.sessionId);
          if (!this.closing && ref !== undefined) this.detach(this.appendLifecycle(ref, 'archived'));
        }),
      );
    }
    if (lifecycle.onDidCloseSession !== undefined) {
      store.add(
        lifecycle.onDidCloseSession((event) => {
          const ref = this.detachObservedSession(event.sessionId);
          if (this.closing || ref === undefined) return;
          this.detach(this.appendLifecycle(ref, 'closed'));
        }),
      );
    }
    return store;
  }

  private liveSession(sessionId: string): ISessionScopeHandle | undefined {
    return this.sessionManager.get(sessionId);
  }

  private observeSession(handle: ISessionScopeHandle): void {
    const ctx = handle.accessor.get(ISessionContext);
    const ref: ThreadRef = {
      hostId: this.hostId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
    };
    const key = threadIdentity(ref);
    if (this.observedSessions.has(key)) return;
    const store = new DisposableStore();
    const activity = handle.accessor.get(ISessionActivityView);
    store.add(
      activity.onDidChange((event) => {
        if (this.closing) return;
        if (event.cause === 'turn_ended') {
          this.detach(this.appendActivityIfEnabled(
            ref,
            'terminal',
            event.state.lastTurnReason ?? 'failed',
          ));
        }
        if (event.cause === 'interaction' && event.state.pendingInteraction !== 'none') {
          this.detach(this.appendActivityIfEnabled(
            ref,
            'attention',
            event.state.pendingInteraction,
          ));
        }
      }),
    );
    this.observedSessions.set(key, store);
  }

  private refForLifecycleSession(
    lifecycle: ISessionManager,
    sessionId: string,
  ): ThreadRef | undefined {
    const session = lifecycle.get(sessionId);
    if (session !== undefined) {
      const ctx = session.accessor.get(ISessionContext);
      return { hostId: this.hostId, workspaceId: ctx.workspaceId, sessionId };
    }
    const observed = [...this.observedSessions.keys()].find((key) => key.endsWith(`\u0000${sessionId}`));
    return observed === undefined ? undefined : parseThreadIdentity(observed);
  }

  private detachObservedSession(sessionId: string): ThreadRef | undefined {
    const key = [...this.observedSessions.keys()].find((candidate) =>
      candidate.endsWith(`\u0000${sessionId}`),
    );
    if (key === undefined) return undefined;
    const store = this.observedSessions.get(key);
    this.observedSessions.delete(key);
    const result = store?.dispose();
    if (isPromiseLike(result)) result.catch(onUnexpectedError);
    return parseThreadIdentity(key);
  }

  private appendLifecycle(ref: ThreadRef, reason: string): Promise<unknown> {
    return this.appendActivityIfEnabled(ref, 'lifecycle', reason);
  }

  private appendActivityIfEnabled(
    target: ThreadRef,
    kind: ThreadActivityKind,
    reason: string,
  ): Promise<unknown> {
    return this.globalEnabled(target).then((enabled) => {
      if (!enabled || this.closing || this.bootstrap.interactive === false) return undefined;
      return this.mailbox.appendActivity({ target, kind, reason }, {
        signal: this.mailboxController.signal,
      });
    });
  }

  private async recordTerminalLifecycleChanges(refs: readonly ThreadRef[]): Promise<void> {
    for (const ref of refs) {
      const summary = await this.sessions.get(ref.sessionId);
      const reason =
        summary === undefined || summary.workspaceId !== ref.workspaceId
          ? 'deleted'
          : summary.archived
            ? 'archived'
            : undefined;
      if (reason === undefined) continue;
      let page;
      try {
        page = await this.mailbox.readActivity(ref, 0, WAIT_ACTIVITY_LIMIT, {
          signal: this.mailboxController.signal,
        });
      } catch (error) {
        if (!(error instanceof ThreadActivityCursorExpiredError)) throw error;
        page = await this.mailbox.readActivity(ref, error.minSeq - 1, WAIT_ACTIVITY_LIMIT, {
          signal: this.mailboxController.signal,
        });
      }
      const alreadyRecorded = page.activities.some(
        (activity) => activity.kind === 'lifecycle' && activity.reason === reason,
      );
      if (!alreadyRecorded) await this.appendLifecycle(ref, reason);
    }
  }

  private async readWaitResult(ref: ThreadRef, cursor: ActivityCursor): Promise<WaitThreadResult> {
    let page;
    try {
      page = await this.mailbox.readActivity(ref, cursor.seq, WAIT_ACTIVITY_LIMIT, {
        signal: this.mailboxController.signal,
      });
    } catch (error) {
      if (!(error instanceof ThreadActivityCursorExpiredError)) throw error;
      throw new Error2(
        ErrorCodes.THREAD_CURSOR_INVALID,
        'Activity cursor is older than retained history; retry ThreadWait without this cursor.',
        {
          details: {
            resyncCursor: encodeCursor({
              v: 1,
              kind: 'activity',
              epoch: error.epoch,
              seq: error.latestSeq,
              thread: threadIdentity(ref),
            }),
          },
        },
      );
    }
    if (page.epoch !== cursor.epoch) {
      throw cursorError('Activity cursor belongs to an expired mailbox epoch.');
    }
    const activities: ThreadActivity[] = page.activities.map((activity) => ({
      ref,
      seq: activity.seq,
      kind: activity.kind,
      at: activity.at,
      reason: activity.reason,
      turnId: activity.turnId,
      messageId: activity.messageId,
    }));
    const seq = activities.at(-1)?.seq ?? cursor.seq;
    return {
      thread: ref,
      cursor: encodeCursor({
        v: 1,
        kind: 'activity',
        epoch: page.epoch,
        seq,
        thread: threadIdentity(ref),
      }),
      activities,
    };
  }

  private detach(operation: Promise<unknown>): void {
    let guarded!: Promise<void>;
    guarded = operation.then(
      () => {},
      (error) => this.log.error('Detached thread communication operation failed', { error }),
    ).finally(() => this.detached.delete(guarded));
    this.detached.add(guarded);
  }

}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new Error2(ErrorCodes.THREAD_LIMIT_EXCEEDED, `limit must be an integer from 1 to ${max}.`);
  }
  return resolved;
}

function boundedTimeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > MAX_WAIT_TIMEOUT_MS) {
    throw new Error2(
      ErrorCodes.THREAD_LIMIT_EXCEEDED,
      `timeoutMs must be an integer from 0 to ${MAX_WAIT_TIMEOUT_MS}.`,
    );
  }
  return resolved;
}

function validateSendInput(input: SendThreadMessageInput): void {
  requireNonEmpty(input.content, 'content');
  requireNonEmpty(input.idempotencyKey, 'idempotencyKey');
  if (input.content.length > 100_000) {
    throw new Error2(ErrorCodes.THREAD_LIMIT_EXCEEDED, 'Message content exceeds 100000 characters.');
  }
  if (input.idempotencyKey.length > 256) {
    throw new Error2(ErrorCodes.THREAD_LIMIT_EXCEEDED, 'idempotencyKey exceeds 256 characters.');
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `${name} must not be empty.`);
  }
}

function threadDisabled(workspaceId: string): Error2 {
  return new Error2(
    ErrorCodes.THREAD_DISABLED,
    `Thread communication is disabled for workspace "${workspaceId}".`,
  );
}

function cursorError(message: string): Error2 {
  return new Error2(ErrorCodes.THREAD_CURSOR_INVALID, message);
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor<K extends CursorPayload['kind']>(
  value: string,
  kind: K,
): Extract<CursorPayload, { readonly kind: K }> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorPayload;
    if (parsed.v !== 1 || parsed.kind !== kind) throw new Error('kind');
    if (kind === 'list' && typeof (parsed as ListCursor).before !== 'string') throw new Error('list');
    if (kind === 'read') {
      const read = parsed as ReadCursor;
      if (!Number.isSafeInteger(read.beforeTurnId) || typeof read.thread !== 'string') throw new Error('read');
      const source = read.source;
      if (source !== undefined && (source === null || typeof source !== 'object' ||
        typeof source.generation !== 'string' || typeof source.epoch !== 'string' ||
        !Number.isSafeInteger(source.watermark) || source.watermark < 0 || typeof source.proof !== 'string')) throw new Error('read source');
    }
    if (
      kind === 'activity' &&
      (typeof (parsed as ActivityCursor).epoch !== 'string' ||
        !Number.isSafeInteger((parsed as ActivityCursor).seq) ||
        typeof (parsed as ActivityCursor).thread !== 'string')
    ) {
      throw new Error('activity');
    }
    return parsed as Extract<CursorPayload, { readonly kind: K }>;
  } catch {
    throw cursorError(`Invalid ${kind} cursor.`);
  }
}

function threadIdentity(ref: ThreadRef): string {
  return `${ref.hostId}\u0000${ref.workspaceId}\u0000${ref.sessionId}`;
}

function parseThreadIdentity(value: string): ThreadRef {
  const [hostId = '', workspaceId = '', sessionId = ''] = value.split('\u0000');
  return { hostId, workspaceId, sessionId };
}

function sameThread(left: ThreadRef, right: ThreadRef): boolean {
  return threadIdentity(left) === threadIdentity(right);
}

function isTerminalPromptState(state: PromptHandle['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'blocked';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
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

function waitBoundedDelivery(
  deliveryPromise: Promise<SendThreadMessageResult['delivery']>,
  signal?: AbortSignal,
  timeoutMs = FAST_DELIVERY_TIMEOUT_MS,
): Promise<SendThreadMessageResult['delivery']> {
  void deliveryPromise.catch(() => {});
  if (signal?.aborted || timeoutMs <= 0) return Promise.resolve('pending');
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  return new Promise<SendThreadMessageResult['delivery']>((resolve, reject) => {
    onAbort = () => resolve('pending');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => resolve('pending'), timeoutMs);
    timer.unref?.();
    deliveryPromise.then(
      (delivery) => resolve(delivery),
      (error) => reject(error),
    );
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  });
}

registerScopedService(
  LifecycleScope.App,
  IThreadCommunicationService,
  ThreadCommunicationService,
  ScopeActivation.OnScopeCreated,
  'threadCommunication',
);
