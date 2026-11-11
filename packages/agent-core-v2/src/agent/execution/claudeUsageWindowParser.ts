export interface ClaudeUsageWindow {
  readonly id: string;
  readonly kind: 'session' | 'weekly' | 'monthly';
  readonly label: string;
  readonly windowDurationMins?: number;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt?: string;
}

const WINDOWS = {
  five_hour: { kind: 'session', label: 'Session', windowDurationMins: 5 * 60 },
  seven_day: { kind: 'weekly', label: 'Weekly', windowDurationMins: 7 * 24 * 60 },
  seven_day_overage_included: { kind: 'weekly', label: 'Weekly · Overage included', windowDurationMins: 7 * 24 * 60 },
} as const;

/**
 * Reads get_usage percentages (0–100) and streamed rate_limit_info utilization (0–1).
 * Adapted from T3 Code's MIT claudeUsageLimits.ts as a dependency-free parser.
 */
export function parseClaudeUsageWindows(value: unknown): readonly ClaudeUsageWindow[] {
  const root = objectOf(value);
  if (root === undefined) return [];
  const limits = objectOf(root['rate_limits'] ?? root['rateLimits']) ?? root;
  const windows: ClaudeUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS) as Array<keyof typeof WINDOWS>) {
    const bucket = objectOf(limits[id]);
    const used = percent(bucket?.['utilization']);
    if (used !== undefined) windows.push(makeWindow(id, used, iso(bucket?.['resets_at'])));
  }
  const scoped = limits['model_scoped'];
  if (Array.isArray(scoped)) {
    for (const raw of scoped) {
      const entry = objectOf(raw);
      const name = entry?.['display_name'];
      const used = percent(entry?.['utilization']);
      if (typeof name !== 'string' || !name.trim() || used === undefined) continue;
      windows.push({
        id: `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        kind: 'weekly', label: `Weekly · ${name}`, windowDurationMins: 7 * 24 * 60,
        usedPercent: used, remainingPercent: 100 - used, resetsAt: iso(entry?.['resets_at']),
      });
    }
  }
  const spend = readSpendPercent(limits);
  if (spend !== undefined) windows.push({
    id: 'monthly_spend', kind: 'monthly', label: 'Monthly spend',
    usedPercent: spend, remainingPercent: 100 - spend,
  });
  const info = objectOf(root['rate_limit_info'] ?? root['rateLimitInfo']) ?? root;
  const type = info['rateLimitType'] ?? info['rate_limit_type'];
  const utilization = info['utilization'];
  if (typeof type === 'string' && Object.hasOwn(WINDOWS, type) &&
      typeof utilization === 'number') {
    const used = percent(utilization * 100);
    if (used !== undefined) windows.push(makeWindow(type as keyof typeof WINDOWS, used,
      iso(info['resetsAt'] ?? info['resets_at'])));
  }
  return windows;
}

function makeWindow(id: keyof typeof WINDOWS, usedPercent: number, resetsAt: string | undefined): ClaudeUsageWindow {
  return { id, ...WINDOWS[id], usedPercent, remainingPercent: 100 - usedPercent, resetsAt };
}

function readSpendPercent(limits: Readonly<Record<string, unknown>>): number | undefined {
  const spend = objectOf(limits['spend']);
  const used = objectOf(spend?.['used']);
  const limit = objectOf(spend?.['limit']);
  const currency = used?.['currency'];
  if (spend?.['enabled'] === true && typeof currency === 'string' && currency.trim() &&
      currency.trim() === (typeof limit?.['currency'] === 'string' ? limit['currency'].trim() : '') &&
      typeof used?.['exponent'] === 'number' && Number.isInteger(used['exponent']) && used['exponent'] >= 0 &&
      used['exponent'] === limit?.['exponent']) {
    const result = percentFromAmounts(used?.['amount_minor'], limit?.['amount_minor']);
    if (result !== undefined) return result;
  }
  const extra = objectOf(limits['extra_usage']);
  if (extra?.['is_enabled'] !== true) return undefined;
  return percentFromAmounts(extra['used_credits'], extra['monthly_limit']) ?? percent(extra['utilization']);
}

function percentFromAmounts(used: unknown, limit: unknown): number | undefined {
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 &&
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? percent(used / limit * 100) : undefined;
}

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(100, value) : undefined;
}

function iso(value: unknown): string | undefined {
  const time = typeof value === 'number' ? value * 1000
    : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time < 8.64e15 ? new Date(time).toISOString() : undefined;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
}
