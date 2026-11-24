import { z } from 'zod';

export const sessionModelEntrySchema = /* @__PURE__ */ z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider_id: z.string().min(1).optional(),
  capabilities: z.array(z.string()),
  supports_thinking: z.boolean(),
  thinking_efforts: z.array(z.string()),
  context_length: z.number().int().positive().optional(),
});
export type SessionModelEntry = z.infer<typeof sessionModelEntrySchema>;

export const sessionQuotaWindowSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1),
  label: z.string(),
  remaining_percent: z.number().min(0).max(100).nullable(),
  reset_at: z.string().nullable(),
});
export type SessionQuotaWindow = z.infer<typeof sessionQuotaWindowSchema>;

export const sessionQuotaSummarySchema = /* @__PURE__ */ z.object({
  provider_id: z.string().min(1),
  status: z.string().min(1),
  windows: z.array(sessionQuotaWindowSchema),
});
export type SessionQuotaSummary = z.infer<typeof sessionQuotaSummarySchema>;

export const sessionCurrentModelStateSchema = /* @__PURE__ */ z.object({
  model: z.string().nullable(),
  model_name: z.string().nullable(),
  thinking: z.boolean().nullable(),
  thinking_effort: z.string().nullable(),
  permission_mode: z.string().nullable(),
  plan_mode: z.boolean(),
});
export type SessionCurrentModelState = z.infer<typeof sessionCurrentModelStateSchema>;

export const sessionModelsResponseSchema = /* @__PURE__ */ z.object({
  executor_id: z.string().min(1),
  current: sessionCurrentModelStateSchema,
  models: z.array(sessionModelEntrySchema),
  quota_summary: sessionQuotaSummarySchema.nullable(),
});
export type SessionModelsResponse = z.infer<typeof sessionModelsResponseSchema>;
