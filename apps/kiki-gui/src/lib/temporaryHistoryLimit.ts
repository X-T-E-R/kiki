import type { TimelineReadingSnapshot } from './navViewState';

/**
 * TEMPORARY local 0.3.2 hotfix, 2026-10-06: keep opening a large session bounded.
 * Older messages remain available through the explicit one-page load button.
 * Remove this switch when automatic history loading has a measured, bounded policy.
 */
export const TEMPORARY_MANUAL_HISTORY_ONLY = true;

export function openingReadingSnapshot(snapshot: TimelineReadingSnapshot): TimelineReadingSnapshot {
  return TEMPORARY_MANUAL_HISTORY_ONLY
    ? { anchor: { atEnd: true, offset: 0 }, openFolds: [], cardForms: {} }
    : snapshot;
}
