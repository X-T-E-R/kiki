import { z } from 'zod';
import { personaIdSchema } from './persona';

export const roomIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const roomIdParamsSchema = z.object({ id: roomIdSchema });
export const roomBudgetSchema = z.object({ botMessagesPerUserMessage: z.number().int().min(1).max(1000) }).strict();
export type RoomBudget = z.infer<typeof roomBudgetSchema>;
export const roomMemberIdSchema = z.string().min(1).max(256);
export const roomMemberInputSchema = z.union([
  z.object({ kind: z.literal('persona').optional(), personaId: personaIdSchema, muted: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('thread'), sessionId: roomMemberIdSchema, muted: z.boolean().optional(), queueWhenBusy: z.boolean().optional() }).strict(),
]);
export type RoomMemberInput = z.infer<typeof roomMemberInputSchema>;
export const roomMemberSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('persona'), personaId: personaIdSchema, sessionId: z.string(), muted: z.boolean() }),
  z.object({ kind: z.literal('thread'), sessionId: roomMemberIdSchema, muted: z.boolean(), joinedAt: z.string(), queueWhenBusy: z.boolean() }),
]);
export type RoomMember = z.infer<typeof roomMemberSchema>;
export const roomDocumentSchema = z.object({
  version: z.literal(1), id: roomIdSchema, name: z.string(),
  members: z.array(roomMemberSchema), host: roomMemberIdSchema, mode: z.literal('mention'),
  budget: roomBudgetSchema, workspace: z.string(), createdAt: z.string(),
  pinned: z.boolean().optional(), archived: z.boolean().optional(),
  generation: z.number().int().nonnegative(), paused: z.boolean(), pauseReason: z.enum(['budget', 'manual']).optional(),
  budgetUsed: z.number().int().nonnegative(), userMessageCount: z.number().int().nonnegative(),
  cursors: z.record(z.string(), z.string().optional()),
  pendingWakes: z.array(z.object({ sessionId: z.string(), sourceMessageId: z.string(), generation: z.number().int() })).optional(),
});
export type RoomDocument = z.infer<typeof roomDocumentSchema>;
export const roomListItemSchema = z.object({
  kind: z.literal('room'), id: roomIdSchema, title: z.string(), workspace: z.string(),
  createdAt: z.string(), updatedAt: z.string(), lastSeq: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(), busy: z.boolean(), needsYou: z.boolean(),
  pendingInteraction: z.enum(['approval', 'question', 'none']), failed: z.boolean(),
  pinned: z.boolean(), archived: z.boolean(),
});
export type RoomListItem = z.infer<typeof roomListItemSchema>;
export const createRoomInputSchema = z.object({
  id: roomIdSchema.optional(), name: z.string().trim().min(1).max(200),
  members: z.array(roomMemberInputSchema).min(2).max(6), host: roomMemberIdSchema.optional(),
  mode: z.literal('mention').optional(), budget: roomBudgetSchema.partial().optional(), workspace: z.string().min(1),
}).strict();
export type CreateRoomInput = z.infer<typeof createRoomInputSchema>;
export const updateRoomInputSchema = createRoomInputSchema.omit({ id: true }).partial().extend({ members: z.array(roomMemberInputSchema).max(6).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() });
export type UpdateRoomInput = z.infer<typeof updateRoomInputSchema>;
export const createThreadRoomInputSchema = createRoomInputSchema.omit({ members: true }).extend({ sessionIds: z.array(roomMemberIdSchema).min(2).max(6) });
export type CreateThreadRoomInput = z.infer<typeof createThreadRoomInputSchema>;
export const roomMemberParamsSchema = roomIdParamsSchema.extend({ memberId: roomMemberIdSchema });
export const searchRoomThreadsInputSchema = z.object({ query: z.string().max(200).optional(), workspaceId: z.string().min(1).optional(), cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
export type SearchRoomThreadsInput = z.infer<typeof searchRoomThreadsInputSchema>;
export const searchRoomThreadsResultSchema = z.object({
  threads: z.array(z.object({
    ref: z.object({ hostId: z.string(), workspaceId: z.string(), sessionId: z.string() }),
    title: z.string().optional(), updatedAt: z.number(), createdAt: z.number(), state: z.enum(['cold', 'idle', 'running']),
  })),
  nextCursor: z.string().optional(), incomplete: z.literal('scan_budget').optional(),
});
export type SearchRoomThreadsResult = z.infer<typeof searchRoomThreadsResultSchema>;
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
export const roomLogResultSchema = z.object({ entries: z.array(roomLogEntrySchema), nextCursor: z.string().optional(), lastSeq: z.number().int().nonnegative().optional() });
export type RoomLogResult = z.infer<typeof roomLogResultSchema>;
export const roomUsageSchema = z.object({
  userMessages: z.number(), botMessages: z.number(), budgetUsed: z.number(), budgetLimit: z.number(), paused: z.boolean(),
  members: z.array(z.object({ sessionId: z.string(), personaId: personaIdSchema.optional(), usage: z.unknown().optional() })),
  questions: z.object({ activeSessionId: z.string().optional(), queued: z.number().int().nonnegative() }).optional(),
});
export type RoomUsage = z.infer<typeof roomUsageSchema>;
export const roomChangeEventSchema = z.object({ roomId: roomIdSchema, room: roomDocumentSchema, entry: roomLogEntrySchema.optional(), deleted: z.boolean().optional() });
export type RoomChangeEvent = z.infer<typeof roomChangeEventSchema>;
export const deleteRoomResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteRoomResponse = z.infer<typeof deleteRoomResponseSchema>;
