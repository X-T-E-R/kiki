import { z } from 'zod';
import { requestConcurrencyRuleSchema } from './requestGovernance';

export const agentActivityRoleSchema = z.enum(['main', 'subagent', 'independent']);
export const agentActivityPhaseSchema = z.enum(['starting', 'running', 'tool_waiting', 'suspended', 'cancelling', 'finalizing']);
export const agentActivityDimensionSchema = z.enum(['executor', 'profile', 'model', 'role', 'session']);
const count = z.number().int().nonnegative();
export const agentActivityCountsSchema = z.object({
  active: count, queued: count, main: count, subagent: count, independent: count,
  queuedMain: count, queuedSubagent: count, queuedIndependent: count,
});
const identity = {
  sessionId: z.string(), agentId: z.string(), executorId: z.string().optional(),
  profileId: z.string().optional(), modelId: z.string().optional(), role: agentActivityRoleSchema,
};
export const agentActivitySnapshotSchema = agentActivityCountsSchema.extend({
  domainId: z.string(), runtimeEpoch: z.string(), seq: z.number().int(), asOf: z.string(),
  coverage: z.literal('this_process'), unit: z.literal('agent_execution'),
  dimensions: z.array(agentActivityCountsSchema.extend({ dimension: agentActivityDimensionSchema, id: z.string().nullable() })),
  agents: z.array(z.object({ ...identity, parentAgentId: z.string().optional(), providerId: z.string().optional(), phase: agentActivityPhaseSchema, startedAt: z.string() })),
  waiting: z.array(z.object({ ...identity, waitedMs: z.number().nonnegative(), blockingRules: z.array(z.string()) })),
  rules: z.array(requestConcurrencyRuleSchema),
});
export const agentAncestorLimitDetailsSchema = z.object({
  resource: z.literal('agent_execution'), rules: z.array(z.string()),
  occupyingAncestors: z.array(z.object({ ruleId: z.string(), sessionId: z.string(), agentId: z.string() })),
  action: z.literal('separate_main_subagent_rules_or_raise_limit'),
});
export type AgentActivityRole = z.infer<typeof agentActivityRoleSchema>;
export type AgentActivityPhase = z.infer<typeof agentActivityPhaseSchema>;
export type AgentActivityDimension = z.infer<typeof agentActivityDimensionSchema>;
export type AgentActivitySnapshot = z.infer<typeof agentActivitySnapshotSchema>;
export type AgentAncestorLimitDetails = z.infer<typeof agentAncestorLimitDetailsSchema>;
