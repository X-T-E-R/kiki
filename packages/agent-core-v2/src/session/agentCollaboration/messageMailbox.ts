import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ThreadDeliveryClaim } from '#/app/threadCommunication/threadMailboxStore';

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

export interface QueuedAgentMessage {
  readonly message: AcceptedAgentMessage;
  readonly claim: ThreadDeliveryClaim;
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
  nextQueued(sessionId: string, targetAgentId: string): Promise<QueuedAgentMessage | undefined>;
  markDelivered(claim: ThreadDeliveryClaim): Promise<boolean>;
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
