import { z } from 'zod';

import { fileContentSchema, imageContentSchema, videoContentSchema } from './message';
import { skillDescriptorSchema } from './skill';

export const listSkillsResponseSchema = z.object({
  skills: z.array(skillDescriptorSchema),
});
export type ListSkillsResponse = z.infer<typeof listSkillsResponseSchema>;

export const builtinSkillContentResponseSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
});
export type BuiltinSkillContentResponse = z.infer<typeof builtinSkillContentResponseSchema>;

/**
 * Attachment parts accepted on skill activation — the media/file subset of
 * the prompt submission's `MessageContent` (text stays in `args`).
 */
export const activateSkillAttachmentSchema = z.discriminatedUnion('type', [
  imageContentSchema,
  videoContentSchema,
  fileContentSchema,
]);
export type ActivateSkillAttachment = z.infer<typeof activateSkillAttachmentSchema>;

export const activateSkillRequestSchema = z.object({
  prompt_id: z.string().min(1).optional(),
  args: z.string().optional(),
  user_input: z.string().optional(),
  attachments: z.array(activateSkillAttachmentSchema).optional(),
});
export type ActivateSkillRequest = z.infer<typeof activateSkillRequestSchema>;

export const activateSkillResultSchema = z.object({
  activated: z.literal(true),
  skill_name: z.string().min(1),
  prompt_id: z.string().min(1).optional(),
  status: z.enum(['running', 'queued', 'blocked']).optional(),
  created_at: z.string().optional(),
  append_timing: z.enum(['agent_idle', 'subagents_done', 'tasks_done']).optional(),
  revision: z.number().int().nonnegative().optional(),
});
export type ActivateSkillResult = z.infer<typeof activateSkillResultSchema>;
