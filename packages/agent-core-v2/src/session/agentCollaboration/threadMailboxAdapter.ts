/**
 * `agentCollaboration` domain — named-agent mailbox adapter.
 *
 * Maps session-local Agent addresses and versioned message envelopes onto the
 * durable `threadCommunication` MiniDb mailbox backend, rooted through
 * `bootstrap`. Checks the retired directory through `hostFs` and warns through
 * `log`; delivery remains owned by the Session-scoped messaging service. Bound
 * at App scope.
 */

import { join } from 'pathe';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ThreadMailboxBacklogError } from '#/app/threadCommunication/mailboxErrors';
import { MiniDbMailboxBackend } from '#/app/threadCommunication/miniDbMailboxBackend';
import type { AcceptedThreadMessage } from '#/app/threadCommunication/threadMailboxStore';
import type { ThreadRef } from '#/app/threadCommunication/threadCommunication';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import {
  AGENT_MESSAGE_BACKLOG_LIMIT,
  AgentMessageMailboxFullError,
  IAgentCollaborationMessageStore,
  type AcceptedAgentMessage,
  type AgentMessageAcceptance,
} from './messageMailbox';

const MAILBOX_HOST_ID = 'agent-collaboration-v2';
const LEGACY_MAILBOX_DIR = 'agent-collaboration-mailbox-v1';
const MAILBOX_DIR = 'agent-collaboration-mailbox-v2';
const RECEIPT_BACKLOG_LIMIT = 256;
const DELIVERY_EVENTS_PER_MESSAGE = 3;

interface AgentMailboxEnvelopeV1 {
  readonly v: 1;
  readonly kind: 'agent_collaboration_message';
  readonly sourceTaskName: string;
  readonly targetTaskName: string;
  readonly content: string;
}

export class AgentCollaborationMessageStoreAdapter implements IAgentCollaborationMessageStore {
  declare readonly _serviceBrand: undefined;

  private readonly backend: MiniDbMailboxBackend;
  private readonly attempts = new Map<string, string>();

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IHostFileSystem fs: IHostFileSystem,
    @ILogService log: ILogService,
  ) {
    this.backend = new MiniDbMailboxBackend(join(bootstrap.storeDir, MAILBOX_DIR), {
      mailboxBacklogLimit: RECEIPT_BACKLOG_LIMIT * DELIVERY_EVENTS_PER_MESSAGE,
      pendingMessageLimit: AGENT_MESSAGE_BACKLOG_LIMIT,
    });
    void warnIfLegacyMailboxPresent(fs, log, join(bootstrap.storeDir, LEGACY_MAILBOX_DIR));
  }

  async accept(input: {
    readonly sessionId: string;
    readonly sourceAgentId: string;
    readonly sourceTaskName: string;
    readonly targetAgentId: string;
    readonly targetTaskName: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<AgentMessageAcceptance> {
    const envelope: AgentMailboxEnvelopeV1 = {
      v: 1,
      kind: 'agent_collaboration_message',
      sourceTaskName: input.sourceTaskName,
      targetTaskName: input.targetTaskName,
      content: input.content,
    };
    try {
      const accepted = await this.backend.acceptMessage({
        producer: { kind: 'peer_thread', source: agentRef(input.sessionId, input.sourceAgentId) },
        target: agentRef(input.sessionId, input.targetAgentId),
        content: JSON.stringify(envelope),
        idempotencyKey: input.idempotencyKey,
      });
      const message = toAgentMessage(accepted.message);
      return {
        message,
        deduplicated: accepted.deduplicated,
        delivery: toAgentDelivery(accepted.delivery),
        payloadConflict: message.content !== input.content,
      };
    } catch (error) {
      if (error instanceof ThreadMailboxBacklogError) {
        throw new AgentMessageMailboxFullError(AGENT_MESSAGE_BACKLOG_LIMIT);
      }
      throw error;
    }
  }

  async nextQueued(sessionId: string, targetAgentId: string): Promise<AcceptedAgentMessage | undefined> {
    const target = agentRef(sessionId, targetAgentId);
    const pending = (await this.backend.listPendingDeliveries())
      .filter((message) => sameThread(message.target, target))
      .toSorted((left, right) => left.targetSeq - right.targetSeq);
    for (const message of pending) {
      const attempt = await this.backend.beginDelivery(message.messageId);
      if (attempt === undefined) continue;
      this.attempts.set(message.messageId, attempt.attemptId);
      return toAgentMessage(attempt.message);
    }
    return undefined;
  }

  async markDelivered(messageId: string): Promise<boolean> {
    const attemptId = this.attempts.get(messageId);
    if (attemptId === undefined) return false;
    this.attempts.delete(messageId);
    return this.backend.acknowledgeDelivery(messageId, attemptId);
  }
}

function agentRef(sessionId: string, agentId: string): ThreadRef {
  return { hostId: MAILBOX_HOST_ID, workspaceId: sessionId, sessionId: agentId };
}

function toAgentMessage(message: AcceptedThreadMessage): AcceptedAgentMessage {
  if (message.producer.kind !== 'peer_thread') {
    throw new Error(`Named-agent mailbox message "${message.messageId}" has an invalid producer.`);
  }
  const source = message.producer.source;
  if (
    source.hostId !== MAILBOX_HOST_ID ||
    message.target.hostId !== MAILBOX_HOST_ID ||
    source.workspaceId !== message.target.workspaceId
  ) {
    throw new Error(`Named-agent mailbox message "${message.messageId}" has an invalid address.`);
  }
  const envelope = parseEnvelope(message.messageId, message.content);
  return {
    messageId: message.messageId,
    sessionId: message.target.workspaceId,
    sourceAgentId: source.sessionId,
    sourceTaskName: envelope.sourceTaskName,
    targetAgentId: message.target.sessionId,
    targetTaskName: envelope.targetTaskName,
    content: envelope.content,
    acceptedAt: message.acceptedAt,
    targetSeq: message.targetSeq,
  };
}

function parseEnvelope(messageId: string, value: string): AgentMailboxEnvelopeV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Named-agent mailbox message "${messageId}" has an invalid envelope.`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Named-agent mailbox message "${messageId}" has an invalid envelope.`);
  }
  const envelope = parsed as Partial<AgentMailboxEnvelopeV1>;
  if (
    envelope.v !== 1 ||
    envelope.kind !== 'agent_collaboration_message' ||
    typeof envelope.sourceTaskName !== 'string' ||
    typeof envelope.targetTaskName !== 'string' ||
    typeof envelope.content !== 'string'
  ) {
    throw new Error(`Named-agent mailbox message "${messageId}" has an invalid envelope.`);
  }
  return envelope as AgentMailboxEnvelopeV1;
}

function toAgentDelivery(
  delivery: 'pending' | 'delivered' | 'undeliverable',
): AgentMessageAcceptance['delivery'] {
  if (delivery === 'pending') return 'queued';
  if (delivery === 'delivered') return 'delivered';
  throw new Error('Named-agent mailbox message is undeliverable.');
}

function sameThread(left: ThreadRef, right: ThreadRef): boolean {
  return left.hostId === right.hostId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId;
}

async function warnIfLegacyMailboxPresent(
  fs: IHostFileSystem,
  log: ILogService,
  path: string,
): Promise<void> {
  const entries = await fs.readdir(path).catch(() => undefined);
  if (entries === undefined || entries.length === 0) return;
  log.warn('Legacy named-agent mailbox data is no longer used and can be deleted manually.', {
    path,
  });
}

registerScopedService(
  LifecycleScope.App,
  IAgentCollaborationMessageStore,
  AgentCollaborationMessageStoreAdapter,
  ScopeActivation.OnScopeCreated,
  'agentCollaborationMessageStore',
);
