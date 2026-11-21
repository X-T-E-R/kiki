import { z } from 'zod';

import { sessionSeedCarryWireSchema, sessionSeedModeWireSchema } from './lifecycle.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const createSessionBranchInputSchema = /* @__PURE__ */ z.object({
  parentAgentId: z.string().optional(),
  initiator: z.enum(['user', 'agent']).optional(),
  task: z.string().optional(),
  prompt: z.string().optional(),
  seed: sessionSeedModeWireSchema.optional(),
  carry: sessionSeedCarryWireSchema.optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().nullable().optional(),
  executor: z.string().optional(),
  cwd: z.string().optional(),
  toolsLocked: z.boolean().optional(),
});

export const createSessionBranchResultSchema = /* @__PURE__ */ z.object({
  branchId: z.string(),
  parentAgentId: z.string(),
  seed: sessionSeedModeWireSchema,
  title: z.string().optional(),
  toolsLocked: z.boolean(),
  started: z.boolean(),
});

export const foldSessionBranchInputSchema = /* @__PURE__ */ z.object({
  branchId: z.string(),
  summary: z.string().optional(),
  context: z.string().optional(),
  asks: z.array(z.string()).optional(),
  done: z.boolean().optional(),
  fromTool: z.boolean().optional(),
});

export const foldSessionBranchResultSchema = /* @__PURE__ */ z.object({
  branchId: z.string(),
  foldId: z.string().optional(),
  status: z.enum(['merged', 'prompted']),
  done: z.boolean(),
  sealed: z.boolean(),
  handedBackCount: z.number(),
  throughTurnId: z.number(),
});

export const discardSessionBranchInputSchema = /* @__PURE__ */ z.object({
  branchId: z.string(),
});

export const discardSessionBranchResultSchema = /* @__PURE__ */ z.object({
  branchId: z.string(),
  discarded: z.boolean(),
});

export const setSessionBranchToolsLockInputSchema = /* @__PURE__ */ z.object({
  branchId: z.string(),
  locked: z.boolean(),
});

export const setSessionBranchToolsLockResultSchema = /* @__PURE__ */ z.object({
  branchId: z.string(),
  toolsLocked: z.boolean(),
});

export const sessionBranchContract = {
  createBranch: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([createSessionBranchInputSchema.optional()]),
    output: createSessionBranchResultSchema,
  }), 'input', 'output'),
  foldBranch: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([foldSessionBranchInputSchema]),
    output: foldSessionBranchResultSchema,
  }), 'input', 'output'),
  discardBranch: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([discardSessionBranchInputSchema]),
    output: discardSessionBranchResultSchema,
  }), 'input', 'output'),
  setToolsLocked: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([setSessionBranchToolsLockInputSchema]),
    output: setSessionBranchToolsLockResultSchema,
  }), 'input', 'output'),
} satisfies ServiceContract;

export const sessionBtwContract = {
  start: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.string() }), 'input', 'output'),
} satisfies ServiceContract;
