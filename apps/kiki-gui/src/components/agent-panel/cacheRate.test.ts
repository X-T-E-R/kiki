import { describe, expect, it } from 'vitest';
import {
  calculateCacheHitRate,
  agentUsageCacheHitRate,
  aggregateTreeCacheHitRate,
} from './cacheRate';
import type { AgentTokenUsage } from './types';

describe('calculateCacheHitRate', () => {
  it('returns null when cacheReadTokens is null or undefined', () => {
    expect(calculateCacheHitRate(null, 100)).toBeNull();
    expect(calculateCacheHitRate(undefined, 100)).toBeNull();
  });

  it('returns null when denominator is 0', () => {
    expect(calculateCacheHitRate(0, 0)).toBeNull();
    expect(calculateCacheHitRate(0, null, 0)).toBeNull();
  });

  it('returns percentage rounded to nearest integer when denominator > 0', () => {
    // 68 / 100 = 68%
    expect(calculateCacheHitRate(68, 100)).toBe(68);
    // 684 / 1000 = 68%
    expect(calculateCacheHitRate(684, 1000)).toBe(68);
    // 686 / 1000 = 69%
    expect(calculateCacheHitRate(686, 1000)).toBe(69);
    // 100 / 100 = 100%
    expect(calculateCacheHitRate(100, 100)).toBe(100);
    // 0 / 100 = 0% (if input is 100 and cache read is 0, denominator is 100 > 0, rate is 0%)
    expect(calculateCacheHitRate(0, 100)).toBe(0);
  });

  it('falls back to cacheRead + cacheWrite if inputTokens is missing', () => {
    expect(calculateCacheHitRate(60, null, 40)).toBe(60);
    expect(calculateCacheHitRate(60, undefined, 40)).toBe(60);
  });

  it('handles negative or invalid values gracefully', () => {
    expect(calculateCacheHitRate(-10, 100)).toBeNull();
    expect(calculateCacheHitRate(10, -50)).toBeNull();
  });
});

describe('agentUsageCacheHitRate', () => {
  it('returns null when usage is undefined or null', () => {
    expect(agentUsageCacheHitRate(undefined)).toBeNull();
    expect(agentUsageCacheHitRate(null)).toBeNull();
  });

  it('calculates rate from AgentTokenUsage object', () => {
    const usage: AgentTokenUsage = {
      contextTokens: 1000,
      contextLimit: 8000,
      totalTokens: 500,
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 150,
      cacheWriteTokens: 50,
      totalCostUsd: 0.01,
      compactionCount: 0,
    };
    // 150 / 200 = 75%
    expect(agentUsageCacheHitRate(usage)).toBe(75);
  });

  it('returns null if denominator is 0', () => {
    const usage: AgentTokenUsage = {
      contextTokens: null,
      contextLimit: null,
      totalTokens: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: null,
      compactionCount: null,
    };
    expect(agentUsageCacheHitRate(usage)).toBeNull();
  });
});

describe('aggregateTreeCacheHitRate', () => {
  it('aggregates across multiple agents summing numerator and denominator, not averaging rates', () => {
    // Agent 1: 10 read / 100 input (10%)
    // Agent 2: 900 read / 1000 input (90%)
    // Average of rates would be (10 + 90) / 2 = 50%
    // True aggregated rate: (10 + 900) / (100 + 1000) = 910 / 1100 = 82.7% -> 83%
    const metrics = {
      main: {
        cacheReadTokens: 10,
        inputTokens: 100,
        cacheWriteTokens: 20,
      },
      sub1: {
        cacheReadTokens: 900,
        inputTokens: 1000,
        cacheWriteTokens: 100,
      },
    };
    const rate = aggregateTreeCacheHitRate(['main', 'sub1'], metrics);
    expect(rate).toBe(83);
  });

  it('returns null when total denominator is 0 or all agents have null/0', () => {
    const metrics = {
      main: {
        cacheReadTokens: null,
        inputTokens: null,
      },
      sub1: {
        cacheReadTokens: 0,
        inputTokens: 0,
      },
    };
    expect(aggregateTreeCacheHitRate(['main', 'sub1'], metrics)).toBeNull();
  });

  it('skips unknown or negative agent metrics', () => {
    const metrics = {
      main: {
        cacheReadTokens: 50,
        inputTokens: 100,
      },
      sub1: {
        cacheReadTokens: null,
        inputTokens: 200,
      },
      sub2: {
        cacheReadTokens: -10,
        inputTokens: 50,
      },
    };
    // Only main is valid: 50 / 100 = 50%
    expect(aggregateTreeCacheHitRate(['main', 'sub1', 'sub2'], metrics)).toBe(50);
  });
});
