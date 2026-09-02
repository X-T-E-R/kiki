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

import type { HostAdapter } from '../host/host';
import { readSettings, subscribeSettings, type ThemePreference } from './settings';

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
 * Keep `<html data-theme>` in sync with the stored preference and the OS, for
 * the life of the document. Returns a teardown for tests.
 */
export function startThemeSync(host: HostAdapter): () => void {
  const sync = (): void => {
    const resolved = resolveTheme(readSettings().theme, prefersDark());
    applyTheme(resolved);
    void host.setTheme?.(resolved);
  };
  sync();

  const unsubscribe = subscribeSettings(sync);
  const media =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DARK_QUERY)
      : undefined;
  media?.addEventListener('change', sync);

  return () => {
    unsubscribe();
    media?.removeEventListener('change', sync);
  };
}
