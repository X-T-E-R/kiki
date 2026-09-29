/**
 * Dev-only token preview: `?tokens=<name>` puts `<html data-kiki-tokens>` on
 * the document so `styles/token-preview.css` can swap the base palette for a
 * candidate direction. The choice sticks for the tab (sessionStorage) so
 * in-app navigation and reloads keep it; `?tokens=off` clears it.
 *
 * main.tsx imports this module only under `import.meta.env.DEV`, so neither
 * the stylesheet nor this code reaches a production bundle, and with no
 * parameter nothing is set and the default palette is untouched.
 */

import '../styles/token-preview.css';

export const TOKEN_PREVIEW_NAMES = ['p923', 'a', 'b', 'c'] as const;
export type TokenPreviewName = (typeof TOKEN_PREVIEW_NAMES)[number];

const STORAGE_KEY = 'kiki.dev.tokenPreview';

function isPreviewName(value: string | null): value is TokenPreviewName {
  return value !== null && (TOKEN_PREVIEW_NAMES as readonly string[]).includes(value);
}

export function startTokenPreview(): void {
  const requested = new URLSearchParams(window.location.search).get('tokens');
  if (requested === 'off') {
    sessionStorage.removeItem(STORAGE_KEY);
  } else if (isPreviewName(requested)) {
    sessionStorage.setItem(STORAGE_KEY, requested);
  }
  const active = sessionStorage.getItem(STORAGE_KEY);
  if (isPreviewName(active)) {
    document.documentElement.dataset['kikiTokens'] = active;
  } else {
    delete document.documentElement.dataset['kikiTokens'];
  }
}
