export interface NavScopeIdentity {
  readonly homeId: string;
  readonly scopeId: string;
  readonly serverHomeId?: string;
  readonly connectionRef?: string;
}

export interface NavVisitMeta {
  readonly visitId: string;
  readonly scope: NavScopeIdentity;
  readonly label?: string;
  readonly backLabel?: string;
  readonly intent?: string;
  readonly timestamp: number;
}

export interface NavSnapshot {
  readonly visitId: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly scope: NavScopeIdentity;
  readonly label?: string;
  readonly ui?: Record<string, unknown>;
  readonly timestamp: number;
}

export interface NavHistoryEntry {
  readonly visitId: string;
  /** Confirmed whole-entity deletion; retain its Router ordinal, not a second stack. */
  readonly missing?: true;
  readonly key?: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly scope: NavScopeIdentity;
  readonly label?: string;
}

const STORAGE_KEY = 'kiki.navHistory.v1';
const SNAPSHOT_LIMIT = 100;
let visitCounter = 0;
let entries: NavHistoryEntry[] = [];
let currentIndex = -1;
let hydrated = false;
let locationConfirmed = false;
const snapshots = new Map<string, NavSnapshot>();
const listeners = new Set<() => void>();
let revision = 0;

export function subscribeNavHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getNavHistoryRevision(): number {
  return revision;
}

function notifyNavigation(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is NavScopeIdentity {
  return isRecord(value) && typeof value['homeId'] === 'string' && typeof value['scopeId'] === 'string' &&
    (value['serverHomeId'] === undefined || typeof value['serverHomeId'] === 'string') &&
    (value['connectionRef'] === undefined || typeof value['connectionRef'] === 'string');
}
export function cloneNavScope(scope: NavScopeIdentity): NavScopeIdentity {
  return { homeId: scope.homeId, scopeId: scope.scopeId, serverHomeId: scope.serverHomeId, connectionRef: scope.connectionRef };
}

function isEntry(value: unknown): value is NavHistoryEntry {
  return isRecord(value) && typeof value['visitId'] === 'string' && value['visitId'] !== '' &&
    typeof value['pathname'] === 'string' && typeof value['search'] === 'string' &&
    typeof value['hash'] === 'string' && isScope(value['scope']) &&
    (value['key'] === undefined || typeof value['key'] === 'string') &&
    (value['missing'] === undefined || value['missing'] === true) &&
    (value['label'] === undefined || typeof value['label'] === 'string');
}

function isSnapshot(value: unknown): value is NavSnapshot {
  return isEntry(value) && isRecord(value) && typeof value['timestamp'] === 'number' &&
    Number.isFinite(value['timestamp']) && (value['ui'] === undefined || isRecord(value['ui']));
}

function trimSnapshots(): void {
  while (snapshots.size > SNAPSHOT_LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!isRecord(saved) || saved['version'] !== 1) return;
    const storedEntries = saved['entries'];
    const index = saved['currentIndex'];
    if (Array.isArray(storedEntries) && storedEntries.every(isEntry) &&
      new Set(storedEntries.map((entry) => entry.visitId)).size === storedEntries.length &&
      typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < storedEntries.length) {
      entries = storedEntries.map((entry) => ({ ...entry, scope: cloneNavScope(entry.scope) }));
      currentIndex = index;
    }
    if (Array.isArray(saved['snapshots'])) {
      for (const snapshot of saved['snapshots']) {
        if (!isSnapshot(snapshot)) continue;
        snapshots.delete(snapshot.visitId);
        snapshots.set(snapshot.visitId, { ...snapshot, scope: cloneNavScope(snapshot.scope) });
      }
      trimSnapshots();
    }
  } catch {
    // Navigation remains usable with disabled storage or a corrupt older cache.
  }
}

function persist(): void {
  try {
    // An unserializable adapter snapshot must not prevent history metadata saving.
    const serializable: NavSnapshot[] = [];
    for (const snapshot of snapshots.values()) {
      try {
        const copy: unknown = JSON.parse(JSON.stringify(snapshot));
        if (isSnapshot(copy)) serializable.push(copy);
      } catch {
        // Keep this snapshot in memory only (for example, a cyclic UI object).
      }
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      entries,
      currentIndex,
      snapshots: serializable,
    }));
  } catch {
    // Quota and security errors must not interrupt navigation or restoration.
  }
}

export function createVisitId(): string {
  return `v_${Date.now()}_${++visitCounter}`;
}

function newVisitId(): string {
  let visitId = createVisitId();
  while (entries.some((entry) => entry.visitId === visitId) || snapshots.has(visitId)) visitId = createVisitId();
  return visitId;
}

/** Observe Router navigation; this store never pushes or traverses browser history. */
export function recordNavigation(params: {
  location: { pathname: string; search: string; hash: string; state?: unknown; key?: string };
  scope: NavScopeIdentity;
  label?: string;
  action?: 'PUSH' | 'POP' | 'REPLACE';
  replace?: boolean;
}): NavHistoryEntry {
  hydrate();
  const { location, scope } = params;
  const state = isRecord(location.state) ? location.state : undefined;
  // kikiNav is the shared Router user-state metadata field. Direct visitId is
  // also accepted for callers that only need to associate a visit identity.
  const meta = isRecord(state?.['kikiNav']) ? state['kikiNav'] : state;
  const suppliedId = typeof meta?.['visitId'] === 'string' && meta['visitId'] !== '' ? meta['visitId'] : undefined;
  const label = params.label ?? (typeof meta?.['label'] === 'string' ? meta['label'] : undefined);
  let action = params.action ?? (params.replace ? 'REPLACE' : 'PUSH');
  let matchedIndex = suppliedId === undefined ? -1 : entries.findIndex((entry) => entry.visitId === suppliedId);
  if (matchedIndex === -1 && location.key !== undefined) {
    matchedIndex = entries.findIndex((entry) => entry.key === location.key);
  }

  // Persisted entries are only a cache. A cold/foreign history entry does not
  // acquire a fabricated predecessor, even if sessionStorage was inherited.
  if (!locationConfirmed) {
    const match = entries[matchedIndex];
    const confirmed = match !== undefined && (suppliedId === match.visitId ||
      (location.key !== 'default' && match.pathname === location.pathname &&
        match.search === location.search && match.hash === location.hash));
    if (!confirmed) {
      entries = [];
      currentIndex = -1;
      matchedIndex = -1;
    }
    locationConfirmed = true;
    if (confirmed) {
      currentIndex = matchedIndex;
      action = 'POP';
    }
  }

  const previous = entries[currentIndex];
  const sameObservation = previous !== undefined &&
    (location.key !== undefined ? location.key === previous.key : suppliedId === previous.visitId) &&
    previous.pathname === location.pathname && previous.search === location.search && previous.hash === location.hash &&
    !isCrossScopeNavigation(previous.scope, scope);

  let entry: NavHistoryEntry;
  if (action === 'POP' && matchedIndex !== -1) {
    currentIndex = matchedIndex;
    const matched = entries[matchedIndex]!;
    // Scope belongs to the history entry, not the backend active during POP.
    const verifiedScope = isCrossScopeNavigation(matched.scope, scope) ? matched.scope :
      { ...matched.scope, serverHomeId: scope.serverHomeId ?? matched.scope.serverHomeId, connectionRef: scope.connectionRef ?? matched.scope.connectionRef };
    entry = { ...matched, scope: verifiedScope, key: location.key ?? matched.key, pathname: location.pathname,
      search: location.search, hash: location.hash, label: label ?? matched.label };
    entries[currentIndex] = entry;
  } else if ((action === 'REPLACE' || sameObservation) && previous !== undefined) {
    const visitId = suppliedId === undefined || suppliedId === previous.visitId ? previous.visitId :
      entries.some((candidate) => candidate.visitId === suppliedId) ? newVisitId() : suppliedId;
    entry = { visitId, key: location.key, pathname: location.pathname, search: location.search,
      hash: location.hash, scope: cloneNavScope(scope), label: label ?? previous.label };
    entries[currentIndex] = entry;
  } else {
    const visitId = suppliedId !== undefined && !entries.some((candidate) => candidate.visitId === suppliedId) ? suppliedId : newVisitId();
    entry = { visitId, key: location.key, pathname: location.pathname, search: location.search,
      hash: location.hash, scope: cloneNavScope(scope), label };
    if (action === 'POP') {
      // An untracked POP may be outside Kiki or predates observation. Its
      // relative position is unknown, so start a safe segment, never append it.
      entries = [entry];
      currentIndex = 0;
    } else {
      entries = entries.slice(0, currentIndex + 1);
      entries.push(entry);
      currentIndex = entries.length - 1;
    }
  }
  const snapshot = snapshots.get(entry.visitId);
  if (snapshot !== undefined) {
    snapshots.set(entry.visitId, { ...snapshot, pathname: entry.pathname, search: entry.search,
      hash: entry.hash, scope: entry.scope, label: entry.label });
  }
  persist();
  notifyNavigation();
  return entry;
}

export function canGoBack(): boolean {
  return getBackEntry() !== null;
}

export function canGoForward(): boolean {
  return locationConfirmed && currentIndex >= 0 && currentIndex < entries.length - 1;
}

export function getCurrentVisit(): NavHistoryEntry | null {
  return locationConfirmed ? entries[currentIndex] ?? null : null;
}

/** Resolve POP/reload before App's layout observation, so restoration wins first landing. */
export function getVisitForLocation(location: { key: string; pathname: string; search: string; hash: string; state?: unknown }): NavHistoryEntry | null {
  hydrate();
  const state = isRecord(location.state) ? location.state : undefined;
  const meta = isRecord(state?.['kikiNav']) ? state['kikiNav'] : undefined;
  const entry = entries.find((candidate) => meta?.['visitId'] === candidate.visitId ||
    ((locationConfirmed || location.key !== 'default') && candidate.key === location.key));
  return entry !== undefined && entry.pathname === location.pathname && entry.search === location.search && entry.hash === location.hash ? entry : null;
}

/** Metadata traversal only: validate at most the candidate demanded by this return. */
export function getPreviousVisit(visitId: string): NavHistoryEntry | null {
  if (!locationConfirmed) return null;
  const index = entries.findIndex((entry) => entry.visitId === visitId);
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (entries[previous]?.missing !== true) return entries[previous] ?? null;
  }
  return null;
}

export function markVisitMissing(visitId: string): void {
  const index = entries.findIndex((entry) => entry.visitId === visitId);
  if (index === -1 || entries[index]?.missing === true) return;
  entries[index] = { ...entries[index]!, missing: true };
  snapshots.delete(visitId);
  persist();
  notifyNavigation();
}

/** Compute from the still-current registered Router segment, never from pathname. */
export function getVisitDelta(visitId: string, source: NavHistoryEntry): number | null {
  const current = getCurrentVisit();
  if (current?.visitId !== source.visitId || current.key !== source.key) return null;
  const index = entries.findIndex((entry) => entry.visitId === visitId);
  return index === -1 ? null : index - currentIndex;
}

export function getBackEntry(): NavHistoryEntry | null {
  const current = getCurrentVisit();
  return current === null ? null : getPreviousVisit(current.visitId);
}

export function getForwardEntry(): NavHistoryEntry | null {
  return canGoForward() ? entries[currentIndex + 1] ?? null : null;
}

export function getBackLabel(defaultLabel?: string): string | undefined {
  return getBackEntry()?.label ?? defaultLabel;
}

/** Partial snapshots use recorded route metadata; unknown visits need a full route and scope. */
export function saveSnapshot(visitId: string, snapshot: Partial<NavSnapshot>): void {
  hydrate();
  const previous = snapshots.get(visitId);
  const entry = entries.find((candidate) => candidate.visitId === visitId);
  const value = { ...entry, ...previous, ...snapshot, visitId, timestamp: snapshot.timestamp ?? Date.now() };
  if (!isSnapshot(value)) return;
  snapshots.delete(visitId);
  snapshots.set(visitId, { ...value, scope: cloneNavScope(value.scope), ui: value.ui === undefined ? undefined : { ...value.ui } });
  trimSnapshots();
  persist();
}

export function getSnapshot(visitId: string): NavSnapshot | undefined {
  hydrate();
  const snapshot = snapshots.get(visitId);
  if (snapshot !== undefined) {
    snapshots.delete(visitId);
    snapshots.set(visitId, snapshot);
    persist();
  }
  return snapshot;
}

export function clearNavHistory(): void {
  entries = [];
  currentIndex = -1;
  snapshots.clear();
  hydrated = true;
  locationConfirmed = false;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // In-memory reset is still effective when storage is inaccessible.
  }
  notifyNavigation();
}

export function saveUiSnapshot(visitId: string, uiPatch: Record<string, unknown>): void {
  const ui = getSnapshot(visitId)?.ui;
  saveSnapshot(visitId, { ui: { ...ui, ...uiPatch } });
}

export function getUiSnapshot<T = Record<string, unknown>>(visitId: string): T | undefined {
  return getSnapshot(visitId)?.ui as T | undefined;
}

/** Render-time reads must not serialize all snapshots on every streaming publish. */
export function peekUiSnapshot(visitId: string): Record<string, unknown> | undefined {
  hydrate();
  return snapshots.get(visitId)?.ui;
}

export function saveScrollPosition(visitId: string, selector: string, top: number, left?: number): void {
  if (!Number.isFinite(top) || (left !== undefined && !Number.isFinite(left))) return;
  const ui = getUiSnapshot(visitId);
  const positions = isRecord(ui?.['scrollPositions']) ? ui['scrollPositions'] : {};
  saveUiSnapshot(visitId, { scrollPositions: { ...positions, [selector]: { top, left } } });
}

export function getScrollPosition(visitId: string, selector: string): { top: number; left?: number } | undefined {
  const positions = getUiSnapshot(visitId)?.['scrollPositions'];
  if (!isRecord(positions) || !Object.hasOwn(positions, selector)) return undefined;
  const position = positions[selector];
  if (!isRecord(position) || typeof position['top'] !== 'number' || !Number.isFinite(position['top']) ||
    (position['left'] !== undefined && (typeof position['left'] !== 'number' || !Number.isFinite(position['left'])))) return undefined;
  return { top: position['top'], left: position['left'] as number | undefined };
}

export function isCrossScopeNavigation(fromScope: NavScopeIdentity, toScope: NavScopeIdentity): boolean {
  return fromScope.homeId !== toScope.homeId || fromScope.scopeId !== toScope.scopeId;
}
