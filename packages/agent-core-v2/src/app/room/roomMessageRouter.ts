import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import {
  IRoomMessageRouter,
  type RoomBotMessageInput,
  type SendMessageReceipt,
} from '#/app/bot/messageRouting';

import { IRoomService } from './room';

export class RoomMessageRouter implements IRoomMessageRouter {
  declare readonly _serviceBrand: undefined;

  constructor(@IRoomService private readonly rooms: IRoomService) {}

  async postBotMessage(input: RoomBotMessageInput): Promise<SendMessageReceipt> {
    const message = await this.rooms.postBotMessage(input.roomId, {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      text: input.text,
      to: input.to,
      replyTo: input.replyTo,
      attachments: input.attachments?.map((attachment) => ({
        blobId: attachment.blobId,
        path: attachment.path,
        title: attachment.title,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    });
    if (message === undefined) {
      return {
        messageId: `room-paused:${input.roomId}:${input.toolCallId}`,
        deliveredTo: [],
        delivery: 'undeliverable',
      };
    }
    return {
      messageId: message.id,
      deliveredTo: ['room'],
      attachments: input.attachments,
      delivery: 'delivered',
      deduplicated: false,
    };
  }
}

registerScopedService(
  LifecycleScope.App,
  IRoomMessageRouter,
  RoomMessageRouter,
  ScopeActivation.OnScopeCreated,
  'room',
);
