import { z } from 'zod';

export const nbSearchCapabilitiesSchema = z
  .object({
    schema_version: z.string(),
    revision: z.string(),
    providers: z.unknown(),
    search: z.unknown(),
    fetch: z.unknown(),
    jobs: z.unknown(),
  })
  .passthrough();

const nbSearchReadinessSchema = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  selection: z.string().optional(),
  issues: z.array(z.string()),
});

export const nbSearchTestStatusSchema = z.object({
  revision: z.string(),
  search: nbSearchReadinessSchema,
  fetch: nbSearchReadinessSchema,
});
