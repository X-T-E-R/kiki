import { z } from 'zod';
import { desktopSpaceHomeIdSchema } from './desktopSpaces';

export const pluginFocusIntentSchema = /* @__PURE__ */ z.object({
  homeId: desktopSpaceHomeIdSchema,
  route: z.string().min(1).max(512).regex(/^\/s\/[^/?#]+$/),
  requestId: z.number().int().positive(),
}).strict();
export type PluginFocusIntent = z.infer<typeof pluginFocusIntentSchema>;

export const desktopPluginFocusQuerySchema = /* @__PURE__ */ z.object({
  home_id: desktopSpaceHomeIdSchema.optional(),
});

export const desktopPluginFocusResponseSchema = /* @__PURE__ */ z.object({
  focus: pluginFocusIntentSchema.nullable(),
});
export type DesktopPluginFocusResponse = z.infer<typeof desktopPluginFocusResponseSchema>;

export const desktopPluginFocusAckSchema = /* @__PURE__ */ z.object({
  home_id: desktopSpaceHomeIdSchema,
  request_id: z.number().int().positive(),
}).strict();
export type DesktopPluginFocusAckInput = z.infer<typeof desktopPluginFocusAckSchema>;

export const desktopPluginFocusAckResponseSchema = /* @__PURE__ */ z.object({
  cleared: z.boolean(),
});

export const desktopPluginFocusRememberSchema = /* @__PURE__ */ z.object({
  home_id: desktopSpaceHomeIdSchema,
  request_id: z.number().int().positive(),
}).strict();
export type DesktopPluginFocusRememberInput = z.infer<typeof desktopPluginFocusRememberSchema>;

export const desktopPluginFocusRememberResponseSchema = /* @__PURE__ */ z.object({
  remembered: z.literal(true),
});
