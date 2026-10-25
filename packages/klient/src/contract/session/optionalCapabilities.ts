import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const optionalCapabilityIdSchema = z.enum(['browser', 'computer', 'memory', 'thread', 'web', 'send_message']);
export const optionalCapabilityChoiceSchema = z.enum(['on', 'off', 'inherit']);
export const optionalCapabilitySessionRowSchema = z.object({
  id: optionalCapabilityIdSchema,
  choice: optionalCapabilityChoiceSchema,
  effective: z.boolean(),
  source: z.enum(['session', 'default', 'off']),
  reason: z.string(),
  allowed: z.boolean(),
  hostLocked: z.boolean(),
  defaultOn: z.boolean(),
  unresolved: z.boolean(),
  applies: z.enum(['next-model-request', 'next-step']),
}).strict();
export const optionalCapabilitySessionViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  hostId: z.string().min(1),
  rows: z.array(optionalCapabilitySessionRowSchema),
}).strict();

export const sessionOptionalCapabilityContract = {
  read: { input: z.tuple([]), output: optionalCapabilitySessionViewSchema },
  set: {
    input: z.tuple([optionalCapabilityIdSchema, optionalCapabilityChoiceSchema]),
    output: optionalCapabilitySessionViewSchema,
  },
} satisfies ServiceContract;
