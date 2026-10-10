import { z } from 'zod';

export const transcriptReadSchema = z.object({
  source: z.enum(['live', 'cold', 'derived']),
  readiness: z.enum(['ready', 'preparing', 'partial', 'unavailable']),
  reason: z.enum(['budget', 'projection_lag', 'partial_tail', 'source_unverified', 'source_missing', 'source_changed', 'stale_cursor', 'transport_degraded', 'journal_gap']).optional(),
  watermark: z.object({
    transcript: z.object({ epoch: z.string().optional(), seq: z.number().int().nonnegative() }).optional(),
    history: z.object({ identity: z.string(), throughBytes: z.number().int().nonnegative(), records: z.number().int().nonnegative().optional() }).optional(),
  }).optional(),
  stale: z.object({ reason: z.enum(['source_changed', 'stale_cursor']), retry: z.enum(['authoritative', 'cold', 'resync']) }).optional(),
});

export type TranscriptRead = z.infer<typeof transcriptReadSchema>;

export function transcriptReadForCoverage(source: TranscriptRead['source'], coverage: { readonly kind: 'full' | 'tail' | 'unknown' }, watermark?: TranscriptRead['watermark']): TranscriptRead {
  return { source, readiness: coverage.kind === 'unknown' ? 'partial' : 'ready', reason: coverage.kind === 'unknown' ? 'source_unverified' : undefined, watermark };
}
