import { z } from 'zod';

/** Localized display text map keyed by locale tag (`en`, `zh`, etc.). */
export const pluginLocalizedTextSchema = z.object({
  default: z.string().min(1).max(240),
  zh: z.string().min(1).max(240).optional(),
  en: z.string().min(1).max(240).optional(),
}).strict();
export type PluginLocalizedText = z.infer<typeof pluginLocalizedTextSchema>;

/** Declarative action executed when a user interacts with a plugin GUI slot item. */
export const pluginSlotActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('insert_prompt'),
    text: z.string().min(1).max(16_384),
    submit: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('invoke_plugin_route'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    subpath: z.string().regex(/^\/[a-zA-Z0-9/_-]{1,120}$/),
    body: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    kind: z.literal('open_plugin_panel'),
    panelId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  }).strict(),
  z.object({
    kind: z.literal('open_settings_section'),
    sectionId: z.string().min(1).max(64),
  }).strict(),
]);
export type PluginSlotAction = z.infer<typeof pluginSlotActionSchema>;

/** Slot 1: Composer toolbar badge or compact action button. */
export const pluginComposerToolbarSlotSchema = z.object({
  slot: z.literal('composer-toolbar'),
  pluginId: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  icon: z.string().min(1).max(64).optional(),
  label: pluginLocalizedTextSchema,
  tooltip: pluginLocalizedTextSchema.optional(),
  tone: z.enum(['neutral', 'accent', 'warning']).default('neutral'),
  badgeText: z.string().max(24).optional(),
  order: z.number().int().min(-1000).max(1000).default(0),
  action: pluginSlotActionSchema,
}).strict();

/** Slot 2: Status-bar capsule displaying concise live plugin telemetry or mode state. */
export const pluginStatusCapsuleSlotSchema = z.object({
  slot: z.literal('status-capsule'),
  pluginId: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  icon: z.string().min(1).max(64).optional(),
  label: pluginLocalizedTextSchema,
  valueText: z.string().max(32).optional(),
  dotTone: z.enum(['idle', 'active', 'ok', 'warn', 'error']).default('idle'),
  order: z.number().int().min(-1000).max(1000).default(0),
  action: pluginSlotActionSchema.optional(),
}).strict();

/** Slot 3: Message hover/context action menu entry. */
export const pluginMessageActionSlotSchema = z.object({
  slot: z.literal('message-action'),
  pluginId: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  icon: z.string().min(1).max(64).optional(),
  label: pluginLocalizedTextSchema,
  appliesToRoles: z.array(z.enum(['user', 'assistant'])).min(1),
  order: z.number().int().min(-1000).max(1000).default(0),
  action: pluginSlotActionSchema,
}).strict();

/** Slot 4: Slash command palette declarative item contributed by a plugin. */
export const pluginSlashCommandSlotSchema = z.object({
  slot: z.literal('slash-command'),
  pluginId: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  icon: z.string().min(1).max(64).optional(),
  command: z.string().regex(/^[a-z0-9][a-z0-9:-]{0,63}$/),
  description: pluginLocalizedTextSchema,
  argumentHint: pluginLocalizedTextSchema.optional(),
  needsSession: z.boolean().default(false),
  action: pluginSlotActionSchema,
}).strict();

/** Slot 5: Native Settings page declarative section descriptor. */
export const pluginSettingsSectionSlotSchema = z.object({
  slot: z.literal('settings-section'),
  pluginId: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  icon: z.string().min(1).max(64).optional(),
  title: pluginLocalizedTextSchema,
  subtitle: pluginLocalizedTextSchema.optional(),
  order: z.number().int().min(-1000).max(1000).default(0),
}).strict();

/** Declarative field mapping for custom tool card semantic rendering (Slot 6). */
export const pluginToolCardFieldSpecSchema = z.object({
  label: pluginLocalizedTextSchema,
  sourcePath: z.string().min(1).max(120),
  format: z.enum(['inline-text', 'code', 'file-path', 'badge', 'key-value', 'diff']).default('inline-text'),
}).strict();

/** Slot 6: Declarative custom tool-card renderer avoiding untrusted JSX execution in the main renderer. */
export const pluginToolCardRendererSlotSchema = z.object({
  slot: z.literal('tool-card-renderer'),
  pluginId: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  icon: z.string().min(1).max(64).optional(),
  toolNames: z.array(z.string().min(1).max(128)).min(1).max(64),
  actionVerb: pluginLocalizedTextSchema,
  targetFieldPath: z.string().max(120).optional(),
  summaryFields: z.array(pluginToolCardFieldSpecSchema).max(6).default([]),
  detailFields: z.array(pluginToolCardFieldSpecSchema).max(8).default([]),
}).strict();

/** Slot 7 & 8: Declarative sidebar panel or inspector tab mounted over the sandboxed `kiki.panel.v1` bridge. */
export const pluginSandboxedPanelSlotSchema = z.object({
  slot: z.enum(['sidebar-panel', 'inspector-tab']),
  pluginId: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9:-]{0,63}$/),
  icon: z.string().min(1).max(64).optional(),
  title: pluginLocalizedTextSchema,
  panelId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  bridge: z.literal('kiki.panel.v1').default('kiki.panel.v1'),
  order: z.number().int().min(-1000).max(1000).default(0),
}).strict();

/** Discriminated union of all declarative GUI extension slots (E12). */
export const pluginGuiSlotContributionSchema = z.discriminatedUnion('slot', [
  pluginComposerToolbarSlotSchema,
  pluginStatusCapsuleSlotSchema,
  pluginMessageActionSlotSchema,
  pluginSlashCommandSlotSchema,
  pluginSettingsSectionSlotSchema,
  pluginToolCardRendererSlotSchema,
  pluginSandboxedPanelSlotSchema,
]);
export type PluginGuiSlotContribution = z.infer<typeof pluginGuiSlotContributionSchema>;

/** Manifest/runtime GUI slot declaration allowing `pluginId` to be omitted and stamped by the host. */
export const pluginGuiSlotDeclarationSchema = z.discriminatedUnion('slot', [
  pluginComposerToolbarSlotSchema.extend({ pluginId: z.string().min(1).optional() }).strict(),
  pluginStatusCapsuleSlotSchema.extend({ pluginId: z.string().min(1).optional() }).strict(),
  pluginMessageActionSlotSchema.extend({ pluginId: z.string().min(1).optional() }).strict(),
  pluginSlashCommandSlotSchema.extend({ pluginId: z.string().min(1).optional() }).strict(),
  pluginSettingsSectionSlotSchema.extend({ pluginId: z.string().min(1).optional() }).strict(),
  pluginToolCardRendererSlotSchema.extend({ pluginId: z.string().min(1).optional() }).strict(),
  pluginSandboxedPanelSlotSchema.extend({ pluginId: z.string().min(1).optional() }).strict(),
]);
export type PluginGuiSlotDeclaration = z.infer<typeof pluginGuiSlotDeclarationSchema>;

/** Descriptor for an authenticated `/api/plugins/:pluginId/*` HTTP route (E12). */
export const pluginHttpRouteDescriptorSchema = z.object({
  pluginId: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  subpath: z.string().regex(/^\/[a-zA-Z0-9/_:-]{1,120}$/),
  scopeAcl: z.enum(['global', 'space', 'session']).default('session'),
  maxBodyBytes: z.number().int().min(0).max(4 * 1024 * 1024).default(262_144),
}).strict();
export type PluginHttpRouteDescriptor = z.infer<typeof pluginHttpRouteDescriptorSchema>;

/** Manifest/runtime HTTP route declaration allowing `pluginId` to be omitted and stamped by the host. */
export const pluginHttpRouteDeclarationSchema = pluginHttpRouteDescriptorSchema
  .extend({ pluginId: z.string().min(1).optional() })
  .strict();
export type PluginHttpRouteDeclaration = z.infer<typeof pluginHttpRouteDeclarationSchema>;

/** Descriptor for an authenticated WebSocket topic broadcast under `event.plugin.topic` (E12). */
export const pluginWsTopicDescriptorSchema = z.object({
  pluginId: z.string().min(1),
  topic: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  scopeAcl: z.enum(['global', 'space', 'session']).default('session'),
}).strict();
export type PluginWsTopicDescriptor = z.infer<typeof pluginWsTopicDescriptorSchema>;

/** Runtime WebSocket topic declaration allowing `pluginId` to be omitted and stamped by the host. */
export const pluginWsTopicDeclarationSchema = pluginWsTopicDescriptorSchema
  .extend({ pluginId: z.string().min(1).optional() })
  .strict();
export type PluginWsTopicDeclaration = z.infer<typeof pluginWsTopicDeclarationSchema>;

/** Wire event pushed over `/api/ws` for subscribed plugin topics. */
export const pluginWsTopicEventSchema = z.object({
  type: z.literal('event.plugin.topic'),
  plugin_id: z.string().min(1),
  topic: z.string().min(1),
  session_id: z.string().min(1).optional(),
  space_id: z.string().min(1).optional(),
  payload: z.unknown(),
}).strict();
export type PluginWsTopicEvent = z.infer<typeof pluginWsTopicEventSchema>;

/** REST response schema for `GET /api/plugins/gui-slots`. */
export const listPluginGuiSlotsResponseSchema = z.object({
  slots: z.array(pluginGuiSlotContributionSchema),
}).strict();
export type ListPluginGuiSlotsResponse = z.infer<typeof listPluginGuiSlotsResponseSchema>;
