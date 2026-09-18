import type { AgentTokenUsage } from './types';

/**
 * Calculates cache hit rate percentage as a number in [0, 100], rounded to integer.
 *
 * Denominator = cacheReadTokens + 未命中输入 tokens = inputTokens (or cacheRead + cacheWrite if inputTokens missing).
 * Numerator = cacheReadTokens.
 *
 * If denominator <= 0, or cacheRead is null/undefined, or denominator is null/undefined, returns null.
 */
export function calculateCacheHitRate(
  cacheReadTokens: number | null | undefined,
  inputTokens: number | null | undefined,
  cacheWriteTokens?: number | null | undefined,
): number | null {
  if (cacheReadTokens === null || cacheReadTokens === undefined) {
    return null;
  }
  if (!Number.isFinite(cacheReadTokens) || cacheReadTokens < 0) {
    return null;
  }

  // Determine total input tokens (cacheRead + unhit input tokens)
  let totalInput: number | null = null;
  if (inputTokens !== null && inputTokens !== undefined && Number.isFinite(inputTokens)) {
    totalInput = inputTokens;
  } else if (
    cacheWriteTokens !== null &&
    cacheWriteTokens !== undefined &&
    Number.isFinite(cacheWriteTokens)
  ) {
    // fallback if inputTokens is missing but write is present
    totalInput = cacheReadTokens + cacheWriteTokens;
  }

  if (totalInput === null || totalInput <= 0) {
    return null;
  }

  const rate = Math.min(100, Math.max(0, Math.round((cacheReadTokens / totalInput) * 100)));
  return rate;
}

/**
 * Convenience helper for AgentTokenUsage.
 */
export function agentUsageCacheHitRate(usage: AgentTokenUsage | null | undefined): number | null {
  if (!usage) return null;
  return calculateCacheHitRate(usage.cacheReadTokens, usage.inputTokens, usage.cacheWriteTokens);
}

/**
 * Aggregates cache hit rate across multiple agents' metrics.
 * Sums all known cacheReadTokens as numerator, and sums all known inputTokens (or cacheRead+cacheWrite) as denominator.
 * Returns percentage in [0, 100] or null if denominator <= 0.
 */
export function aggregateTreeCacheHitRate(
  agentIds: readonly string[],
  metrics: Readonly<Record<string, {
    cacheReadTokens?: number | null;
    inputTokens?: number | null;
    cacheWriteTokens?: number | null;
  }>>,
): number | null {
  const ids = [...new Set(agentIds)];
  let totalNumerator = 0;
  let totalDenominator = 0;
  let hasKnown = false;

  for (const id of ids) {
    const item = metrics[id];
    if (!item) continue;
    const read = item.cacheReadTokens;
    const input = item.inputTokens;
    const write = item.cacheWriteTokens;

    if (read !== null && read !== undefined && Number.isFinite(read) && read >= 0) {
      let denom: number | null = null;
      if (input !== null && input !== undefined && Number.isFinite(input) && input >= 0) {
        denom = input;
      } else if (write !== null && write !== undefined && Number.isFinite(write) && write >= 0) {
        denom = read + write;
      }

      if (denom !== null && denom > 0) {
        hasKnown = true;
        totalNumerator += read;
        totalDenominator += denom;
      }
    }
  }

  if (!hasKnown || totalDenominator <= 0) {
    return null;
  }

  return Math.min(100, Math.max(0, Math.round((totalNumerator / totalDenominator) * 100)));
}

export function aggregateTreeCacheReadTokens(
  agentIds: readonly string[],
  metrics: Readonly<Record<string, { cacheReadTokens?: number | null }>>,
): number | null {
  const ids = [...new Set(agentIds)];
  let total = 0;
  let hasKnown = false;
  for (const id of ids) {
    const val = metrics[id]?.cacheReadTokens;
    if (val !== null && val !== undefined && Number.isFinite(val) && val >= 0) {
      hasKnown = true;
      total += val;
    }
  }
  return hasKnown ? total : null;
}

export function aggregateTreeCacheWriteTokens(
  agentIds: readonly string[],
  metrics: Readonly<Record<string, { cacheWriteTokens?: number | null }>>,
): number | null {
  const ids = [...new Set(agentIds)];
  let total = 0;
  let hasKnown = false;
  for (const id of ids) {
    const val = metrics[id]?.cacheWriteTokens;
    if (val !== null && val !== undefined && Number.isFinite(val) && val >= 0) {
      hasKnown = true;
      total += val;
    }
  }
  return hasKnown ? total : null;
}
