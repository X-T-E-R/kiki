import { z } from 'zod';

export const pluginImMediaCapabilitySchema = z.object({
  kind: z.string().min(1).max(128),
  mimeTypes: z.array(z.string().min(1).max(128)).max(100).optional(),
  maxBytes: z.number().int().positive().optional(),
  rendering: z.string().min(1).max(128).optional(),
}).strict();

export const pluginImAdapterDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(128),
  inbound: z.boolean(),
  outbound: z.boolean(),
  listenerRealm: z.string().min(1).max(512).optional(),
  textLimit: z.number().int().positive().optional(),
  minSendIntervalMs: z.number().int().min(0).max(60_000).optional(),
  maxInboundBytes: z.number().int().min(1).max(8 * 1024 * 1024),
  supportsEdit: z.boolean().optional(),
  supportsButtons: z.boolean().optional(),
  supportsMentions: z.boolean().optional(),
  supportsReply: z.boolean().optional(),
  supportsHistory: z.boolean().optional(),
  mediaCapabilities: z.array(pluginImMediaCapabilitySchema).max(100),
}).strict().refine((value) => value.inbound || value.outbound, { message: 'An IM adapter needs an input or output direction' })
  .refine((value) => !value.inbound || value.listenerRealm !== undefined, { message: 'Inbound IM adapters must declare the real protocol/message-source listenerRealm', path: ['listenerRealm'] });

/** One configured platform account, owned by this plugin. Host owns all bindings and sessions. */
export type PluginImAdapterDefinition = z.infer<typeof pluginImAdapterDefinitionSchema>;
export type PluginImMediaCapability = z.infer<typeof pluginImMediaCapabilitySchema>;

export interface PluginImIdentity {
  readonly chatId: string;
  readonly senderId: string;
  readonly topicId: string;
  readonly chatKind?: 'private' | 'group';
  readonly chatTitle?: string;
  readonly senderName?: string;
  readonly topicTitle?: string;
}

export interface PluginImMedia {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export const pluginImHistoryRequestSchema = z.object({
  chatId: z.string().min(1).max(1024),
  topicId: z.string().min(1).max(1024),
  cursor: z.string().min(1).max(8192).optional(),
  limit: z.number().int().min(1).max(50),
}).strict();

export const pluginImHistoryMessageSchema = z.object({
  sourceMessageId: z.string().min(1).max(1024),
  identity: z.object({ chatId: z.string().min(1).max(1024), senderId: z.string().min(1).max(1024), topicId: z.string().min(1).max(1024), chatKind: z.enum(['private', 'group']).optional(), chatTitle: z.string().max(4096).optional(), senderName: z.string().max(4096).optional(), topicTitle: z.string().max(4096).optional() }).strict(),
  kind: z.enum(['text', 'image', 'file', 'audio', 'video']),
  operation: z.enum(['create', 'edit', 'retract']).optional(),
  isSelf: z.boolean().optional(),
  timestamp: z.number().int().nonnegative().optional(),
  text: z.string().max(16_384).optional(),
  mentioned: z.boolean().optional(),
  mentionIds: z.array(z.string().min(1).max(1024)).max(1000).optional(),
  replyToMessageId: z.string().min(1).max(1024).optional(),
  media: z.array(z.object({ kind: z.string().min(1).max(128), name: z.string().max(1024), mediaType: z.string().max(128) }).strict()).max(4).optional(),
}).strict();

export const pluginImHistoryPageSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), messages: z.array(pluginImHistoryMessageSchema).max(50), order: z.enum(['chronological', 'reverse_chronological']), nextCursor: z.string().min(1).max(8192).optional(), coverage: z.enum(['complete', 'partial', 'unknown']), end: z.enum(['reached', 'more', 'unknown']) }).strict(),
  z.object({ status: z.literal('unsupported'), detail: z.string().max(4096).optional() }).strict(),
]);

/** Cursors belong to the adapter. Host never interprets them as platform sequence numbers. */
export type PluginImHistoryRequest = z.infer<typeof pluginImHistoryRequestSchema>;
export type PluginImHistoryMessage = z.infer<typeof pluginImHistoryMessageSchema>;
/** Unknown coverage or end remains unknown even when a page is short or empty. */
export type PluginImHistoryPage = z.infer<typeof pluginImHistoryPageSchema>;

export interface PluginImEvent {
  readonly eventId: string;
  readonly cursor?: number;
  readonly sourceMessageId?: string;
  readonly operation?: 'create' | 'edit' | 'retract';
  readonly isSelf?: boolean;
  readonly timestamp?: number;
  readonly mentioned?: boolean;
  readonly mentionIds?: readonly string[];
  readonly replyToMessageId?: string;
  readonly identity: PluginImIdentity;
  readonly kind: 'text' | 'image' | 'file' | 'audio' | 'video' | 'callback';
  readonly text?: string;
  readonly callbackData?: string;
  readonly callbackQueryId?: string;
  readonly media?: PluginImMedia;
  readonly tooLarge?: boolean;
  readonly preview?: string;
}

export interface PluginImText {
  readonly identity: PluginImIdentity;
  readonly text: string;
  readonly code: string;
  readonly messageId?: string;
  readonly replyToMessageId?: string;
  readonly mentionIds?: readonly string[];
  readonly buttons?: readonly { readonly id: string; readonly label: string }[];
}

export interface PluginImOutboundMedia extends PluginImMedia {
  readonly identity: PluginImIdentity;
  /** Open media kind, for example file, image, voice, audio or video. */
  readonly kind: string;
}

/** Partial and unknown results are terminal receipts; never resend accepted parts automatically. */
export interface PluginImDeliveryReceipt {
  readonly status: 'delivered' | 'partial' | 'unsupported' | 'failed' | 'unknown';
  readonly messageIds?: readonly string[];
  readonly unsupported?: readonly string[];
  readonly detail?: string;
  readonly errorKind?: 'rate_limited';
  readonly retryAfterMs?: number;
}

export interface PluginImAdapterContext {
  readonly signal: AbortSignal;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly instanceId: string;
}

export interface PluginImStartContext extends PluginImAdapterContext {
  readonly offset?: number;
  /** Resolves after the Host has processed this event. Emits before start resolves are rejected. */
  emit(event: PluginImEvent): Promise<void>;
}

export interface PluginImAdapter {
  start(context: PluginImStartContext): Promise<{ readonly accountId: string; readonly listenerAccountId?: string; readonly targets?: readonly PluginImIdentity[] }>;
  stop(): Promise<void>;
  sendText?(message: PluginImText, context: PluginImAdapterContext): Promise<PluginImDeliveryReceipt>;
  sendMedia?(message: PluginImOutboundMedia, context: PluginImAdapterContext): Promise<PluginImDeliveryReceipt>;
  editText?(message: PluginImText & { readonly messageId: string }, context: PluginImAdapterContext): Promise<PluginImDeliveryReceipt>;
  answerCallback?(callbackQueryId: string, context: PluginImAdapterContext): Promise<void>;
  readHistory?(request: PluginImHistoryRequest, context: PluginImAdapterContext): Promise<PluginImHistoryPage>;
}
