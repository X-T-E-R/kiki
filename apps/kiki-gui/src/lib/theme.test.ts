// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeSettings } from './settings';
import { applyTheme, onThemeChange, resolveTheme, startThemeSync } from './theme';

type MediaListener = (event: MediaQueryListEvent) => void;

/** Minimal matchMedia stand-in with a settable match state. */
function stubMatchMedia(matches: boolean): { flip: (next: boolean) => void } {
  const listeners = new Set<MediaListener>();
  const state = { matches };
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return state.matches;
    },
    addEventListener: (_type: string, listener: MediaListener) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: MediaListener) => { listeners.delete(listener); },
  }));
  return {
    flip: (next: boolean) => {
      state.matches = next;
      for (const listener of listeners) listener({} as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset['theme'];
});

describe('resolveTheme', () => {
  it('pins light and dark regardless of the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the system only for the system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('applyTheme', () => {
  it('writes the resolved theme onto the document element', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});

describe('startThemeSync', () => {
  it('applies the stored preference over the system preference', () => {
    stubMatchMedia(true);
    writeSettings({ theme: 'light' });

    const stop = startThemeSync();
    expect(document.documentElement.dataset['theme']).toBe('light');
    stop();
  });

  it('re-resolves when the preference changes', () => {
    stubMatchMedia(false);
    const stop = startThemeSync();
    expect(document.documentElement.dataset['theme']).toBe('light');

    writeSettings({ theme: 'dark' });
    expect(document.documentElement.dataset['theme']).toBe('dark');
    stop();
  });

  it('follows an OS flip while the preference is system, and stops after teardown', () => {
    const media = stubMatchMedia(false);
    writeSettings({ theme: 'system' });
    const stop = startThemeSync();
    expect(document.documentElement.dataset['theme']).toBe('light');

    media.flip(true);
    expect(document.documentElement.dataset['theme']).toBe('dark');

    stop();
    media.flip(false);
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});

describe('onThemeChange', () => {
  it('fires when the resolved theme flips and stops after teardown', async () => {
    stubMatchMedia(false);
    writeSettings({ theme: 'system' });
    const stopSync = startThemeSync();

    const seen: string[] = [];
    const stop = onThemeChange(() => {
      seen.push(document.documentElement.dataset['theme'] ?? '');
    });

    applyTheme('dark');
    await vi.waitFor(() => { expect(seen).toEqual(['dark']); });

    applyTheme('dark');
    applyTheme('light');
    await vi.waitFor(() => { expect(seen).toEqual(['dark', 'light']); });

    stop();
    applyTheme('dark');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(['dark', 'light']);
    stopSync();
  });

  it('ignores unrelated attribute writes on the document element', async () => {
    const listener = vi.fn();
    const stop = onThemeChange(listener);

    document.documentElement.dataset['locale'] = 'en';
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listener).not.toHaveBeenCalled();
    stop();
    delete document.documentElement.dataset['locale'];
  });
});
