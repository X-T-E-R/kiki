import { z } from 'zod';

import { taskSchema, taskStatusSchema } from './task';

export const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listTasksResponseSchema = z.object({
  items: z.array(taskSchema),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().optional(),
});
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

export const getTaskQuerySchema = z.object({
  with_output: z.coerce.boolean().optional(),
  output_bytes: z.coerce.number().int().nonnegative().optional(),
  agent_id: z.string().min(1).optional(),
});
export type GetTaskQuery = z.infer<typeof getTaskQuerySchema>;

export const getTaskResponseSchema = taskSchema;
export type GetTaskResponse = z.infer<typeof getTaskResponseSchema>;

export const cancelTaskQuerySchema = z.object({
  agent_id: z.string().min(1).optional(),
});
export type CancelTaskQuery = z.infer<typeof cancelTaskQuerySchema>;

export const cancelTaskResultSchema = z.object({
  cancelled: z.literal(true),
});
export type CancelTaskResult = z.infer<typeof cancelTaskResultSchema>;

export const taskAlreadyFinishedDataSchema = z.object({
  cancelled: z.literal(false),
});
export type TaskAlreadyFinishedData = z.infer<typeof taskAlreadyFinishedDataSchema>;
