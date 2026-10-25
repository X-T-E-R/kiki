import { describe, expect, it } from 'vitest';
import { CompactionProjection } from '../src/facts/compactionProjection';

describe('compaction headline fields', () => {
  it('keeps strategy, fallback and source when the begin record is outside the window', () => {
    const projection = new CompactionProjection();
    const ops = projection.project({
      type: 'context.apply_compaction',
      summary: 'handoff',
      strategy: 'relay',
      fallbackFrom: 'summarize',
      source: 'manual',
      time: 5,
    }, 1);
    expect(ops?.[0]).toMatchObject({
      op: 'marker.upsert',
      item: {
        marker: 'compaction',
        payload: { strategy: 'relay', fallbackFrom: 'summarize', source: 'manual', phase: 'completed' },
      },
    });
  });
});
