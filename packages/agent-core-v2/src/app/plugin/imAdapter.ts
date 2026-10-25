import { z } from 'zod';
import { PLUGIN_IM_COMPLETE_LIMITS, type PluginImAdapterDefinition, type PluginImEvent, type PluginImDeliveryReceipt } from '@kiki/protocol';

export const pluginImIdentitySchema = z.object({ chatId: z.string().min(1).max(1024), senderId: z.string().min(1).max(1024), topicId: z.string().min(1).max(1024), chatKind: z.enum(['private', 'group']).optional(), chatTitle: z.string().max(4096).optional(), senderName: z.string().max(4096).optional(), topicTitle: z.string().max(4096).optional() }).strict();
const wireMedia = z.object({ name: z.string().min(1).max(1024), mediaType: z.string().min(1).max(128), base64: z.string().max(12 * 1024 * 1024).refine((value) => {
  if (value.length % 4 !== 0) return false;
  const padding = value.search(/[^A-Za-z0-9+/]/);
  return padding === -1 || (padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding)));
}) }).strict();
const eventIdentitySchema = z.object({ eventId: z.string().min(1).max(1024), cursor: z.number().int().nonnegative().optional(), sourceMessageId: z.string().min(1).max(1024).optional(), operation: z.enum(['create', 'edit', 'retract']).optional(), isSelf: z.boolean().optional(), timestamp: z.number().int().nonnegative().optional(), mentioned: z.boolean().optional(), mentionIds: z.array(z.string().min(1).max(1024)).max(1000).optional(), replyToMessageId: z.string().min(1).max(1024).optional(), identity: pluginImIdentitySchema, preview: z.string().max(16384).optional() });
const partSchema = z.object({ kind: z.enum(['text', 'image', 'file', 'audio', 'video']), text: z.string().max(1024 * 1024).optional(), media: wireMedia.optional(), tooLarge: z.boolean().optional() }).strict().refine((part) => part.kind === 'text' ? part.text !== undefined && part.media === undefined : part.media !== undefined || (part.text?.trim().length ?? 0) > 0 || part.tooLarge === true, { message: 'A complete message part needs hydrated media or an explicit unavailable description' });
const eventSchema = z.discriminatedUnion('kind', [
  eventIdentitySchema.extend({ kind: z.enum(['text', 'image', 'file', 'audio', 'video', 'callback']), text: z.string().max(1024 * 1024).optional(), callbackData: z.string().max(16384).optional(), callbackQueryId: z.string().max(1024).optional(), media: wireMedia.optional(), tooLarge: z.boolean().optional() }).strict(),
  eventIdentitySchema.extend({ kind: z.literal('message'), sourceMessageId: z.string().min(1).max(1024), operation: z.literal('create').optional(), parts: z.array(partSchema).min(1).max(PLUGIN_IM_COMPLETE_LIMITS.parts) }).strict(),
]);
export const pluginImDeliverySchema = z.object({ status: z.enum(['delivered', 'partial', 'unsupported', 'failed', 'unknown']), messageIds: z.array(z.string().max(1024)).max(1000).optional(), unsupported: z.array(z.string().max(128)).max(100).optional(), detail: z.string().max(4096).optional(), errorKind: z.literal('rate_limited').optional(), retryAfterMs: z.number().int().min(0).max(60_000).optional() }).strict();

export interface PluginImAdapterRegistration {
  readonly pluginId: string;
  readonly definition: PluginImAdapterDefinition;
  readonly providerKind: `plugin:${string}/${string}`;
  readonly instanceId: string;
  readonly revision: string;
  connect(listener: (event: PluginImEvent) => Promise<void>, offset?: number): Promise<PluginImConnection>;
}

export interface PluginImAdapterSink {
  replace(registrations: readonly PluginImAdapterRegistration[]): Promise<void>;
  withdraw(pluginIds?: readonly string[]): Promise<void>;
}

export interface PluginImConnection {
  request(action: 'sendText' | 'sendMedia' | 'editText' | 'answerCallback', input: unknown): Promise<PluginImDeliveryReceipt | undefined>;
  readHistory?(input: import('@kiki/protocol').PluginImHistoryRequest): Promise<import('@kiki/protocol').PluginImHistoryPage>;
  stop(): Promise<void>;
  readonly accountId: string;
  readonly listenerAccountId?: string;
  readonly targets?: readonly import('@kiki/protocol').PluginImIdentity[];
}

export function parsePluginImEvent(input: unknown, definition: PluginImAdapterDefinition): PluginImEvent {
  if (!definition.inbound) throw new Error('IM adapter does not support input');
  if (JSON.stringify(input).length > PLUGIN_IM_COMPLETE_LIMITS.serializedChars) throw new Error('IM complete input exceeds the serialized message limit');
  const event = eventSchema.parse(input);
  if (event.operation !== undefined && event.operation !== 'create' && event.sourceMessageId === undefined) throw new Error('IM edit/retract needs its real target sourceMessageId');
  const hydrate = (media: z.infer<typeof wireMedia> | undefined) => media === undefined ? undefined : { name: media.name, mediaType: media.mediaType, bytes: new Uint8Array(Buffer.from(media.base64, 'base64')) };
  if (event.kind === 'message') {
    const parts = event.parts.map((part) => ({ ...part, media: hydrate(part.media) }));
    if (parts.some((part) => (part.media?.bytes.byteLength ?? 0) > definition.maxInboundBytes)) throw new Error('IM input attachment exceeds the declared byte limit');
    if (parts.reduce((sum, part) => sum + (part.media?.bytes.byteLength ?? 0), 0) > PLUGIN_IM_COMPLETE_LIMITS.mediaBytes) throw new Error('IM complete input exceeds the total media byte limit');
    if (parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0) > PLUGIN_IM_COMPLETE_LIMITS.textChars) throw new Error('IM input text exceeds the message limit');
    return { ...event, parts };
  }
  const media = hydrate(event.media);
  if (media !== undefined && media.bytes.byteLength > definition.maxInboundBytes) throw new Error('IM input exceeds the declared byte limit');
  return { ...event, media };
}
