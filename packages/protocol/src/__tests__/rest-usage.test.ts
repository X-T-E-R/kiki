import { describe, expect, it } from 'vitest';

import { usageQuerySchema, usageResponseSchema, usagePricingQuerySchema, usagePricingResponseSchema, usagePricingUpdateSchema } from '../index';

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
  it('validates per-token currency prices and supports explicit override removal', () => {
    const price = { input_cost_per_token: 0, output_cost_per_token: 0.01, currency: 'USD' };
    expect(usagePricingUpdateSchema.parse({ overrides: { model: price, removed: null } })).toEqual({ overrides: { model: price, removed: null } });
    for (const invalid of [NaN, Infinity, -1]) {
      expect(usagePricingUpdateSchema.safeParse({ overrides: { model: { ...price, input_cost_per_token: invalid } } }).success).toBe(false);
    }
    expect(usagePricingUpdateSchema.safeParse({ overrides: { model: { ...price, currency: 'usd' } } }).success).toBe(false);
    expect(usagePricingQuerySchema.parse({ model: ['proxy/model', 'unknown'] }).model).toEqual(['proxy/model', 'unknown']);
    expect(usagePricingResponseSchema.parse({ items: [{ model: 'unknown', pricing_model: null, matched_key: null, source: 'unknown', prices: null }], overrides: {} }).items[0]?.source).toBe('unknown');
  });
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
  it('accepts additive bucket counts and session attribution from the server', () => {
    const baseline = response();
    const aggregate = baseline.summary;
    const enriched = {
      ...baseline,
      trend: [{
        key: '0', start_at: 0, end_at: 1, turn_count: 2, request_count: 3,
        groups: [], drilldown: { sessions: [], sessions_truncated: false },
      }],
      sessions: {
        ...baseline.sessions,
        items: [{
          id: 's', workspace_id: 'w', title: null, created_at: 0, updated_at: 0,
          archived: false, deleted: false, usage: aggregate, unknown_price_models: [],
          primary_model: 'model-a', profile_names: ['reviewer', 'worker'],
        }],
      },
    };
    expect(usageResponseSchema.parse(enriched).trend[0]?.request_count).toBe(3);
    expect(usageResponseSchema.parse(enriched).sessions.items[0]?.profile_names).toEqual(['reviewer', 'worker']);
    expect(usageResponseSchema.safeParse({ ...enriched, trend: [{ ...enriched.trend[0], turn_count: -1 }] }).success).toBe(false);
  });

  it('accepts native source dimensions and additive profile filters while retaining old responses', () => {
    for (const dimension of ['agent', 'model', 'project', 'session', 'provider', 'profile']) {
      expect(usageQuerySchema.parse({ dimension, profile: ['explore', 'general'] })).toEqual({
        dimension, profile: ['explore', 'general'],
      });
      const baseline = response();
      expect(usageResponseSchema.parse({ ...baseline, query: { ...baseline.query, dimension, profiles: ['explore'] } }).query.profiles).toEqual(['explore']);
    }
    expect(usageQuerySchema.parse({ profile: 'explore' }).profile).toBe('explore');
    expect(usageResponseSchema.parse(response()).query.profiles).toBeUndefined();
    for (const profile of ['', [], ['']]) {
      expect(usageQuerySchema.safeParse({ profile }).success).toBe(false);
    }
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
