/**
 * One compaction, one timeline marker.
 *
 * A single compaction reaches the store through several producers: the live
 * bus adds progress markers (`phase: started | blocked | cancelled |
 * completed`), and the durable `context.apply_compaction` record can be
 * replayed by more than one wire adapter (live binding + cold backfill), each
 * minting its own ordinal-based marker id. Rendering all of them stacks four
 * or five identical "Context compacted" lines at the same spot.
 *
 * This pass picks exactly one marker per compaction, keyed by the summary the
 * compaction produced (unique per run), and prefers the durable record so the
 * marker carries the real strategy and the record's own time. Progress-only
 * markers are hidden, except a `started` run that has not settled yet, which
 * renders as the in-flight "Compacting context…" line.
 */

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
    if (phase === 'cancelled') {
      fates.set(item.markerId, 'hidden');
      continue;
    }
    const summary = summaryOf(payload);
    if (summary === undefined) continue;
    const durable = payload?.['type'] === 'context.apply_compaction';
    const keeper = keeperBySummary.get(summary);
    if (keeper === undefined) {
      keeperBySummary.set(summary, { markerId: item.markerId, durable });
      continue;
    }
    if (durable && !keeper.durable) {
      fates.set(keeper.markerId, 'hidden');
      keeperBySummary.set(summary, { markerId: item.markerId, durable });
      continue;
    }
    fates.set(item.markerId, 'hidden');
  }
  return fates;
}
