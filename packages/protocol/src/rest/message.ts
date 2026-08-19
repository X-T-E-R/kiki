/**
 *   GET /v1/sessions/{session_id}/messages
 *     Query: cursorQuery + role
 *     Default page_size=50; max 100 (per SCHEMAS §1.3).
 *     Response data: Page<Message>
 *
 *   GET /v1/sessions/{session_id}/messages/{message_id}
 *     Response data: Message
 *     Errors: 40401 (session.not_found) + 40403 (message.not_found)
 */

import { z } from 'zod';

import {
  fileContentSchema,
  imageContentSchema,
  messageRoleSchema,
  messageSchema,
  textContentSchema,
  videoContentSchema,
} from '../message';
import { cursorQuerySchema } from '../pagination';
import { expectedSessionCursorSchema } from '../session';
import { promptExecutionOverridesSchema, promptSubmitResultSchema } from './prompt';

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
