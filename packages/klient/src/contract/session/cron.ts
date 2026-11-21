import { z } from 'zod';
import { cronScriptExecutionSchema, cronTriggerCheckSchema, cronTriggerSchema } from '@kiki/protocol';

import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const cronTaskSchema = /* @__PURE__ */ z.object({
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
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(cronTaskSchema) }), 'input', 'output'),
  getNextFireTime: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.number().nullable() }), 'input', 'output'),
  getNextFireForTask: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string()]),
    output: /* @__PURE__ */ z.number().nullable(),
  }), 'input', 'output'),
} satisfies ServiceContract;
