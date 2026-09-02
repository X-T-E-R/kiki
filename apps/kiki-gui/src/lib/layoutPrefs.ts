/**
 * Local panel-layout preferences: sidebar + right-rail pixel widths and the
 * session-list grouping/sorting selection, all persisted to `localStorage`
 * under one `kiki.layout` key. This mirrors the `kiki.settings` pattern in
 * `lib/settings.ts` — a tiny pub/sub with a cached snapshot so components can
 * `useSyncExternalStore` without re-reading storage on every render.
 *
 * Widths are clamped to sensible min/max bounds on read and write so a stale
 * or hand-edited value can never paint a broken layout. Container width is
 * passed into the drag path so the stored value stays inside the viewport even
 * after a window resize.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { SessionSortOrder } from './sessionList';

export interface SessionListPreferences {
  /** `time` (four recency buckets) or `workspace` (one bucket per workspace). */
  groupBy: 'time' | 'workspace';
  sortBy: SessionSortOrder;
}

export interface LayoutPreferences extends SessionListPreferences {
  /** Sidebar (left) width in px. */
  sidebarWidth: number;
  /** Right rail width in px (the conversation /s/:id right panel). */
  railWidth: number;
}

export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

export const RAIL_DEFAULT_WIDTH = 300;
export const RAIL_MIN_WIDTH = 240;
export const RAIL_MAX_WIDTH = 520;

const STORAGE_KEY = 'kiki.layout';

const DEFAULTS: LayoutPreferences = {
  groupBy: 'time',
  sortBy: 'updated-desc',
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  railWidth: RAIL_DEFAULT_WIDTH,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isGroupBy(value: unknown): value is LayoutPreferences['groupBy'] {
  return value === 'time' || value === 'workspace';
}

function isSortBy(value: unknown): value is SessionSortOrder {
  return value === 'updated-desc' || value === 'updated-asc' || value === 'title';
}

function readObject(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readLayoutPreferences(): LayoutPreferences {
  const stored = readObject(STORAGE_KEY);
  const groupBy = stored['groupBy'];
  const sortBy = stored['sortBy'];
  const sidebarWidth = stored['sidebarWidth'];
  const railWidth = stored['railWidth'];
  return {
    groupBy: isGroupBy(groupBy) ? groupBy : DEFAULTS.groupBy,
    sortBy: isSortBy(sortBy) ? sortBy : DEFAULTS.sortBy,
    sidebarWidth: clamp(
      typeof sidebarWidth === 'number' ? sidebarWidth : DEFAULTS.sidebarWidth,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
    ),
    railWidth: clamp(
      typeof railWidth === 'number' ? railWidth : DEFAULTS.railWidth,
      RAIL_MIN_WIDTH,
      RAIL_MAX_WIDTH,
    ),
  };
}

const listeners = new Set<() => void>();
let snapshotCache: LayoutPreferences | undefined;

function publish(next: LayoutPreferences): LayoutPreferences {
  snapshotCache = next;
  for (const listener of listeners) listener();
  return next;
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.storageArea !== undefined && event.storageArea !== null) {
    try {
      if (event.storageArea !== localStorage) return;
    } catch {
      return;
    }
  }
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  publish(readLayoutPreferences());
}

let storageListening = false;
function attachStorageListener(): void {
  if (storageListening) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('storage', handleStorageEvent);
  storageListening = true;
}

function detachStorageListener(): void {
  if (!storageListening) return;
  if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    window.removeEventListener('storage', handleStorageEvent);
  }
  storageListening = false;
}

export function subscribeLayoutPreferences(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) attachStorageListener();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detachStorageListener();
  };
}

export function layoutPreferencesSnapshot(): LayoutPreferences {
  snapshotCache ??= readLayoutPreferences();
  return snapshotCache;
}

export function writeLayoutPreferences(patch: Partial<LayoutPreferences>): LayoutPreferences {
  const current = layoutPreferencesSnapshot();
  const next: LayoutPreferences = {
    ...current,
    ...patch,
    sidebarWidth: clamp(patch.sidebarWidth ?? current.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    railWidth: clamp(patch.railWidth ?? current.railWidth, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage is a convenience; in-memory state remains authoritative.
  }
  return publish(next);
}

export function useLayoutPreferences(): LayoutPreferences {
  const getSnapshot = useCallback(() => layoutPreferencesSnapshot(), []);
  const getServerSnapshot = useCallback(() => DEFAULTS, []);
  return useSyncExternalStore(subscribeLayoutPreferences, getSnapshot, getServerSnapshot);
}

/**
 * Pointer-drag width hook. Returns the current width (kept in a CSS variable
 * by the caller), a `startResize` pointer-down handler for the grab handle,
 * and a `reset` callback (double-click) that restores the default. `final`
 * reports whether the pointer has been released, so the caller can persist
 * only once per gesture.
 */
export function usePaneResize(options: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number, final: boolean) => void;
  onReset?: () => void;
  /** +1 for a left-edge handle (drag right grows), -1 for a right-edge. */
  direction?: 1 | -1;
}) {
  const { value, min, max, onChange, onReset, direction = 1 } = options;

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Only the primary button drags.
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startValue = value;
      handle.setPointerCapture(event.pointerId);

      const up = () => {
        onChange(clamp(valueRef, min, max), true);
        handle.removeEventListener('pointermove', trackedMove);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      // Track the latest value so `up` persists the final width even when the
      // last move event was coalesced out.
      let valueRef = startValue;
      const trackedMove = (moveEvent: Event) => {
        const clientX = (moveEvent as PointerEvent).clientX;
        valueRef = clamp(startValue + (clientX - startX) * direction, min, max);
        onChange(valueRef, false);
      };
      handle.addEventListener('pointermove', trackedMove);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    },
    [value, min, max, onChange, direction],
  );

  const reset = useCallback(() => {
    onReset?.();
  }, [onReset]);

  return { startResize, reset };
}