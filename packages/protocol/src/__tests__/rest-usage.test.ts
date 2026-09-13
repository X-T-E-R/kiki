import { describe, expect, it } from 'vitest';

import { usageQuerySchema, usageResponseSchema } from '../index';

function response() {
  return {
    query: {
      granularity: 'day',
      range: {
        preset: 'all',
        start_at: null,
        end_at: null,
        defaulted_to_all_history: true,
      },
      dimension: 'model',
      models: [],
      providers: [],
      agent_ids: [],
      workspace_ids: [],
      include_archived: false,
      timezone_offset_minutes: 0,
    },
    summary: {
      tokens: {
        input_other: 0,
        output: 0,
        input_cache_read: 0,
        input_cache_creation: 0,
      },
      cost_usd_estimated: 0,
      cost_unknown: false,
      session_count: 0,
    },
    trend: [],
    sessions: {
      items: [],
      total: 0,
      has_more: false,
      next_page_token: null,
    },
    reliability: {
      complete: true,
      coverage: { earliest_at: null, latest_at: null },
      scanned_sessions: 0,
      incomplete_sessions: 0,
      unknown_price_models: [],
      includes_deleted_sessions: false,
      incomplete_reason: null,
    },
  };
}

describe('usage REST schemas', () => {
  it('accepts additive usage knowledge without requiring it from older servers', () => {
    const baseline = response();
    const enriched = {
      ...baseline,
      summary: { ...baseline.summary, tokens_unknown: true },
      reliability: {
        ...baseline.reliability,
        usage_coverage: { known_records: 2, missing_records: 1, legacy_zero_records: 1 },
      },
    };
    expect(usageResponseSchema.parse(enriched).summary.tokens_unknown).toBe(true);
    expect(usageResponseSchema.parse(enriched).reliability.usage_coverage?.missing_records).toBe(1);
    expect(usageResponseSchema.safeParse(baseline).success).toBe(true);
    expect(usageResponseSchema.safeParse({ ...enriched, reliability: { ...enriched.reliability, usage_coverage: { known_records: 0, missing_records: -1, legacy_zero_records: 0 } } }).success).toBe(false);
  });
  it('parses repeated attribution and workspace filters', () => {
    expect(
      usageQuerySchema.parse({
        model: ['model-a', 'model-b'],
        provider: 'provider-a',
        'agent.id': ['agent-a'],
        'workspace.id': 'workspace-a',
      }),
    ).toMatchObject({
      model: ['model-a', 'model-b'],
      provider: 'provider-a',
      'agent.id': ['agent-a'],
      'workspace.id': 'workspace-a',
    });
  });

  it('requires deleted-session reliability metadata', () => {
    expect(usageResponseSchema.safeParse(response()).success).toBe(true);
    const missingComplete = response();
    const missingDeleted = response();
    delete (missingComplete.reliability as { complete?: boolean }).complete;
    delete (missingDeleted.reliability as { includes_deleted_sessions?: boolean })
      .includes_deleted_sessions;
    expect(usageResponseSchema.safeParse(missingComplete).success).toBe(false);
    expect(usageResponseSchema.safeParse(missingDeleted).success).toBe(false);
  });
});
