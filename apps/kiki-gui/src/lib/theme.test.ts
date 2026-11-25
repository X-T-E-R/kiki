// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeSettings } from '@kiki/session-core/settings';
import { browserHost } from '../host/browser';
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
  delete document.documentElement.dataset['skin'];
  delete document.documentElement.dataset['kikiProse'];
  delete document.documentElement.dataset['kikiMotion'];
  delete document.documentElement.dataset['kikiChatWidth'];
  document.documentElement.removeAttribute('style');
  delete (window as unknown as Record<string, unknown>)['__KIKI_ACTIVE_SPACE__'];
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
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

    const stop = startThemeSync(browserHost);
    expect(document.documentElement.dataset['theme']).toBe('light');
    stop();
  });

  it('re-resolves when the preference changes', () => {
    stubMatchMedia(false);
    const stop = startThemeSync(browserHost);
    expect(document.documentElement.dataset['theme']).toBe('light');

    writeSettings({ theme: 'dark' });
    expect(document.documentElement.dataset['theme']).toBe('dark');
    stop();
  });

  it('follows an OS flip while the preference is system, and stops after teardown', () => {
    const media = stubMatchMedia(false);
    writeSettings({ theme: 'system' });
    const stop = startThemeSync(browserHost);
    expect(document.documentElement.dataset['theme']).toBe('light');

    media.flip(true);
    expect(document.documentElement.dataset['theme']).toBe('dark');

    stop();
    media.flip(false);
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('notifies KikiAndroid bridge via setAppearance when theme mounts and switches', () => {
    const setAppearance = vi.fn();
    (window as unknown as { KikiAndroid?: unknown }).KikiAndroid = { setAppearance };
    try {
      stubMatchMedia(false);
      writeSettings({ theme: 'light' });
      const stop = startThemeSync(browserHost);
      expect(setAppearance).toHaveBeenLastCalledWith(false);

      writeSettings({ theme: 'dark' });
      expect(setAppearance).toHaveBeenLastCalledWith(true);
      stop();
    } finally {
      delete (window as unknown as { KikiAndroid?: unknown }).KikiAndroid;
    }
  });
});

describe('onThemeChange', () => {
  it('fires when the resolved theme flips and stops after teardown', async () => {
    stubMatchMedia(false);
    writeSettings({ theme: 'system' });
    const stopSync = startThemeSync(browserHost);

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

describe('public/theme-boot.js pre-paint boot', () => {
  const bootScriptSource = readFileSync(
    resolve(import.meta.dirname, '../../public/theme-boot.js'),
    'utf8',
  );

  function runThemeBoot(): void {
    new Function(bootScriptSource)();
  }

  function addThemeColorMeta(content = '#fbfaf6'): HTMLMetaElement {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = content;
    document.head.append(meta);
    return meta;
  }

  it('applies cached skin CSS vars, appearance attrs, and theme-color synchronously before first paint', () => {
    stubMatchMedia(false);
    const meta = addThemeColorMeta('#fbfaf6');
    localStorage.setItem('kiki.skin.boot', JSON.stringify({
      v: 1,
      theme: 'dark',
      skinId: 'porcelain',
      proseFace: 'serif',
      motion: 'reduce',
      chatWidth: 'wide',
      proseFontSize: 17,
      codeFontSize: 13,
      light: { '--color-paper': '#F8FBFF', '--color-canvas': '#E7EDF4' },
      dark: { '--color-paper': '#152238', '--color-canvas': '#0D1624', '--color-ink': '#E4EDF9' },
    }));

    runThemeBoot();

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.dataset['skin']).toBe('porcelain');
    expect(document.documentElement.dataset['kikiProse']).toBe('serif');
    expect(document.documentElement.dataset['kikiMotion']).toBe('reduce');
    expect(document.documentElement.dataset['kikiChatWidth']).toBe('wide');
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#152238');
    expect(document.documentElement.style.getPropertyValue('--color-canvas')).toBe('#0D1624');
    expect(document.documentElement.style.getPropertyValue('--color-ink')).toBe('#E4EDF9');
    expect(document.documentElement.style.getPropertyValue('--kiki-prose-font-size')).toBe('17px');
    expect(document.documentElement.style.getPropertyValue('--kiki-code-font-size')).toBe('13px');
    expect(meta.getAttribute('content')).toBe('#152238');
  });

  it('uses space-scoped boot payload and space authority cached theme when active space is injected', () => {
    stubMatchMedia(false);
    const meta = addThemeColorMeta('#fbfaf6');
    (window as unknown as Record<string, unknown>)['__KIKI_ACTIVE_SPACE__'] = { homeId: 'acme' };
    localStorage.setItem('kiki.skin.boot', JSON.stringify({
      v: 1,
      theme: 'light',
      skinId: 'porcelain',
      light: { '--color-paper': '#F8FBFF' },
      dark: { '--color-paper': '#152238' },
    }));
    localStorage.setItem('kiki.space.acme.kiki.skin.boot', JSON.stringify({
      v: 1,
      skinId: 'celadon',
      light: { '--color-paper': '#F2F7EF' },
      dark: { '--color-paper': '#1A2925' },
    }));
    localStorage.setItem('kiki.spacePreferences.cache', JSON.stringify({
      entries: {},
      authorities: { 'srv-1|acme': true },
      lastKnown: { homeId: 'acme', serverId: 'srv-1', values: { theme: 'dark' } },
      resolved: {},
    }));

    runThemeBoot();

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.dataset['skin']).toBe('celadon');
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#1A2925');
    expect(meta.getAttribute('content')).toBe('#1A2925');
  });

  it('rejects disallowed CSS keys and unsafe values in kiki.skin.boot', () => {
    stubMatchMedia(false);
    const meta = addThemeColorMeta('#fbfaf6');
    localStorage.setItem('kiki.skin.boot', JSON.stringify({
      v: 1,
      theme: 'light',
      skinId: 'bad;skin',
      light: {
        '--color-paper': '#F2F7EF',
        '--evil-var': '#ff0000',
        background: 'red',
        '--color-canvas': 'red; } body { display: none',
      },
      dark: {},
    }));

    runThemeBoot();

    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#F2F7EF');
    expect(document.documentElement.style.getPropertyValue('--evil-var')).toBe('');
    expect(document.documentElement.style.getPropertyValue('background')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--color-canvas')).toBe('');
    expect(document.documentElement.dataset['skin']).toBeUndefined();
    expect(meta.getAttribute('content')).toBe('#F2F7EF');
  });
});
