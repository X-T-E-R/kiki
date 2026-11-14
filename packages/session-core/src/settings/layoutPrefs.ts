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

import { isSessionSortOrder, type SessionSortOrder } from '../sessions/sessionList';

/** Status filter chips: executing, awaiting input, cleanup unconfirmed, or idle. */
export type SessionStatusFilter = 'running' | 'needs-me' | 'cleanup-pending' | 'idle';
/** Archived visibility: hidden (default), included, or archived only. */
export type SessionArchivedFilter = 'hide' | 'include' | 'only';
/** Private visibility: hidden (default), included, or private only. */
export type SessionPrivateFilter = 'hide' | 'include' | 'only';

export interface SessionListFilters {
  /** Empty = any status; several = OR within the dimension. */
  status: readonly SessionStatusFilter[];
  /** Empty = every workspace; several = OR within the dimension. */
  workspaces: readonly string[];
  archived: SessionArchivedFilter;
  /** Undefined or `hide` excludes private sessions; `include` shows all; `only` shows private only. */
  private?: SessionPrivateFilter;
}

export const DEFAULT_SESSION_LIST_FILTERS: SessionListFilters = {
  status: [],
  workspaces: [],
  archived: 'hide',
};

export interface SessionListPreferences {
  /** `time` (recency buckets), `workspace` (one bucket per workspace) or
   * `none` (one flat list in the chosen sort order). */
  groupBy: 'time' | 'workspace' | 'none';
  sortBy: SessionSortOrder;
  filters: SessionListFilters;
}

/** Sidebar navigation destinations the user can show or tuck away. */
export type SidebarNavKey = 'cron' | 'memory' | 'personas' | 'usage' | 'capabilities' | 'discover';

export const ALL_SIDEBAR_NAV_KEYS: readonly SidebarNavKey[] = [
  'cron',
  'memory',
  'personas',
  'usage',
  'capabilities',
  'discover',
];

/** Scheduled tasks, capabilities and discovery start in "More
 * tools"; memory, personas and usage lead the navigation. */
export const DEFAULT_PINNED_NAV_ITEMS: readonly SidebarNavKey[] = [
  'memory',
  'personas',
  'usage',
];

const PHONE_PINNED_NAV_ITEMS: readonly SidebarNavKey[] = [];

/**
 * The pinned tools a device shows. A phone that has never saved a choice
 * starts with none pinned, so its drawer opens on the conversation list
 * rather than a column of tool rows; any saved choice — made on the device
 * or brought in by a settings import — wins everywhere.
 *
 * "Never saved" is the default list itself, by identity: reading storage
 * without a stored list yields `DEFAULT_PINNED_NAV_ITEMS`, while a stored,
 * imported or chosen list is always an array of its own, even when it holds
 * the same three entries.
 */
export function shownPinnedNavItems(
  preferences: Pick<LayoutPreferences, 'pinnedNavItems'>,
  phone: boolean,
): readonly SidebarNavKey[] {
  return phone && preferences.pinnedNavItems === DEFAULT_PINNED_NAV_ITEMS
    ? PHONE_PINNED_NAV_ITEMS
    : preferences.pinnedNavItems;
}

export interface LayoutPreferences extends SessionListPreferences {
  /** Sidebar (left) width in px. */
  sidebarWidth: number;
  /** Right rail width in px (the conversation /s/:id right panel). */
  railWidth: number;
  /**
   * Manual collapsed override for desktop left sidebar.
   * `undefined`: follow automatic responsive breakpoint (>=1280 expanded, 768-1279 collapsed).
   * `boolean`: user explicit toggle choice overriding automatic breakpoint.
   */
  sidebarCollapsed?: boolean;
  /**
   * Last open/closed choice for the docked right rail (wide layouts only; the
   * narrow overlay rail opens per visit).
   * `undefined`: follow the `railOpenByDefault` setting.
   * `boolean`: the user's explicit toggle, kept across sessions and reloads.
   */
  railOpen?: boolean;
  /**
   * Navigation destinations shown directly in the primary nav. The rest are
   * tucked into the secondary "More tools" section below it.
   */
  pinnedNavItems: readonly SidebarNavKey[];
  /** Whether that secondary navigation section is folded. Default: folded. */
  sidebarNavSectionCollapsed?: boolean;
  /** Whether the sidebar persona group is folded. Default: expanded (`false`). */
  sidebarPersonaSectionCollapsed?: boolean;
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
  filters: DEFAULT_SESSION_LIST_FILTERS,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  railWidth: RAIL_DEFAULT_WIDTH,
  pinnedNavItems: DEFAULT_PINNED_NAV_ITEMS,
  sidebarNavSectionCollapsed: true,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isGroupBy(value: unknown): value is LayoutPreferences['groupBy'] {
  return value === 'time' || value === 'workspace' || value === 'none';
}

function isSortBy(value: unknown): value is SessionSortOrder {
  return isSessionSortOrder(value);
}

const STATUS_FILTERS: readonly SessionStatusFilter[] = ['running', 'needs-me', 'cleanup-pending', 'idle'];

/** Tolerant nav read: unknown or duplicated entries drop out, and a malformed
 * value falls back to the default set instead of emptying the nav. */
export function parsePinnedNavItems(value: unknown): readonly SidebarNavKey[] {
  if (!Array.isArray(value)) return DEFAULT_PINNED_NAV_ITEMS;
  const valid = ALL_SIDEBAR_NAV_KEYS;
  const parsed = [...new Set(value.filter((item): item is SidebarNavKey => typeof item === 'string' && (valid as readonly string[]).includes(item)))];
  return parsed;
}

/** Tolerant filter read: unknown entries drop out instead of voiding the set. */
export function parseSessionListFilters(value: unknown): SessionListFilters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_SESSION_LIST_FILTERS;
  const record = value as Record<string, unknown>;
  const status = Array.isArray(record['status'])
    ? STATUS_FILTERS.filter((entry) => (record['status'] as unknown[]).includes(entry))
    : [];
  const workspaces = Array.isArray(record['workspaces'])
    ? [...new Set((record['workspaces'] as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry !== ''))]
    : [];
  const archivedRaw = record['archived'];
  const archived: SessionArchivedFilter =
    archivedRaw === 'include' || archivedRaw === 'only' ? archivedRaw : 'hide';
  const privateRaw = record['private'];
  const privateFilter: SessionPrivateFilter =
    privateRaw === 'include' || privateRaw === 'only' ? privateRaw : 'hide';
  return privateFilter === 'hide'
    ? { status, workspaces, archived }
    : { status, workspaces, archived, private: privateFilter };
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
  const sidebarCollapsed = stored['sidebarCollapsed'];
  const railOpen = stored['railOpen'];
  const pinnedNavItems = parsePinnedNavItems(stored['pinnedNavItems']);
  const sidebarNavSectionCollapsed = typeof stored['sidebarNavSectionCollapsed'] === 'boolean'
    ? stored['sidebarNavSectionCollapsed']
    : DEFAULT_LAYOUT_PREFERENCES.sidebarNavSectionCollapsed;
  const sidebarPersonaSectionCollapsed = typeof stored['sidebarPersonaSectionCollapsed'] === 'boolean'
    ? stored['sidebarPersonaSectionCollapsed']
    : undefined;
  return {
    groupBy: isGroupBy(groupBy) ? groupBy : DEFAULT_LAYOUT_PREFERENCES.groupBy,
    sortBy: isSortBy(sortBy) ? sortBy : DEFAULT_LAYOUT_PREFERENCES.sortBy,
    filters: parseSessionListFilters(stored['filters']),
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
    sidebarCollapsed: typeof sidebarCollapsed === 'boolean' ? sidebarCollapsed : undefined,
    railOpen: typeof railOpen === 'boolean' ? railOpen : undefined,
    pinnedNavItems,
    sidebarNavSectionCollapsed,
    ...(sidebarPersonaSectionCollapsed !== undefined ? { sidebarPersonaSectionCollapsed } : {}),
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

/** Test-only: drop the cached snapshot so the next read comes from storage. */
export function resetLayoutPreferencesForTests(): void {
  snapshotCache = undefined;
}

export function writeLayoutPreferences(patch: Partial<LayoutPreferences>): LayoutPreferences {
  const current = layoutPreferencesSnapshot();
  const next: LayoutPreferences = {
    ...current,
    ...patch,
    sidebarWidth: clamp(patch.sidebarWidth ?? current.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    railWidth: clamp(patch.railWidth ?? current.railWidth, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH),
    sidebarCollapsed: patch.sidebarCollapsed !== undefined ? patch.sidebarCollapsed : current.sidebarCollapsed,
    railOpen: patch.railOpen !== undefined ? patch.railOpen : current.railOpen,
    pinnedNavItems: patch.pinnedNavItems !== undefined
      ? parsePinnedNavItems(patch.pinnedNavItems)
      : current.pinnedNavItems,
    sidebarNavSectionCollapsed: patch.sidebarNavSectionCollapsed !== undefined
      ? patch.sidebarNavSectionCollapsed
      : current.sidebarNavSectionCollapsed,
    ...(patch.sidebarPersonaSectionCollapsed !== undefined
      ? { sidebarPersonaSectionCollapsed: patch.sidebarPersonaSectionCollapsed }
      : current.sidebarPersonaSectionCollapsed !== undefined
        ? { sidebarPersonaSectionCollapsed: current.sidebarPersonaSectionCollapsed }
        : {}),
  };
  // Every write stores the whole record, so an unrelated write (a width, the
  // grouping) would otherwise save the default tool list as if it had been
  // chosen. Only a list someone actually set is stored; the default stays
  // implicit, which is what lets a phone apply its own (`shownPinnedNavItems`).
  const { pinnedNavItems: _unsavedDefault, ...withoutPinned } = next;
  const stored = next.pinnedNavItems === DEFAULT_PINNED_NAV_ITEMS ? withoutPinned : next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage is a convenience; in-memory state remains authoritative.
  }
  return publish(next);
}

export function setSidebarPersonaSectionCollapsed(collapsed: boolean): LayoutPreferences {
  return writeLayoutPreferences({ sidebarPersonaSectionCollapsed: collapsed });
}
