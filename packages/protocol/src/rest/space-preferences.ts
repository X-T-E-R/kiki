import { z } from 'zod';
import { backgroundLookSchema } from '../appearance';

export const spacePreferenceValuesSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  skin: z.object({ source: z.enum(['builtin', 'user', 'pack']), id: z.string().min(1) }).strict(),
  tweaks: z.object({ accent: z.string().optional(), fontSans: z.string().optional(), fontMono: z.string().optional(), fontProse: z.string().optional(), radius: z.number().min(0).max(24).optional(), spacing: z.number().min(0.5).max(2).optional() }).strict(),
  background: z.object({
    light: z.lazy(() => portableBackgroundSlotSchema).nullable(),
    dark: z.lazy(() => portableBackgroundSlotSchema).nullable(),
    linked: z.boolean(), assist: z.boolean(),
  }).strict(),
  proseFont: z.enum(['serif', 'sans']),
  defaultAppendTiming: z.enum(['agent_idle', 'subagents_done', 'tasks_done']),
  foldSteps: z.boolean(),
  worktreeSkipConfirm: z.boolean(),
}).strict();
const portableMediaSchema = z.object({ id: z.string().regex(/^pack:[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/), kind: z.enum(['image', 'video']), mime: z.string(), name: z.string(), bytes: z.number().min(0) }).strict();
export const portableBackgroundSlotSchema = z.object({
  media: z.array(portableMediaSchema).max(32), poster: portableMediaSchema.optional(),
  interval: z.number().min(0).max(3600), look: backgroundLookSchema,
  packId: z.string().optional(), sample: z.object({ dark: z.number(), light: z.number() }).optional(),
}).strict();
export type SpacePreferenceValues = z.infer<typeof spacePreferenceValuesSchema>;
export const DEFAULT_SPACE_PREFERENCES: SpacePreferenceValues = {
  theme: 'system', skin: { source: 'builtin', id: 'paper' }, tweaks: {},
  background: { light: null, dark: null, linked: true, assist: true },
  proseFont: 'serif', defaultAppendTiming: 'agent_idle', foldSteps: true, worktreeSkipConfirm: false,
};
export const spaceDomainSchema = z.enum(['config', 'agents', 'instructions', 'skills', 'mcp', 'appearance', 'plugins', 'credentials', 'generic_roots']);
export type SpaceDomain = z.infer<typeof spaceDomainSchema>;
export const spaceModeSchema = z.enum(['follow', 'fixed']);
export const spaceSelectionSchema = z.object({
  mode: spaceModeSchema, reason: z.enum(['edited', 'frozen', 'migrated']).optional(),
  excluded: z.boolean().optional(), baseline: z.unknown().optional(), baseline_revision: z.string().optional(),
}).strict();
export const spaceItemSchema = z.object({
  id: z.string(), name: z.string(), domain: spaceDomainSchema, kind: z.enum(['preference', 'config', 'resource', 'source']),
  selection: spaceSelectionSchema,
  stored: z.unknown().nullable(), effective: z.unknown().nullable(), main: z.unknown().nullable(), actual: z.unknown().nullable(),
  origin: z.enum(['main', 'home', 'builtin', 'preset', 'project', 'environment', 'shared', 'isolated', 'unavailable']),
  available: z.boolean(), pending: z.boolean(), activation: z.enum(['immediate', 'reload', 'restart']),
  revision: z.string(), main_revision: z.string(), dependencies: z.array(z.string()),
  can_push: z.boolean(), blocked_reason: z.string().optional(),
});
export type SpaceItem = z.infer<typeof spaceItemSchema>;
export const spaceDetailSchema = z.object({
  schema: z.literal(2), id: z.string(), name: z.string(), primary: z.boolean(), revision: z.string(),
  inherit: z.object({ config: z.boolean(), agents: z.boolean(), instructions: z.union([z.boolean(), z.literal('stack')]), skills: z.boolean(), mcp: z.boolean(), appearance: z.boolean(), plugins: z.boolean(), credentials: z.enum(['shared', 'isolated']), generic_roots: z.boolean() }),
  groups: z.array(z.object({ domain: spaceDomainSchema, mode: spaceModeSchema, fixed_count: z.number(), follow_count: z.number() })),
  items: z.array(spaceItemSchema), preferences: spacePreferenceValuesSchema,
  preference_authority: z.boolean(), undo_id: z.string().optional(), restart_required: z.boolean(),
});
export type SpaceDetail = z.infer<typeof spaceDetailSchema>;
export const spacePlanRequestSchema = z.object({
  action: z.enum(['follow', 'fixed', 'push-to-main', 'edit', 'exclude']),
  items: z.array(z.string().min(1)).max(512).optional(),
  groups: z.array(spaceDomainSchema).optional(),
  changes: z.array(z.object({ id: z.string().min(1), value: z.unknown() }).strict()).max(512).optional(),
}).strict();
export type SpacePlanRequest = z.infer<typeof spacePlanRequestSchema>;
export const spacePreviewRowSchema = z.object({
  id: z.string(), name: z.string(), domain: spaceDomainSchema,
  before: z.unknown().nullable(), after: z.unknown().nullable(),
  selected: z.boolean(), same_value: z.boolean(), main_changed: z.boolean(), conflict: z.boolean(),
  dependencies: z.array(z.string()), blocked_reason: z.string().optional(),
});
export const spacePreviewSchema = z.object({
  schema: z.literal(2), token: z.string(), action: spacePlanRequestSchema.shape.action,
  rows: z.array(spacePreviewRowSchema), revision: z.string(), main_revision: z.string(),
  restart_required: z.boolean(), expires_at: z.string(),
});
export type SpacePreview = z.infer<typeof spacePreviewSchema>;
export const spaceApplyRequestSchema = z.object({ token: z.string().min(1), selected: z.array(z.string()).max(512) }).strict();
export type SpaceApplyRequest = z.infer<typeof spaceApplyRequestSchema>;
export const spaceMutationResponseSchema = z.object({ detail: spaceDetailSchema, applied: z.array(z.string()), undo_id: z.string().optional() });
export type SpaceMutationResponse = z.infer<typeof spaceMutationResponseSchema>;
export const spacePreferencePatchSchema = spacePreferenceValuesSchema.partial();
export const spacePreferenceImportSchema = z.object({ values: spacePreferencePatchSchema, device_id: z.string().min(1).max(128) }).strict();
export type SpacePreferenceImport = z.infer<typeof spacePreferenceImportSchema>;
export const spacePreferenceImportResponseSchema = z.object({ detail: spaceDetailSchema, imported: z.boolean(), device_conflict: z.boolean() });
export type SpacePreferenceImportResponse = z.infer<typeof spacePreferenceImportResponseSchema>;
export const spaceUndoRequestSchema = z.object({ undo_id: z.string().min(1) }).strict();
export const spaceDetailParamsSchema = z.object({ id: z.union([z.literal('main'), z.string().regex(/^h-[a-z0-9-]+$/)]) });
