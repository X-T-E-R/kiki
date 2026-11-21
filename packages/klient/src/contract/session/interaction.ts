/**
 * `sessionInteractionService` — blocking human-in-the-loop request kernel.
 * Mirrors `agent-core-v2/session/interaction/interaction.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const interactionKindSchema = /* @__PURE__ */ z.enum(['approval', 'question', 'user_tool']);

export const interactionOriginSchema = /* @__PURE__ */ z.object({
  agentId: z.string().optional(),
  turnId: z.number().optional(),
});

export const interactionSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  kind: interactionKindSchema,
  payload: z.unknown(),
  origin: interactionOriginSchema,
  createdAt: z.number(),
});

export const interactionResolutionSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  response: z.unknown(),
});

export const sessionInteractionContract = {
  listPending: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([interactionKindSchema.optional()]),
    output: /* @__PURE__ */ z.array(interactionSchema),
  }), 'input', 'output'),
  respond: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), z.unknown()]), output: noResult }), 'input', 'output'),
  acquireConsumer: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
  releaseConsumer: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
  hasConsumer: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.boolean() }), 'input', 'output'),
  isRecentlyResolved: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ z.boolean() }), 'input', 'output'),
} satisfies ServiceContract;
