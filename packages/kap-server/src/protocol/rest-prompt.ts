import { z } from 'zod';

import { isoDateTimeSchema } from '@kiki/agent-core-v2/_base/utils/isoDateTime';
import { messageContentSchema } from './message';
import {
  promptPermissionModeSchema,
  promptPlanGateSchema,
  promptThinkingSchema,
} from '@kiki/agent-core-v2/app/sessionLegacy/sessionProtocol';

export { promptPermissionModeSchema, promptPlanGateSchema, promptThinkingSchema };
export type {
  PromptPermissionMode,
  PromptPlanGate,
  PromptThinking,
} from '@kiki/agent-core-v2/app/sessionLegacy/sessionProtocol';

export const promptSkillActivationSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
});
export type PromptSkillActivation = z.infer<typeof promptSkillActivationSchema>;

export const deferredAppendTimingSchema = z.enum(['agent_idle', 'subagents_done', 'tasks_done']);
export type DeferredAppendTiming = z.infer<typeof deferredAppendTimingSchema>;

export const goalFollowUpTimingSchema = z.enum(['subagents_done', 'tasks_done']);
export type GoalFollowUpTiming = z.infer<typeof goalFollowUpTimingSchema>;

export const goalInitialStatusSchema = z.enum(['active', 'paused']);
export type GoalInitialStatus = z.infer<typeof goalInitialStatusSchema>;

export const promptSubmissionSchema = z.object({
  content: z.array(messageContentSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  agent_id: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: promptThinkingSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_gate: promptPlanGateSchema.optional(),
  plan_mode: z.boolean().optional(),
  swarm_mode: z.boolean().optional(),
  goal_objective: z.string().optional(),
  goal_control: z.enum(['pause', 'resume', 'cancel']).optional(),
  goal_follow_up_timing: goalFollowUpTimingSchema.optional(),
  goal_initial_status: goalInitialStatusSchema.optional(),
  append_timing: deferredAppendTimingSchema.optional(),
  disabled_tools: z.array(z.string()).optional(),
  prompt_id: z.string().min(1).optional(),
  skills: z.array(promptSkillActivationSchema).min(1).optional(),
});
export type PromptSubmission = z.infer<typeof promptSubmissionSchema>;

export const promptExecutionOverridesSchema = promptSubmissionSchema.pick({
  profile: true,
  model: true,
  thinking: true,
  permission_mode: true,
  plan_gate: true,
  plan_mode: true,
  swarm_mode: true,
  disabled_tools: true,
});
export type PromptExecutionOverrides = z.infer<typeof promptExecutionOverridesSchema>;

export const promptStatusSchema = z.enum(['running', 'queued', 'blocked']);
export type PromptStatus = z.infer<typeof promptStatusSchema>;

export const promptItemSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  status: promptStatusSchema,
  content: z.array(messageContentSchema).min(1),
  created_at: isoDateTimeSchema,
  append_timing: deferredAppendTimingSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
});
export type PromptItem = z.infer<typeof promptItemSchema>;

export const promptListResponseSchema = z.object({
  active: promptItemSchema.nullable(),
  queued: z.array(promptItemSchema),
});
export type PromptListResponse = z.infer<typeof promptListResponseSchema>;

export const promptSubmitResultSchema = promptItemSchema;
export type PromptSubmitResult = z.infer<typeof promptSubmitResultSchema>;

export const promptReplaceRequestSchema = z.object({
  content: z.array(messageContentSchema).min(1),
  replace_attachments: z.boolean().optional(),
});
export type PromptReplaceRequest = z.infer<typeof promptReplaceRequestSchema>;

export const promptReplaceResultSchema = promptItemSchema;
export type PromptReplaceResult = z.infer<typeof promptReplaceResultSchema>;

export const promptTimingRequestSchema = z.object({
  append_timing: deferredAppendTimingSchema,
  expected_revision: z.number().int().nonnegative().optional(),
});
export type PromptTimingRequest = z.infer<typeof promptTimingRequestSchema>;

export const promptTimingResultSchema = promptItemSchema;
export type PromptTimingResult = z.infer<typeof promptTimingResultSchema>;

export const promptMoveRequestSchema = z.object({
  target_index: z.number().int().nonnegative(),
});
export type PromptMoveRequest = z.infer<typeof promptMoveRequestSchema>;

export const promptMoveResultSchema = z.object({
  moved: z.literal(true),
  prompt_id: z.string().min(1),
  target_index: z.number().int().nonnegative(),
  queued_prompt_ids: z.array(z.string().min(1)),
});
export type PromptMoveResult = z.infer<typeof promptMoveResultSchema>;

export const promptSteerRequestSchema = z.object({
  prompt_ids: z.array(z.string().min(1)).min(1),
});
export type PromptSteerRequest = z.infer<typeof promptSteerRequestSchema>;

export const promptSteerResultSchema = z.object({
  steered: z.literal(true),
  prompt_ids: z.array(z.string().min(1)).min(1),
});
export type PromptSteerResult = z.infer<typeof promptSteerResultSchema>;

export const promptAbortResponseSchema = z.object({
  aborted: z.boolean(),
  at_seq: z.number().int().nonnegative().optional(),
});
export type PromptAbortResponse = z.infer<typeof promptAbortResponseSchema>;
