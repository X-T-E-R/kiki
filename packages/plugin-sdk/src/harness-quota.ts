import { z } from 'zod';

const identifier = z.string().min(1).max(1024).regex(/^[^\s\u0000]+$/);
const engineIds = z.array(identifier).min(1).refine((ids) => new Set(ids).size === ids.length, 'Duplicate engine id');

/** Five minutes. Plugins may declare a longer interval; shorter declarations are rejected. */
export const HARNESS_QUOTA_MIN_REFRESH_MS = 300_000;

export const harnessQuotaUnitSchema = z.enum(['percent', 'money', 'tokens', 'requests', 'credits', 'count']);

export const harnessQuotaSourceDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: z.string().min(1),
  engineIds,
  minRefreshIntervalMs: z.number().int().min(HARNESS_QUOTA_MIN_REFRESH_MS).optional(),
}).strict();

export const harnessQuotaReadingSchema = z.object({
  accountId: identifier,
  accountLabel: z.string().min(1).optional(),
  /** Exact native model ids. Omit on a pooled reading only when the mapping is unknown. */
  modelIds: z.array(identifier).optional(),
  /** Display pool. A pooled reading without modelIds cannot route. */
  pool: z.string().min(1).optional(),
  unit: harnessQuotaUnitSchema,
  window: z.string().min(1).optional(),
  /** Omitted means unknown. Zero is a known exhausted value. */
  remaining: z.number().finite().nonnegative().optional(),
  resetAt: z.string().datetime({ offset: true }).optional(),
  readAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const harnessQuotaBatchSchema = z.union([
  z.array(harnessQuotaReadingSchema).max(500),
  z.object({ readings: z.array(harnessQuotaReadingSchema).max(500) }).strict(),
]);

export type HarnessQuotaUnit = z.infer<typeof harnessQuotaUnitSchema>;
export type HarnessQuotaSourceDefinition = z.infer<typeof harnessQuotaSourceDefinitionSchema>;
export type HarnessQuotaReading = z.infer<typeof harnessQuotaReadingSchema>;

export interface HarnessQuotaContext {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly kikiHome: string;
}

export interface HarnessQuotaAdapter {
  /** One batch for this source. Do not issue a request per model, engine, or account. */
  read(context: HarnessQuotaContext): Promise<{ readonly readings: readonly HarnessQuotaReading[] } | readonly HarnessQuotaReading[]>;
}

export const harnessQuotaSnapshotSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  engineIds: z.array(z.string().min(1)),
  minRefreshIntervalMs: z.number().int().positive(),
  readAt: z.string().datetime({ offset: true }).optional(),
  readings: z.array(harnessQuotaReadingSchema).optional(),
}).strict();

export const harnessQuotaCacheResponseSchema = z.object({
  sources: z.array(harnessQuotaSnapshotSchema),
}).strict();

export const harnessQuotaReadRequestSchema = z.object({
  source: z.string().regex(/^plugin:[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/),
}).strict();

export type PluginHarnessQuotaSnapshot = z.infer<typeof harnessQuotaSnapshotSchema>;

/** Read-only view of the host cache. Does not poll the quota source. */
export interface PluginHarnessQuotaApi {
  cached(): Promise<{ readonly sources: readonly PluginHarnessQuotaSnapshot[] }>;
}
