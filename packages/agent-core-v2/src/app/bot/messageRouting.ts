import { createDecorator, type ServiceIdentifier, type LiveRef } from '#/_base/di/instantiation';

export interface MessageAttachmentReceipt {
  readonly blobId: string;
  readonly path: string;
  readonly title?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export interface MessageSenderIdentity {
  readonly personaId?: string;
  readonly name?: string;
  readonly sessionId: string;
}

export interface MessageHandoffReceipt {
  readonly targetPersonaId: string;
  readonly targetSessionId: string;
  readonly targetName: string;
  readonly messageId?: string;
}

export interface SendMessageReceipt {
  readonly messageId: string;
  readonly deliveredTo: readonly string[];
  readonly attachments?: readonly MessageAttachmentReceipt[];
  readonly sender?: MessageSenderIdentity;
  readonly handoff?: MessageHandoffReceipt;
  readonly deduplicated?: boolean;
  readonly delivery?: 'pending' | 'delivered' | 'undeliverable';
}

export interface RoomBotMessageInput {
  readonly roomId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly text: string;
  readonly to?: string;
  readonly replyTo?: string;
  readonly attachments?: readonly MessageAttachmentReceipt[];
}

export interface IRoomMessageRouter {
  readonly _serviceBrand: undefined;

  postBotMessage(input: RoomBotMessageInput): Promise<SendMessageReceipt>;
}

export const IRoomMessageRouter: ServiceIdentifier<IRoomMessageRouter> =
  createDecorator<IRoomMessageRouter>('roomMessageRouter');

export type RoomMessageRouterRef = LiveRef<IRoomMessageRouter>;
