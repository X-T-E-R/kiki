import { z } from 'zod';
import { browserIdSchema, browserStatusSchema } from './browser';

export const browserPresetIdSchema = z.enum(['kimi-webbridge', 'independent-browser', 'codex-browser']);
export type BrowserPresetId = z.infer<typeof browserPresetIdSchema>;
export const browserSetupStepSchema = z.object({
  id: z.string(), state: z.enum(['ready', 'missing', 'running', 'user_action', 'failed', 'warning']),
  reason: z.string().optional(), detail: z.string().optional(), percent: z.number().min(0).max(100).optional(),
}).strict();
export const browserSetupActionSchema = z.object({
  id: z.enum(['prepare', 'connect', 'cancel', 'install_extension', 'open_instructions', 'enable_feature', 'choose_connection']),
  url: z.string().url().optional(), target: z.enum(['chrome', 'edge', 'documentation']).optional(),
}).strict();
export const browserSetupStatusSchema = z.object({
  preset: browserPresetIdSchema, displayName: z.string(), controlSurface: z.enum(['plugin-skill', 'browser-connection', 'external-app']),
  state: z.enum(['not_prepared', 'preparing', 'needs_user_action', 'ready', 'connected', 'failed', 'external_only', 'unsupported']),
  supported: z.boolean(), executionHost: z.string(), steps: z.array(browserSetupStepSchema), actions: z.array(browserSetupActionSchema),
  pluginId: z.string().optional(), skill: z.string().optional(), capabilityId: z.string().optional(),
  connectionId: browserIdSchema.optional(), connection: browserStatusSchema.optional(),
  checkedAt: z.string().optional(), error: z.string().optional(), reason: z.string().optional(),
  sourceUrl: z.string().url(),
}).strict();
export type BrowserSetupStatus = z.infer<typeof browserSetupStatusSchema>;
export const browserSetupListSchema = z.object({ presets: z.array(browserSetupStatusSchema) }).strict();
export type BrowserSetupList = z.infer<typeof browserSetupListSchema>;
export const browserSetupPrepareInputSchema = z.object({ consent: z.literal(true) }).strict();
export type BrowserSetupPrepareInput = z.infer<typeof browserSetupPrepareInputSchema>;
export const browserSetupConnectInputSchema = z.object({
  connectionId: browserIdSchema.optional(), name: z.string().trim().min(1).max(256).optional(), setDefault: z.boolean().optional(),
}).strict();
export type BrowserSetupConnectInput = z.infer<typeof browserSetupConnectInputSchema>;
