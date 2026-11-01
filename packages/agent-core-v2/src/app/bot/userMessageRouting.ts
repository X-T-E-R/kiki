import { createDecorator } from '#/_base/di/instantiation';
import { Error2, ErrorCodes } from '#/errors';
import {
  INTERNAL_MESSAGE_CAPABILITIES,
  MessageRoutingError,
  internalMessageChannel,
  routeUserMessage as coreRouteUserMessage,
  supportsMessageMedia,
  validateUserMessageChannels as coreValidateUserMessageChannels,
} from '@kiki-dsh/im-bridge-core/userMessageRouting';
import type { MessageAttachmentReceipt, MessageSenderIdentity, SendMessageReceipt } from '@kiki-dsh/im-bridge-core/messageRouting';
import type {
  MessageChannelBinding,
  MessageChannelReceipt,
  MessageMediaCapability,
  RouteUserMessageOptions,
  UserMessageChannel,
  UserMessageInput,
} from '@kiki-dsh/im-bridge-core/userMessageRouting';

export type { MessageAttachmentReceipt, MessageSenderIdentity, SendMessageReceipt } from '@kiki-dsh/im-bridge-core/messageRouting';
export type {
  MessageChannelBinding,
  MessageChannelReceipt,
  MessageMediaCapability,
  RouteUserMessageOptions,
  UserMessageChannel,
  UserMessageInput,
} from '@kiki-dsh/im-bridge-core/userMessageRouting';
export { INTERNAL_MESSAGE_CAPABILITIES, internalMessageChannel, supportsMessageMedia };

export interface IUserMessageRouter {
  readonly _serviceBrand: undefined;
  sendMessage(input: UserMessageInput): Promise<SendMessageReceipt>;
}

export const IUserMessageRouter = createDecorator<IUserMessageRouter>('userMessageRouter');

function translateRoutingError(error: unknown): never {
  if (error instanceof MessageRoutingError) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, error.message, { details: error.details, cause: error });
  }
  throw error;
}

export function validateUserMessageChannels(
  input: UserMessageInput,
  channels: readonly MessageChannelBinding[],
  options: RouteUserMessageOptions = {},
): void {
  try {
    coreValidateUserMessageChannels(input, channels, options);
  } catch (error) {
    translateRoutingError(error);
  }
}

export async function routeUserMessage(
  input: UserMessageInput,
  channels: readonly UserMessageChannel[],
  options: RouteUserMessageOptions = {},
): Promise<SendMessageReceipt> {
  try {
    return await coreRouteUserMessage(input, channels, options);
  } catch (error) {
    translateRoutingError(error);
  }
}
