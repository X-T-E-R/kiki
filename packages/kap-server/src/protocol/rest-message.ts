/**
 *   GET /v1/sessions/{session_id}/messages
 *   GET /v1/sessions/{session_id}/messages/{message_id}
 */

import { z } from 'zod';

import {
  fileContentSchema,
  imageContentSchema,
  messageRoleSchema,
  messageSchema,
  textContentSchema,
  videoContentSchema,
} from './message';

import { cursorQuerySchema } from './pagination';
import { promptExecutionOverridesSchema, promptSubmitResultSchema } from './rest-prompt';
import { expectedSessionCursorSchema } from './session';

export const listMessagesQuerySchema = cursorQuerySchema.and(
  z.object({
    role: messageRoleSchema.optional(),
  }),
);
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const listMessagesResponseSchema = z.object({
  items: z.array(messageSchema),
  has_more: z.boolean(),
});
export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;

export const getMessageResponseSchema = messageSchema;
export type GetMessageResponse = z.infer<typeof getMessageResponseSchema>;

export const editableMessageContentSchema = z.discriminatedUnion('type', [
  textContentSchema,
  imageContentSchema,
  videoContentSchema,
  fileContentSchema,
]);

export const editMessageRequestSchema = promptExecutionOverridesSchema.extend({
  content: z.array(editableMessageContentSchema).min(1),
  expected_cursor: expectedSessionCursorSchema,
});
export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;

export const regenerateMessageRequestSchema = promptExecutionOverridesSchema.extend({
  expected_cursor: expectedSessionCursorSchema,
});
export type RegenerateMessageRequest = z.infer<typeof regenerateMessageRequestSchema>;

export const messageActionResponseSchema = promptSubmitResultSchema;
