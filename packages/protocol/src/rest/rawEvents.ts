import { z } from 'zod';
import { isoDateTimeSchema } from '../time';

export const rawEventStreamGradeSchema = /* @__PURE__ */ z.enum(['turn', 'delta']);
export type RawEventStreamGrade = z.infer<typeof rawEventStreamGradeSchema>;

export const rawSessionEventsQuerySchema = /* @__PURE__ */ z.object({
  after: z.string().min(1).optional(),
  grade: rawEventStreamGradeSchema.default('delta'),
});
export type RawSessionEventsQuery = z.infer<typeof rawSessionEventsQuerySchema>;

export const rawGlobalEventsQuerySchema = /* @__PURE__ */ z.object({
  after: z.string().min(1).optional(),
});
export type RawGlobalEventsQuery = z.infer<typeof rawGlobalEventsQuerySchema>;

export const rawEventResetFrameSchema = /* @__PURE__ */ z.object({
  type: z.literal('reset'),
  session_id: z.string().min(1).optional(),
  epoch: z.string(),
  latest_seq: z.number().int().nonnegative(),
  reason: z.string().min(1).optional(),
});
export type RawEventResetFrame = z.infer<typeof rawEventResetFrameSchema>;

export const rawToolRequiresActionFrameSchema = /* @__PURE__ */ z.object({
  type: z.literal('tool.requires_action'),
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  interaction_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  turn_id: z.number().int().nonnegative().optional(),
  name: z.string().min(1),
  args: z.unknown(),
  timestamp: isoDateTimeSchema,
});
export type RawToolRequiresActionFrame = z.infer<typeof rawToolRequiresActionFrameSchema>;

export const rawContextUndoFrameSchema = /* @__PURE__ */ z.object({
  type: z.literal('context.undo'),
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  turns: z.number().int().positive(),
  cut_to_turn_id: z.number().int().nonnegative().optional(),
  from_turn_id: z.number().int().nonnegative().optional(),
  removed_turn_ids: z.array(z.number().int().nonnegative()),
  timestamp: isoDateTimeSchema,
});
export type RawContextUndoFrame = z.infer<typeof rawContextUndoFrameSchema>;

export const rawEventFrameSchema = /* @__PURE__ */ z.object({
  type: z.string().min(1),
  epoch: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  session_id: z.string().min(1).optional(),
  timestamp: isoDateTimeSchema.optional(),
  volatile: z.boolean().optional(),
  payload: z.unknown().optional(),
}).passthrough();
export type RawEventFrame = z.infer<typeof rawEventFrameSchema>;
