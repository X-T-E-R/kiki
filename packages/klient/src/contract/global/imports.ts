import { z } from 'zod';
import {
  importSourceSchema, importDiscoveryInputSchema, importDiscoveryPageSchema, importPreviewInputSchema,
  importPreviewSchema, importStartInputSchema, importJobSchema, importListInputSchema,
  importArchiveQuerySchema, importArchiveSchema, importReadInputSchema, importReadPageSchema,
} from '@kiki/protocol';
import type { ServiceContract } from '../types.js';

export const importsContract = {
  sources: { input: z.tuple([]), output: z.array(importSourceSchema) },
  discover: { input: z.tuple([importDiscoveryInputSchema]), output: importDiscoveryPageSchema },
  preview: { input: z.tuple([importPreviewInputSchema]), output: importPreviewSchema },
  start: { input: z.tuple([importStartInputSchema]), output: importJobSchema },
  jobs: { input: z.tuple([importListInputSchema.optional()]), output: z.object({ items: z.array(importJobSchema), cursor: z.string().nullable() }) },
  job: { input: z.tuple([z.string()]), output: importJobSchema },
  cancel: { input: z.tuple([z.string()]), output: importJobSchema },
  resume: { input: z.tuple([z.string()]), output: importJobSchema },
  archives: { input: z.tuple([importArchiveQuerySchema.optional()]), output: z.object({ items: z.array(importArchiveSchema), cursor: z.string().nullable() }) },
  read: { input: z.tuple([importReadInputSchema]), output: importReadPageSchema },
} satisfies ServiceContract;
