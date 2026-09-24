/** Manual discovery produces process-local suggestions; managed OAuth retains its catalog sync. */
import { z } from 'zod';

import {
  listDiscoveredModelsResponseSchema,
  refreshProviderModelsResponseSchema,
} from '@kiki/protocol';

import type { ServiceContract } from '../types.js';

export const refreshProviderModelsOptionsSchema = z.object({
  scope: z.enum(['all', 'oauth']).optional(),
  providerId: z.string().optional(),
  apiKey: z.string().min(1).optional(),
});

export { listDiscoveredModelsResponseSchema, refreshProviderModelsResponseSchema };

export const providerDiscoveryContract = {
  listDiscoveredModels: {
    input: z.tuple([]),
    output: listDiscoveredModelsResponseSchema,
  },
  refreshProviderModels: {
    input: z.tuple([refreshProviderModelsOptionsSchema.optional()]),
    output: refreshProviderModelsResponseSchema,
  },
} satisfies ServiceContract;
