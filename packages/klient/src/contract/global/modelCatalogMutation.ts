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

export { providerEntitySchema };

export const deleteModelOptionsSchema = z.object({
  baseRevision: z.string().min(1).optional(),
});

export const modelCatalogMutationContract = {
  readModel: { input: z.tuple([z.string()]), output: modelEntitySchema },
  createModel: { input: z.tuple([createModelRequestSchema]), output: modelEntitySchema },
  updateModel: {
    input: z.tuple([z.string(), patchModelRequestSchema]),
    output: modelEntitySchema,
  },
  deleteModel: {
    input: z.tuple([z.string(), deleteModelOptionsSchema.optional()]),
    output: z.void(),
  },
  readProvider: { input: z.tuple([z.string()]), output: providerEntitySchema },
  createProvider: { input: z.tuple([createProviderRequestSchema]), output: providerEntitySchema },
  updateProvider: {
    input: z.tuple([z.string(), patchProviderRequestSchema]),
    output: providerEntitySchema,
  },
  deleteProvider: { input: z.tuple([z.string()]), output: z.void() },
} satisfies ServiceContract;

export { getModelResponseSchema };
