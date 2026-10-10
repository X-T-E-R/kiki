import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaque = z.string().regex(/^[a-z0-9-]{16,96}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.string().datetime({ offset: false });
export const usageExportTokensSchema = z.object({
  input_other: count, input_cache_read: count, input_cache_creation: count, output: count,
}).strict();
export const usageExportQualitySchema = z.object({
  known_records: count, missing_records: count, legacy_zero_records: count, invalid_records: count,
  estimated_records: count, mapping_unknown: z.boolean(), price_unknown: z.boolean(), complete: z.boolean(),
}).strict();
export const usageExportCostSchema = z.object({
  usd_estimated: z.number().finite().nonnegative().nullable(), currency: z.literal('USD'),
  source: z.literal('kiki-local-estimate'), pricing_version: hash,
}).strict();
export const usageExportBucketDataSchema = z.object({
  start_at: utc, end_at: utc, source: z.literal('kiki'), model: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:/-]+$/),
  mapping_version: z.literal('kiki-public-model-v1'), tokens: usageExportTokensSchema,
  quality: usageExportQualitySchema, cost: usageExportCostSchema,
}).strict().superRefine((v, ctx) => {
  const start = Date.parse(v.start_at); const end = Date.parse(v.end_at);
  if (start % 1_800_000 !== 0 || end !== start + 1_800_000) ctx.addIssue({ code: 'custom', message: 'Expected an absolute UTC half-hour bucket' });
  if (Object.values(v.tokens).reduce((a, b) => a + b, 0) > Number.MAX_SAFE_INTEGER) ctx.addIssue({ code: 'custom', message: 'Unsafe token total' });
  if (v.quality.price_unknown && v.cost.usd_estimated !== null) ctx.addIssue({ code: 'custom', message: 'Unknown cost must be null' });
});
export const usageExportItemSchema = z.object({
  schema_version: z.literal('kiki.usage.bucket.v1'), stream_id: opaque, bucket_id: opaque,
  revision: count.min(1), payload_hash: hash, operation: z.enum(['replace', 'delete']),
  bucket: usageExportBucketDataSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  if ((v.operation === 'replace') !== (v.bucket !== null)) ctx.addIssue({ code: 'custom', message: 'replace requires bucket; delete requires null' });
});
export const usageExportBatchSchema = z.object({
  schema_version: z.literal('kiki.usage.batch.v1'), batch_id: opaque, items: z.array(usageExportItemSchema).min(1).max(200),
}).strict();
export const usageExportAckSchema = z.object({
  stream_id: opaque, bucket_id: opaque, revision: count.min(1), payload_hash: hash,
  status: z.enum(['applied', 'duplicate', 'stale', 'conflict', 'rejected', 'remote_diverged']),
}).strict();
export const usageExportReceiptSchema = z.object({
  schema_version: z.literal('kiki.usage.receipt.v1'), batch_id: opaque, items: z.array(usageExportAckSchema).max(200),
}).strict();
export const usageExportScopeSchema = z.object({
  start_at: count.refine((n) => n % 1_800_000 === 0), end_at: count.nullable(),
  include_ephemeral: z.boolean(), excluded_workspace_ids: z.array(z.string().min(1).max(512)).max(1000),
}).strict().refine((v) => v.end_at === null || v.end_at > v.start_at, 'end_at must be after start_at');
export const usageExportPrivateGrantSchema = z.object({
  host: z.string().min(1).max(255), ip: z.string().min(1).max(64), port: z.number().int().min(1).max(65535), protocol: z.enum(['http:', 'https:']),
}).strict();
export const usageExportTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('webhook'), endpoint: z.string().url().max(2048), private_grant: usageExportPrivateGrantSchema.optional(), gzip: z.boolean(), authentication: z.enum(['none', 'bearer', 'hmac']) }).strict(),
  z.object({ kind: z.literal('vibe'), endpoint: z.string().url().max(2048), private_grant: usageExportPrivateGrantSchema.optional() }).strict(),
  z.object({ kind: z.literal('script'), command: z.string().min(1).max(8192), timeout_ms: count.min(100).max(60000), output_limit_bytes: count.min(1024).max(1048576) }).strict(),
]);
export const usageExportDraftSchema = z.object({
  id: z.string().uuid().optional(), label: z.string().min(1).max(80), target: usageExportTargetSchema,
  scope: usageExportScopeSchema,
  schedule_minutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
}).strict();
export const usageExportSecretInputSchema = z.object({
  value: z.string().min(1).max(8192), storage: z.enum(['keyring', 'private-file']), acknowledge_file_storage: z.boolean().optional(),
}).strict();
export const VIBE_CAFE_ORIGIN = 'https://vibecafe.ai';
export const VIBE_CAFE_INGEST_ENDPOINT = `${VIBE_CAFE_ORIGIN}/api/usage/ingest`;
export const usageExportVibeAuthInputSchema = z.object({
  storage: z.enum(['auto', 'keyring', 'private-file']).default('auto'), acknowledge_file_storage: z.boolean().optional(),
}).strict();
export const usageExportVibeAuthSchema = z.object({
  flow_id: z.string().uuid(), destination_id: z.string().uuid(),
  state: z.enum(['pending', 'connected', 'cancelled', 'denied', 'expired', 'error']),
  user_code: z.string().max(128), verification_uri: z.string().url(),
  expires_at: count, poll_after_ms: count, error_category: z.string().nullable(),
}).strict();
export type UsageExportVibeAuthInput = z.input<typeof usageExportVibeAuthInputSchema>;
export type UsageExportVibeAuth = z.infer<typeof usageExportVibeAuthSchema>;
export const usageExportSaveSchema = z.object({ draft: usageExportDraftSchema, secret: usageExportSecretInputSchema.optional() }).strict();
export const usageExportConsentSchema = z.object({ preview_fingerprint: hash, acknowledge: z.literal(true) }).strict();
export const usageExportDestinationSchema = z.object({
  id: z.string().uuid(), label: z.string(), target: usageExportTargetSchema, account_fingerprint: hash,
  scope: usageExportScopeSchema, schedule_minutes: z.number(), stream_id: opaque, enabled: z.boolean(),
  consent_fingerprint: hash.nullable(), credential_storage: z.enum(['none', 'keyring', 'private-file']),
  state: z.enum(['draft', 'disabled', 'ready', 'needs-auth', 'retrying', 'queue-full', 'quarantined', 'remote-diverged', 'adapter-unavailable']),
  next_at: count.nullable(), last_success_at: count.nullable(), error_category: z.string().nullable(),
}).strict();
export const usageExportQueueSchema = z.object({
  pending: count, inflight: count, quarantined: count, bytes: count, limit_bytes: count, warning: z.boolean(), oldest_at: count.nullable(),
}).strict();
export const usageExportPreviewSchema = z.object({
  destination: usageExportDestinationSchema, preview_fingerprint: hash, items: z.array(usageExportItemSchema),
  total_buckets: count, source_complete: z.boolean(), invalid_records: count,
  disclosures: z.array(z.string()),
}).strict();
export const usageExportStatusSchema = z.object({
  writer: z.boolean(), scan_complete: z.boolean(), scan_error: z.string().nullable(),
  destinations: z.array(z.object({ destination: usageExportDestinationSchema, queue: usageExportQueueSchema }).strict()),
}).strict();
export type UsageExportTokens = z.infer<typeof usageExportTokensSchema>;
export type UsageExportQuality = z.infer<typeof usageExportQualitySchema>;
export type UsageExportBucketData = z.infer<typeof usageExportBucketDataSchema>;
export type UsageExportItem = z.infer<typeof usageExportItemSchema>;
export type UsageExportBatch = z.infer<typeof usageExportBatchSchema>;
export type UsageExportReceipt = z.infer<typeof usageExportReceiptSchema>;
export type UsageExportScope = z.infer<typeof usageExportScopeSchema>;
export type UsageExportTarget = z.infer<typeof usageExportTargetSchema>;
export type UsageExportDraft = z.infer<typeof usageExportDraftSchema>;
export type UsageExportSave = z.infer<typeof usageExportSaveSchema>;
export type UsageExportDestination = z.infer<typeof usageExportDestinationSchema>;
export type UsageExportPreview = z.infer<typeof usageExportPreviewSchema>;
export type UsageExportStatus = z.infer<typeof usageExportStatusSchema>;
export type UsageExportQueue = z.infer<typeof usageExportQueueSchema>;
export type UsageExportConsent = z.infer<typeof usageExportConsentSchema>;

const handoffBoundary = count.refine((n) => n % 1_800_000 === 0);
export const collectorHandoffIdentitySchema = z.object({
  apiUrl: z.string().url().max(2048), keyFingerprint: z.string().regex(/^[a-f0-9]{16}$/), ingest_endpoint: z.string().url().max(2048),
}).strict().refine((value) => {
  const url = new URL(value.apiUrl);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && new URL('/api/usage/ingest', url).href === value.ingest_endpoint;
}, 'Expected collector ingest identity');
export const legacyHandoffReceiptSchema = z.object({
  completed_at: count, cutoff_at: handoffBoundary, ingested: count, coverage_complete: z.literal(true), cutoff_persisted: z.literal(true), collector_version: z.string().min(1).max(80), collector_identity: collectorHandoffIdentitySchema,
}).strict();
export const usageExportHandoffSchema = z.object({
  schema_version: z.literal('kiki.usage.handoff.v1'), data_home_fingerprint: hash, account_fingerprint: hash,
  cutoff_at: handoffBoundary, namespace: z.string().regex(/^kiki-[a-z0-9-]{16,96}$/), phase: z.enum(['prepared', 'armed', 'awaiting-native', 'completed', 'rollback-prepared']),
  legacy_receipt: legacyHandoffReceiptSchema.nullable(), native_receipt: usageExportReceiptSchema.nullable(), previous_cutoff_at: handoffBoundary.nullable(),
}).strict();
export const usageExportHandoffArmSchema = usageExportConsentSchema.extend({ collector_file: z.string().min(1).max(4096) }).strict();
export type UsageExportHandoff = z.infer<typeof usageExportHandoffSchema>;
export type LegacyHandoffReceipt = z.infer<typeof legacyHandoffReceiptSchema>;
export type UsageExportHandoffArm = z.infer<typeof usageExportHandoffArmSchema>;
