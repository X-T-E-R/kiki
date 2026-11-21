import { z } from 'zod';
import { botSummarySchema, botStateSchema, botUpdateInputSchema, roomIdSchema, personaIdSchema, roomDocumentSchema, roomListItemSchema, createRoomInputSchema, updateRoomInputSchema, postRoomMessageInputSchema, roomMessageSchema, roomLogOptionsSchema, roomLogResultSchema, roomUsageSchema, roomMemberIdSchema, roomMemberInputSchema, createThreadRoomInputSchema, searchRoomThreadsInputSchema, searchRoomThreadsResultSchema } from '@kiki/protocol';
import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const botContract = {
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(botSummarySchema) }), 'input', 'output'),
  enable: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([personaIdSchema]), output: botSummarySchema }), 'input', 'output'),
  ensureHomeSession: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([personaIdSchema]), output: botSummarySchema }), 'input', 'output'),
  update: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([personaIdSchema, botUpdateInputSchema]), output: botStateSchema }), 'input', 'output'),
} satisfies ServiceContract;
export const roomContract = {
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(roomDocumentSchema) }), 'input', 'output'),
  listItems: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(roomListItemSchema) }), 'input', 'output'),
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema]), output: /* @__PURE__ */ maybe(roomDocumentSchema) }), 'input', 'output'),
  create: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([createRoomInputSchema]), output: roomDocumentSchema }), 'input', 'output'),
  createFromThreads: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([createThreadRoomInputSchema]), output: roomDocumentSchema }), 'input', 'output'),
  searchThreads: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([searchRoomThreadsInputSchema.optional()]), output: searchRoomThreadsResultSchema }), 'input', 'output'),
  addMember: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema, roomMemberInputSchema]), output: roomDocumentSchema }), 'input', 'output'),
  removeMember: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema, roomMemberIdSchema]), output: roomDocumentSchema }), 'input', 'output'),
  update: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema, updateRoomInputSchema]), output: roomDocumentSchema }), 'input', 'output'),
  delete: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema]), output: noResult }), 'input', 'output'),
  postUserMessage: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema, postRoomMessageInputSchema]), output: roomMessageSchema }), 'input', 'output'),
  pause: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema]), output: roomDocumentSchema }), 'input', 'output'),
  continue: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema]), output: roomDocumentSchema }), 'input', 'output'),
  stop: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema]), output: roomDocumentSchema }), 'input', 'output'),
  log: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema, roomLogOptionsSchema.optional()]), output: roomLogResultSchema }), 'input', 'output'),
  usage: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([roomIdSchema]), output: roomUsageSchema }), 'input', 'output'),
} satisfies ServiceContract;
