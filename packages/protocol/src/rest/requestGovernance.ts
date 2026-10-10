import { z } from 'zod';

export const requestConcurrencyRuleSchema = z.object({
  id: z.string(), resource: z.enum(['model_request', 'agent_execution']), scope: z.enum(['global', 'each_session']),
  executors: z.array(z.string()).optional(), profiles: z.array(z.string()).optional(),
  roles: z.array(z.enum(['main', 'subagent', 'independent'])).optional(),
  models: z.array(z.string()).optional(), providers: z.array(z.string()).optional(),
  subagentsOnly: z.boolean(), maxConcurrent: z.number().int().positive().optional(),
  overflow: z.enum(['queue', 'reject']), maxWaitMs: z.number().positive().optional(),
  enabled: z.boolean(),
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

/**
 * Wire patch for the `request_governance` config section via `POST /config`.
 * `rules` is the full list: the section merge replaces arrays wholesale, so
 * an edit, a toggle, and a deletion all travel as the same complete write.
 * Keys are the config-file snake_case shape; the server converts to the
 * engine's camelCase section before validating it against the section schema.
 */
export const requestConcurrencyRulePatchSchema = z.object({
  id: z.string().min(1),
  resource: z.enum(['model_request', 'agent_execution']).optional(),
  executors: z.array(z.string().min(1)).min(1).optional(),
  profiles: z.array(z.string().min(1)).min(1).optional(),
  roles: z.array(z.enum(['main', 'subagent', 'independent'])).min(1).optional(),
  scope: z.enum(['global', 'each_session']).optional(),
  models: z.array(z.string().min(1)).min(1).optional(),
  providers: z.array(z.string().min(1)).min(1).optional(),
  subagents_only: z.boolean().optional(),
  max_concurrent: z.number().int().positive().optional(),
  overflow: z.enum(['queue', 'reject']).optional(),
  max_wait_ms: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
}).strict();

export const requestGovernanceConfigPatchSchema = z.object({
  schema_version: z.literal(1).optional(),
  max_wait_ms: z.number().int().positive().optional(),
  max_queue_size: z.number().int().positive().optional(),
  rules: z.array(requestConcurrencyRulePatchSchema).optional(),
}).strict();
export type RequestGovernanceConfigPatch = z.infer<typeof requestGovernanceConfigPatchSchema>;
