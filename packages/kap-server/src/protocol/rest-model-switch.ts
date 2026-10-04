import { z } from 'zod';

export const modelSwitchModeSchema = z.enum(['direct', 'compact', 'fresh']);
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
export const modelSwitchActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update'), input: modelSwitchInputSchema.omit({ operationId: true }), expectedRevision: z.number().int().nonnegative().optional() }),
  z.object({ action: z.literal('retry'), mode: modelSwitchModeSchema.optional() }),
  z.object({ action: z.literal('keep_original'), mode: z.undefined().optional() }),
  z.object({ action: z.literal('cancel'), mode: z.undefined().optional() }),
  z.object({ action: z.literal('move'), targetIndex: z.number().int().nonnegative() }),
  z.object({ action: z.literal('hold'), held: z.boolean() }),
]);
