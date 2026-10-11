import type { LocateOutcome } from './timelineLocate';
import type { TimelineReadingSnapshot } from './navViewState';

export interface TimelineReadingAdapter {
  /** Commit folds/card forms and await the existing renderer's next measured frame. */
  readonly applyFolds: (snapshot: TimelineReadingSnapshot) => void | Promise<void>;
  /** Resolve stable row keys against the current virtualizer/locate index (no DOM scan). */
  readonly hasAnchor: (key: string) => boolean;
  readonly hasMore: () => boolean;
  readonly loadOlder: () => Promise<boolean>;
  readonly hasLoadError: () => boolean;
  readonly nextFrame: () => Promise<void>;
  /** Existing scrollToOffset(row.start + offset), or landAtEnd for atEnd. */
  readonly restoreAnchor: (anchor: TimelineReadingSnapshot['anchor']) => void | Promise<void>;
  /** Pause initial landing/append following while paging an old reading position. */
  readonly beginRestore: (atEnd: boolean) => void;
  readonly endRestore: (outcome: LocateOutcome) => void;
  readonly isCancelled?: () => boolean;
}

/** A failed page is retryable; exhaustion alone proves a deleted/missing anchor. */
export async function restoreTimelineReading(
  snapshot: TimelineReadingSnapshot,
  adapter: TimelineReadingAdapter,
): Promise<LocateOutcome> {
  if (adapter.isCancelled?.()) return { status: 'no-timeline' };
  let outcome: LocateOutcome = { status: 'load-failed' };
  adapter.beginRestore(snapshot.anchor.atEnd);
  try {
    await adapter.applyFolds(snapshot);
    const key = snapshot.anchor.key;
    if (!snapshot.anchor.atEnd) {
      if (key === undefined) return outcome = { status: 'not-found' };
      while (!adapter.hasAnchor(key)) {
        if (adapter.isCancelled?.()) return outcome = { status: 'no-timeline' };
        if (!adapter.hasMore()) return outcome = { status: 'not-found' };
        // Deliberately try again despite a previous error; the existing paging owner resets it.
        const loaded = await adapter.loadOlder();
        for (let frame = 0; frame < 4; frame += 1) await adapter.nextFrame();
        if (adapter.hasLoadError()) return outcome;
        if (!loaded && !adapter.hasAnchor(key)) return outcome;
      }
    }
    if (adapter.isCancelled?.()) return outcome = { status: 'no-timeline' };
    await adapter.restoreAnchor(snapshot.anchor);
    return outcome = { status: 'found' };
  } catch {
    return outcome;
  } finally {
    adapter.endRestore(outcome);
  }
}
