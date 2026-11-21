import { z } from 'zod';

import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const sessionActivityStateSchema = /* @__PURE__ */ z.object({
  busy: z.boolean(),
  executing: z.boolean().optional(),
  cleanupPending: z.boolean().optional(),
  mainTurnActive: z.boolean(),
  pendingInteraction: z.enum(['none', 'approval', 'question']),
  lastTurnReason: z.enum(['completed', 'cancelled', 'failed']).optional(),
});

export const sessionActivityViewContract = {
  state: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: sessionActivityStateSchema }), 'input', 'output'),
} satisfies ServiceContract;
