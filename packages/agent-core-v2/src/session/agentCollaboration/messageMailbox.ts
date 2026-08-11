/**
 * `agentCollaboration` domain — durable named-agent message mailbox contracts.
 *
 * The App-scoped Store owns FIFO acceptance and durable consumption. The
 * Session-scoped service binds those records to live Agent step boundaries.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const AGENT_MESSAGE_BACKLOG_LIMIT = 128;

export interface AcceptedAgentMessage {
  readonly messageId: string;
  readonly sessionId: string;
  readonly sourceAgentId: string;
  readonly sourceTaskName: string;
  readonly targetAgentId: string;
  readonly targetTaskName: string;
  readonly content: string;
  readonly acceptedAt: number;
  readonly targetSeq: number;
}

export interface AgentMessageAcceptance {
  readonly message: AcceptedAgentMessage;
  readonly deduplicated: boolean;
  readonly delivery: 'queued' | 'delivered';
  readonly payloadConflict: boolean;
}

export interface IAgentCollaborationMessageStore {
  readonly _serviceBrand: undefined;

  accept(input: {
    readonly sessionId: string;
    readonly sourceAgentId: string;
    readonly sourceTaskName: string;
    readonly targetAgentId: string;
    readonly targetTaskName: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<AgentMessageAcceptance>;
  nextQueued(sessionId: string, targetAgentId: string): Promise<AcceptedAgentMessage | undefined>;
  markDelivered(messageId: string): Promise<boolean>;
}

export const IAgentCollaborationMessageStore: ServiceIdentifier<IAgentCollaborationMessageStore> =
  createDecorator<IAgentCollaborationMessageStore>('agentCollaborationMessageStore');

export interface IAgentCollaborationMessagingService {
  readonly _serviceBrand: undefined;

  send(input: {
    readonly sourceAgentId: string;
    readonly sourceTaskName: string;
    readonly targetAgentId: string;
    readonly targetTaskName: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<AgentMessageAcceptance>;
}

export const IAgentCollaborationMessagingService: ServiceIdentifier<IAgentCollaborationMessagingService> =
  createDecorator<IAgentCollaborationMessagingService>('agentCollaborationMessagingService');

export class AgentMessageMailboxFullError extends Error {
  constructor(readonly limit: number = AGENT_MESSAGE_BACKLOG_LIMIT) {
    super(`Named agent message backlog is full (${limit} queued messages).`);
    this.name = 'AgentMessageMailboxFullError';
  }
}
