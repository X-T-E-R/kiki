import { describe, expect, it } from 'vitest';
import { contextStrategyStatusSchema, contextStrategyWriteSchema } from '../contextStrategy';
import { compactSessionRequestSchema } from '../rest/session';
import { compactionResultSchema } from '../events';

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
});
