import { createKimiDeviceId } from '@kiki/oauth';

import { Disposable, DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentPromptService, type PromptHandle } from '#/agent/prompt/prompt';
import {
  USER_PROMPT_ORIGIN,
  type PeerThreadOrigin,
  type PromptOrigin,
} from '#/agent/contextMemory/types';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import { Error2, ErrorCodes, isError2 } from '#/errors';
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
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { THREAD_COMMUNICATION_SECTION, type ThreadCommunicationConfig } from './configSection';
import {
  IThreadCommunicationService,
  type ListThreadsInput,
  type ListThreadsResult,
  type ReadThreadInput,
  type ReadThreadResult,
  type SendThreadMessageInput,
  type SendThreadMessageResult,
  type ThreadActivity,
  type ThreadRef,
  type ThreadSummary,
  type ThreadTurn,
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
import {
  SEND_PEER_THREAD_MESSAGE,
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
}

interface ActivityCursor {
  readonly v: 1;
  readonly kind: 'activity';
  readonly epoch: string;
  readonly seq: number;
  readonly thread: string;
}

interface MutableTurn {
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly input: string;
  readonly startedAt?: number;
  readonly output: string[];
}

interface TargetDrainState {
  readonly target: ThreadRef;
  requested: boolean;
  running?: Promise<SendThreadMessageResult['delivery']>;
}

export class ThreadCommunicationService extends Disposable implements IThreadCommunicationService, IThreadPeerSendCapability {
  declare readonly _serviceBrand: undefined;
  readonly hostId: string;

  private readonly observedSessions = new Map<string, DisposableStore>();
  private recovery: Promise<void> | undefined;
  private readonly detached = new Set<Promise<void>>();
  private readonly targetDrains = new Map<string, TargetDrainState>();
  private readonly mailboxController = new AbortController();
  private readonly shutdownSignal: Promise<void>;
  private resolveShutdown!: () => void;
  private closing = false;
  private shutdownFlight: Promise<void> | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionIndex private readonly sessions: ISessionIndex,
    @ISessionManager private readonly sessionManager: ISessionManager,
    @IThreadMailboxStore private readonly mailbox: IThreadMailboxStore,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.hostId = createKimiDeviceId(bootstrap.homeDir);
    this.shutdownSignal = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
    this._register(toDisposable(() => {
      for (const store of this.observedSessions.values()) store.dispose();
      this.observedSessions.clear();
    }));
    this._register(this.followLifecycle(this.sessionManager));
    void this.ensureRecovery().catch(() => {});
  }

  shutdown(): Promise<void> {
    this.shutdownFlight ??= this.doShutdown();
    return this.shutdownFlight;
  }

  private async doShutdown(): Promise<void> {
    this.closing = true;
    this.mailboxController.abort(new Error('Thread communication is shutting down.'));
    this.resolveShutdown();
    this.dispose();
    await this.recovery?.catch(() => {});
    while (this.detached.size > 0) {
      await Promise.all(this.detached);
    }
  }

  async listThreads(input: ListThreadsInput = {}): Promise<ListThreadsResult> {
    await this.ensureRecovery();
    if (!(await this.globalEnabled())) return { threads: [] };
    const limit = boundedLimit(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const decoded = input.cursor === undefined ? undefined : decodeCursor(input.cursor, 'list');
    if (decoded !== undefined && decoded.workspaceId !== input.workspaceId) {
      throw cursorError('List cursor does not match the requested workspace.');
    }

    const threads: ThreadSummary[] = [];
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
        if (!(await this.workspaceEnabled(summary.workspaceId))) continue;
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
    await this.ensureRecovery();
    const summary = await this.requireThread(input.thread);
    const limit = boundedLimit(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    const decoded = input.cursor === undefined ? undefined : decodeCursor(input.cursor, 'read');
    const identity = threadIdentity(input.thread);
    if (decoded !== undefined && decoded.thread !== identity) {
      throw cursorError('Read cursor does not match the requested thread.');
    }
    await this.flushLiveMain(summary.id);
    const turns = await this.readCompletedTurns(summary);
    const beforeTurnId = decoded?.beforeTurnId ?? Number.MAX_SAFE_INTEGER;
    const eligible = turns.filter((turn) => turn.turnId < beforeTurnId);
    const page = eligible.slice(Math.max(0, eligible.length - limit));
    const hasOlder = eligible.length > page.length;
    return {
      thread: input.thread,
      turns: page,
      nextCursor:
        hasOlder && page[0] !== undefined
          ? encodeCursor({ v: 1, kind: 'read', beforeTurnId: page[0].turnId, thread: identity })
          : undefined,
    };
  }

  async sendMessage(input: SendThreadMessageInput): Promise<SendThreadMessageResult> {
    return this.sendProducedMessage({
      producer: { kind: 'external_client' },
      target: input.target,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async [SEND_PEER_THREAD_MESSAGE](input: SendPeerThreadMessageInput): Promise<SendThreadMessageResult> {
    await this.ensureRecovery();
    validateSendInput(input);
    await this.requireThread(input.source);
    if (sameThread(input.source, input.target)) {
      throw new Error2(ErrorCodes.THREAD_SELF_SEND, 'A thread cannot send a message to itself.');
    }
    return this.sendProducedMessage({
      producer: { kind: 'peer_thread', source: input.source },
      target: input.target,
      content: input.content,
      idempotencyKey: input.idempotencyKey,
    });
  }

  private async sendProducedMessage(input: {
    readonly producer: ThreadMessageProducer;
    readonly target: ThreadRef;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<SendThreadMessageResult> {
    await this.ensureRecovery();
    validateSendInput(input);
    await this.requireThread(input.target);
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
    if (delivery === 'pending') {
      delivery = await this.deliverMessage(accepted.message);
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
    await this.ensureRecovery();
    if (input.threads.length === 0 || input.threads.length > MAX_WAIT_THREADS) {
      throw new Error2(
        ErrorCodes.THREAD_LIMIT_EXCEEDED,
        `ThreadWait accepts between 1 and ${MAX_WAIT_THREADS} threads.`,
      );
    }
    const seen = new Set<string>();
    for (const item of input.threads) {
      this.requireLocalHost(item.thread);
      const key = threadIdentity(item.thread);
      if (seen.has(key)) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'ThreadWait contains duplicate threads.');
      }
      seen.add(key);
      if (!(await this.workspaceEnabled(item.thread.workspaceId))) {
        throw threadDisabled(item.thread.workspaceId);
      }
    }
    const timeoutMs = boundedTimeout(input.timeoutMs);
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

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.recordTerminalLifecycleChanges(input.threads.map((item) => item.thread));
      const results = await Promise.all(
        input.threads.map((item, index) => this.readWaitResult(item.thread, baselines[index]!)),
      );
      if (results.some((result) => result.activities.length > 0)) {
        return { threads: results, timedOut: false };
      }
      if (this.closing || Date.now() >= deadline) return { threads: results, timedOut: true };
      await Promise.race([
        sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now()))),
        this.shutdownSignal,
      ]);
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

  async isWorkspaceEnabled(workspaceId: string): Promise<boolean> {
    await this.ensureRecovery();
    return this.globalEnabled().then(async (enabled) => enabled && this.workspaceEnabled(workspaceId));
  }

  private async globalEnabled(): Promise<boolean> {
    await this.config.ready;
    return this.config.get<ThreadCommunicationConfig>(THREAD_COMMUNICATION_SECTION).enabled;
  }

  private async workspaceEnabled(workspaceId: string): Promise<boolean> {
    return (await this.mailbox.getWorkspaceOverride(workspaceId, {
      signal: this.mailboxController.signal,
    })) !== false;
  }

  private requireLocalHost(ref: ThreadRef): void {
    if (ref.hostId !== this.hostId) {
      throw new Error2(ErrorCodes.THREAD_CROSS_HOST, 'Cross-host thread communication is not supported.', {
        details: { hostId: ref.hostId },
      });
    }
  }

  private async requireThread(ref: ThreadRef): Promise<SessionSummary> {
    this.requireLocalHost(ref);
    if (!(await this.globalEnabled()) || !(await this.workspaceEnabled(ref.workspaceId))) {
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

  private requestTargetDrain(
    target: ThreadRef,
    observedMessageId?: string,
  ): Promise<SendThreadMessageResult['delivery']> {
    if (this.closing) return Promise.resolve('pending');
    const key = threadIdentity(target);
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
      const claim = await this.mailbox.claimNext({
        target,
        consumerId: `thread-communication/${this.hostId}`,
        leaseMs: DELIVERY_LEASE_MS,
      }, {
        signal: this.mailboxController.signal,
      });
      if (claim === undefined || this.closing) return observed;
      const delivery = await this.deliverClaim(claim);
      if (claim.message.messageId === observedMessageId) observed = delivery;
      if (delivery === 'pending') return observed;
    }
  }

  private async deliverClaim(
    claim: ThreadDeliveryClaim,
  ): Promise<SendThreadMessageResult['delivery']> {
    const message = claim.message;
    let prompt: IAgentPromptService;
    let handle: PromptHandle;
    try {
      await this.requireThread(message.target);
      const session = await this.sessionManager.resume(message.target.sessionId);
      if (session === undefined) {
        throw new Error2(ErrorCodes.THREAD_NOT_FOUND, `Thread "${message.target.sessionId}" does not exist.`);
      }
      const main = await ensureMainAgent(session);
      prompt = main.accessor.get(IAgentPromptService);
      const origin: PromptOrigin = message.producer.kind === 'peer_thread'
        ? {
            kind: 'peer_thread',
            source: message.producer.source,
            messageId: message.messageId,
            acceptedAt: message.acceptedAt,
          } satisfies PeerThreadOrigin
        : USER_PROMPT_ORIGIN;
      const text = message.producer.kind === 'peer_thread'
        ? `Message from thread ${await this.threadLabel(message.producer.source)}:\n\n${message.content}`
        : message.content;
      handle = await prompt.enqueue({
        id: message.messageId,
        message: {
          id: message.messageId,
          role: 'user',
          content: [{ type: 'text', text }],
          toolCalls: [],
          origin,
        },
      });
    } catch (error) {
      if (this.closing) return 'pending';
      return this.recordUndeliverable(claim, error);
    }
    if (handle.state === 'running' || handle.state === 'steered' || isTerminalPromptState(handle.state)) {
      return this.acknowledgeClaim(claim);
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
    const changed = await this.mailbox.acknowledgeDelivery(claim, {
      requestId: threadMailboxClaimRequestId('thread-ack', claim),
      signal: this.mailboxController.signal,
    });
    return changed ? 'delivered' : 'pending';
  }

  private async recordUndeliverable(
    claim: ThreadDeliveryClaim,
    error: unknown,
  ): Promise<SendThreadMessageResult['delivery']> {
    const reason = error instanceof Error ? error.message : String(error);
    const changed = await this.mailbox.markUndeliverable(claim, reason, {
      requestId: threadMailboxClaimRequestId('thread-undeliverable', claim),
      signal: this.mailboxController.signal,
    });
    if (!changed) return 'pending';
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
    const flight = this.recoverPendingDeliveries().catch((error) => {
      if (this.recovery === flight) this.recovery = undefined;
      throw error;
    });
    this.recovery = flight;
    return flight;
  }

  private async recoverPendingDeliveries(): Promise<void> {
    await this.config.ready;
    if (this.closing) return;
    const targets = await this.mailbox.listPendingTargets({
      signal: this.mailboxController.signal,
    });
    for (const target of targets) {
      if (this.closing || !(await this.globalEnabled())) return;
      if (target.hostId !== this.hostId) continue;
      await this.requestTargetDrain(target);
    }
  }

  private async flushLiveMain(sessionId: string): Promise<void> {
    const live = this.liveSession(sessionId);
    const main = live?.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
    await main?.accessor.get(IWireService).flush();
  }

  private async readCompletedTurns(summary: SessionSummary): Promise<ThreadTurn[]> {
    const handlerScope = workspacePersistenceScope(
      this.bootstrap.scope('sessions'),
      summary.workspaceId,
    );
    const wireScope = agentScopeOf(sessionScopeOf(handlerScope, summary.id), MAIN_AGENT_ID);
    const turns = new Map<number, MutableTurn>();
    const completed: ThreadTurn[] = [];
    let nextTurnId = 0;
    const cancelledTurnIds = new Set<number>();
    for await (const record of this.appendLog.read<WireRecord>(wireScope, AGENT_WIRE_RECORD_KEY)) {
      if (record.type === 'turn.cancel') {
        const cancelled = readNumber(record, 'turnId');
        if (
          cancelled !== undefined &&
          typeof record['target'] === 'string' &&
          (record['target'] === 'active' || record['target'] === 'queued') &&
          cancelled >= nextTurnId
        ) {
          cancelledTurnIds.add(cancelled);
          nextTurnId = advanceReadTurnClock(nextTurnId, cancelledTurnIds);
        }
        continue;
      }
      if (record.type === 'turn.prompt') {
        const origin = readPromptOrigin(record['origin']);
        const input = readContentText(record['input']);
        if (origin !== undefined) {
          turns.set(nextTurnId, {
            turnId: nextTurnId,
            origin,
            input,
            startedAt: readNumber(record, 'time'),
            output: [],
          });
        }
        nextTurnId = advanceReadTurnClock(nextTurnId + 1, cancelledTurnIds);
        continue;
      }
      if (record.type === 'context.append_loop_event') {
        const event = record['event'] as LoopRecordedEvent | undefined;
        if (event?.type !== 'tool.result' && event?.turnId !== undefined) {
          const observedTurnId = Number.parseInt(event.turnId, 10);
          if (Number.isInteger(observedTurnId) && observedTurnId >= nextTurnId) {
            nextTurnId = advanceReadTurnClock(observedTurnId + 1, cancelledTurnIds);
          }
        }
        if (event?.type !== 'content.part' || event.part.type !== 'text') continue;
        const turnId = event.turnId === undefined ? undefined : Number.parseInt(event.turnId, 10);
        if (turnId === undefined || !Number.isInteger(turnId)) continue;
        turns.get(turnId)?.output.push(event.part.text);
        continue;
      }
      if (record.type !== 'turn.ended') continue;
      const turnId = readNumber(record, 'turnId');
      const reason = readTurnReason(record['reason']);
      if (turnId === undefined || reason === undefined) continue;
      const turn = turns.get(turnId);
      turns.delete(turnId);
      if (turn === undefined) continue;
      const origin = publicTurnOrigin(turn.origin);
      if (origin === undefined) continue;
      completed.push({
        turnId,
        startedAt: turn.startedAt,
        endedAt: readNumber(record, 'time') ?? turn.startedAt ?? 0,
        reason,
        origin: origin.kind,
        peer: origin.peer,
        input: turn.input,
        output: turn.output.join(''),
      });
    }
    return completed.toSorted((left, right) => left.turnId - right.turnId);
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
          this.detach(this.mailbox.appendActivity({
            target: ref,
            kind: 'terminal',
            reason: event.state.lastTurnReason ?? 'failed',
          }, {
            signal: this.mailboxController.signal,
          }));
        }
        if (event.cause === 'interaction' && event.state.pendingInteraction !== 'none') {
          this.detach(this.mailbox.appendActivity({
            target: ref,
            kind: 'attention',
            reason: event.state.pendingInteraction,
          }, {
            signal: this.mailboxController.signal,
          }));
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
    store?.dispose();
    return parseThreadIdentity(key);
  }

  private appendLifecycle(ref: ThreadRef, reason: string): Promise<unknown> {
    return this.mailbox.appendActivity({ target: ref, kind: 'lifecycle', reason }, {
      signal: this.mailboxController.signal,
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

function publicTurnOrigin(
  origin: PromptOrigin,
): { readonly kind: 'user' | 'peer'; readonly peer?: ThreadTurn['peer'] } | undefined {
  if (origin.kind === 'peer_thread') {
    return { kind: 'peer', peer: { source: origin.source, messageId: origin.messageId } };
  }
  if (origin.kind === 'user') return { kind: 'user' };
  if (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  ) {
    return { kind: 'user' };
  }
  return undefined;
}

function readPromptOrigin(value: unknown): PromptOrigin | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return value as PromptOrigin;
}

function readContentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((part): part is ContentPart => part !== null && typeof part === 'object' && 'type' in part)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function readNumber(record: WireRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTurnReason(value: unknown): ThreadTurn['reason'] | undefined {
  return value === 'completed' || value === 'cancelled' || value === 'failed' || value === 'blocked'
    ? value
    : undefined;
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
    if (
      kind === 'read' &&
      (!Number.isSafeInteger((parsed as ReadCursor).beforeTurnId) ||
        typeof (parsed as ReadCursor).thread !== 'string')
    ) {
      throw new Error('read');
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

function advanceReadTurnClock(nextTurnId: number, cancelledTurnIds: Set<number>): number {
  for (const cancelled of cancelledTurnIds) {
    if (cancelled < nextTurnId) cancelledTurnIds.delete(cancelled);
  }
  while (cancelledTurnIds.delete(nextTurnId)) nextTurnId++;
  return nextTurnId;
}

function isTerminalPromptState(state: PromptHandle['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'blocked';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

registerScopedService(
  LifecycleScope.App,
  IThreadCommunicationService,
  ThreadCommunicationService,
  ScopeActivation.OnScopeCreated,
  'threadCommunication',
);
