import { z } from 'zod';
import { spacePresetIdSchema } from './space';

export const workPresetPreferenceSchema = /* @__PURE__ */ z.object({
  name: z.string().trim().min(1).max(80).optional(),
  default_task: z.enum(['office', 'writing', 'extract', 'tables']).optional(),
}).strict();
export const workPresetPluginSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string(),
  required: z.boolean(),
  installed: z.boolean(),
  enabled: z.boolean(),
  available: z.boolean(),
  prerequisite: z.string().optional(),
});
export const workPresetItemSchema = /* @__PURE__ */ z.object({
  id: spacePresetIdSchema,
  name: z.string().min(1),
  description: z.string(),
  enabled: z.boolean(),
  removed: z.boolean(),
  preferences: workPresetPreferenceSchema,
  plugins: z.array(workPresetPluginSchema),
});
export const workPresetsResponseSchema = /* @__PURE__ */ z.object({
  home_id: z.string().min(1),
  items: z.array(workPresetItemSchema),
});
export const workPresetParamsSchema = /* @__PURE__ */ z.object({ id: spacePresetIdSchema });
export const enableWorkPresetRequestSchema = /* @__PURE__ */ z.object({ consent: z.literal(true), install_prerequisites: z.boolean().default(false) }).strict();
export const updateWorkPresetRequestSchema = /* @__PURE__ */ z.object({ enabled: z.boolean().optional(), preferences: workPresetPreferenceSchema.optional() }).strict();
export const workPresetMutationResponseSchema = /* @__PURE__ */ z.object({
  preset: workPresetItemSchema,
  completed: z.array(z.string()),
  failures: z.array(z.object({ plugin_id: z.string(), message: z.string() })),
});
export type WorkPresetPreference = z.infer<typeof workPresetPreferenceSchema>;
export type WorkPresetItem = z.infer<typeof workPresetItemSchema>;
export type WorkPresetsResponse = z.infer<typeof workPresetsResponseSchema>;
export type WorkPresetMutationResponse = z.infer<typeof workPresetMutationResponseSchema>;
