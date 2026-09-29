import { z } from 'zod';

export const executorPromptDeliverySchema = z.enum(['append', 'replace', 'preamble']);
export const executorPromptIncludeSchema = z.enum([
  'agents_md', 'memory_snapshot', 'skill_catalog', 'workspace_info',
  'system.*', 'delegation.*',
]).or(z.string().regex(/^(?:system|delegation)\.[a-z][a-z0-9_.-]*$/));

const executorPromptSectionSchema = z.object({
  delivery: executorPromptDeliverySchema.optional(),
  include: z.array(executorPromptIncludeSchema).default([]).readonly(),
  body: z.string().optional(),
  append: z.string().optional(),
}).strict();

export const executorPromptSchema = executorPromptSectionSchema.extend({
  per_engine: z.record(z.string().min(1), executorPromptSectionSchema.partial()).optional(),
}).strict();
export type ExecutorPrompt = z.infer<typeof executorPromptSchema>;
