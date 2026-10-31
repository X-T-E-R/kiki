import { z } from 'zod';

const draft = {
  profile: z.string().trim().min(1),
};

export const agentReferenceCandidatesQuerySchema = z.union([
  z.object({ session_id: z.string().trim().min(1), agent_id: z.string().trim().min(1) }).strict(),
  z.object({ workspace_id: z.string().trim().min(1), ...draft }).strict(),
  z.object({ cwd: z.string().trim().min(1).refine(value => /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value), 'cwd must be absolute'), ...draft }).strict(),
]);
export type AgentReferenceCandidatesQuery = z.infer<typeof agentReferenceCandidatesQuerySchema>;

export const agentReferenceCandidateSchema = z.object({
  profile: z.string().min(1),
  label: z.string().min(1),
  executor: z.string().min(1),
  engine_label: z.string().min(1),
  reference: z.string().min(1),
  configuration: z.enum(['native', 'profile']),
  group: z.enum(['native', 'profile', 'main']),
  defaults_available: z.boolean(),
  available: z.boolean(),
  unavailable_reason: z.string().optional(),
  unavailable_reason_code: z.string().optional(),
  description: z.string().optional(),
});
export type AgentReferenceCandidate = z.infer<typeof agentReferenceCandidateSchema>;

export const agentReferenceCandidatesResponseSchema = z.object({
  items: z.array(agentReferenceCandidateSchema),
  delegation_available: z.boolean(),
  unavailable_reason: z.string().optional(),
});
export type AgentReferenceCandidatesResponse = z.infer<typeof agentReferenceCandidatesResponseSchema>;
