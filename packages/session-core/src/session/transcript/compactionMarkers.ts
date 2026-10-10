/** Reconciles legacy live/replayed markers; durable commits with equal summaries at different times remain separate runs. */

export type CompactionMarkerFate = 'hidden' | 'pending';

interface MarkerLike {
  readonly kind: string;
  readonly markerId?: string;
  readonly marker?: string;
  readonly payload?: unknown;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function summaryOf(payload: Record<string, unknown> | undefined): string | undefined {
  const direct = payload?.['summary'];
  if (typeof direct === 'string' && direct !== '') return direct;
  const nested = recordOf(payload?.['result'])?.['summary'];
  return typeof nested === 'string' && nested !== '' ? nested : undefined;
}

/**
 * Marker ids that must not render as-is: `hidden` drops the marker, `pending`
 * turns it into the in-flight line. Markers absent from the map render
 * normally.
 */
export function compactionMarkerFates(items: readonly MarkerLike[]): ReadonlyMap<string, CompactionMarkerFate> {
  const fates = new Map<string, CompactionMarkerFate>();
  const keeperBySummary = new Map<string, { readonly markerId: string; readonly durable: boolean }>();
  let openStart: string | undefined;
  for (const item of items) {
    // A later turn means the run is over even if its settle event was lost.
    if (item.kind === 'turn' && openStart !== undefined) {
      fates.set(openStart, 'hidden');
      openStart = undefined;
    }
    if (item.kind !== 'marker' || item.marker !== 'compaction' || item.markerId === undefined) continue;
    const payload = recordOf(item.payload);
    const phase = payload?.['phase'];
    if (phase === 'started') {
      if (openStart !== undefined) fates.set(openStart, 'hidden');
      openStart = item.markerId;
      fates.set(item.markerId, 'pending');
      continue;
    }
    if (phase === 'blocked') {
      fates.set(item.markerId, 'hidden');
      continue;
    }
    if (openStart !== undefined) {
      fates.set(openStart, 'hidden');
      openStart = undefined;
    }
    const summary = summaryOf(payload);
    if (summary === undefined) continue;
    const durable = payload?.['type'] === 'context.apply_compaction';
    const key = durable ? `${String(payload?.['time'] ?? item.markerId)}\0${summary}` : summary;
    const bySummary = keeperBySummary.get(summary);
    const keeper = keeperBySummary.get(key) ?? (durable && bySummary?.durable ? undefined : bySummary);
    if (keeper === undefined) {
      keeperBySummary.set(key, { markerId: item.markerId, durable });
      if (durable) keeperBySummary.set(summary, { markerId: item.markerId, durable });
      continue;
    }
    if (durable && !keeper.durable) {
      fates.set(keeper.markerId, 'hidden');
      keeperBySummary.set(key, { markerId: item.markerId, durable });
      keeperBySummary.set(summary, { markerId: item.markerId, durable });
      continue;
    }
    fates.set(item.markerId, 'hidden');
  }
  return fates;
}
