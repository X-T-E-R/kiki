import { z } from 'zod';

export const pluginPreviewRequestSchema = z.object({
  source: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

export const pluginInstallRequestSchema = pluginPreviewRequestSchema.extend({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  consent: z.boolean(),
});

export const pluginInstallPlanSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  fingerprint: z.string(),
  changes: z.array(z.string()),
  consentRequired: z.boolean(),
  permissions: z.object({
    fs: z.enum(['workspace', 'outside']).optional(),
    net: z.array(z.string()).optional(),
    exec: z.array(z.string()).optional(),
    secrets: z.boolean().optional(),
    uiPanel: z.boolean().optional(),
  }).optional(),
  contributions: z.array(z.string()),
  contextTokens: z.number(),
  unsupported: z.array(z.string()),
});

export const pluginSettingsResponseSchema = z.object({
  schema: z.unknown().optional(),
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  secretsConfigured: z.array(z.string()),
});
export const pluginSettingsPatchSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const pluginPrerequisiteInstallSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  consent: z.literal(true),
});

export const pluginPanelSummarySchema = z.object({
  pluginId: z.string(), id: z.string(), label: z.string(), slot: z.enum(['sidebar', 'workspace']),
});
export const pluginPanelDocumentSchema = z.object({ html: z.string(), sandbox: z.literal('allow-scripts') });
export const pluginPanelBridgeRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('session.summary'), session_id: z.string().min(1) }),
  z.object({ method: z.literal('session.sendMessage'), session_id: z.string().min(1), text: z.string().min(1).max(16_384) }),
  z.object({ method: z.literal('plugin.call'), session_id: z.string().min(1).optional(), action: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), args: z.unknown() }),
]);
export const pluginPanelBridgeResponseSchema = z.object({ result: z.unknown() });

export type PluginPanelSummary = z.infer<typeof pluginPanelSummarySchema>;
export type PluginPanelDocument = z.infer<typeof pluginPanelDocumentSchema>;
export type PluginPanelBridgeRequest = z.infer<typeof pluginPanelBridgeRequestSchema>;
export type PluginPanelBridgeResponse = z.infer<typeof pluginPanelBridgeResponseSchema>;
export type PluginSettingsResponse = z.infer<typeof pluginSettingsResponseSchema>;
export type PluginSettingsPatch = z.infer<typeof pluginSettingsPatchSchema>;
export type PluginPrerequisiteInstall = z.infer<typeof pluginPrerequisiteInstallSchema>;
export type PluginPreviewRequest = z.infer<typeof pluginPreviewRequestSchema>;
export type PluginInstallRequest = z.infer<typeof pluginInstallRequestSchema>;
export type PluginInstallPlan = z.infer<typeof pluginInstallPlanSchema>;

export const pluginNavigationSchema = z.object({
  request: z.object({ id: z.number().int(), pluginId: z.string(), sessionId: z.string(), at: z.number() }).optional(),
});
export type PluginNavigation = z.infer<typeof pluginNavigationSchema>;

export const pluginUsageTargetSchema = z.union([
  z.object({ workspace_id: z.string().min(1) }).strict(),
  z.object({ session_id: z.string().min(1) }).strict(),
]);
export const pluginUsageOverrideSchema = z.enum(['inherit', 'on', 'off']);
export const pluginUsageRequestSchema = z.object({ target: pluginUsageTargetSchema, plugin_id: z.string().min(1), override: pluginUsageOverrideSchema }).strict();
export const pluginUsageItemSchema = z.object({
  id: z.string(), displayName: z.string(), version: z.string().optional(), icon: z.string().optional(),
  home_enabled: z.boolean(), state: z.enum(['ok', 'error']), override: pluginUsageOverrideSchema,
  effective: z.boolean(), reason: z.enum(['home_disabled', 'workspace_disabled', 'invalid_plugin']).optional(),
  app_service: z.boolean(), skillCount: z.number(), mcpServerCount: z.number(),
});
export const pluginUsageResponseSchema = z.object({
  home_id: z.string(), target: z.object({ workspace_id: z.string(), name: z.string(), root: z.string() }),
  revision: z.number().int().nonnegative(), apply_state: z.enum(['applied', 'pending', 'failed']),
  errors: z.array(z.string()), plugins: z.array(pluginUsageItemSchema),
});
export type PluginUsageTarget = z.infer<typeof pluginUsageTargetSchema>;
export type PluginUsageRequest = z.infer<typeof pluginUsageRequestSchema>;
export type PluginUsageResponse = z.infer<typeof pluginUsageResponseSchema>;
export type PluginUsageItem = z.infer<typeof pluginUsageItemSchema>;
