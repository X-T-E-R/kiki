import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ThreadMailboxBacklogError } from '#/app/threadCommunication/mailboxErrors';
import {
  IThreadMailboxStore,
  threadMailboxClaimRequestId,
  type AcceptedThreadMessage,
  type ThreadDeliveryClaim,
} from '#/app/threadCommunication/threadMailboxStore';
import type { ThreadRef } from '#/app/threadCommunication/threadCommunication';

import {
  AGENT_MESSAGE_BACKLOG_LIMIT,
  AgentMessageMailboxFullError,
  IAgentCollaborationMessageStore,
  type AcceptedAgentMessage,
  type AgentMessageAcceptance,
} from './messageMailbox';

const MAILBOX_HOST_ID = 'agent-collaboration-v2';
const CLAIM_LEASE_MS = 30_000;

interface AgentMailboxEnvelopeV1 {
  readonly v: 1;
  readonly kind: 'agent_collaboration_message';
  readonly sourceTaskName: string;
  readonly targetTaskName: string;
  readonly content: string;
}

interface AgentPendingAck {
  readonly claim: ThreadDeliveryClaim;
  readonly requestId: string;
}

export class AgentCollaborationMessageStoreAdapter implements IAgentCollaborationMessageStore {
  declare readonly _serviceBrand: undefined;

  private readonly claimRequestIds = new Map<string, string>();
  private readonly pendingAcks = new Map<string, AgentPendingAck>();

  constructor(@IThreadMailboxStore private readonly mailbox: IThreadMailboxStore) {}

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
      const accepted = await this.mailbox.acceptMessage({
        producer: { kind: 'peer_thread', source: agentRef(input.sessionId, input.sourceAgentId) },
        target: agentRef(input.sessionId, input.targetAgentId),
        content: JSON.stringify(envelope),
        idempotencyKey: input.idempotencyKey,
        pendingLimit: AGENT_MESSAGE_BACKLOG_LIMIT,
      });
      return {
        message: toAgentMessage(accepted.message),
        deduplicated: accepted.deduplicated,
        delivery: toAgentDelivery(accepted.delivery),
        payloadConflict: accepted.payloadConflict,
      };
    } catch (error) {
      if (error instanceof ThreadMailboxBacklogError) {
        throw new AgentMessageMailboxFullError(error.limit);
      }
      throw error;
    }
  }

  async nextQueued(sessionId: string, targetAgentId: string): Promise<{
    readonly message: AcceptedAgentMessage;
    readonly claim: ThreadDeliveryClaim;
  } | undefined> {
    const target = agentRef(sessionId, targetAgentId);
    const key = threadIdentity(target);
    const pendingAck = this.pendingAcks.get(key);
    if (pendingAck !== undefined) await this.completePendingAck(key, pendingAck);
    const requestId = this.claimRequestIds.get(key) ?? randomUUID();
    this.claimRequestIds.set(key, requestId);
    const claim = await this.mailbox.claimNext({
      target,
      consumerId: `agent-collaboration/${sessionId}/${targetAgentId}`,
      leaseMs: CLAIM_LEASE_MS,
    }, {
      requestId,
    });
    if (this.claimRequestIds.get(key) === requestId) this.claimRequestIds.delete(key);
    return claim === undefined ? undefined : { message: toAgentMessage(claim.message), claim };
  }

  markDelivered(claim: ThreadDeliveryClaim): Promise<boolean> {
    const key = threadIdentity(claim.message.target);
    let pending = this.pendingAcks.get(key);
    if (pending === undefined) {
      pending = {
        claim,
        requestId: threadMailboxClaimRequestId('agent-ack', claim),
      };
      this.pendingAcks.set(key, pending);
    }
    return this.completePendingAck(key, pending);
  }

  private async completePendingAck(key: string, pending: AgentPendingAck): Promise<boolean> {
    const changed = await this.mailbox.acknowledgeDelivery(pending.claim, {
      requestId: pending.requestId,
    });
    if (this.pendingAcks.get(key) === pending) this.pendingAcks.delete(key);
    return changed;
  }
}

function agentRef(sessionId: string, agentId: string): ThreadRef {
  return { hostId: MAILBOX_HOST_ID, workspaceId: sessionId, sessionId: agentId };
}

function threadIdentity(target: ThreadRef): string {
  return `${target.hostId}\u0000${target.workspaceId}\u0000${target.sessionId}`;
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

registerScopedService(
  LifecycleScope.App,
  IAgentCollaborationMessageStore,
  AgentCollaborationMessageStoreAdapter,
  ScopeActivation.OnScopeCreated,
  'agentCollaborationMessageStore',
);
