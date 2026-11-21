import { z } from 'zod';

import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const optionalCapabilityIdSchema = /* @__PURE__ */ z.enum(['browser', 'computer', 'memory', 'thread', 'branch', 'web', 'send_message']);
export const optionalCapabilityChoiceSchema = /* @__PURE__ */ z.enum(['on', 'off', 'inherit']);
export const optionalCapabilitySessionRowSchema = /* @__PURE__ */ z.object({
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
export const optionalCapabilitySessionViewSchema = /* @__PURE__ */ z.object({
  revision: z.number().int().nonnegative(),
  hostId: z.string().min(1),
  rows: z.array(optionalCapabilitySessionRowSchema),
}).strict();

export const sessionOptionalCapabilityContract = {
  read: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: optionalCapabilitySessionViewSchema }), 'input', 'output'),
  set: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([optionalCapabilityIdSchema, optionalCapabilityChoiceSchema]),
    output: optionalCapabilitySessionViewSchema,
  }), 'input', 'output'),
} satisfies ServiceContract;
