import { z } from 'zod';
import { personaIdSchema } from './persona';

export const roomIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const roomIdParamsSchema = z.object({ id: roomIdSchema });
export const roomBudgetSchema = z.object({ botMessagesPerUserMessage: z.number().int().min(1).max(1000) }).strict();
export type RoomBudget = z.infer<typeof roomBudgetSchema>;
export const roomMemberInputSchema = z.object({ personaId: personaIdSchema, muted: z.boolean().optional() }).strict();
export type RoomMemberInput = z.infer<typeof roomMemberInputSchema>;
export const roomMemberSchema = z.object({ personaId: personaIdSchema, sessionId: z.string(), muted: z.boolean() });
export type RoomMember = z.infer<typeof roomMemberSchema>;
export const roomDocumentSchema = z.object({
  version: z.literal(1), id: roomIdSchema, name: z.string(),
  members: z.array(roomMemberSchema), host: personaIdSchema, mode: z.literal('mention'),
  budget: roomBudgetSchema, workspace: z.string(), createdAt: z.string(),
  generation: z.number().int().nonnegative(), paused: z.boolean(), pauseReason: z.enum(['budget', 'manual']).optional(),
  budgetUsed: z.number().int().nonnegative(), userMessageCount: z.number().int().nonnegative(),
  cursors: z.record(z.string(), z.string().optional()),
  pendingWakes: z.array(z.object({ sessionId: z.string(), sourceMessageId: z.string(), generation: z.number().int() })).optional(),
});
export type RoomDocument = z.infer<typeof roomDocumentSchema>;
export const createRoomInputSchema = z.object({
  id: roomIdSchema.optional(), name: z.string().trim().min(1).max(200),
  members: z.array(roomMemberInputSchema).min(2).max(6), host: personaIdSchema.optional(),
  mode: z.literal('mention').optional(), budget: roomBudgetSchema.partial().optional(), workspace: z.string().min(1),
}).strict();
export type CreateRoomInput = z.infer<typeof createRoomInputSchema>;
export const updateRoomInputSchema = createRoomInputSchema.omit({ id: true }).partial();
export type UpdateRoomInput = z.infer<typeof updateRoomInputSchema>;
export const roomAttachmentSchema = z.object({
  blobId: z.string().min(1), path: z.string().min(1), title: z.string().optional(),
  mimeType: z.string().optional(), size: z.number().int().nonnegative().optional(),
});
export type RoomAttachment = z.infer<typeof roomAttachmentSchema>;
export const roomMessageSchema = z.object({
  id: z.string(), at: z.string(), kind: z.literal('message'), from: z.string(), username: z.string().optional(),
  text: z.string(), idempotencyKey: z.string().optional(), replyTo: z.string().optional(),
  mentions: z.array(z.string()), attachments: z.array(roomAttachmentSchema).optional(),
});
export type RoomMessage = z.infer<typeof roomMessageSchema>;
export const roomSystemLogSchema = z.object({
  id: z.string(), at: z.string(), kind: z.literal('system'), from: z.literal('system'),
  event: z.string(), text: z.string(), data: z.record(z.string(), z.unknown()).optional(),
});
export const roomLogEntrySchema = z.discriminatedUnion('kind', [roomMessageSchema, roomSystemLogSchema]);
export type RoomLogEntry = z.infer<typeof roomLogEntrySchema>;
export const postRoomMessageInputSchema = z.object({
  text: z.string().trim().min(1).max(20_000), username: z.string().max(200).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(), replyTo: z.string().optional(),
  attachments: z.array(roomAttachmentSchema).max(10).optional(),
}).strict();
export type PostRoomMessageInput = z.infer<typeof postRoomMessageInputSchema>;
export const roomLogOptionsSchema = z.object({ afterId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
export type RoomLogOptions = z.infer<typeof roomLogOptionsSchema>;
export const roomLogResultSchema = z.object({ entries: z.array(roomLogEntrySchema), nextCursor: z.string().optional() });
export type RoomLogResult = z.infer<typeof roomLogResultSchema>;
export const roomUsageSchema = z.object({
  userMessages: z.number(), botMessages: z.number(), budgetUsed: z.number(), budgetLimit: z.number(), paused: z.boolean(),
  members: z.array(z.object({ sessionId: z.string(), personaId: personaIdSchema, usage: z.unknown().optional() })),
  questions: z.object({ activeSessionId: z.string().optional(), queued: z.number().int().nonnegative() }).optional(),
});
export type RoomUsage = z.infer<typeof roomUsageSchema>;
export const roomChangeEventSchema = z.object({ roomId: roomIdSchema, room: roomDocumentSchema, entry: roomLogEntrySchema.optional() });
export type RoomChangeEvent = z.infer<typeof roomChangeEventSchema>;
export const deleteRoomResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteRoomResponse = z.infer<typeof deleteRoomResponseSchema>;
