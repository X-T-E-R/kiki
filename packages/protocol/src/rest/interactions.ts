import { z } from 'zod';
import { messageContentSchema } from '../message';
import { isoDateTimeSchema } from '../time';

export const pendingUserToolSchema = /* @__PURE__ */ z.object({
  interaction_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  turn_id: z.number().int().nonnegative().optional(),
  tool_call_id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
  created_at: isoDateTimeSchema,
});
export type PendingUserTool = z.infer<typeof pendingUserToolSchema>;

export const interactionRespondRequestSchema = /* @__PURE__ */ z.union([
  z.object({
    result: z.union([z.string(), z.array(messageContentSchema)]),
    is_error: z.boolean().optional(),
  }).strict(),
  z.object({
    error: z.string(),
  }).strict(),
]);
export type InteractionRespondRequest = z.infer<typeof interactionRespondRequestSchema>;

export const interactionRespondResultSchema = /* @__PURE__ */ z.object({
  resolved: z.literal(true),
  interaction_id: z.string().min(1),
  resolved_at: isoDateTimeSchema,
});
export type InteractionRespondResult = z.infer<typeof interactionRespondResultSchema>;
