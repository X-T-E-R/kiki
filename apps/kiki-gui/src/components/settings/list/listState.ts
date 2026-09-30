/**
 * The settings list pattern, headless half: the view state one long list
 * keeps (query, one filter chip, sort, density, folded groups, selection)
 * and the pure steps that turn items into visible, grouped rows. Pages own
 * their item shape; they hand in how to read a row's text, which filter
 * chips exist, and how to group. Nothing here renders.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

export type ListDensity = 'comfortable' | 'compact';

/** A chip that narrows the list. `all` is implicit and always first. */
export interface ListFilterSpec<T> {
  readonly id: string;
  readonly label: string;
  readonly test: (item: T) => boolean;
  /** `attention` chips draw their count in the attention ink when non-zero. */
  readonly tone?: 'attention';
}

export interface ListSortSpec<T> {
  readonly id: string;
  readonly label: string;
  readonly compare: (a: T, b: T) => number;
}

export interface ListGroupOf<T> {
  readonly key: string;
  readonly label: string;
  readonly items: readonly T[];
  /** Total before filtering, so a header can say "3 of 12". */
  readonly total: number;
}

/** Case-folded, whitespace-split AND match: "gpt sol" finds "axon/gpt-5.6-sol". */
export function matchesQuery(haystack: readonly (string | undefined)[], query: string): boolean {
  const needles = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (needles.length === 0) return true;
  const text = haystack.filter((part): part is string => part !== undefined).join('\n').toLowerCase();
  return needles.every((needle) => text.includes(needle));
}

/**
 * Items → groups, in order. `groupOf` may return several keys (an item that
 * is "in use" and also belongs to its provider). Group order follows
 * `order`, then first appearance. Totals count the unfiltered items.
 */
export function groupItems<T>(
  all: readonly T[],
  visible: readonly T[],
  groupOf: (item: T) => readonly { key: string; label: string }[],
  order: readonly string[] = [],
): ListGroupOf<T>[] {
  const groups = new Map<string, { key: string; label: string; items: T[]; total: number }>();
  const touch = (key: string, label: string) => {
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, label, items: [], total: 0 };
      groups.set(key, group);
    }
    return group;
  };
  for (const item of all) for (const { key, label } of groupOf(item)) touch(key, label).total += 1;
  for (const item of visible) for (const { key, label } of groupOf(item)) touch(key, label).items.push(item);
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  return [...groups.values()]
    .map((group, index) => ({ group, index }))
    .toSorted((a, b) => rank(a.group.key) - rank(b.group.key) || a.index - b.index)
    .map(({ group }) => group);
}

// ---- per-list view prefs, remembered on this device ----

interface StoredListView {
  sort?: string;
  density?: ListDensity;
  folded?: readonly string[];
}

const PREFS_KEY = 'kiki.settingsLists';
const listeners = new Set<() => void>();
let cache: Record<string, StoredListView> | null = null;

function readAll(): Record<string, StoredListView> {
  if (cache !== null) return cache;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFS_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    cache = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, StoredListView> : {};
  } catch {
    cache = {};
  }
  return cache;
}

function writeOne(listId: string, patch: StoredListView) {
  const next = { ...readAll(), [listId]: { ...readAll()[listId], ...patch } };
  cache = next;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private mode: keep in memory */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test hook: forget the cached prefs so the next read goes back to storage. */
export function resetListPrefsCache() {
  cache = null;
}
export interface ListViewOptions<T> {
  /** Stable id: the key the sort / density / folded groups are remembered under. */
  readonly listId: string;
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
  readonly textOf: (item: T) => readonly (string | undefined)[];
  readonly filters?: readonly ListFilterSpec<T>[];
  readonly sorts?: readonly ListSortSpec<T>[];
  readonly defaultDensity?: ListDensity;
}

export interface ListView<T> {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly filter: string;
  readonly setFilter: (id: string) => void;
  readonly sort: string;
  readonly setSort: (id: string) => void;
  readonly density: ListDensity;
  readonly setDensity: (density: ListDensity) => void;
  /** Items after query + filter + sort. */
  readonly visible: readonly T[];
  /** Per filter chip: how many items it would show under the current query. */
  readonly counts: Readonly<Record<string, number>>;
  /** True while the query or a chip narrows the list. */
  readonly narrowed: boolean;
  readonly clear: () => void;
  readonly isFolded: (groupKey: string) => boolean;
  readonly toggleFold: (groupKey: string) => void;
  readonly selected: ReadonlySet<string>;
  readonly toggleSelected: (key: string) => void;
  readonly setSelected: (keys: ReadonlySet<string>) => void;
}

/** View state for one settings list; see the module comment. */
export function useListView<T>({
  listId, items, keyOf, textOf, filters = [], sorts = [], defaultDensity = 'comfortable',
}: ListViewOptions<T>): ListView<T> {
  const stored = useSyncExternalStore(subscribe, () => readAll()[listId], () => undefined);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const sort = sorts.some((spec) => spec.id === stored?.sort) ? stored!.sort! : (sorts[0]?.id ?? '');
  const density = stored?.density ?? defaultDensity;
  const folded = useMemo(() => new Set(stored?.folded ?? []), [stored?.folded]);

  const matched = useMemo(() => items.filter((item) => matchesQuery(textOf(item), query)), [items, textOf, query]);
  const counts = useMemo(() => {
    const out: Record<string, number> = { all: matched.length };
    for (const spec of filters) out[spec.id] = matched.filter(spec.test).length;
    return out;
  }, [matched, filters]);
  const visible = useMemo(() => {
    const chip = filters.find((spec) => spec.id === filter);
    const narrowed = chip === undefined ? matched : matched.filter(chip.test);
    const compare = sorts.find((spec) => spec.id === sort)?.compare;
    return compare === undefined ? narrowed : narrowed.toSorted(compare);
  }, [matched, filters, filter, sorts, sort]);

  // Selection never outlives its rows: a removed or filtered-away item drops out.
  const visibleKeys = useMemo(() => new Set(visible.map(keyOf)), [visible, keyOf]);
  const liveSelected = useMemo(
    () => new Set([...selected].filter((key) => visibleKeys.has(key))),
    [selected, visibleKeys],
  );

  const toggleFold = useCallback((groupKey: string) => {
    const next = new Set(folded);
    if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
    writeOne(listId, { folded: [...next] });
  }, [folded, listId]);

  return {
    query,
    setQuery,
    filter: filters.some((spec) => spec.id === filter) ? filter : 'all',
    setFilter,
    sort,
    setSort: (id) => { writeOne(listId, { sort: id }); },
    density,
    setDensity: (next) => { writeOne(listId, { density: next }); },
    visible,
    counts,
    narrowed: query.trim() !== '' || filter !== 'all',
    clear: () => { setQuery(''); setFilter('all'); },
    // A search reveals matches inside folded groups; folding is for browsing.
    isFolded: (groupKey) => query.trim() === '' && folded.has(groupKey),
    toggleFold,
    selected: liveSelected,
    toggleSelected: (key) => {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
    },
    setSelected,
  };
}