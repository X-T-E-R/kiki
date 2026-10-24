import { z } from 'zod';
import { textPresentationSchema } from '@kiki/transcript';

import { isoDateTimeSchema } from './time';

export const messageRoleSchema = z.enum(['user', 'assistant', 'tool', 'system']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  presentation: textPresentationSchema.optional(),
});
export type TextContent = z.infer<typeof textContentSchema>;

export const toolUseContentSchema = z.object({
  type: z.literal('tool_use'),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  input: z.unknown(),
});
export type ToolUseContent = z.infer<typeof toolUseContentSchema>;

export const toolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  tool_call_id: z.string().min(1),
  output: z.unknown(),
  is_error: z.boolean().optional(),
});
export type ToolResultContent = z.infer<typeof toolResultContentSchema>;

export const imageSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.string().min(1),
    // Provider-issued file id behind a reference such as `ms://…` — forwarded
    // when the provider keys media by id. Matches the kap-server wire schema.
    id: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('base64'),
    media_type: z.string().min(1),
    data: z.string().min(1),
  }),
  z.object({ kind: z.literal('file'), file_id: z.string().min(1) }),
  // Stored prompt/message projections address the Session-owned canonical
  // copy; `file` remains the transient upload form accepted on submission.
  z.object({ kind: z.literal('session_media'), file_id: z.string().min(1) }),
]);
export type ImageSource = z.infer<typeof imageSourceSchema>;

export const imageContentSchema = z.object({
  type: z.literal('image'),
  source: imageSourceSchema,
  // Original filename, when the caller (or the stored media it references) knows one.
  name: z.string().min(1).optional(),
});
export type ImageContent = z.infer<typeof imageContentSchema>;

// Video uses the same source shape as image (url / base64 / uploaded or Session media id).
export const videoContentSchema = z.object({
  type: z.literal('video'),
  source: imageSourceSchema,
  name: z.string().min(1).optional(),
});
export type VideoContent = z.infer<typeof videoContentSchema>;

export const audioContentSchema = z.object({
  type: z.literal('audio'),
  source: imageSourceSchema,
  name: z.string().min(1).optional(),
});
export type AudioContent = z.infer<typeof audioContentSchema>;

export const fileContentSchema = z.object({
  type: z.literal('file'),
  file_id: z.string().min(1),
  name: z.string(),
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type FileContent = z.infer<typeof fileContentSchema>;

export const thinkingContentSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
});
export type ThinkingContent = z.infer<typeof thinkingContentSchema>;

export const messageContentSchema = z.discriminatedUnion('type', [
  textContentSchema,
  toolUseContentSchema,
  toolResultContentSchema,
  imageContentSchema,
  videoContentSchema,
  audioContentSchema,
  fileContentSchema,
  thinkingContentSchema,
]);
export type MessageContent = z.infer<typeof messageContentSchema>;

const streamAttachmentSchema = z.object({
  fileId: z.string(), mimeType: z.string(), size: z.number(), name: z.string().optional(),
});
const streamMediaUrlSchema = z.object({
  url: z.string(), id: z.string().optional(), name: z.string().optional(),
  mimeType: z.string().optional(), size: z.number().optional(), attachment: streamAttachmentSchema.optional(),
});

export const assistantStreamPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'), text: z.string(), presentation: z.unknown().optional(),
    attachment: streamAttachmentSchema.optional(),
    resourceLink: z.object({
      uri: z.string(), name: z.string().optional(), mimeType: z.string().optional(),
      size: z.number().optional(), title: z.string().optional(), description: z.string().optional(),
    }).optional(),
  }),
  z.object({
    type: z.literal('think'), think: z.string(), encrypted: z.string().optional(),
    reasoningKey: z.string().optional(), reasoningDetails: z.array(z.record(z.string(), z.unknown())).optional(),
    hidden: z.boolean().optional(),
  }),
  z.object({ type: z.literal('image_url'), imageUrl: streamMediaUrlSchema }),
  z.object({ type: z.literal('audio_url'), audioUrl: streamMediaUrlSchema }),
  z.object({ type: z.literal('video_url'), videoUrl: streamMediaUrlSchema }),
]);
export type AssistantStreamPart = z.infer<typeof assistantStreamPartSchema>;

export const messageSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: messageRoleSchema,
  content: z.array(messageContentSchema),
  created_at: isoDateTimeSchema,
  prompt_id: z.string().min(1).optional(),
  parent_message_id: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Message = z.infer<typeof messageSchema>;
