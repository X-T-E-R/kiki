import { z } from 'zod';
import { mediaSourceSchema, mediaSourcesInputSchema, mediaCatalogSchema, mediaProvidersSchema, mediaCapabilityQuerySchema, mediaCapabilitiesSchema, mediaVoiceQuerySchema, mediaVoicePageSchema, mediaJobsInputSchema, mediaJobSchema } from '@kiki/protocol';
import type { ServiceContract } from '../types.js';

export const mediaContract = {
  sources: { input: z.tuple([]), output: z.array(mediaSourceSchema) },
  setSources: { input: z.tuple([mediaSourcesInputSchema]), output: z.array(mediaSourceSchema) },
  catalog: { input: z.tuple([z.object({ id: z.string().min(1) }).strict()]), output: mediaCatalogSchema },
  providers: { input: z.tuple([]), output: mediaProvidersSchema },
  capabilities: { input: z.tuple([mediaCapabilityQuerySchema]), output: z.union([mediaCapabilitiesSchema, z.object({ providers: mediaProvidersSchema }).strict()]) },
  voices: { input: z.tuple([mediaVoiceQuerySchema]), output: mediaVoicePageSchema },
  jobs: { input: z.tuple([mediaJobsInputSchema.optional()]), output: z.array(mediaJobSchema) },
  job: { input: z.tuple([z.string().min(1)]), output: mediaJobSchema },
} satisfies ServiceContract;
export const agentMediaContract = {
  cancel: { input: z.tuple([z.string().min(1)]), output: mediaJobSchema },
  resume: { input: z.tuple([z.string().min(1)]), output: mediaJobSchema },
} satisfies ServiceContract;
