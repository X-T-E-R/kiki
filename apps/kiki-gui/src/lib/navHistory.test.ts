import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavHistoryEntry, NavScopeIdentity } from './navHistory';

type NavHistory = typeof import('./navHistory');
const scope: NavScopeIdentity = { homeId: 'main', scopeId: 'local' };
const otherScope: NavScopeIdentity = { homeId: 'other-home', scopeId: 'remote' };
const storageKey = 'kiki.navHistory.v1';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

let nav: NavHistory;
let storage: MemoryStorage;

function visit(pathname: string, key: string, options: {
  action?: 'PUSH' | 'POP' | 'REPLACE';
  state?: unknown;
  scope?: NavScopeIdentity;
  label?: string;
  search?: string;
  hash?: string;
  replace?: boolean;
} = {}): NavHistoryEntry {
  return nav.recordNavigation({
    location: { pathname, key, search: options.search ?? '', hash: options.hash ?? '', state: options.state },
    scope: options.scope ?? scope,
    action: options.action,
    label: options.label,
    replace: options.replace,
  });
}

function pop(entry: NavHistoryEntry, key = entry.key): NavHistoryEntry {
  return nav.recordNavigation({
    location: { ...entry, key, state: { kikiNav: { visitId: entry.visitId } } },
    scope: entry.scope,
    action: 'POP',
  });
}

async function reload(): Promise<void> {
  vi.resetModules();
  nav = await import('./navHistory');
}

beforeEach(async () => {
  storage = new MemoryStorage();
  vi.stubGlobal('sessionStorage', storage);
  await reload();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Router-aligned visits', () => {
  it('notifies subscribers after PUSH, REPLACE, POP and clear have committed', () => {
    const observed: Array<{ revision: number; back: boolean; path?: string }> = [];
    const unsubscribe = nav.subscribeNavHistory(() => {
      observed.push({ revision: nav.getNavHistoryRevision(), back: nav.canGoBack(), path: nav.getCurrentVisit()?.pathname });
    });
    const first = visit('/settings/general', 'a');
    visit('/usage', 'b');
    visit('/usage', 'c', { action: 'REPLACE', search: '?panel=history' });
    pop(first);
    nav.clearNavHistory();
    expect(observed.map((value) => value.back)).toEqual([false, true, true, false, false]);
    expect(observed.map((value) => value.path)).toEqual(['/settings/general', '/usage', '/usage', '/settings/general', undefined]);
    expect(new Set(observed.map((value) => value.revision)).size).toBe(5);
    unsubscribe();
    visit('/new', 'd');
    expect(observed).toHaveLength(5);
  });

  it('has no registered source before observing a location', () => {
    expect(nav.getCurrentVisit()).toBeNull();
    expect(nav.canGoBack()).toBe(false);
    expect(nav.canGoForward()).toBe(false);
    expect(nav.getBackEntry()).toBeNull();
    expect(nav.getForwardEntry()).toBeNull();
  });

  it('starts a cold deep link at index zero without a fake back entry', () => {
    const cold = visit('/s/example-session', 'default', { action: 'POP', search: '?turn=example-turn', hash: '#block' });
    expect(nav.getCurrentVisit()).toEqual(cold);
    expect(cold).toMatchObject({ pathname: '/s/example-session', search: '?turn=example-turn', hash: '#block', scope });
    expect(nav.canGoBack()).toBe(false);
    expect(nav.getBackEntry()).toBeNull();
    expect(nav.canGoForward()).toBe(false);
    expect(JSON.parse(storage.getItem(storageKey)!).currentIndex).toBe(0);
  });

  it('tracks A → B → C, POP back/forward, and discards C after PUSH from B', () => {
    const a = visit('/activity', 'a', { label: 'Activity' });
    const b = visit('/usage', 'b', { label: 'Usage' });
    const c = visit('/settings/ai', 'c');
    expect(new Set([a.visitId, b.visitId, c.visitId]).size).toBe(3);
    expect(nav.getCurrentVisit()).toEqual(c);
    expect(nav.canGoBack()).toBe(true);
    expect(nav.getBackEntry()).toEqual(b);
    expect(nav.getBackLabel()).toBe('Usage');
    expect(nav.canGoForward()).toBe(false);

    pop(b);
    expect(nav.getCurrentVisit()).toEqual(b);
    expect(nav.getBackEntry()).toEqual(a);
    expect(nav.canGoBack()).toBe(true);
    expect(nav.getForwardEntry()).toEqual(c);
    expect(nav.canGoForward()).toBe(true);
    pop(c);
    expect(nav.getCurrentVisit()).toEqual(c);
    pop(b);
    const d = visit('/memory', 'd');
    expect(nav.getCurrentVisit()).toEqual(d);
    expect(nav.canGoForward()).toBe(false);
    expect(nav.getForwardEntry()).toBeNull();
    expect(JSON.parse(storage.getItem(storageKey)!).entries.map((entry: NavHistoryEntry) => entry.visitId))
      .toEqual([a.visitId, b.visitId, d.visitId]);
    pop(b);
    expect(nav.getForwardEntry()).toEqual(d);
    pop(a);
    expect(nav.canGoBack()).toBe(false);
    expect(nav.getForwardEntry()).toEqual(b);
  });

  it('matches a POP by router key when no metadata is available', () => {
    const a = visit('/activity', 'a');
    visit('/usage', 'b');
    expect(visit('/activity', 'a', { action: 'POP' })).toEqual(a);
    expect(nav.canGoBack()).toBe(false);
    expect(nav.canGoForward()).toBe(true);
  });

  it('matches a POP by visitId when the router key changes', () => {
    const a = visit('/activity', 'a');
    visit('/usage', 'b');
    const restored = pop(a, 'reloaded-a');
    expect(restored.visitId).toBe(a.visitId);
    expect(restored.key).toBe('reloaded-a');
    expect(nav.canGoBack()).toBe(false);
    expect(nav.canGoForward()).toBe(true);
  });

  it('treats repeated observation of the same router entry as idempotent', () => {
    const a = visit('/activity', 'a');
    expect(visit('/activity', 'a')).toEqual(a);
    expect(nav.canGoBack()).toBe(false);
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(1);
  });

  it('keeps distinct visits to the same URL and never reuses an old PUSH visitId', () => {
    const a = visit('/usage', 'a');
    const b = visit('/usage', 'b', { state: { visitId: a.visitId } });
    expect(b.visitId).not.toBe(a.visitId);
    expect(nav.getBackEntry()).toEqual(a);
  });

  it('accepts preallocated visit metadata without requiring unrelated state to be an object', () => {
    const id = nav.createVisitId();
    const a = visit('/activity', 'a', { state: { kikiNav: { visitId: id, label: 'Activity' }, focusSearch: true } });
    expect(a.visitId).toBe(id);
    expect(a.label).toBe('Activity');
    expect(() => visit('/usage', 'b', { state: 'unrelated' })).not.toThrow();
  });

  it('REPLACE updates the current visit, preserves snapshots, and does not add a level', () => {
    const a = visit('/activity', 'a');
    const b = visit('/settings/old', 'b', { label: 'Settings' });
    nav.saveUiSnapshot(b.visitId, { card: 'example-card' });
    const replaced = visit('/settings/ai', 'b2', { action: 'REPLACE', search: '?tab=models', hash: '#example-card' });
    expect(replaced.visitId).toBe(b.visitId);
    expect(replaced.label).toBe('Settings');
    expect(nav.getBackEntry()).toEqual(a);
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(2);
    expect(nav.getSnapshot(b.visitId)).toMatchObject({ pathname: '/settings/ai', search: '?tab=models', hash: '#example-card', ui: { card: 'example-card' } });
    pop(a);
    expect(nav.getForwardEntry()).toEqual(replaced);
  });

  it('supports replace shorthand and replacement of a visit identity', () => {
    const a = visit('/activity', 'a');
    const b = visit('/usage', 'b');
    const replaced = visit('/memory', 'm', { replace: true, state: { visitId: 'replacement-visit' } });
    expect(replaced.visitId).toBe('replacement-visit');
    expect(replaced.visitId).not.toBe(b.visitId);
    expect(nav.getBackEntry()).toEqual(a);
    const duplicate = visit('/settings/ai', 's', { action: 'REPLACE', state: { visitId: a.visitId } });
    expect(duplicate.visitId).not.toBe(a.visitId);
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(2);
  });

  it('REPLACE at a cold location remains one entry', () => {
    visit('/settings/ai', 'a', { action: 'REPLACE' });
    expect(nav.canGoBack()).toBe(false);
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(1);
  });

  it('an unknown POP starts a safe segment instead of inventing relative history', () => {
    visit('/activity', 'a');
    visit('/usage', 'b');
    const unknown = visit('/memory', 'unknown', { action: 'POP' });
    expect(nav.getCurrentVisit()).toEqual(unknown);
    expect(nav.canGoBack()).toBe(false);
    expect(nav.canGoForward()).toBe(false);
  });

  it('returns the fallback back label when a source is unlabeled', () => {
    expect(nav.getBackLabel()).toBeUndefined();
    expect(nav.getBackLabel('Back')).toBe('Back');
    visit('/activity', 'a');
    visit('/usage', 'b');
    expect(nav.getBackLabel('Back')).toBe('Back');
  });

  it('detects both home and connection changes and preserves recorded scope on POP', () => {
    expect(nav.isCrossScopeNavigation(scope, { ...scope })).toBe(false);
    expect(nav.isCrossScopeNavigation(scope, { ...scope, homeId: 'other' })).toBe(true);
    expect(nav.isCrossScopeNavigation(scope, { ...scope, scopeId: 'remote' })).toBe(true);
    const a = visit('/s/example-session', 'a');
    visit('/s/example-session', 'b', { scope: otherScope });
    const target = visit(a.pathname, 'a', { action: 'POP', scope: otherScope });
    expect(target.scope).toEqual(scope);
    expect(nav.isCrossScopeNavigation(otherScope, target.scope)).toBe(true);
  });

  it('generates unique IDs even within one millisecond and across resets', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const ids = Array.from({ length: 1000 }, () => nav.createVisitId());
    nav.clearNavHistory();
    ids.push(nav.createVisitId());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^v_1234_\d+$/.test(id))).toBe(true);
  });
});

describe('visit snapshots', () => {
  it('uses visit metadata for partial snapshots and enforces the lookup identity', () => {
    const a = visit('/usage', 'a', { label: 'Usage', search: '?range=week' });
    nav.saveSnapshot(a.visitId, { visitId: 'wrong-id', ui: { selectedBucket: 'example-bucket' }, timestamp: 42 });
    expect(nav.getSnapshot(a.visitId)).toMatchObject({ ...a, timestamp: 42, ui: { selectedBucket: 'example-bucket' } });
    expect(nav.getSnapshot('wrong-id')).toBeUndefined();
    expect(nav.getSnapshot('missing')).toBeUndefined();
  });

  it('keeps snapshots separate for repeated visits to a route', () => {
    const a = visit('/usage', 'a');
    nav.saveUiSnapshot(a.visitId, { selectedBucket: 'first' });
    const b = visit('/usage', 'b');
    nav.saveUiSnapshot(b.visitId, { selectedBucket: 'second' });
    expect(nav.getUiSnapshot(a.visitId)).toEqual({ selectedBucket: 'first' });
    expect(nav.getUiSnapshot(b.visitId)).toEqual({ selectedBucket: 'second' });
  });

  it('supports full snapshots outside the observed sequence but rejects incomplete unknown visits', () => {
    nav.saveSnapshot('unknown', { ui: { card: 'example-card' } });
    expect(nav.getSnapshot('unknown')).toBeUndefined();
    nav.saveSnapshot('external', { pathname: '/usage', search: '', hash: '', scope, label: 'Usage' });
    expect(nav.getSnapshot('external')).toMatchObject({ visitId: 'external', pathname: '/usage', scope });
    expect(nav.getCurrentVisit()).toBeNull();
    expect(nav.canGoBack()).toBe(false);
  });

  it('merges UI patches and preserves independent scroll containers', () => {
    const a = visit('/usage', 'a');
    nav.saveUiSnapshot(a.visitId, { selectedBucket: 'example-bucket', filter: 'old' });
    nav.saveUiSnapshot(a.visitId, { filter: 'new' });
    nav.saveScrollPosition(a.visitId, '.usage-list', 800, 25);
    nav.saveScrollPosition(a.visitId, '#details', 200);
    nav.saveScrollPosition(a.visitId, '.usage-list', 900, 30);
    expect(nav.getUiSnapshot<{ selectedBucket: string; filter: string }>(a.visitId))
      .toMatchObject({ selectedBucket: 'example-bucket', filter: 'new' });
    expect(nav.getScrollPosition(a.visitId, '.usage-list')).toEqual({ top: 900, left: 30 });
    expect(nav.getScrollPosition(a.visitId, '#details')).toEqual({ top: 200 });
    expect(nav.getScrollPosition(a.visitId, 'missing')).toBeUndefined();
    expect(nav.getScrollPosition('missing', '.usage-list')).toBeUndefined();
  });

  it('ignores nonfinite scroll positions and safely handles unusual selector keys', () => {
    const a = visit('/usage', 'a');
    nav.saveScrollPosition(a.visitId, 'list', 10);
    nav.saveScrollPosition(a.visitId, 'list', Infinity);
    nav.saveScrollPosition(a.visitId, 'list', 15, NaN);
    expect(nav.getScrollPosition(a.visitId, 'list')).toEqual({ top: 10 });
    expect(nav.getScrollPosition(a.visitId, 'toString')).toBeUndefined();
    nav.saveScrollPosition(a.visitId, '__proto__', 12);
    expect(nav.getScrollPosition(a.visitId, '__proto__')).toEqual({ top: 12 });
    nav.saveUiSnapshot(a.visitId, { scrollPositions: { bad: { top: '12' }, worse: { top: 12, left: Infinity } } });
    expect(nav.getScrollPosition(a.visitId, 'bad')).toBeUndefined();
    expect(nav.getScrollPosition(a.visitId, 'worse')).toBeUndefined();
  });

  it('evicts the least recently read or written snapshot beyond 100, not history metadata', () => {
    const visits: NavHistoryEntry[] = [];
    for (let i = 0; i < 100; i++) {
      const entry = visit(`/s/example-${i}`, `key-${i}`);
      visits.push(entry);
      nav.saveUiSnapshot(entry.visitId, { index: i });
    }
    nav.getSnapshot(visits[0]!.visitId);
    nav.saveUiSnapshot(visits[1]!.visitId, { touched: true });
    const newest = visit('/s/example-100', 'key-100');
    nav.saveUiSnapshot(newest.visitId, { index: 100 });
    expect(nav.getSnapshot(visits[2]!.visitId)).toBeUndefined();
    expect(nav.getSnapshot(visits[0]!.visitId)).toBeDefined();
    expect(nav.getSnapshot(visits[1]!.visitId)).toBeDefined();
    const saved = JSON.parse(storage.getItem(storageKey)!);
    expect(saved.snapshots).toHaveLength(100);
    expect(saved.entries).toHaveLength(101);
    pop(visits[2]!);
    expect(nav.getCurrentVisit()?.visitId).toBe(visits[2]!.visitId);
    expect(nav.canGoBack()).toBe(true);
  });
});

describe('sessionStorage survivability', () => {
  it('restores sequence, forward entries, UI, and scroll after a confirmed reload', async () => {
    const a = visit('/activity', 'a');
    const b = visit('/usage', 'b');
    nav.saveUiSnapshot(b.visitId, { selectedBucket: 'example-bucket' });
    nav.saveScrollPosition(b.visitId, '.usage-list', 812, 4);
    const c = visit('/memory', 'c');
    pop(b);
    await reload();
    expect(nav.canGoBack()).toBe(false);
    expect(nav.getCurrentVisit()).toBeNull();
    expect(pop(b)).toEqual(b);
    expect(nav.getBackEntry()).toEqual(a);
    expect(nav.getForwardEntry()).toEqual(c);
    expect(nav.getUiSnapshot(b.visitId)).toMatchObject({ selectedBucket: 'example-bucket' });
    expect(nav.getScrollPosition(b.visitId, '.usage-list')).toEqual({ top: 812, left: 4 });
  });

  it('confirms restored identity by a nondefault router key without adding an entry', async () => {
    const a = visit('/activity', 'a');
    const b = visit('/usage', 'b');
    await reload();
    expect(visit('/usage', 'b')).toEqual(b);
    expect(nav.getBackEntry()).toEqual(a);
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(2);
  });

  it('restores by explicit visitId even when the router key changed', async () => {
    const a = visit('/activity', 'a');
    const b = visit('/usage', 'b');
    await reload();
    const restored = visit('/usage', 'default', { state: { visitId: b.visitId } });
    expect(restored.visitId).toBe(b.visitId);
    expect(nav.getBackEntry()).toEqual(a);
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(2);
  });

  it('records the observed canonical URL while retaining a confirmed visit across reload', async () => {
    const a = visit('/activity', 'a');
    const b = visit('/settings/old', 'b');
    nav.saveUiSnapshot(b.visitId, { card: 'example-card' });
    await reload();
    const restored = visit('/settings/ai', 'new-key', { action: 'REPLACE', state: { kikiNav: { visitId: b.visitId } }, search: '?tab=models' });
    expect(restored).toMatchObject({ visitId: b.visitId, pathname: '/settings/ai', search: '?tab=models' });
    expect(nav.getBackEntry()).toEqual(a);
    expect(nav.getSnapshot(b.visitId)).toMatchObject({ pathname: '/settings/ai', search: '?tab=models', ui: { card: 'example-card' } });
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(2);
  });

  it('never resurrects history from inherited storage on a cold or foreign deep link', async () => {
    visit('/activity', 'default');
    visit('/usage', 'b');
    await reload();
    visit('/activity', 'default', { action: 'POP' });
    expect(nav.canGoBack()).toBe(false);
    expect(nav.canGoForward()).toBe(false);
    expect(nav.getBackEntry()).toBeNull();
    await reload();
    visit('/s/example-deep-link', 'foreign', { action: 'POP' });
    expect(nav.canGoBack()).toBe(false);
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(1);
  });

  it.each(['not-json', 'null', '{"version":2}', '{"version":1,"entries":[{}],"currentIndex":20,"snapshots":[{}]}'])
    ('tolerates invalid persisted data: %s', async (raw) => {
      storage.setItem(storageKey, raw);
      await reload();
      expect(() => visit('/usage', 'default', { action: 'POP' })).not.toThrow();
      expect(nav.canGoBack()).toBe(false);
      expect(nav.getSnapshot('missing')).toBeUndefined();
    });

  it('bounds restored snapshots and preserves their LRU order', async () => {
    const saved = Array.from({ length: 105 }, (_, i) => ({ visitId: `saved-${i}`, pathname: '/usage', search: '', hash: '', scope, timestamp: i }));
    storage.setItem(storageKey, JSON.stringify({ version: 1, snapshots: saved }));
    await reload();
    expect(nav.getSnapshot('saved-4')).toBeUndefined();
    expect(nav.getSnapshot('saved-5')).toBeDefined();
    nav.saveSnapshot('new', { pathname: '/usage', search: '', hash: '', scope });
    expect(nav.getSnapshot('saved-6')).toBeUndefined();
    expect(nav.getSnapshot('saved-5')).toBeDefined();
    expect(JSON.parse(storage.getItem(storageKey)!).snapshots).toHaveLength(100);
  });

  it('remains functional when storage reads, writes, and removals throw', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    const a = visit('/activity', 'a');
    const b = visit('/usage', 'b');
    nav.saveUiSnapshot(b.visitId, { selectedBucket: 'example-bucket' });
    expect(nav.getBackEntry()).toEqual(a);
    expect(nav.getUiSnapshot(b.visitId)).toEqual({ selectedBucket: 'example-bucket' });
    expect(() => nav.clearNavHistory()).not.toThrow();
    expect(nav.getCurrentVisit()).toBeNull();
    expect(nav.getSnapshot(b.visitId)).toBeUndefined();
  });

  it('survives an exception while obtaining sessionStorage itself', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => {
      const a = visit('/activity', 'a');
      visit('/usage', 'b');
      nav.saveUiSnapshot(a.visitId, { card: 'example-card' });
      expect(nav.getUiSnapshot(a.visitId)).toEqual({ card: 'example-card' });
      expect(nav.canGoBack()).toBe(true);
      nav.clearNavHistory();
    }).not.toThrow();
  });

  it('keeps unserializable UI in memory without losing persisted history or other snapshots', async () => {
    const a = visit('/activity', 'a');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    nav.saveUiSnapshot(a.visitId, { cyclic });
    const b = visit('/usage', 'b');
    nav.saveUiSnapshot(b.visitId, { selectedBucket: 'example-bucket' });
    expect(nav.getUiSnapshot(a.visitId)?.['cyclic']).toBe(cyclic);
    expect(JSON.parse(storage.getItem(storageKey)!).entries).toHaveLength(2);
    await reload();
    pop(b);
    expect(nav.getBackEntry()).toEqual(a);
    expect(nav.getSnapshot(a.visitId)).toBeUndefined();
    expect(nav.getUiSnapshot(b.visitId)).toEqual({ selectedBucket: 'example-bucket' });
  });

  it('clears history and snapshots durably', async () => {
    const a = visit('/activity', 'a');
    visit('/usage', 'b');
    nav.saveUiSnapshot(a.visitId, { card: 'example-card' });
    nav.clearNavHistory();
    expect(storage.getItem(storageKey)).toBeNull();
    expect(nav.getCurrentVisit()).toBeNull();
    expect(nav.canGoBack()).toBe(false);
    expect(nav.canGoForward()).toBe(false);
    expect(nav.getSnapshot(a.visitId)).toBeUndefined();
    await reload();
    visit('/memory', 'default', { action: 'POP' });
    expect(nav.canGoBack()).toBe(false);
  });
});
