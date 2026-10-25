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

export interface PluginImEvent {
  readonly eventId: string;
  readonly cursor?: number;
  readonly sourceMessageId?: string;
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
}
