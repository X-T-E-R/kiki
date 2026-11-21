/**
 * `sessionIndex` — the persisted session read model. Mirrors
 * `agent-core-v2/app/sessionIndex/sessionIndex.ts`.
 */

import { z } from 'zod';

import { maybe, pageOf } from '../helpers.js';
import { negotiatedExecutorSchema } from '../session/metadata.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const sessionSummarySchema = /* @__PURE__ */ z.object({
  id: z.string(),
  workspaceId: z.string(),
  cwd: z.string().optional(),
  title: z.string().optional(),
  lastPrompt: z.string().optional(),
  delivery: z.enum(['reply', 'message']).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
  private: z.boolean().optional(),
  archivedAt: z.number().optional(),
  executionPhase: z.enum(['running', 'pausing', 'paused', 'resuming', 'failed']).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  lastTurnReason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  executorId: z.string().optional(),
  negotiated: negotiatedExecutorSchema.optional(),
  allowKikiSubagents: z.boolean().optional(),
});

export const sessionListQuerySchema = /* @__PURE__ */ z.object({
  workspaceIds: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().optional(),
  childOf: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});

export const sessionCountQuerySchema = /* @__PURE__ */ z.object({
  workspaceIds: z.array(z.string()).optional(),
  includeArchived: z.boolean().optional(),
});

export const sessionsContract = {
  listRecent: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([sessionListQuerySchema]), output: /* @__PURE__ */ pageOf(sessionSummarySchema) }), 'input', 'output'),
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(sessionSummarySchema) }), 'input', 'output'),
  count: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([sessionCountQuerySchema]), output: /* @__PURE__ */ z.number() }), 'input', 'output'),
} satisfies ServiceContract;
