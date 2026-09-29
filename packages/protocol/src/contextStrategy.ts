import { z } from 'zod';

export const contextStrategySchema = z.enum(['summarize', 'auto', 'fresh']);
export const contextStrategyStatusSchema = z.object({
  strategy: contextStrategySchema,
  source: z.enum(['session', 'profile', 'global', 'default', 'subagent', 'executor']),
  shadow: z.boolean(),
});
export const contextStrategyWriteSchema = z.object({
  strategy: contextStrategySchema.nullable(),
  save: z.enum(['global']).optional(),
});
export type ContextStrategyStatus = z.infer<typeof contextStrategyStatusSchema>;
