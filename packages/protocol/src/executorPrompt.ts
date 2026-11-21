import { z } from 'zod';

export const executorPromptDeliverySchema = /* @__PURE__ */ z.enum(['append', 'replace', 'preamble']);
export const executorPromptIncludeSchema = /* @__PURE__ */ z.enum([
  'agents_md', 'memory_snapshot', 'skill_catalog', 'workspace_info',
  'system.*', 'delegation.*',
]).or(z.string().regex(/^(?:system|delegation)\.[a-z][a-z0-9_.-]*$/));

const executorPromptSectionSchema = /* @__PURE__ */ z.object({
  delivery: executorPromptDeliverySchema.optional(),
  include: z.array(executorPromptIncludeSchema).readonly().optional(),
  body: z.string().optional(),
  append: z.string().optional(),
}).strict();

export const executorPromptSchema = /* @__PURE__ */ executorPromptSectionSchema.extend({
  per_engine: z.record(z.string().min(1), executorPromptSectionSchema.partial()).optional(),
}).strict();
export type ExecutorPrompt = z.infer<typeof executorPromptSchema>;
