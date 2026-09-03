/**
 * Usage formatting helpers shared by the ContextMeter detail card, the
 * transcript turn-tail readout, and the /usage dashboard. The dashboard's
 * aggregation moved server-side with the V2 usage API (`GET /api/v2/usage`;
 * see lib/usageV2 for the client half) — this module keeps only the
 * deterministic, locale-independent formatters.
 */

/**
 * Deterministic USD formatting (no Intl locale drift in tests):
 *   $0.00 · $0.0043 (<$0.01) · $0.432 (<$1) · $12.34 · $1,234.56
 */
export function formatCostUsd(usd: number): string {
  const rounded = Math.max(0, usd);
  if (rounded === 0) return '$0.00';
  if (rounded < 0.01) return `$${rounded.toFixed(4)}`;
  if (rounded < 1) return `$${rounded.toFixed(3)}`;
  // Group the integer part of the rounded string so a carried cent
  // (999.999 → "1000.00") lands in the integer part instead of truncating.
  const [intPart, cents] = rounded.toFixed(2).split('.');
  return `$${formatGrouped(Number(intPart))}.${cents}`;
}

/** Integer with thousands separators, locale-independent: 12,483,201. */
export function formatGrouped(value: number): string {
  return Math.round(value).toString().replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact, locale-independent decode throughput for the turn-tail readout. */
export function formatTokensPerSecond(value: number): string {
  const rate = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (rate < 10) return (Math.round(rate * 10) / 10).toString();
  return Math.round(rate).toString();
}
