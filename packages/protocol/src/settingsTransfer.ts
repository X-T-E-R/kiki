import { z } from 'zod';

export const SETTINGS_TRANSFER_CATEGORIES = ['models', 'agents', 'permissions', 'tools', 'browser', 'notifications', 'appearance'] as const;
export const settingsTransferCategorySchema = z.enum(SETTINGS_TRANSFER_CATEGORIES);
export type SettingsTransferCategory = z.infer<typeof settingsTransferCategorySchema>;
export const SETTINGS_TRANSFER_MAX_BYTES = 8 * 1024 * 1024;

export const settingsTransferPreferencesSchema = z.object({
  settings: z.object({
    sendShortcut: z.enum(['enter', 'cmd-enter']).optional(),
    draftPersistence: z.boolean().optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    requestTimeoutSeconds: z.number().int().min(5).max(600).optional(),
    readingTimeoutSeconds: z.number().int().min(0).max(2_147_483).optional(),
    subagentPanelOpenMode: z.enum(['tab', 'fullscreen']).optional(),
    defaultAppendTiming: z.enum(['agent_idle', 'subagents_done', 'tasks_done']).optional(),
    foldSteps: z.boolean().optional(),
    worktreeSkipConfirm: z.boolean().optional(),
    railOpenByDefault: z.boolean().optional(),
    motion: z.enum(['system', 'reduce', 'full']).optional(),
    proseFont: z.enum(['serif', 'sans']).optional(),
    awayNotifications: z.object({ completed: z.boolean(), failed: z.boolean(), question: z.boolean(), approval: z.boolean() }).strict().optional(),
  }).strict().optional(),
  layout: z.object({
    sidebarWidth: z.number().min(200).max(480).optional(),
    railWidth: z.number().min(240).max(520).optional(),
    sidebarCollapsed: z.boolean().optional(),
    pinnedNavItems: z.array(z.enum(['cron', 'memory', 'personas', 'usage', 'capabilities', 'discover'])).max(6).optional(),
    sidebarNavSectionCollapsed: z.boolean().optional(),
    groupBy: z.enum(['time', 'workspace', 'none']).optional(),
    sortBy: z.enum(['updated-desc', 'updated-asc', 'created-desc', 'title']).optional(),
  }).strict().optional(),
  desktop: z.object({ notifications: z.boolean().optional(), closeToTray: z.boolean().optional() }).strict().optional(),
  locale: z.enum(['en', 'zh']).optional(),
}).strict();
export type SettingsTransferPreferences = z.infer<typeof settingsTransferPreferencesSchema>;

const dataSchema = z.record(z.string().min(1).max(256), z.json());
export const settingsTransferNbSearchCredentialSchema = z.object({
  kind: z.literal('nbSearchCredential'),
  key: z.string().min(1).max(256),
  binding: z.object({
    providerId: z.string().min(1).max(256),
    env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    consumers: z.array(z.object({ id: z.string().min(1).max(256), baseUrl: z.string().nullable() }).strict()).min(1).max(1024),
  }).strict(),
  value: z.string().min(1).max(8192),
}).strict();
export type SettingsTransferNbSearchCredential = z.infer<typeof settingsTransferNbSearchCredentialSchema>;
export const settingsTransferResourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), key: z.string().min(1).max(512), text: z.string().max(1_048_576), category: z.enum(['agents', 'models']).optional() }).strict(),
  z.object({ kind: z.literal('mcp'), key: z.string().min(1).max(256), value: dataSchema }).strict(),
  settingsTransferNbSearchCredentialSchema,
]);
export type SettingsTransferResource = z.infer<typeof settingsTransferResourceSchema>;

export const settingsTransferNoticeSchema = z.enum(['localScope', 'externalLogins', 'localPaths', 'omittedCredentials', 'omittedBrowserConnections', 'pluginCode', 'profileScope']);
export type SettingsTransferNotice = z.infer<typeof settingsTransferNoticeSchema>;
export const settingsTransferPackageSchema = z.object({
  format: z.literal('kiki.settings'),
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  categories: z.array(settingsTransferCategorySchema).max(7),
  includesCredentials: z.boolean(),
  config: dataSchema,
  resources: z.array(settingsTransferResourceSchema).max(1024),
  preferences: settingsTransferPreferencesSchema.optional(),
  notices: z.array(settingsTransferNoticeSchema).max(16),
}).strict();
export type SettingsTransferPackage = z.infer<typeof settingsTransferPackageSchema>;

export const settingsTransferExportInputSchema = z.object({ categories: z.array(settingsTransferCategorySchema).min(1).max(7), includeCredentials: z.boolean().default(false) }).strict();
export type SettingsTransferExportInput = z.infer<typeof settingsTransferExportInputSchema>;
export const settingsTransferModeSchema = z.enum(['append', 'overwrite']);
export type SettingsTransferMode = z.infer<typeof settingsTransferModeSchema>;
export const settingsTransferPreviewInputSchema = z.object({
  bundle: settingsTransferPackageSchema,
  categories: z.array(settingsTransferCategorySchema).max(7),
  mode: settingsTransferModeSchema.default('append'),
  includeCredentials: z.boolean().default(false),
}).strict();
export type SettingsTransferPreviewInput = z.infer<typeof settingsTransferPreviewInputSchema>;

export const settingsTransferScopeSchema = z.object({ home: z.string(), spaceId: z.string().optional() }).strict();
export const settingsTransferCategorySummarySchema = z.object({
  id: settingsTransferCategorySchema,
  items: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
}).strict();
export type SettingsTransferCategorySummary = z.infer<typeof settingsTransferCategorySummarySchema>;
export const settingsTransferCatalogSchema = z.object({
  scope: settingsTransferScopeSchema,
  categories: z.array(settingsTransferCategorySummarySchema),
  notices: z.array(settingsTransferNoticeSchema),
}).strict();
export type SettingsTransferCatalog = z.infer<typeof settingsTransferCatalogSchema>;
export const settingsTransferPreviewSchema = settingsTransferCatalogSchema.extend({
  previewId: z.string(),
  includesCredentials: z.boolean(),
  credentialsSelected: z.boolean(),
  mode: settingsTransferModeSchema,
});
export type SettingsTransferPreview = z.infer<typeof settingsTransferPreviewSchema>;
export const settingsTransferApplyInputSchema = z.object({ previewId: z.string().min(1).max(64) }).strict();
export const settingsTransferApplyResultSchema = z.object({
  status: z.enum(['complete', 'partial', 'failed']),
  scope: settingsTransferScopeSchema,
  items: z.array(z.object({ category: settingsTransferCategorySchema, key: z.string(), status: z.enum(['applied', 'unchanged', 'failed', 'unverified']) }).strict()),
  failure: z.enum(['changed', 'expired', 'writeFailed', 'readbackFailed']).optional(),
  timing: z.literal('settingsReloaded'),
}).strict();
export type SettingsTransferApplyResult = z.infer<typeof settingsTransferApplyResultSchema>;
