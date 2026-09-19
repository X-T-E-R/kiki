import { z } from 'zod';

export const cronTaskSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable(),
  workspace_id: z.string(),
  cron: z.string(),
  human_schedule: z.string(),
  prompt_preview: z.string(),
  next_fire_at: z.string().nullable(),
  recurring: z.boolean(),
  paused: z.boolean(),
  age_days: z.number(),
  stale: z.boolean(),
  created_at: z.string(),
  last_fired_at: z.string().nullable(),
});

export const listCronTasksQuerySchema = z.object({
  session_id: z.string().min(1).optional(),
});

export const listCronTasksResponseSchema = z.object({
  items: z.array(cronTaskSchema),
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

export const runCronTaskResponseSchema = z.object({
  triggered: z.literal(true),
});
