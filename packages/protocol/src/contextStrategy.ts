import { z } from 'zod';

export const contextStrategySchema = /* @__PURE__ */ z.enum(['summarize', 'auto', 'fresh']);
export const contextStrategyStatusSchema = /* @__PURE__ */ z.object({
  strategy: contextStrategySchema,
  source: z.enum(['session', 'profile', 'model', 'global', 'default', 'subagent', 'executor']),
  shadow: z.boolean(),
});
export const contextStrategyWriteSchema = /* @__PURE__ */ z.object({
  strategy: contextStrategySchema.nullable(),
  save: z.enum(['global']).optional(),
});
export type ContextStrategyStatus = z.infer<typeof contextStrategyStatusSchema>;
