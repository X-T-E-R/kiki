import { z } from 'zod';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const executionControlStateSchema = /* @__PURE__ */ z.object({
  phase: z.enum(['running', 'pausing', 'paused', 'resuming', 'failed']),
  pauseOperationId: z.string().optional(),
  resumeOperationId: z.string().optional(),
  cancelPauseOperationId: z.string().optional(),
  requestedAt: z.string().optional(),
  pausedAt: z.string().optional(),
  resumedAt: z.string().optional(),
  agents: z.array(z.object({
    agentId: z.string(), state: z.enum(['settling', 'paused', 'idle', 'unknown']),
    turnId: z.number().optional(), resumable: z.boolean(), detail: z.string().optional(),
  })),
  error: z.string().optional(),
});

export const executionControlContract = {
  read: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: executionControlStateSchema }), 'input', 'output'),
  pause: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.object({ operationId: z.string().min(1).max(256) })]), output: executionControlStateSchema }), 'input', 'output'),
  cancelPause: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.object({ operationId: z.string().min(1).max(256), pauseOperationId: z.string().min(1).max(256) })]), output: executionControlStateSchema }), 'input', 'output'),
  resume: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.object({ operationId: z.string().min(1).max(256), pauseOperationId: z.string().min(1).max(256) })]), output: executionControlStateSchema }), 'input', 'output'),
} satisfies ServiceContract;
