import { z } from 'zod';
import { mediaKindSchema, mediaProviderDefinitionSchema } from '@kiki/plugin-sdk/media';

export const mediaScriptSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  label: z.string().min(1).max(200),
  kinds: z.array(mediaKindSchema).min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  protocol: z.enum(['file', 'json']).default('file'),
  format: z.string().regex(/^[a-z0-9]+$/).optional(),
  mime: z.string().optional(),
  enabled: z.boolean().default(true),
  removed: z.boolean().default(false),
}).strict();
export const mediaScriptSourcesSchema = z.array(mediaScriptSourceSchema).max(1000).refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'Duplicate script source id');
export const mediaSourceSettingPropertySchema = z.object({ type: z.enum(['string', 'boolean', 'number']), title: z.string().optional(), description: z.string().optional(), secret: z.boolean().optional(), default: z.union([z.string(), z.number(), z.boolean()]).optional() }).strict();
export const mediaManagedSourceSchema = z.object({
  provider: z.string(), sourceId: z.string(), pluginId: z.string(), label: z.string(), custom: z.boolean(), enabled: z.boolean(), removed: z.boolean(),
  definitions: z.array(mediaProviderDefinitionSchema),
  schema: z.object({ schemaVersion: z.literal(1), schema: z.object({ type: z.literal('object'), properties: z.record(z.string(), mediaSourceSettingPropertySchema), required: z.array(z.string()).optional() }).strict() }).strict(),
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  secretsConfigured: z.array(z.string()), missing: z.array(z.string()),
}).strict();
export const mediaSourceSettingsInputSchema = z.object({ provider: z.string().min(1) }).strict();
export const mediaSourceUpdateSchema = mediaSourceSettingsInputSchema.extend({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), enabled: z.boolean().optional(), removed: z.boolean().optional() });
export const mediaScriptSourceInputSchema = mediaScriptSourceSchema.omit({ enabled: true, removed: true }).extend({ environment: z.record(z.string(), z.string()).optional() });
export type MediaScriptSource = z.infer<typeof mediaScriptSourceSchema>;
export type MediaScriptSourceInput = z.input<typeof mediaScriptSourceInputSchema>;
export type MediaManagedSource = z.infer<typeof mediaManagedSourceSchema>;
export type MediaSourceUpdate = z.infer<typeof mediaSourceUpdateSchema>;
