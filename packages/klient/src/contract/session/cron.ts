import { z } from 'zod';
import { cronScriptExecutionSchema, cronTriggerCheckSchema, cronTriggerSchema } from '@kiki/protocol';

import type { ServiceContract } from '../types.js';

export const cronTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  recurring: z.boolean().optional(),
  deliveryMode: z.enum(['queue', 'steer', 'idle']).optional(),
  paused: z.boolean().optional(),
  lastFiredAt: z.number().optional(),
  trigger: cronTriggerSchema.optional(),
  approvedScript: cronScriptExecutionSchema.optional(),
  scheduleCursorAt: z.number().optional(),
  oneShotClaimed: z.boolean().optional(),
  lastTriggerCheck: cronTriggerCheckSchema.optional(),
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
