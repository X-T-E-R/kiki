import { gzipSync } from 'node:zlib';

import { usageExportBatchSchema, usageExportItemSchema, usageExportReceiptSchema, type UsageExportBatch, type UsageExportItem } from '@kiki/protocol';
import { z } from 'zod';

import type { UsageExportAdapter, UsageExportAdapterContext, UsageExportAdapterResult } from './adapter';

export const VIBE_MAPPING_VERSION = 'vibe-kimi-bucket-v1';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const vibeUsageBucketSchema = z.object({
  source: z.literal('kimi-code'), model: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:/-]+$/),
  project: z.literal('unknown'), hostname: z.string().regex(/^kiki-[a-z0-9-]{16,96}$/),
  bucketStart: z.string().datetime({ offset: false }), inputTokens: count, outputTokens: count,
  cachedInputTokens: count, reasoningOutputTokens: z.literal(0), cacheCreation5mTokens: z.literal(0),
  cacheCreation1hTokens: z.literal(0), totalTokens: count,
}).strict().superRefine((v, ctx) => {
  if (v.totalTokens !== v.inputTokens + v.outputTokens) ctx.addIssue({ code: 'custom', message: 'Invalid compatible token total' });
});
export const vibeUsagePayloadSchema = z.object({ buckets: z.array(vibeUsageBucketSchema).max(1) }).strict();
const vibeReceiptSchema = z.object({
  ingested: count, sessions: z.literal(0).optional(),
  dropped: z.object({ buckets: count, unknownSources: z.array(z.string()).optional(), unknownModels: count.optional(), implausible: count.optional() }).strict().optional(),
  protected: z.object({ buckets: count }).strict().optional(),
}).strict();

export function mapVibeUsageBucket(input: UsageExportItem): z.infer<typeof vibeUsageBucketSchema> {
  const item = usageExportItemSchema.parse(input);
  if (item.operation !== 'replace' || item.bucket === null) throw new Error('vibe_delete_unsupported');
  const { bucket } = item;
  if (!bucket.quality.complete) throw new Error('vibe_incomplete_bucket');
  const inputTokens = bucket.tokens.input_other + bucket.tokens.input_cache_creation;
  const outputTokens = bucket.tokens.output;
  return vibeUsageBucketSchema.parse({
    source: 'kimi-code', model: bucket.model, project: 'unknown', hostname: `kiki-${item.stream_id}`,
    bucketStart: bucket.start_at, inputTokens, outputTokens, cachedInputTokens: bucket.tokens.input_cache_read,
    reasoningOutputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, totalTokens: inputTokens + outputTokens,
  });
}

export function requiresVibeRemoteRebuild(previous: UsageExportItem, next: UsageExportItem): boolean {
  const before = mapVibeUsageBucket(previous);
  const after = mapVibeUsageBucket(next);
  const key = (bucket: z.infer<typeof vibeUsageBucketSchema>): string => JSON.stringify([bucket.source, bucket.model, bucket.project, bucket.hostname, bucket.bucketStart]);
  return key(before) !== key(after) || after.inputTokens < before.inputTokens || after.cachedInputTokens < before.cachedInputTokens || after.outputTokens < before.outputTokens;
}

export function mapVibeUsageBatch(batch: UsageExportBatch): z.infer<typeof vibeUsagePayloadSchema> {
  const parsed = usageExportBatchSchema.parse(batch);
  if (parsed.items.length !== 1) throw new Error('vibe_single_bucket_required');
  const bucket = mapVibeUsageBucket(parsed.items[0]!);
  if (bucket.totalTokens === 0) throw new Error(bucket.cachedInputTokens > 0 ? 'cached_only_unsupported' : 'vibe_zero_bucket_unsupported');
  return vibeUsagePayloadSchema.parse({ buckets: [bucket] });
}

export function parseVibeUsageReceipt(body: string, expected: number): UsageExportAdapterResult {
  let json: unknown;
  try { json = JSON.parse(body); } catch { return { outcome: 'retry', errorCategory: 'invalid_protocol' }; }
  const parsed = vibeReceiptSchema.safeParse(json);
  if (!parsed.success) return { outcome: 'retry', errorCategory: 'invalid_protocol' };
  const v = parsed.data;
  if ((v.protected?.buckets ?? 0) > 0) return { outcome: 'remote-diverged', errorCategory: 'vibe_protected' };
  if ((v.dropped?.unknownSources?.length ?? 0) > 0) return { outcome: 'invalid', errorCategory: 'vibe_unknown_source' };
  if ((v.dropped?.unknownModels ?? 0) > 0) return { outcome: 'invalid', errorCategory: 'vibe_unknown_model' };
  if ((v.dropped?.implausible ?? 0) > 0) return { outcome: 'invalid', errorCategory: 'vibe_implausible' };
  if ((v.dropped?.buckets ?? 0) > 0) return { outcome: 'invalid', errorCategory: 'invalid_protocol' };
  if (v.ingested !== expected) return { outcome: 'retry', errorCategory: 'vibe_partial_receipt' };
  return { outcome: 'delivered' };
}

async function postVibe(payload: z.infer<typeof vibeUsagePayloadSchema>, context: UsageExportAdapterContext): Promise<UsageExportAdapterResult> {
  if (context.target.kind !== 'vibe') return { outcome: 'invalid', errorCategory: 'invalid_protocol' };
  if (context.signal.aborted) return { outcome: 'retry', errorCategory: 'network' };
  try {
    const body = gzipSync(Buffer.from(JSON.stringify(vibeUsagePayloadSchema.parse(payload))));
    const response = await context.post({ body, contentType: 'application/json', contentEncoding: 'gzip' });
    if (response.status === 401 || response.status === 403) return { outcome: 'needs-auth', errorCategory: 'http_auth' };
    if (response.status === 413) return { outcome: 'too-large', errorCategory: 'http_too_large' };
    if (response.status === 429 || response.status >= 500) return { outcome: 'retry', retryAfterMs: response.retryAfterMs, errorCategory: response.status === 429 ? 'http_rate_limited' : 'network' };
    if (response.status < 200 || response.status >= 300) return { outcome: 'invalid', errorCategory: 'invalid_protocol' };
    return parseVibeUsageReceipt(response.body, payload.buckets.length);
  } catch { return { outcome: 'retry', errorCategory: 'network' }; }
}

export function createVibeUsageAdapter(): UsageExportAdapter {
  return {
    kind: 'vibe', mappingVersion: VIBE_MAPPING_VERSION,
    capabilities: { absoluteReplace: false, delete: false, perItemAck: false }, maxBatchItems: 1, maxBodyBytes: 1_048_576,
    test: (context) => postVibe({ buckets: [] }, context),
    async send(batch, context) {
      let payload: z.infer<typeof vibeUsagePayloadSchema>;
      try {
        const parsed = usageExportBatchSchema.parse(batch);
        if (parsed.items.length !== 1) return { outcome: 'invalid', errorCategory: 'invalid_protocol' };
        const item = parsed.items[0]!;
        const previous = context.previousAcknowledged?.find(ack => ack.stream_id === item.stream_id && ack.bucket_id === item.bucket_id);
        if (previous !== undefined && (item.operation === 'delete' || requiresVibeRemoteRebuild(previous, item))) return { outcome: 'remote-diverged', errorCategory: 'remote_diverged' };
        payload = mapVibeUsageBatch(parsed);
      } catch (error) {
        return { outcome: 'invalid', errorCategory: error instanceof Error && error.message === 'cached_only_unsupported' ? 'cached_only_unsupported' : 'invalid_protocol' };
      }
      const result = await postVibe(payload, context);
      if (result.outcome !== 'delivered') return result;
      const receipt = usageExportReceiptSchema.parse({
        schema_version: 'kiki.usage.receipt.v1', batch_id: batch.batch_id,
        items: batch.items.map(({ stream_id, bucket_id, revision, payload_hash }) => ({ stream_id, bucket_id, revision, payload_hash, status: 'applied' })),
      });
      return { ...result, receipt };
    },
  };
}
