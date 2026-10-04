import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { usageExportBatchSchema, usageExportReceiptSchema } from '@kiki/protocol';
import type { UsageExportAdapter, UsageExportAdapterResult, UsageExportHttpResponse } from './adapter';

export function classifyExportHttp(response: UsageExportHttpResponse): UsageExportAdapterResult | undefined {
  if (response.status === 401 || response.status === 403) return { outcome: 'needs-auth' };
  if (response.status === 413) return { outcome: 'too-large' };
  if (response.status === 429 || response.status >= 500 || response.status === 408) return { outcome: 'retry', retryAfterMs: response.retryAfterMs };
  if (response.status < 200 || response.status >= 300) return { outcome: 'invalid' };
  return undefined;
}
export function createWebhookUsageAdapter(): UsageExportAdapter {
  return {
    kind: 'webhook', mappingVersion: 'kiki-webhook-v1', capabilities: { absoluteReplace: true, delete: true, perItemAck: true }, maxBatchItems: 200, maxBodyBytes: 1_048_576,
    async test(context) {
      const nonce = randomBytes(24).toString('hex');
      const response = await context.post({ body: Buffer.from(JSON.stringify({ schema_version: 'kiki.usage.test.v1', nonce })), contentType: 'application/json' });
      const failure = classifyExportHttp(response); if (failure !== undefined) return failure;
      try { const value = JSON.parse(response.body) as Record<string, unknown>; return value['schema_version'] === 'kiki.usage.test.v1' && value['nonce'] === nonce && value['protocol'] === 'kiki.usage.bucket.v1' ? { outcome: 'delivered' } : { outcome: 'invalid' }; }
      catch { return { outcome: 'invalid' }; }
    },
    async send(batch, context) {
      const clean = usageExportBatchSchema.parse(batch);
      const body = Buffer.from(JSON.stringify(clean));
      const gzip = context.target.kind === 'webhook' && context.target.gzip;
      const response = await context.post({ body: gzip ? gzipSync(body) : body, contentType: 'application/json', contentEncoding: gzip ? 'gzip' : undefined });
      const failure = classifyExportHttp(response); if (failure !== undefined) return failure;
      try { const receipt = usageExportReceiptSchema.parse(JSON.parse(response.body)); return receipt.batch_id === clean.batch_id ? { outcome: 'delivered', receipt } : { outcome: 'invalid' }; }
      catch { return { outcome: 'invalid' }; }
    },
  };
}
