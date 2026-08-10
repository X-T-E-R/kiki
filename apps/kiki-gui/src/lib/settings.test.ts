import { beforeEach, describe, expect, it } from 'vitest';

import { readDesktopPrefs, readSettings, writeDesktopPrefs } from './settings';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

describe('desktop close preference', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('defaults absent, partial, and malformed storage to hide-to-tray', () => {
    expect(readSettings().closeToTray).toBe(true);
    expect(readDesktopPrefs().closeToTray).toBe(true);

    localStorage.setItem('kiki.settings', JSON.stringify({ sendShortcut: 'enter' }));
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ notifications: false }));
    expect(readSettings().closeToTray).toBe(true);
    expect(readDesktopPrefs()).toEqual({ notifications: false, closeToTray: true });

    localStorage.setItem('kiki.settings', JSON.stringify({ closeToTray: 'invalid' }));
    localStorage.setItem('kiki.desktopPrefs', '{not-json');
    expect(readSettings().closeToTray).toBe(true);
    expect(readDesktopPrefs().closeToTray).toBe(true);
  });

  it('preserves an explicitly persisted quit choice', () => {
    writeDesktopPrefs({ closeToTray: false });
    expect(readDesktopPrefs().closeToTray).toBe(false);
  });
});
