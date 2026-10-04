import { z } from 'zod';

export const modelSwitchModeSchema = z.enum(['direct', 'compact', 'fresh']);
export type ModelSwitchMode = z.infer<typeof modelSwitchModeSchema>;
export const modelSwitchInputSchema = z.object({
  operationId: z.string().min(1), model: z.string().min(1), mode: modelSwitchModeSchema,
  thinking: z.string().optional(), selectedFromModel: z.string().optional(),
});
export const modelSwitchReceiptSchema = z.object({
  operationId: z.string(), agentId: z.string(), state: z.enum(['pending', 'preparing', 'completed', 'failed', 'cancelled']),
  fromModel: z.string(), toModel: z.string(), mode: modelSwitchModeSchema,
  binding: z.object({ model: z.string(), thinking: z.string() }).optional(),
  windowEpoch: z.number().int().nonnegative().optional(), summaryGenerated: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const queuedModelSwitchSchema = z.object({
  input: modelSwitchInputSchema, receipt: modelSwitchReceiptSchema, revision: z.number().int().nonnegative(),
  originalBinding: z.object({ model: z.string(), thinking: z.string() }), queueIndex: z.number().int(),
});

export const modelSwitchQueuedEventSchema = z.object({
  type: z.literal('prompt.model_switch_queued'), time: z.number().optional(),
  entry: queuedModelSwitchSchema.omit({ queueIndex: true }), queueIndex: z.number().int().nonnegative(),
});
export const modelSwitchStatusEventSchema = z.object({
  type: z.literal('prompt.model_switch_status'), time: z.number().optional(),
  operationId: z.string(), receipt: modelSwitchReceiptSchema,
});
