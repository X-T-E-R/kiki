import { useSyncExternalStore } from 'react';

import { useI18n } from '../i18n';

const TICK_MS = 1_000;
let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(() => {
      current = Date.now();
      for (const active of listeners) active();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return current;
}

/**
 * Shared 1s clock for relative-time displays: one interval for the whole app,
 * running only while at least one consumer is mounted. Components calling this
 * hook re-render on every tick, so their `time.relativeTime(...)` output ages.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Relative time that keeps aging ("just now" → "2m ago") instead of freezing
 * at the value computed on first render.
 */
export function RelativeTime({ at, className }: { readonly at: string; readonly className?: string }) {
  const { time } = useI18n();
  useNow();
  return <span className={className}>{time.relativeTime(at)}</span>;
}
