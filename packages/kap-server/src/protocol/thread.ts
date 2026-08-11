import { z } from 'zod';

export const threadRefSchema = z.object({
  host_id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  session_id: z.string().trim().min(1),
});
export type ThreadRef = z.infer<typeof threadRefSchema>;

export const threadSummarySchema = z.object({
  ref: threadRefSchema,
  title: z.string().optional(),
  updated_at: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  state: z.enum(['cold', 'idle', 'running']),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadTurnSchema = z.object({
  turn_id: z.number().int().nonnegative(),
  started_at: z.number().int().nonnegative().optional(),
  ended_at: z.number().int().nonnegative(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  origin: z.enum(['user', 'peer']),
  peer: z
    .object({
      source: threadRefSchema,
      message_id: z.string().min(1),
    })
    .optional(),
  input: z.string(),
  output: z.string(),
});
export type ThreadTurn = z.infer<typeof threadTurnSchema>;

export const threadActivitySchema = z.object({
  ref: threadRefSchema,
  seq: z.number().int().nonnegative(),
  kind: z.enum(['terminal', 'attention', 'lifecycle', 'message_undeliverable']),
  at: z.number().int().nonnegative(),
  reason: z.string(),
  turn_id: z.number().int().nonnegative().optional(),
  message_id: z.string().min(1).optional(),
});
export type ThreadActivity = z.infer<typeof threadActivitySchema>;
