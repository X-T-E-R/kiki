import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

function shouldDeferInitially(): boolean {
  if (typeof window === 'undefined') return false;
  if (/jsdom/i.test(window.navigator?.userAgent ?? '')) return false;
  if (window.innerWidth > 767) return false;
  return /^\/(?:p\/[^/]+\/)?s\/[^/]+/.test(window.location.pathname);
}

let deferred = shouldDeferInitially();
let releaseScheduled = false;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let postPaintTimer: ReturnType<typeof setTimeout> | undefined;

function release(): void {
  if (!deferred) return;
  deferred = false;
  if (fallbackTimer !== undefined) {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  }
  if (postPaintTimer !== undefined) {
    clearTimeout(postPaintTimer);
    postPaintTimer = undefined;
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', release, true);
    window.removeEventListener('keydown', release, true);
  }
  for (const listener of listeners) listener();
}

if (deferred && typeof window !== 'undefined') {
  fallbackTimer = setTimeout(release, 3_000);
  window.addEventListener('pointerdown', release, { capture: true, once: true, passive: true });
  window.addEventListener('keydown', release, { capture: true, once: true, passive: true });
}

/**
 * Signal that the first transcript row has mounted so deferred secondary
 * boot queries can hydrate right after the initial transcript frame settles.
 */
export function markTranscriptMounted(): void {
  if (!deferred || releaseScheduled) return;
  releaseScheduled = true;
  postPaintTimer = setTimeout(release, 250);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return deferred;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * True only during the initial cold-open window of a mobile `/s/:id` view
 * before the first transcript frame paints. Secondary background queries
 * (agent profile catalog, executors, plugin slots, external clients, away
 * completion polls) wait for this gate so the session's own transcript gets
 * uncontested network and main-thread priority.
 */
export function useDeferSecondaryBootQueries(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
