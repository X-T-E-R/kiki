/**
 * `modelCatalogMutation` — the engine's `IModelCatalogMutationService`: the
 * single write path for the `[providers]` / `[models]` config tables. Every
 * payload is a sparse entity patch, so an edit writes exactly one entity and
 * can never rebuild or drop a sibling; `base_revision` turns the write into a
 * compare-and-swap that reports a structured conflict instead of overwriting
 * a concurrent edit.
 */

import {
  createModelRequestSchema,
  createProviderRequestSchema,
  getModelResponseSchema,
  modelEntitySchema,
  patchModelRequestSchema,
  patchProviderRequestSchema,
  providerEntitySchema,
} from '@kiki/protocol';
import { z } from 'zod';

import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export { providerEntitySchema };

export const deleteModelOptionsSchema = /* @__PURE__ */ z.object({
  baseRevision: z.string().min(1).optional(),
});

export const modelCatalogMutationContract = {
  readModel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: modelEntitySchema }), 'input', 'output'),
  createModel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([createModelRequestSchema]), output: modelEntitySchema }), 'input', 'output'),
  updateModel: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), patchModelRequestSchema]),
    output: modelEntitySchema,
  }), 'input', 'output'),
  deleteModel: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), deleteModelOptionsSchema.optional()]),
    output: /* @__PURE__ */ z.void(),
  }), 'input', 'output'),
  readProvider: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: providerEntitySchema }), 'input', 'output'),
  createProvider: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([createProviderRequestSchema]), output: providerEntitySchema }), 'input', 'output'),
  updateProvider: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), patchProviderRequestSchema]),
    output: providerEntitySchema,
  }), 'input', 'output'),
  deleteProvider: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ z.void() }), 'input', 'output'),
} satisfies ServiceContract;

export { getModelResponseSchema };
