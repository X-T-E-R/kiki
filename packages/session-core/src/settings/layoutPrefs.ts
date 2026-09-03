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

import type { SessionSortOrder } from '../sessions/sessionList';

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

export const DEFAULT_LAYOUT_PREFERENCES: LayoutPreferences = {
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
    groupBy: isGroupBy(groupBy) ? groupBy : DEFAULT_LAYOUT_PREFERENCES.groupBy,
    sortBy: isSortBy(sortBy) ? sortBy : DEFAULT_LAYOUT_PREFERENCES.sortBy,
    sidebarWidth: clamp(
      typeof sidebarWidth === 'number' ? sidebarWidth : DEFAULT_LAYOUT_PREFERENCES.sidebarWidth,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
    ),
    railWidth: clamp(
      typeof railWidth === 'number' ? railWidth : DEFAULT_LAYOUT_PREFERENCES.railWidth,
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

