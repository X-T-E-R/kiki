/**
 * The settings list pattern, headless half: the view state one long list
 * keeps (query, one filter chip, sort, density, folded groups, selection)
 * and the pure steps that turn items into visible, grouped rows. Pages own
 * their item shape; they hand in how to read a row's text, which filter
 * chips exist, and how to group. Nothing here renders.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

export type ListDensity = 'comfortable' | 'compact';

/** Above this many rows a list windows its body; below it every row stays mounted. */
export const VIRTUALIZE_AFTER = 60;

/**
 * The list-tools threshold (settings conventions §3, design rule 2). A list
 * shorter than this is read at a glance, so it gets no search, no row-density
 * switch and no filter chips: three rows under a search box and five chips is
 * furniture, not help. Pages do not pick their own number; this is the one.
 */
export const LIST_TOOLS_MIN_ITEMS = 8;

/** Which list tools a list earns; `listToolsFor` decides, the toolbar obeys. */
export interface ListTools {
  /** The search field (with its count) and the row-density switch. */
  readonly search: boolean;
  /** The filter chips. */
  readonly filters: boolean;
  /** The chips worth drawing: those that divide the list (some rows, not all). */
  readonly filterIds: readonly string[];
  /** The sort switch. */
  readonly sort: boolean;
}

/**
 * Search once a list reaches `LIST_TOOLS_MIN_ITEMS`; filter chips only then and
 * only when a chip actually divides the list (at least two kinds, or a problem
 * chip that some rows match and others do not) — a chip that matches every row
 * or none narrows nothing; sort only when the page says order changes what the
 * reader concludes. Judged on the whole list, never on what a query left, so
 * the tools do not vanish while someone is typing.
 */
export function listToolsFor<T>(
  items: readonly T[],
  filters: readonly ListFilterSpec<T>[],
  sorts: readonly ListSortSpec<T>[],
  orderMatters: boolean,
): ListTools {
  const long = items.length >= LIST_TOOLS_MIN_ITEMS;
  // "Accounts 0" beside "API 8" is not a choice, and neither is "API 8" when
  // every row is an API: only a chip that splits the list is drawn.
  const filterIds = long
    ? filters.filter((spec) => {
      const matched = items.filter(spec.test).length;
      return matched > 0 && matched < items.length;
    }).map((spec) => spec.id)
    : [];
  return {
    search: long,
    filters: filterIds.length > 0,
    filterIds,
    sort: orderMatters && sorts.length > 1,
  };
}

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
  /**
   * The page says the order of this list changes what the reader concludes
   * (newest failure first, say), so the sort switch is offered. Without it
   * the list keeps the first sort's order and shows no switch.
   */
  readonly orderMatters?: boolean;
  readonly defaultDensity?: ListDensity;
}

export interface ListView<T> {
  /** The tools this list has earned; the toolbar draws only these. */
  readonly tools: ListTools;
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
  /**
   * Selection mode, entered only from an explicit "Select" action (the
   * toolbar's `selectLabel` button). Rows show their check boxes only while it
   * is on; leaving it drops the selection.
   */
  readonly selecting: boolean;
  readonly setSelecting: (on: boolean) => void;
}

/** View state for one settings list; see the module comment. */
export function useListView<T>({
  listId, items, keyOf, textOf, filters = [], sorts = [], orderMatters = false, defaultDensity = 'comfortable',
}: ListViewOptions<T>): ListView<T> {
  const stored = useSyncExternalStore(subscribe, () => readAll()[listId], () => undefined);
  const [rawQuery, setQuery] = useState('');
  const [rawFilter, setFilter] = useState('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [selecting, setSelectingState] = useState(false);
  const tools = useMemo(() => listToolsFor(items, filters, sorts, orderMatters), [items, filters, sorts, orderMatters]);
  // A tool the list has not earned has no effect either: a query typed before
  // the list shrank, a chip picked back then or a sort remembered from a longer
  // list must not keep narrowing or reordering rows with no control in sight.
  const query = tools.search ? rawQuery : '';
  const filter = tools.filterIds.includes(rawFilter) ? rawFilter : 'all';
  const sort = tools.sort && sorts.some((spec) => spec.id === stored?.sort) ? stored!.sort! : (sorts[0]?.id ?? '');
  const density = tools.search ? stored?.density ?? defaultDensity : defaultDensity;
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
    tools,
    query,
    setQuery,
    filter,
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
    selecting,
    setSelecting: (on) => {
      setSelectingState(on);
      if (!on) setSelected(new Set());
    },
  };
}