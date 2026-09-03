// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  readLayoutPreferences,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  subscribeLayoutPreferences,
  writeLayoutPreferences,
} from './layoutPrefs';

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
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      railWidth: RAIL_DEFAULT_WIDTH,
    });
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
    const next = writeLayoutPreferences({ groupBy: 'workspace', sortBy: 'title', sidebarWidth: 300 });
    expect(next.groupBy).toBe('workspace');
    expect(next.sortBy).toBe('title');
    expect(next.sidebarWidth).toBe(300);
    expect(JSON.parse(ls().getItem('kiki.layout') ?? '{}')).toEqual(next);
  });

  it('clamps widths on write', () => {
    const next = writeLayoutPreferences({ railWidth: RAIL_MIN_WIDTH - 10 });
    expect(next.railWidth).toBe(RAIL_MIN_WIDTH);
  });
});