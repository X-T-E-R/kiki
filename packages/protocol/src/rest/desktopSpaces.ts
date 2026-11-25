import { z } from 'zod';
import { SPACE_COLOR_PATTERN, spaceNameSchema, spacePresetIdSchema } from './space';

export const desktopSpaceHomeIdSchema = /* @__PURE__ */ z.string().min(1).max(128).regex(/^[^\u0000-\u001F\u007F]+$/);

export const desktopLocalSpaceSummarySchema = /* @__PURE__ */ z.object({
  home_id: desktopSpaceHomeIdSchema,
  name: spaceNameSchema,
  path: z.string().min(1).max(4096),
  color: z.string().regex(SPACE_COLOR_PATTERN).optional(),
  preset: spacePresetIdSchema.optional(),
  is_primary: z.boolean(),
  registered: z.boolean(),
  running: z.boolean(),
  pid: z.number().int().positive().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  desktop_managed: z.boolean().optional(),
}).strict();
export type DesktopLocalSpaceSummary = z.infer<typeof desktopLocalSpaceSummarySchema>;

export const desktopSpaceStatusSchema = /* @__PURE__ */ z.object({
  home_id: desktopSpaceHomeIdSchema,
  state: z.enum(['hot', 'active', 'pending', 'busy', 'offline']),
  busy_sessions: z.number().int().nonnegative(),
  needs_you_sessions: z.number().int().nonnegative(),
  heartbeat_fresh: z.boolean(),
  server_id: z.string().min(1).max(128).optional(),
  needs_you_session_ids: z.array(z.string().min(1)).optional(),
  as_of: z.number().int().nonnegative(),
}).strict();
export type DesktopSpaceStatus = z.infer<typeof desktopSpaceStatusSchema>;

export const desktopSpacesResponseSchema = /* @__PURE__ */ z.object({
  spaces: z.array(desktopLocalSpaceSummarySchema),
  statuses: z.array(desktopSpaceStatusSchema),
});
export type DesktopSpacesResponse = z.infer<typeof desktopSpacesResponseSchema>;
