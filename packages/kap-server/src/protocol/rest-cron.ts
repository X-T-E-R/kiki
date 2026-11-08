import { z } from 'zod';
import { cronDeliveryModeSchema, cronRunResultSchema, cronScriptExecutionSchema, cronTriggerCheckSchema, cronTriggerSchema, cronTriggerScriptIdSchema } from '@kiki/protocol';

export const cronTaskSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable(),
  workspace_id: z.string(),
  cron: z.string(),
  human_schedule: z.string(),
  prompt_preview: z.string(),
  next_fire_at: z.string().nullable(),
  recurring: z.boolean(),
  delivery_mode: cronDeliveryModeSchema,
  paused: z.boolean(),
  age_days: z.number(),
  stale: z.boolean(),
  created_at: z.string(),
  last_fired_at: z.string().nullable(),
  trigger: cronTriggerSchema.optional(),
  approved_script: cronScriptExecutionSchema.optional(),
  last_trigger_check: cronTriggerCheckSchema.optional(),
});

export const cronTaskDetailSchema = cronTaskSchema.extend({ prompt: z.string() });

export const cronTaskDetailResponseSchema = z.object({ task: cronTaskDetailSchema });

export const cronScriptPreviewQuerySchema = z.object({ session_id: z.string().min(1), script: cronTriggerScriptIdSchema });
export const cronScriptPreviewResponseSchema = z.object({ execution: cronScriptExecutionSchema.nullable() });

export const createCronTaskRequestSchema = z.object({
  session_id: z.string().min(1),
  cron: z.string().trim().min(1),
  prompt: z.string().refine((value) => value.trim().length > 0, 'prompt must not be blank'),
  recurring: z.boolean().optional(),
  delivery_mode: cronDeliveryModeSchema.optional(),
  trigger: cronTriggerSchema.optional(),
  script_confirmation: cronScriptExecutionSchema.optional(),
  paused: z.boolean().optional(),
}).strict();

export const updateCronTaskRequestSchema = createCronTaskRequestSchema
  .omit({ paused: true })
  .partial()
  .extend({ trigger: cronTriggerSchema.nullish() })
  .refine((value) => Object.keys(value).length > 0, 'at least one editable field is required');

export const listCronTasksQuerySchema = z.object({
  session_id: z.string().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const listCronTasksResponseSchema = z.object({
  items: z.array(cronTaskSchema),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().optional(),
});

export const cronTaskActionQuerySchema = z.object({
  session_id: z.string().min(1).optional(),
});

export const cronTaskActionResponseSchema = z.object({
  task: cronTaskSchema,
});

export const deleteCronTaskResponseSchema = z.object({
  deleted: z.literal(true),
});

export const runCronTaskResponseSchema = cronRunResultSchema;
