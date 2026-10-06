import { describe, expect, it } from 'vitest';
import { contextStrategyStatusSchema, contextStrategyWriteSchema } from '../contextStrategy';
import { compactSessionRequestSchema, compactSessionResponseSchema } from '../rest/session';
import { compactionResultSchema, compactionStartedEventSchema, compactionCompletedEventSchema, compactionCancelledEventSchema } from '../events';

describe('context strategy wire contract', () => {
  it('accepts a session selection or clear, and a global sync', () => {
    expect(contextStrategyWriteSchema.parse({ strategy: 'fresh' })).toEqual({ strategy: 'fresh' });
    expect(contextStrategyWriteSchema.parse({ strategy: null })).toEqual({ strategy: null });
    expect(contextStrategyWriteSchema.parse({ strategy: 'auto', save: 'global' })).toEqual({ strategy: 'auto', save: 'global' });
    expect(contextStrategyWriteSchema.safeParse({ strategy: 'relay' }).success).toBe(false);
    expect(contextStrategyStatusSchema.parse({ strategy: 'summarize', source: 'default', shadow: false }).strategy).toBe('summarize');
  });

  it('keeps old compact calls valid and carries optional relay metadata', () => {
    expect(compactSessionRequestSchema.parse({})).toEqual({});
    expect(compactSessionRequestSchema.parse({ strategy: 'relay' })).toEqual({ strategy: 'relay' });
    const previous = { summary: 'old', compactedCount: 1, tokensBefore: 20, tokensAfter: 10 };
    expect(compactionResultSchema.parse(previous)).toEqual(previous);
    expect(compactionResultSchema.parse({ ...previous, strategy: 'relay', shapeVersion: 1,
      reasonCodes: ['notes_previous_window'], fallbackFrom: 'summarize' })).toMatchObject({ strategy: 'relay', shapeVersion: 1 });
  });

  it('preserves manual queue receipts and event attribution while accepting older servers', () => {
    expect(compactSessionResponseSchema.parse({})).toEqual({});
    const queued = { accepted: true, status: 'queued', source: 'manual' };
    expect(compactSessionResponseSchema.parse(queued)).toEqual(queued);
    const started = { type: 'compaction.started', trigger: 'manual', phase: 'queued' };
    expect(compactionStartedEventSchema.parse(started)).toEqual(started);
    const result = { summary: 'summary', compactedCount: 2, tokensBefore: 30, tokensAfter: 10 };
    expect(compactionCompletedEventSchema.parse({ type: 'compaction.completed', trigger: 'manual', result })).toEqual({ type: 'compaction.completed', trigger: 'manual', result });
    expect(compactionCancelledEventSchema.parse({ type: 'compaction.cancelled', trigger: 'manual', reason: 'No safe prefix' })).toEqual({ type: 'compaction.cancelled', trigger: 'manual', reason: 'No safe prefix' });
    expect(compactionCompletedEventSchema.parse({ type: 'compaction.completed', result })).toEqual({ type: 'compaction.completed', result });
  });
});
