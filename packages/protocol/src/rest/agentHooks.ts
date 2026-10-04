import { z } from 'zod';

export const agentHooksInspectSchema = z.object({
  revision: z.string(),
  binding: z.object({
    executorId: z.string(), modelId: z.string().optional(), modelAlias: z.string().optional(),
    profileId: z.string().optional(), routeId: z.string().optional(), agentRole: z.enum(['root', 'subagent']).optional(),
  }),
  sources: z.array(z.object({ namespace: z.string(), path: z.string(), status: z.enum(['loaded', 'absent', 'invalid', 'unavailable']) })),
  diagnostics: z.array(z.object({ path: z.string(), hookId: z.string().optional(), message: z.string() })),
  rules: z.array(z.object({
    id: z.string(), path: z.string(), namespace: z.string(),
    event: z.enum(['prompt.submit', 'step.before', 'step.after', 'turn.after', 'session.start', 'turn.stopping', 'tool.before', 'tool.after']),
    action: z.object({ type: z.enum(['inject', 'observe']) }),
    active: z.boolean(), reason: z.string().optional(),
    completedSteps: z.number().int().nonnegative(), nextDue: z.number().int().positive().optional(),
    semanticRevision: z.string().optional(), order: z.number().int().nonnegative(), resetPending: z.boolean(),
  })),
});

export type AgentHooksInspect = z.infer<typeof agentHooksInspectSchema>;
