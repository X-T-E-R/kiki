import { createDecorator } from '#/_base/di/instantiation';
import { Error2, ErrorCodes } from '#/errors';
import type { MessageAttachmentReceipt, MessageSenderIdentity, SendMessageReceipt } from './messageRouting';

export interface MessageMediaCapability {
  readonly kind: string;
  readonly mimeTypes?: readonly string[];
  readonly maxBytes?: number;
  readonly rendering?: string;
}

export interface MessageChannelBinding {
  readonly id: string;
  readonly kind: 'internal' | 'im' | 'notify';
  readonly bound?: boolean;
  readonly enabled: boolean;
  readonly capabilities: readonly MessageMediaCapability[];
}

export interface MessageChannelReceipt {
  readonly channelId: string;
  readonly status: 'delivered' | 'partial' | 'unsupported' | 'failed' | 'unknown';
  readonly borrowed?: boolean;
  readonly messageIds?: readonly string[];
  readonly unsupported?: readonly string[];
  readonly detail?: string;
}

export interface UserMessageInput {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly text: string;
  readonly attachments: readonly MessageAttachmentReceipt[];
  readonly channel?: string;
  readonly channels?: readonly string[];
  readonly replyTo?: string;
  readonly sender?: MessageSenderIdentity;
}

export interface UserMessageChannel extends MessageChannelBinding {
  send(input: UserMessageInput, skipped: readonly string[]): Promise<Omit<MessageChannelReceipt, 'channelId'>>;
}

export interface IUserMessageRouter {
  readonly _serviceBrand: undefined;
  sendMessage(input: UserMessageInput): Promise<SendMessageReceipt>;
}

export const IUserMessageRouter = createDecorator<IUserMessageRouter>('userMessageRouter');

export const INTERNAL_MESSAGE_CAPABILITIES: readonly MessageMediaCapability[] = [
  { kind: 'file' },
  { kind: 'image', mimeTypes: ['image/*'] },
  { kind: 'audio', mimeTypes: ['audio/*'], rendering: 'audio_player' },
  { kind: 'voice', mimeTypes: ['audio/*'], rendering: 'audio_player' },
  { kind: 'video', mimeTypes: ['video/*'] },
];

export function supportsMessageMedia(channel: MessageChannelBinding, media: MessageAttachmentReceipt): boolean {
  const kind = media.kind ?? 'file';
  return channel.capabilities.some((capability) => capability.kind === kind
    && (capability.maxBytes === undefined || (media.size !== undefined && media.size <= capability.maxBytes))
    && (capability.mimeTypes === undefined || capability.mimeTypes.some((mime) => {
      const actual = media.mimeType?.toLowerCase();
      return actual !== undefined && (mime === actual || (mime.endsWith('/*') && actual.startsWith(mime.slice(0, -1))));
    })));
}

export interface RouteUserMessageOptions {
  readonly allowChannelBorrowing?: boolean;
}

function requestChannelIds(input: UserMessageInput): readonly string[] {
  const requested = [
    ...(input.channel === undefined ? [] : [input.channel]),
    ...(input.channels ?? []),
  ];
  return [...new Set(requested)];
}

function invalidTarget(reason: string, message: string, channelId?: string): never {
  throw new Error2(ErrorCodes.REQUEST_INVALID, `${reason}: ${message}`, {
    details: { reason, ...(channelId === undefined ? {} : { channelId }) },
  });
}

function selectChannels<T extends MessageChannelBinding>(
  input: UserMessageInput,
  channels: readonly T[],
  options: RouteUserMessageOptions,
): { readonly channels: readonly T[]; readonly borrowed: ReadonlySet<string> } {
  const byId = new Map<string, T>();
  for (const channel of channels) if (!byId.has(channel.id)) byId.set(channel.id, channel);
  const requested = requestChannelIds(input);
  if (requested.length === 0) {
    return {
      channels: [...byId.values()].filter((channel) => channel.enabled && channel.bound !== false),
      borrowed: new Set(),
    };
  }
  const selected: T[] = [];
  const borrowed = new Set<string>();
  for (const id of requested) {
    const channel = byId.get(id);
    if (channel === undefined) invalidTarget('channel_not_found', `Message channel ${id} does not exist.`, id);
    if (!channel.enabled) invalidTarget('channel_disabled', `Message channel ${id} is disabled.`, id);
    if (channel.bound === false) {
      if (options.allowChannelBorrowing !== true) {
        invalidTarget('channel_borrowing_disabled', `Message channel ${id} is available but not bound to this conversation.`, id);
      }
      borrowed.add(id);
    }
    selected.push(channel);
  }
  return { channels: selected, borrowed };
}

function validateSelectedMessageChannels(input: UserMessageInput, selected: readonly MessageChannelBinding[]): void {
  if (selected.length === 0) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'no_destination: No message channel is enabled for this conversation.', { details: { reason: 'no_destination' } });
  }
  const unsupported = input.attachments.filter((attachment) => !selected.some((channel) => supportsMessageMedia(channel, attachment)));
  if (unsupported.length > 0) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `media_unsupported: No selected channel supports ${unsupported.map((item) => `${item.kind ?? 'file'} (${item.mimeType ?? 'unknown MIME'})`).join(', ')}.`, {
      details: { reason: 'media_unsupported', channels: selected.map((channel) => channel.id) },
    });
  }
}

export function validateUserMessageChannels(
  input: UserMessageInput,
  channels: readonly MessageChannelBinding[],
  options: RouteUserMessageOptions = {},
): void {
  const selection = selectChannels(input, channels, options);
  validateSelectedMessageChannels(input, selection.channels);
}

export async function routeUserMessage(
  input: UserMessageInput,
  channels: readonly UserMessageChannel[],
  options: RouteUserMessageOptions = {},
): Promise<SendMessageReceipt> {
  const selection = selectChannels(input, channels, options);
  validateSelectedMessageChannels(input, selection.channels);
  const receipts: MessageChannelReceipt[] = [];
  for (const channel of selection.channels) {
    const supported = input.attachments.filter((attachment) => supportsMessageMedia(channel, attachment));
    const unsupported = [...new Set(input.attachments.filter((attachment) => !supportsMessageMedia(channel, attachment))
      .map((attachment) => attachment.kind ?? 'file'))];
    try {
      const sent = await channel.send({ ...input, attachments: supported }, unsupported);
      const skipped = [...new Set([...unsupported, ...(sent.unsupported ?? [])])];
      const status = sent.status === 'delivered' && skipped.length > 0
        ? supported.length > 0 || input.text.length > 0 ? 'partial' : 'unsupported'
        : sent.status;
      receipts.push({
        ...sent,
        channelId: channel.id,
        status,
        borrowed: selection.borrowed.has(channel.id) ? true : undefined,
        unsupported: skipped.length > 0 ? skipped : undefined,
      });
    } catch {
      receipts.push({ channelId: channel.id, status: 'unknown', borrowed: selection.borrowed.has(channel.id) ? true : undefined,
        unsupported: unsupported.length > 0 ? unsupported : undefined, detail: 'Send outcome is unknown; do not resend automatically.' });
    }
  }
  const delivered = receipts.some((receipt) => receipt.status === 'delivered' || receipt.status === 'partial');
  const blocked = receipts.length > 0 && receipts.every((receipt) => receipt.status === 'unsupported' || receipt.status === 'failed');
  return {
    messageId: `send:${input.toolCallId}`,
    deliveredTo: delivered ? ['user'] : [],
    attachments: input.attachments.length > 0 ? input.attachments : undefined,
    sender: input.sender,
    delivery: delivered ? 'delivered' : blocked ? 'undeliverable' : 'pending',
    channels: receipts,
  };
}

export function internalMessageChannel(enabled = true): UserMessageChannel {
  return {
    id: 'internal', kind: 'internal', enabled, capabilities: INTERNAL_MESSAGE_CAPABILITIES,
    send: async (input, skipped) => {
      if (skipped.length > 0 && input.text.length === 0 && input.attachments.length === 0) return { status: 'unsupported', unsupported: skipped };
      return { status: 'delivered' };
    },
  };
}
