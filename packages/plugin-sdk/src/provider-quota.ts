import { z } from 'zod';
import type { PluginLlmProviderContext } from './llm-provider.js';

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const opaqueIdSchema = z.string().min(1).max(256).regex(/^[^\s\u0000]+$/);

export const providerQuotaSourceDefinitionSchema = /* @__PURE__ */ z.object({
  schemaVersion: z.literal(1),
  id: slugSchema,
  providerId: slugSchema,
  label: z.string().min(1).max(128),
  panelId: slugSchema.optional(),
}).strict();
export type ProviderQuotaSourceDefinition = Readonly<z.infer<typeof providerQuotaSourceDefinitionSchema>>;

export const pluginProviderQuotaTargetDescriptorSchema = /* @__PURE__ */ z.object({
  id: opaqueIdSchema,
  label: z.string().min(1).max(256),
  accountLabel: z.string().min(1).max(256).optional(),
  revision: z.string().min(1).max(256),
  active: z.boolean(),
  sourceLabel: z.string().min(1).max(256).optional(),
}).strict();
export type PluginProviderQuotaTargetDescriptor = Readonly<z.infer<typeof pluginProviderQuotaTargetDescriptorSchema>>;

export const pluginProviderQuotaMeterSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  scope: z.enum(['account', 'key', 'team', 'model', 'window']).optional(),
  unit: z.enum(['percent', 'credits', 'tokens', 'count', 'usd']),
  unit_label: z.string().max(64).optional(),
  used: z.number().finite().nullable(),
  limit: z.number().finite().nullable(),
  remaining: z.number().finite().nullable(),
  status: z.enum(['ready', 'stale', 'auth_required', 'error', 'unknown']),
  message: z.string().max(1024).optional(),
  data_as_of: z.string().datetime({ offset: true }).optional(),
  window: z.object({
    label: z.string().max(128).optional(),
    duration_seconds: z.number().positive().finite().optional(),
    reset_at: z.string().datetime({ offset: true }).optional(),
    reset_timezone: z.string().max(128).optional(),
  }).strict().optional(),
}).strict();
export type PluginProviderQuotaMeter = Readonly<z.infer<typeof pluginProviderQuotaMeterSchema>>;

export const pluginProviderQuotaReadResultSchema = /* @__PURE__ */ z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    meters: z.array(pluginProviderQuotaMeterSchema).max(200),
  }).strict(),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['auth_required', 'rate_limited', 'request_failed', 'unsupported']),
    message: z.string().max(1024).optional(),
    partialMeters: z.array(pluginProviderQuotaMeterSchema).max(200).optional(),
  }).strict(),
]);
export type PluginProviderQuotaReadResult = Readonly<z.infer<typeof pluginProviderQuotaReadResultSchema>>;

export interface ProviderQuotaAdapter {
  listTargets(context: PluginLlmProviderContext): Promise<readonly PluginProviderQuotaTargetDescriptor[]>;
  read(targetId: string, context: PluginLlmProviderContext): Promise<PluginProviderQuotaReadResult>;
}
