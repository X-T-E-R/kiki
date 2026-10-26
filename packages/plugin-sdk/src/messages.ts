import { z } from 'zod';

const messageAttachmentFields = {
  title: z.string().min(1).max(512).optional(),
  kind: z.string().min(1).max(64).optional(),
  mime_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/u).optional(),
};

export const pluginMessageAttachmentSchema = z.union([
  z.object({ path: z.string().min(1), ...messageAttachmentFields }).strict(),
  z.object({ file_id: z.string().min(1), ...messageAttachmentFields }).strict(),
]);

export const pluginMessageBatchItemSchema = z.object({
  text: z.string().max(20_000).optional(),
  attachments: z.array(pluginMessageAttachmentSchema).max(32).optional(),
  reply_to: z.string().min(1).optional(),
  mention_ids: z.array(z.string().min(1).max(1024)).max(1000).optional(),
}).strict().refine((input) => (input.text?.trim().length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0, {
  message: 'A message cannot be blank.',
});

export const pluginMessageSendInputSchema = z.object({
  text: z.string().max(20_000).optional(),
  attachments: z.array(pluginMessageAttachmentSchema).max(32).optional(),
  reply_to: z.string().min(1).optional(),
  mention_ids: z.array(z.string().min(1).max(1024)).max(1000).optional(),
  messages: z.array(pluginMessageBatchItemSchema).min(1).max(32).optional(),
  to: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  channels: z.array(z.string().min(1)).min(1).max(32).optional(),
  request_id: z.string().min(1).max(256).optional(),
}).strict().superRefine((input, ctx) => {
  const hasBatch = input.messages !== undefined;
  const hasLegacyContent = input.text !== undefined || input.attachments !== undefined || input.reply_to !== undefined || input.mention_ids !== undefined;
  if (hasBatch && hasLegacyContent) {
    ctx.addIssue({ code: 'custom', path: ['messages'], message: 'messages cannot be combined with text, attachments, or reply_to.' });
    return;
  }
  if (!hasBatch && ((input.text?.trim().length ?? 0) === 0 && (input.attachments?.length ?? 0) === 0)) {
    ctx.addIssue({ code: 'custom', message: 'A message cannot be blank.' });
  }
});

export type PluginMessageAttachment = z.infer<typeof pluginMessageAttachmentSchema>;
export type PluginMessageBatchItem = z.infer<typeof pluginMessageBatchItemSchema>;
export type PluginMessageSendInput = z.infer<typeof pluginMessageSendInputSchema>;

export const pluginMessageChannelReceiptSchema = z.object({
  channel_id: z.string().min(1),
  status: z.enum(['delivered', 'partial', 'unsupported', 'failed', 'unknown']),
  borrowed: z.boolean().optional(),
  message_ids: z.array(z.string().min(1)).optional(),
  unsupported: z.array(z.string().min(1)).optional(),
  detail: z.string().optional(),
}).strict();

export const pluginMessageAttachmentReceiptSchema = z.object({
  blob_id: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1).optional(),
  mime_type: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
  kind: z.string().min(1).optional(),
}).strict();

export const pluginMessageSenderSchema = z.object({
  persona_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  session_id: z.string().min(1),
}).strict();

export const pluginMessageHandoffSchema = z.object({
  target_persona_id: z.string().min(1),
  target_session_id: z.string().min(1),
  target_name: z.string().min(1),
  message_id: z.string().min(1).optional(),
}).strict();

export const pluginMessageReceiptSchema = z.object({
  message_id: z.string().min(1),
  delivered_to: z.array(z.string()),
  channels: z.array(pluginMessageChannelReceiptSchema).optional(),
  attachments: z.array(pluginMessageAttachmentReceiptSchema).optional(),
  sender: pluginMessageSenderSchema.optional(),
  handoff: pluginMessageHandoffSchema.optional(),
  deduplicated: z.boolean().optional(),
  delivery: z.enum(['pending', 'delivered', 'undeliverable']).optional(),
  detail: z.string().optional(),
}).strict();

export const pluginMessageBatchItemReceiptSchema = pluginMessageReceiptSchema.extend({
  index: z.number().int().nonnegative(),
  delivery: z.enum(['pending', 'delivered', 'undeliverable', 'cancelled', 'not_sent']).optional(),
  detail: z.string().optional(),
}).strict();

export const pluginMessageBatchReceiptSchema = z.object({
  messages: z.array(pluginMessageBatchItemReceiptSchema).min(1).max(32),
}).strict();

export type PluginMessageChannelReceipt = z.infer<typeof pluginMessageChannelReceiptSchema>;
export type PluginMessageAttachmentReceipt = z.infer<typeof pluginMessageAttachmentReceiptSchema>;
export type PluginMessageSender = z.infer<typeof pluginMessageSenderSchema>;
export type PluginMessageHandoff = z.infer<typeof pluginMessageHandoffSchema>;
export type PluginMessageReceipt = z.infer<typeof pluginMessageReceiptSchema>;
export type PluginMessageBatchItemReceipt = z.infer<typeof pluginMessageBatchItemReceiptSchema>;
export type PluginMessageBatchReceipt = z.infer<typeof pluginMessageBatchReceiptSchema>;
export type PluginMessageSendReceipt = PluginMessageReceipt | PluginMessageBatchReceipt;

export interface PluginMessagesApi {
  send(input: PluginMessageSendInput): Promise<PluginMessageSendReceipt>;
}
