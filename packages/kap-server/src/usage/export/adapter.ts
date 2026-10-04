import type { UsageExportBatch, UsageExportItem, UsageExportReceipt, UsageExportTarget } from '@kiki/protocol';

export interface UsageExportHttpRequest {
  readonly body: Uint8Array;
  readonly contentType: 'application/json';
  readonly contentEncoding?: 'gzip';
}
export interface UsageExportHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs?: number;
}
export interface UsageExportAdapterContext {
  readonly target: UsageExportTarget;
  readonly signal: AbortSignal;
  readonly previousAcknowledged?: readonly UsageExportItem[];
  readonly post: (request: UsageExportHttpRequest) => Promise<UsageExportHttpResponse>;
}
export const USAGE_EXPORT_ERROR_CATEGORIES = [
  'adapter_unavailable', 'network', 'http_auth', 'http_rate_limited', 'http_too_large', 'invalid_protocol',
  'partial_receipt', 'remote_diverged', 'cached_only_unsupported', 'vibe_partial_receipt', 'vibe_protected',
  'vibe_unknown_source', 'vibe_unknown_model', 'vibe_implausible', 'script_timeout', 'script_output_limit',
  'script_spawn_failed', 'script_nonzero_exit', 'script_invalid_receipt', 'script_protocol_error', 'generic',
] as const;
export type UsageExportErrorCategory = (typeof USAGE_EXPORT_ERROR_CATEGORIES)[number];
export interface UsageExportAdapterResult {
  readonly errorCategory?: UsageExportErrorCategory;
  readonly outcome: 'delivered' | 'retry' | 'needs-auth' | 'too-large' | 'invalid' | 'remote-diverged';
  readonly receipt?: UsageExportReceipt;
  readonly retryAfterMs?: number;
}
/** Adapters receive only strict, content-free bucket DTOs. Script commands retain ordinary OS-user permissions; this interface is not a sandbox. */
export interface UsageExportAdapter {
  readonly kind: UsageExportTarget['kind'];
  readonly mappingVersion: string;
  readonly capabilities: { readonly absoluteReplace: boolean; readonly delete: boolean; readonly perItemAck: boolean };
  readonly maxBatchItems: number;
  readonly maxBodyBytes: number;
  test(context: UsageExportAdapterContext): Promise<UsageExportAdapterResult>;
  send(batch: UsageExportBatch, context: UsageExportAdapterContext): Promise<UsageExportAdapterResult>;
}
