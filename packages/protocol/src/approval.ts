import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const approvalDecisionSchema = z.enum(['approved', 'rejected', 'cancelled']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalScopeSchema = z.enum(['session']);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

export const approvalRequestSchema = z.object({
  approval_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  turn_id: z.number().int().nonnegative().optional(),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  action: z.string(),
  tool_input_display: z.unknown(),
  ssh: z.object({
    kind: z.enum(['login', 'host_key']),
    hostname: z.string(), user: z.string(), port: z.number(),
    proxyJump: z.string().optional(), proxyCommand: z.string().optional(),
    algorithm: z.string().optional(), fingerprint: z.string().optional(),
    prompts: z.array(z.object({ prompt: z.string(), echo: z.boolean() })).optional(),
  }).optional(),
  created_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema,
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalResponseSchema = z.object({
  decision: approvalDecisionSchema,
  scope: approvalScopeSchema.optional(),
  feedback: z.string().optional(),
  selected_label: z.string().optional(),
  selected_option_id: z.string().optional(),
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
