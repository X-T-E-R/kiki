import { z } from 'zod';

export const providerQuotaMeterSchema = z.object({
  id: z.string(), label: z.string(),
  unit: z.enum(['percent', 'money', 'tokens', 'requests', 'credits', 'count']),
  unit_label: z.string(), currency: z.string().optional(),
  used: z.number().finite().nullable(), limit: z.number().finite().nullable(), remaining: z.number().finite().nullable(),
  model_group: z.string().optional(), scope: z.enum(['account', 'key', 'team']),
  status: z.enum(['ready', 'unknown', 'error', 'auth_required', 'stale']).optional(), message: z.string().optional(), data_as_of: z.string().datetime({ offset: true }).optional(),
  window: z.object({ label: z.string(), duration_seconds: z.number().positive().optional(), reset_at: z.string().datetime({ offset: true }).optional(), reset_timezone: z.string().optional() }).strict().optional(),
}).strict();
export const providerQuotaSourceSchema = z.object({
  id: z.string(), label: z.string(), kind: z.enum(['provider', 'external_service', 'executor']),
  provider_id: z.string(), account_label: z.string(), enabled: z.boolean(), supported: z.boolean(),
  status: z.enum(['unknown', 'ready', 'stale', 'error', 'auth_required', 'off', 'unsupported']),
  reason: z.string().optional(), message: z.string().optional(),
  checked_at: z.string().datetime().optional(), data_as_of: z.string().datetime().optional(),
  refresh_after: z.string().datetime().optional(), stale_at: z.string().datetime().optional(),
  refreshing: z.boolean(), refresh_mode: z.literal('explicit'),
  auth: z.object({ action: z.enum(['oauth_login', 'provider_settings', 'external_service_settings', 'executor_login']), provider: z.string() }).strict(),
  source: z.object({ label: z.string(), url: z.string().url().optional() }).strict(),
  meters: z.array(providerQuotaMeterSchema),
}).strict();
export const providerQuotaSnapshotSchema = z.object({ schema_version: z.literal('1'), sources: z.array(providerQuotaSourceSchema), generated_at: z.string().datetime() }).strict();
export const providerQuotaSelectSchema = z.object({ source_id: z.string().min(1).max(512) }).strict();
export const providerQuotaEnableSchema = providerQuotaSelectSchema.extend({ enabled: z.boolean() }).strict();
export type ProviderQuotaMeter = z.infer<typeof providerQuotaMeterSchema>;
export type ProviderQuotaSource = z.infer<typeof providerQuotaSourceSchema>;
export type ProviderQuotaSnapshot = z.infer<typeof providerQuotaSnapshotSchema>;
