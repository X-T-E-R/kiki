// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  readLayoutPreferences,
  resetLayoutPreferencesForTests,
  shownPinnedNavItems,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  subscribeLayoutPreferences,
  writeLayoutPreferences,
} from './layoutPrefs';
import {
  applyLocalSettingsTransferPreferences,
  readLocalSettingsTransferPreferences,
} from './settingsTransfer';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length(): number { return this.#items.size; }
  clear(): void { this.#items.clear(); }
  getItem(key: string): string | null { return this.#items.get(key) ?? null; }
  key(index: number): string | null { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string): void { this.#items.delete(key); }
  setItem(key: string, value: string): void { this.#items.set(key, value); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
});

function ls(): Storage {
  return globalThis.localStorage as Storage;
}

describe('readLayoutPreferences', () => {
  it('falls back to defaults when nothing is stored', () => {
    const prefs = readLayoutPreferences();
    expect(prefs).toEqual({
      groupBy: 'time',
      sortBy: 'updated-desc',
      filters: { status: [], workspaces: [], archived: 'hide' },
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      railWidth: RAIL_DEFAULT_WIDTH,
      pinnedNavItems: ['memory', 'personas', 'usage'],
      sidebarNavSectionCollapsed: true,
    });
  });

  it('round-trips group/sort/filters and drops unknown filter entries', () => {
    ls().setItem('kiki.layout', JSON.stringify({
      groupBy: 'none',
      sortBy: 'created-desc',
      filters: { status: ['running', 'cleanup-pending', 'bogus'], workspaces: ['ws-a', 'ws-a', 3], archived: 'only' },
    }));
    const prefs = readLayoutPreferences();
    expect(prefs.groupBy).toBe('none');
    expect(prefs.sortBy).toBe('created-desc');
    expect(prefs.filters).toEqual({ status: ['running', 'cleanup-pending'], workspaces: ['ws-a'], archived: 'only' });
  });

  it('falls back to default filters for a malformed value', () => {
    ls().setItem('kiki.layout', JSON.stringify({ filters: 'nope' }));
    expect(readLayoutPreferences().filters).toEqual({ status: [], workspaces: [], archived: 'hide' });
  });

  it('clamps out-of-range widths to the min/max bounds', () => {
    ls().setItem('kiki.layout', JSON.stringify({ sidebarWidth: 5, railWidth: 99999 }));
    expect(readLayoutPreferences().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(readLayoutPreferences().railWidth).toBe(RAIL_MAX_WIDTH);
  });

  it('rejects invalid groupBy/sortBy values', () => {
    ls().setItem('kiki.layout', JSON.stringify({ groupBy: 'nope', sortBy: 'nope' }));
    expect(readLayoutPreferences().groupBy).toBe('time');
    expect(readLayoutPreferences().sortBy).toBe('updated-desc');
  });

  it('reads and writes sidebarCollapsed preference', () => {
    expect(readLayoutPreferences().sidebarCollapsed).toBeUndefined();
    writeLayoutPreferences({ sidebarCollapsed: true });
    expect(readLayoutPreferences().sidebarCollapsed).toBe(true);
    writeLayoutPreferences({ sidebarCollapsed: false });
    expect(readLayoutPreferences().sidebarCollapsed).toBe(false);
  });

  it('keeps the docked rail choice, and leaves it to the setting until one is made', () => {
    expect(readLayoutPreferences().railOpen).toBeUndefined();
    writeLayoutPreferences({ railOpen: false });
    expect(readLayoutPreferences().railOpen).toBe(false);
    // A write that does not name the rail keeps the choice.
    writeLayoutPreferences({ railWidth: 320 });
    expect(readLayoutPreferences().railOpen).toBe(false);
    writeLayoutPreferences({ railOpen: true });
    expect(readLayoutPreferences().railOpen).toBe(true);

    ls().setItem('kiki.layout', JSON.stringify({ railOpen: 'yes' }));
    expect(readLayoutPreferences().railOpen).toBeUndefined();
  });

  it('keeps explicitly pinned capabilities and discovery', () => {
    ls().setItem('kiki.layout', JSON.stringify({ pinnedNavItems: ['capabilities', 'discover'] }));
    expect(readLayoutPreferences().pinnedNavItems).toEqual(['capabilities', 'discover']);
  });

  it('reads and sanitizes pinnedNavItems and preserves sidebarNavSectionCollapsed', () => {
    ls().setItem('kiki.layout', JSON.stringify({
      pinnedNavItems: ['board', 'cron', 'unknown-key', 'board'],
      sidebarNavSectionCollapsed: false,
    }));
    const prefs = readLayoutPreferences();
    expect(prefs.pinnedNavItems).toEqual(['cron']);
    expect(prefs.sidebarNavSectionCollapsed).toBe(false);

    ls().setItem('kiki.layout', JSON.stringify({ pinnedNavItems: 'not-an-array' }));
    expect(readLayoutPreferences().pinnedNavItems).toEqual(['memory', 'personas', 'usage']);
  });
});

describe('subscribeLayoutPreferences', () => {
  it('detaches the storage listener after the last subscriber leaves', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const first = subscribeLayoutPreferences(() => {});
    const second = subscribeLayoutPreferences(() => {});

    expect(add).toHaveBeenCalledTimes(1);
    first();
    expect(remove).not.toHaveBeenCalled();
    second();
    expect(remove).toHaveBeenCalledTimes(1);

    const third = subscribeLayoutPreferences(() => {});
    expect(add).toHaveBeenCalledTimes(2);
    third();
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

describe('writeLayoutPreferences', () => {
  it('persists and returns the merged preferences', () => {
    resetLayoutPreferencesForTests();
    const next = writeLayoutPreferences({ groupBy: 'workspace', sortBy: 'title', sidebarWidth: 300 });
    expect(next.groupBy).toBe('workspace');
    expect(next.sortBy).toBe('title');
    expect(next.sidebarWidth).toBe(300);
    // The default tool list nobody chose stays implicit (see below).
    const { pinnedNavItems: _implicit, ...persisted } = next;
    expect(JSON.parse(ls().getItem('kiki.layout') ?? '{}')).toEqual(persisted);
  });

  it('clamps widths on write', () => {
    const next = writeLayoutPreferences({ railWidth: RAIL_MIN_WIDTH - 10 });
    expect(next.railWidth).toBe(RAIL_MIN_WIDTH);
  });

  it('writes and updates pinnedNavItems and sidebarNavSectionCollapsed', () => {
    const next = writeLayoutPreferences({
      pinnedNavItems: ['usage', 'capabilities'],
      sidebarNavSectionCollapsed: false,
    });
    expect(next.pinnedNavItems).toEqual(['usage', 'capabilities']);
    expect(next.sidebarNavSectionCollapsed).toBe(false);
    expect(readLayoutPreferences().pinnedNavItems).toEqual(['usage', 'capabilities']);
    expect(readLayoutPreferences().sidebarNavSectionCollapsed).toBe(false);
  });
});

describe('pinned tools on a phone', () => {
  const stored = () => JSON.parse(ls().getItem('kiki.layout') ?? '{}') as Record<string, unknown>;

  it('starts a phone with none pinned until this device saves a choice, which then wins', () => {
    resetLayoutPreferencesForTests();
    expect(shownPinnedNavItems(readLayoutPreferences(), true)).toEqual([]);
    expect(shownPinnedNavItems(readLayoutPreferences(), false)).toEqual(['memory', 'personas', 'usage']);

    // An unrelated write must not save the default list as if it were chosen.
    writeLayoutPreferences({ sidebarNavSectionCollapsed: false, groupBy: 'none' });
    expect(stored()).not.toHaveProperty('pinnedNavItems');
    resetLayoutPreferencesForTests();
    expect(shownPinnedNavItems(readLayoutPreferences(), true)).toEqual([]);

    // A choice is saved even when it equals the default, and a phone keeps it
    // across later writes and reloads.
    writeLayoutPreferences({ pinnedNavItems: ['memory', 'personas', 'usage'] });
    writeLayoutPreferences({ sidebarWidth: 300 });
    expect(stored()['pinnedNavItems']).toEqual(['memory', 'personas', 'usage']);
    resetLayoutPreferencesForTests();
    expect(shownPinnedNavItems(readLayoutPreferences(), true)).toEqual(['memory', 'personas', 'usage']);

    // Unpinning everything is a choice too.
    writeLayoutPreferences({ pinnedNavItems: [] });
    expect(shownPinnedNavItems(readLayoutPreferences(), false)).toEqual([]);
  });

  it('respects a tool list that arrived through a settings import', async () => {
    resetLayoutPreferencesForTests();
    const result = await applyLocalSettingsTransferPreferences({ layout: { pinnedNavItems: ['cron'] } }, 'overwrite');
    expect(result.status).toBe('complete');
    resetLayoutPreferencesForTests();
    expect(shownPinnedNavItems(readLayoutPreferences(), true)).toEqual(['cron']);

    // An import that carries no tool list leaves the phone default in place,
    // and an export only carries a list this device actually saved.
    ls().clear();
    resetLayoutPreferencesForTests();
    await applyLocalSettingsTransferPreferences({ layout: { sidebarWidth: 300 } }, 'overwrite');
    resetLayoutPreferencesForTests();
    expect(shownPinnedNavItems(readLayoutPreferences(), true)).toEqual([]);
    expect(readLocalSettingsTransferPreferences()?.layout).not.toHaveProperty('pinnedNavItems');
  });
});