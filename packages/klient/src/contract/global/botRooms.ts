import { z } from 'zod';
import { botSummarySchema, botStateSchema, botUpdateInputSchema, roomIdSchema, personaIdSchema, roomDocumentSchema, createRoomInputSchema, updateRoomInputSchema, postRoomMessageInputSchema, roomMessageSchema, roomLogOptionsSchema, roomLogResultSchema, roomUsageSchema } from '@kiki/protocol';
import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const botContract = {
  list: { input: z.tuple([]), output: z.array(botSummarySchema) },
  enable: { input: z.tuple([personaIdSchema]), output: botSummarySchema },
  ensureHomeSession: { input: z.tuple([personaIdSchema]), output: botSummarySchema },
  update: { input: z.tuple([personaIdSchema, botUpdateInputSchema]), output: botStateSchema },
} satisfies ServiceContract;
export const roomContract = {
  list: { input: z.tuple([]), output: z.array(roomDocumentSchema) },
  get: { input: z.tuple([roomIdSchema]), output: maybe(roomDocumentSchema) },
  create: { input: z.tuple([createRoomInputSchema]), output: roomDocumentSchema },
  update: { input: z.tuple([roomIdSchema, updateRoomInputSchema]), output: roomDocumentSchema },
  delete: { input: z.tuple([roomIdSchema]), output: noResult },
  postUserMessage: { input: z.tuple([roomIdSchema, postRoomMessageInputSchema]), output: roomMessageSchema },
  pause: { input: z.tuple([roomIdSchema]), output: roomDocumentSchema },
  continue: { input: z.tuple([roomIdSchema]), output: roomDocumentSchema },
  stop: { input: z.tuple([roomIdSchema]), output: roomDocumentSchema },
  log: { input: z.tuple([roomIdSchema, roomLogOptionsSchema.optional()]), output: roomLogResultSchema },
  usage: { input: z.tuple([roomIdSchema]), output: roomUsageSchema },
} satisfies ServiceContract;
