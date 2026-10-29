import { z } from 'zod';

export const decisionProtocolSchema = z.enum(['system_one', 'pair_score']);
export type DecisionProtocol = z.infer<typeof decisionProtocolSchema>;
export function decisionProtocolForProviderType(type: string | undefined): DecisionProtocol | undefined {
  return type === 'system_one' || type === 'pair_score' ? type : undefined;
}
export const decisionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connection'), connection: z.string().trim().min(1), model: z.string().trim().min(1).optional() }).strict(),
  z.object({ kind: z.literal('model'), model: z.string().trim().min(1) }).strict(),
]);
export type DecisionSource = z.infer<typeof decisionSourceSchema>;
export const decisionSourceStatusSchema = z.object({
  state: z.enum(['ready', 'unconfigured', 'auth', 'protocol', 'capability_mismatch']),
  connection: z.string().optional(),
  model: z.string().optional(),
  protocol: z.enum(['chat_json', 'system_one', 'pair_score']).optional(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  credential_source: z.enum(['provider', 'env', 'oauth', 'headers', 'model', 'none']).optional(),
  credential_env: z.string().optional(),
}).strict();
export type DecisionSourceStatus = z.infer<typeof decisionSourceStatusSchema>;
export const decisionConnectionProbeInputSchema = z.object({
  source: decisionSourceSchema,
  confirm_destination: z.string().min(1),
}).strict();
export const decisionConnectionProbeResultSchema = z.object({
  ok: z.boolean(),
  status: decisionSourceStatusSchema,
  duration_ms: z.number().nonnegative(),
  reason: z.enum(['unconfigured', 'auth', 'protocol', 'invalid_output', 'timeout', 'aborted', 'rate_limited', 'unavailable', 'consent_required']).optional(),
}).strict();
export type DecisionConnectionProbeInput = z.infer<typeof decisionConnectionProbeInputSchema>;
export type DecisionConnectionProbeResult = z.infer<typeof decisionConnectionProbeResultSchema>;
export const moveReviewerKeyInputSchema = z.object({ connection: z.string().min(1) }).strict();
export const moveReviewerKeyResultSchema = z.object({
  connection: z.string().min(1),
  state: z.enum(['complete', 'connection_saved', 'source_switched']),
  retryable: z.boolean(),
}).strict();
export type MoveReviewerKeyInput = z.infer<typeof moveReviewerKeyInputSchema>;
export type MoveReviewerKeyResult = z.infer<typeof moveReviewerKeyResultSchema>;
