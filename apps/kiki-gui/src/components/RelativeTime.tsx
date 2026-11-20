import { useSyncExternalStore } from 'react';

import { useI18n } from '../i18n';

function clock(intervalMs: number) {
  let current = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let visibilityBound = false;
  const listeners = new Set<() => void>();
  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const tick = () => {
    current = Date.now();
    for (const active of listeners) active();
  };
  const start = () => {
    if (timer !== undefined || listeners.size === 0) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    current = Date.now();
    timer = setInterval(tick, intervalMs);
  };
  const onVisibility = () => {
    if (listeners.size === 0) return;
    if (document.visibilityState === 'hidden') {
      stop();
    } else {
      tick();
      start();
    }
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!visibilityBound && typeof document !== 'undefined') {
        visibilityBound = true;
        document.addEventListener('visibilitychange', onVisibility);
      }
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => current,
  };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const seconds = clock(1_000);
const minutes = clock(60_000);
const secondsSubscribe = (listener: () => void): (() => void) => seconds.subscribe(listener);
const secondsSnapshot = (): number => seconds.getSnapshot();
const minutesSubscribe = (listener: () => void): (() => void) => minutes.subscribe(listener);
const minutesSnapshot = (): number => minutes.getSnapshot();

/** Shared second clock for live elapsed-duration and countdown displays. */
export function useNow(): number {
  return useSyncExternalStore(secondsSubscribe, secondsSnapshot, secondsSnapshot);
}

const idleSubscribe = (): (() => void) => () => {};
const idleSnapshot = (): number => 0;

/**
 * Live milliseconds since `anchor`, ticking once a second. Only a caller with
 * an anchor joins the clock, so a list can hand this to every row and pay a
 * re-render per second for the running ones alone.
 */
export function useElapsedSince(anchor: number | undefined): number | undefined {
  const ticking = anchor !== undefined;
  const now = useSyncExternalStore(
    ticking ? secondsSubscribe : idleSubscribe,
    ticking ? secondsSnapshot : idleSnapshot,
    ticking ? secondsSnapshot : idleSnapshot,
  );
  return anchor === undefined ? undefined : Math.max(0, now - anchor);
}

/**
 * Relative time that keeps aging ("just now" → "2m ago") instead of freezing
 * at the value computed on first render. Timestamps older than a week render a
 * fixed calendar date and need no timer subscription.
 */
export function RelativeTime({ at, className }: { readonly at: string; readonly className?: string }) {
  const { time } = useI18n();
  const ageMs = Date.now() - Date.parse(at);
  const recent = ageMs < 60_000;
  const staticDate = Number.isNaN(ageMs) || ageMs >= SEVEN_DAYS_MS;
  useSyncExternalStore(
    staticDate ? idleSubscribe : recent ? secondsSubscribe : minutesSubscribe,
    staticDate ? idleSnapshot : recent ? secondsSnapshot : minutesSnapshot,
    staticDate ? idleSnapshot : recent ? secondsSnapshot : minutesSnapshot,
  );
  return <span className={className}>{time.relativeTime(at)}</span>;
}
