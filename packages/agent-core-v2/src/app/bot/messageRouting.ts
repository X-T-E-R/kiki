import { createDecorator, type LiveRef, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { MessageAttachmentReceipt, SendMessageReceipt } from '@nb-corp/im-bridge-core/messageRouting';

export type { MessageAttachmentReceipt, MessageSenderIdentity, MessageHandoffReceipt, SendMessageReceipt } from '@nb-corp/im-bridge-core/messageRouting';
export * from './userMessageRouting';

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
