/**
 * Theme application. The palette itself lives in `index.css`: `@theme` holds
 * the light values and `[data-theme='dark']` overrides the same variables, so
 * everything downstream (Tailwind utilities, Streamdown's shadcn variables,
 * the `dark:` variant that drives shiki's dark slot) follows one attribute on
 * `<html>`.
 *
 * `system` resolves through `prefers-color-scheme` and keeps following it, so
 * an OS switch flips the app without a reload.
 */

import { readSettings, subscribeSettings, type ThemePreference } from '@kiki/session-core/settings';

import type { HostAdapter } from '../host/host';
import { androidBridge, hasAndroidBridge } from './androidBridge';
import { isEmbeddedAndroidHost } from './appShell';
import { subscribeSkinPrefs } from './skins/store';

export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['theme'] = resolved;
}

/**
 * Fire `listener` whenever the resolved theme on `<html data-theme>` flips.
 * Surfaces that cannot follow CSS variables (xterm.js resolves colors itself)
 * re-read the tokens from this hook instead of waiting for a remount.
 */
export function onThemeChange(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  const observer = new MutationObserver(() => { listener(); });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => { observer.disconnect(); };
}

/**
 * Point the browser's own chrome (the Android status bar and toolbar, Safari's
 * tab bar, the overscroll gutter) at the app's paper. The colour is read back
 * from the computed `--color-paper`, so it follows the in-app theme and any
 * skin that repaints the paper rather than the OS theme. `index.html` keeps
 * two OS-keyed metas as the fallback for when its pre-paint script cannot run
 * (a served GUI's CSP forbids inline scripts); every one of them gets the same
 * colour, so whichever the browser picks is the app's.
 */
function applyThemeColor(): void {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return;
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim();
  // Nothing to read before the stylesheet applies; the pre-paint value stands.
  if (paper === '') return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (meta.content !== paper) meta.content = paper;
  }
}

let themeColorQueued = false;

/**
 * The skin re-applies its palette on the same change that triggers this (a
 * theme flip, a skin pick), partly in a later microtask (`onThemeChange`), so
 * the paper is read once those writers have run rather than mid-change.
 */
function queueThemeColor(): void {
  if (themeColorQueued) return;
  themeColorQueued = true;
  queueMicrotask(() => {
    themeColorQueued = false;
    applyThemeColor();
  });
}

/**
 * Keep `<html data-theme>` in sync with the stored preference and the OS, for
 * the life of the document. Returns a teardown for tests.
 */
export function startThemeSync(host: HostAdapter): () => void {
  const sync = (): void => {
    const resolved = resolveTheme(readSettings().theme, prefersDark());
    applyTheme(resolved);
    queueThemeColor();
    void host.setTheme?.(resolved);
    if (hasAndroidBridge() || isEmbeddedAndroidHost()) {
      void androidBridge.setAppearance({ dark: resolved === 'dark' });
    }
  };
  sync();

  const unsubscribe = subscribeSettings(sync);
  const media =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DARK_QUERY)
      : undefined;
  media?.addEventListener('change', sync);
  // A skin can repaint the paper without the theme changing.
  const stopSkin = subscribeSkinPrefs(queueThemeColor);

  return () => {
    unsubscribe();
    media?.removeEventListener('change', sync);
    stopSkin();
  };
}
