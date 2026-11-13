import { z } from 'zod';

import { sessionSeedCarryWireSchema, sessionSeedModeWireSchema } from './lifecycle.js';
import type { ServiceContract } from '../types.js';

export const createSessionBranchInputSchema = z.object({
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

export const createSessionBranchResultSchema = z.object({
  branchId: z.string(),
  parentAgentId: z.string(),
  seed: sessionSeedModeWireSchema,
  title: z.string().optional(),
  toolsLocked: z.boolean(),
  started: z.boolean(),
});

export const foldSessionBranchInputSchema = z.object({
  branchId: z.string(),
  summary: z.string().optional(),
  context: z.string().optional(),
  asks: z.array(z.string()).optional(),
  done: z.boolean().optional(),
  fromTool: z.boolean().optional(),
});

export const foldSessionBranchResultSchema = z.object({
  branchId: z.string(),
  foldId: z.string().optional(),
  status: z.enum(['merged', 'prompted']),
  done: z.boolean(),
  sealed: z.boolean(),
  handedBackCount: z.number(),
  throughTurnId: z.number(),
});

export const discardSessionBranchInputSchema = z.object({
  branchId: z.string(),
});

export const discardSessionBranchResultSchema = z.object({
  branchId: z.string(),
  discarded: z.boolean(),
});

export const setSessionBranchToolsLockInputSchema = z.object({
  branchId: z.string(),
  locked: z.boolean(),
});

export const setSessionBranchToolsLockResultSchema = z.object({
  branchId: z.string(),
  toolsLocked: z.boolean(),
});

export const sessionBranchContract = {
  createBranch: {
    input: z.tuple([createSessionBranchInputSchema.optional()]),
    output: createSessionBranchResultSchema,
  },
  foldBranch: {
    input: z.tuple([foldSessionBranchInputSchema]),
    output: foldSessionBranchResultSchema,
  },
  discardBranch: {
    input: z.tuple([discardSessionBranchInputSchema]),
    output: discardSessionBranchResultSchema,
  },
  setToolsLocked: {
    input: z.tuple([setSessionBranchToolsLockInputSchema]),
    output: setSessionBranchToolsLockResultSchema,
  },
} satisfies ServiceContract;

export const sessionBtwContract = {
  start: { input: z.tuple([]), output: z.string() },
} satisfies ServiceContract;
