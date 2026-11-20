import { existsSync } from 'node:fs';

import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import {
  installNativeFsWatchErrorGuard,
  isNativeFsWatchErrorGuardInstalled,
  setNativeFsWatchErrorReporter,
} from '#/_base/utils/nativeFsWatchErrorGuard';

installNativeFsWatchErrorGuard();
setNativeFsWatchErrorReporter(onUnexpectedError);

interface ChokidarRawWatcher {
  on(event: 'raw', listener: (eventName: string, path: string, details: unknown) => void): unknown;
  unwatch(paths: string | readonly string[]): unknown;
}

const DELETED_WATCH_BURST_WINDOW_MS = 100;
const DELETED_WATCH_BURST_THRESHOLD = 4;
const DELETED_WATCH_TRACKED_CAP = 256;

export function guardChokidarDeletedWatchSpin(
  watcher: ChokidarRawWatcher,
  exists: (path: string) => boolean = existsSync,
): void {
  const bursts = new Map<string, { start: number; count: number }>();
  watcher.on('raw', (eventName: string, _path: string, details: unknown) => {
    if (eventName !== 'rename' && eventName !== 'change') return;
    const watchedPath = typeof details === 'object' && details !== null && 'watchedPath' in details
      ? (details as { readonly watchedPath?: unknown }).watchedPath
      : undefined;
    if (typeof watchedPath !== 'string' || watchedPath.length === 0) return;
    const now = performance.now();
    const prev = bursts.get(watchedPath);
    if (prev === undefined || now - prev.start > DELETED_WATCH_BURST_WINDOW_MS) {
      if (bursts.size >= DELETED_WATCH_TRACKED_CAP) bursts.clear();
      bursts.set(watchedPath, { start: now, count: 1 });
      return;
    }
    prev.count += 1;
    if (prev.count < DELETED_WATCH_BURST_THRESHOLD) return;
    bursts.delete(watchedPath);
    if (!exists(watchedPath)) {
      void watcher.unwatch(watchedPath);
    }
  });
}

export function createDeletedRootSpinDetector(
  root: string,
  exists: (path: string) => boolean = existsSync,
): () => boolean {
  let windowStart = 0;
  let count = 0;
  return () => {
    const now = performance.now();
    if (count === 0 || now - windowStart > DELETED_WATCH_BURST_WINDOW_MS) {
      windowStart = now;
      count = 1;
      return false;
    }
    count += 1;
    if (count < DELETED_WATCH_BURST_THRESHOLD) return false;
    count = 0;
    return !exists(root);
  };
}

export { installNativeFsWatchErrorGuard, isNativeFsWatchErrorGuardInstalled };
