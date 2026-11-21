import { z } from 'zod';

import {
  cronRunResultSchema,
  cronScriptExecutionSchema,
  cronTriggerCheckSchema,
  cronTriggerSchema,
  cronTriggerScriptIdSchema,
} from '../cron';
import { cronDeliveryModeSchema } from '../events';

export const cronTaskSchema = /* @__PURE__ */ z.object({
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

export const cronTaskDetailSchema = /* @__PURE__ */ cronTaskSchema.extend({ prompt: z.string() });

export const cronTaskDetailResponseSchema = /* @__PURE__ */ z.object({ task: cronTaskDetailSchema });

export const cronScriptPreviewQuerySchema = /* @__PURE__ */ z.object({
  session_id: z.string().min(1),
  script: cronTriggerScriptIdSchema,
});
export const cronScriptPreviewResponseSchema = /* @__PURE__ */ z.object({
  execution: cronScriptExecutionSchema.nullable(),
});

export const createCronTaskRequestSchema = /* @__PURE__ */ z.object({
  session_id: z.string().min(1),
  cron: z.string().trim().min(1),
  prompt: z.string().refine((value) => value.trim().length > 0, 'prompt must not be blank'),
  recurring: z.boolean().optional(),
  delivery_mode: cronDeliveryModeSchema.optional(),
  trigger: cronTriggerSchema.optional(),
  script_confirmation: cronScriptExecutionSchema.optional(),
  paused: z.boolean().optional(),
}).strict();

export const updateCronTaskRequestSchema = /* @__PURE__ */ createCronTaskRequestSchema
  .omit({ paused: true })
  .partial()
  .extend({ trigger: cronTriggerSchema.nullish() })
  .refine((value) => Object.keys(value).length > 0, 'at least one editable field is required');

export const listCronTasksQuerySchema = /* @__PURE__ */ z.object({
  session_id: z.string().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const listCronTasksResponseSchema = /* @__PURE__ */ z.object({
  items: z.array(cronTaskSchema),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().optional(),
});

export const cronTaskActionQuerySchema = /* @__PURE__ */ z.object({
  session_id: z.string().min(1).optional(),
});

export const cronTaskActionResponseSchema = /* @__PURE__ */ z.object({
  task: cronTaskSchema,
});

export const deleteCronTaskResponseSchema = /* @__PURE__ */ z.object({
  deleted: z.literal(true),
});

export const runCronTaskResponseSchema = cronRunResultSchema;
