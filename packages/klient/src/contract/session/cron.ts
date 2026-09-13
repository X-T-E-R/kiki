import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const cronTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  recurring: z.boolean().optional(),
  lastFiredAt: z.number().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export const sessionCronContract = {
  list: { input: z.tuple([]), output: z.array(cronTaskSchema) },
  getNextFireTime: { input: z.tuple([]), output: z.number().nullable() },
  getNextFireForTask: {
    input: z.tuple([z.string()]),
    output: z.number().nullable(),
  },
} satisfies ServiceContract;
