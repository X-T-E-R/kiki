/**
 * `workspaceService` — process-wide catalog of known workspaces. Mirrors
 * `agent-core-v2/app/workspace/workspace.ts`.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const workspaceSchema = /* @__PURE__ */ z.object({
  id: z.string(),
  root: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastOpenedAt: z.number(),
  pinned: z.boolean(),
});

export const workspaceUpdateSchema = /* @__PURE__ */ z.object({
  name: z.string().optional(),
  pinned: z.boolean().optional(),
});

export const workspacesContract = {
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(workspaceSchema) }), 'input', 'output'),
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(workspaceSchema) }), 'input', 'output'),
  createOrTouch: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), z.string().optional()]),
    output: workspaceSchema,
  }), 'input', 'output'),
  update: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), workspaceUpdateSchema]),
    output: /* @__PURE__ */ maybe(workspaceSchema),
  }), 'input', 'output'),
  delete: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;
