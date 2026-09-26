import { useSyncExternalStore } from 'react';

import { useI18n } from '../i18n';

function clock(intervalMs: number) {
  let current = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (timer === undefined) {
        current = Date.now();
        timer = setInterval(() => {
          current = Date.now();
          for (const active of listeners) active();
        }, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => current,
  };
}

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

/**
 * Relative time that keeps aging ("just now" → "2m ago") instead of freezing
 * at the value computed on first render.
 */
export function RelativeTime({ at, className }: { readonly at: string; readonly className?: string }) {
  const { time } = useI18n();
  const recent = Date.now() - Date.parse(at) < 60_000;
  useSyncExternalStore(
    recent ? secondsSubscribe : minutesSubscribe,
    recent ? secondsSnapshot : minutesSnapshot,
    recent ? secondsSnapshot : minutesSnapshot,
  );
  return <span className={className}>{time.relativeTime(at)}</span>;
}
