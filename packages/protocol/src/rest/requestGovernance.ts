import { z } from 'zod';

export const requestConcurrencyRuleSchema = z.object({
  id: z.string(), resource: z.literal('model_request'), scope: z.enum(['global', 'each_session']),
  models: z.array(z.string()).optional(), providers: z.array(z.string()).optional(),
  subagentsOnly: z.boolean(), maxConcurrent: z.number().int().positive().optional(),
  overflow: z.enum(['queue', 'reject']), maxWaitMs: z.number().positive().optional(),
});
export const requestGovernanceSnapshotSchema = z.object({
  domainId: z.string(), runtimeEpoch: z.string(), seq: z.number().int(), asOf: z.string(),
  coverage: z.object({ native: z.literal('managed'), external: z.literal('unmanaged') }),
  active: z.number().int().nonnegative(), queued: z.number().int().nonnegative(),
  dimensions: z.array(z.object({ dimension: z.enum(['model', 'provider', 'session', 'role']), id: z.string(), active: z.number().int().nonnegative(), queued: z.number().int().nonnegative() })),
  rules: z.array(requestConcurrencyRuleSchema),
  waiting: z.array(z.object({ attemptId: z.string(), sessionId: z.string().optional(), agentId: z.string().optional(), modelId: z.string(), providerId: z.string(), purpose: z.string(), waitedMs: z.number().nonnegative(), blockingRules: z.array(z.string()) })),
});
export type RequestGovernanceSnapshot = z.infer<typeof requestGovernanceSnapshotSchema>;
