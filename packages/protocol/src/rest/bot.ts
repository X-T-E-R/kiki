import { z } from 'zod';
import { personaIdSchema } from './persona';

export const botSummarySchema = /* @__PURE__ */ z.object({
  personaId: personaIdSchema,
  name: z.string(),
  title: z.string().optional(),
  homeSessionId: z.string().optional(),
  pinned: z.boolean(),
  hidden: z.boolean(),
});
export type BotSummary = z.infer<typeof botSummarySchema>;

export const botStateSchema = /* @__PURE__ */ botSummarySchema.omit({ name: true, title: true });
export type BotState = z.infer<typeof botStateSchema>;
export const botUpdateInputSchema = /* @__PURE__ */ z.object({ pinned: z.boolean().optional(), hidden: z.boolean().optional() }).strict();
export type BotUpdateInput = z.infer<typeof botUpdateInputSchema>;
export const botIdParamsSchema = /* @__PURE__ */ z.object({ id: personaIdSchema });
export const listBotsResponseSchema = /* @__PURE__ */ z.array(botSummarySchema);
export type ListBotsResponse = z.infer<typeof listBotsResponseSchema>;
