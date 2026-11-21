/** Manual discovery produces process-local suggestions; managed OAuth retains its catalog sync. */
import { z } from 'zod';

import {
  listDiscoveredModelsResponseSchema,
  refreshProviderModelsResponseSchema,
} from '@kiki/protocol';

import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const refreshProviderModelsOptionsSchema = /* @__PURE__ */ z.object({
  scope: z.enum(['all', 'oauth']).optional(),
  providerId: z.string().optional(),
  apiKey: z.string().min(1).optional(),
});

export { listDiscoveredModelsResponseSchema, refreshProviderModelsResponseSchema };

export const providerDiscoveryContract = {
  listDiscoveredModels: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([]),
    output: listDiscoveredModelsResponseSchema,
  }), 'input', 'output'),
  refreshProviderModels: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([refreshProviderModelsOptionsSchema.optional()]),
    output: refreshProviderModelsResponseSchema,
  }), 'input', 'output'),
} satisfies ServiceContract;
