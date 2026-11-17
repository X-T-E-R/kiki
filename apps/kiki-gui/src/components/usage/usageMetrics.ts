import type { UsagePricingResponse } from '@kiki/protocol';

import {
  USAGE_SOURCE_KEY_UNKNOWN,
  type UsageGroupBy,
  type UsageResponseWire,
  type UsageTrendBucketWire,
} from '../../lib/usageV2';

export interface ActivityCounts {
  readonly turns: number;
  readonly requests: number;
  readonly hasTurns: boolean;
  readonly hasRequests: boolean;
}

export function summarizeActivityCounts(trend: readonly UsageTrendBucketWire[]): ActivityCounts {
  let turns = 0;
  let requests = 0;
  let hasTurns = false;
  let hasRequests = false;
  for (const bucket of trend) {
    if (typeof bucket.turn_count === 'number' && Number.isFinite(bucket.turn_count)) {
      turns += bucket.turn_count;
      hasTurns = true;
    }
    if (typeof bucket.request_count === 'number' && Number.isFinite(bucket.request_count)) {
      requests += bucket.request_count;
      hasRequests = true;
    }
  }
  return { turns, requests, hasTurns, hasRequests };
}

export function avgCostPerTurn(
  summary: UsageResponseWire['summary'],
  activity: ActivityCounts,
): number | undefined {
  if (summary.cost_unknown || !activity.hasTurns || activity.turns <= 0) return undefined;
  return summary.cost_usd_estimated / activity.turns;
}

/**
 * Estimates USD saved by cache hits compared to paying full base-input price.
 * Only returns a figure when pricing is resolved in USD with both base input
 * and cache-read rates for every model contributing non-zero cache reads;
 * partial or missing pricing returns undefined so savings are never fabricated.
 */
export function computeCacheSavingsUsd(
  trend: readonly UsageTrendBucketWire[],
  pricingItems: readonly UsagePricingResponse['items'][number][] | undefined,
  groupBy: UsageGroupBy = 'model',
): number | undefined {
  if (pricingItems === undefined || pricingItems.length === 0) return undefined;
  const priceByModel = new Map(pricingItems.map((item) => [item.model, item.prices]));
  let totalSaved = 0;
  let sawCacheRead = false;

  for (const bucket of trend) {
    for (const group of bucket.groups) {
      const cacheRead = group.tokens.input_cache_read;
      if (cacheRead <= 0) continue;
      sawCacheRead = true;

      const modelId =
        group.model_alias ??
        (groupBy === 'model' &&
        group.key !== USAGE_SOURCE_KEY_UNKNOWN &&
        !group.key.startsWith('provider:') &&
        !group.key.startsWith('profile:')
          ? group.key
          : null);
      if (modelId === null) return undefined;

      const prices = priceByModel.get(modelId);
      if (
        prices === undefined ||
        prices === null ||
        prices.currency !== 'USD' ||
        typeof prices.cache_read_input_token_cost !== 'number'
      ) {
        return undefined;
      }
      const deltaPerToken = prices.input_cost_per_token - prices.cache_read_input_token_cost;
      if (deltaPerToken > 0) {
        totalSaved += cacheRead * deltaPerToken;
      }
    }
  }

  return sawCacheRead && totalSaved > 0 ? totalSaved : undefined;
}
