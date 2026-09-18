/**
 *   GET  /v1/sessions/{session_id}/tasks                 query: {status?}
 *     Response data: `{ items: Task[] }`
 *
 *   GET  /v1/sessions/{session_id}/tasks/{task_id}       query: {with_output?, output_bytes?, agent_id?}
 *     Response data: `Task`
 *     Errors: 40401 (session/agent not found), 40406 (task.not_found)
 *
 *   POST /v1/sessions/{session_id}/tasks/{task_id}:cancel  query: {agent_id?}
 *     Body: empty
 *     Response data: `{ cancelled: true }`
 *     Errors: 40401 (session/agent not found), 40406 (task.not_found), 40904 (task.already_finished)
 *
 *   `agent_id` selects the owning agent's task service; omitted = main agent.
 */

import { z } from 'zod';

import { taskSchema, taskStatusSchema } from '../task';

export const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listTasksResponseSchema = z.object({
  items: z.array(taskSchema),
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
