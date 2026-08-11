import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TERMINAL_PANEL_PREFS,
  readTerminalPanelPrefs,
  TERMINAL_PANEL_DEFAULT_HEIGHT,
  TERMINAL_PANEL_MAX_HEIGHT,
  TERMINAL_PANEL_MIN_HEIGHT,
  writeTerminalPanelPrefs,
} from './terminalPrefs';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length(): number { return this.#items.size; }
  clear(): void { this.#items.clear(); }
  getItem(key: string): string | null { return this.#items.get(key) ?? null; }
  key(index: number): string | null { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string): void { this.#items.delete(key); }
  setItem(key: string, value: string): void { this.#items.set(key, value); }
}

describe('terminal panel prefs', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it('defaults to closed with the default height', () => {
    expect(readTerminalPanelPrefs('sess_x')).toEqual(DEFAULT_TERMINAL_PANEL_PREFS);
  });

  it('round-trips open state and height per session', () => {
    writeTerminalPanelPrefs('sess_a', { open: true, height: 320 });
    writeTerminalPanelPrefs('sess_b', { open: false, height: 200 });
    expect(readTerminalPanelPrefs('sess_a')).toEqual({ open: true, height: 320 });
    expect(readTerminalPanelPrefs('sess_b')).toEqual({ open: false, height: 200 });
  });

  it('merges partial writes with the stored entry', () => {
    writeTerminalPanelPrefs('sess_a', { open: true, height: 300 });
    writeTerminalPanelPrefs('sess_a', { height: 420 });
    expect(readTerminalPanelPrefs('sess_a')).toEqual({ open: true, height: 420 });
    writeTerminalPanelPrefs('sess_a', { open: false });
    expect(readTerminalPanelPrefs('sess_a')).toEqual({ open: false, height: 420 });
  });

  it('clamps heights into the supported range', () => {
    writeTerminalPanelPrefs('sess_a', { open: true, height: 20 });
    expect(readTerminalPanelPrefs('sess_a').height).toBe(TERMINAL_PANEL_MIN_HEIGHT);
    writeTerminalPanelPrefs('sess_a', { height: 99_999 });
    expect(readTerminalPanelPrefs('sess_a').height).toBe(TERMINAL_PANEL_MAX_HEIGHT);
  });

  it('survives malformed stored JSON', () => {
    localStorage.setItem('kiki.terminalPanel.v1', '{not json');
    expect(readTerminalPanelPrefs('sess_a')).toEqual(DEFAULT_TERMINAL_PANEL_PREFS);
    localStorage.setItem(
      'kiki.terminalPanel.v1',
      JSON.stringify({ sess_a: { open: 'yes', height: 'tall' } }),
    );
    expect(readTerminalPanelPrefs('sess_a')).toEqual({
      open: false,
      height: TERMINAL_PANEL_DEFAULT_HEIGHT,
    });
  });
});
