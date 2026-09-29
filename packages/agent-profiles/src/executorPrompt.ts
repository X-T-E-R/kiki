import { z } from 'zod';

export const executorPromptDeliverySchema = z.enum(['append', 'replace', 'preamble']);
export const executorPromptIncludeSchema = z.enum([
  'agents_md', 'memory_snapshot', 'skill_catalog', 'workspace_info',
  'system.*', 'delegation.*',
]).or(z.string().regex(/^(?:system|delegation)\.[a-z][a-z0-9_.-]*$/));

const sectionSchema = z.object({
  delivery: executorPromptDeliverySchema.optional(),
  include: z.array(executorPromptIncludeSchema).default([]).readonly(),
  body: z.string().optional(),
  append: z.string().optional(),
}).strict();

export const executorPromptSchema = sectionSchema.extend({
  per_engine: z.record(z.string().min(1), sectionSchema.partial()).optional(),
}).strict();

export type ExecutorPrompt = z.infer<typeof executorPromptSchema>;

export function resolveExecutorPrompt(config: ExecutorPrompt | undefined, id: string): {
  readonly delivery: z.infer<typeof executorPromptDeliverySchema>;
  readonly include: readonly string[];
  readonly body?: string;
  readonly append?: string;
} {
  const section = config?.per_engine?.[id];
  return {
    delivery: section?.delivery ?? config?.delivery ?? 'append',
    include: section?.include ?? config?.include ?? [],
    body: section?.body ?? config?.body,
    append: section?.append ?? config?.append,
  };
}
