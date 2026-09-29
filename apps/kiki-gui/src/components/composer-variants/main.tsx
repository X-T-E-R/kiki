/**
 * Dev-only entry for the composer state prototypes. Not part of the app
 * bundle (vite build only reads index.html); open it from the dev server:
 *
 *   /src/components/composer-variants/preview.html?composer=a|b|c|d&state=<name>&theme=light|dark&lang=zh|en
 *
 * Everything on the page is mock state (states.ts); nothing talks to a server.
 */

import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../../index.css';
import '../../styles/motion.css';
import { LOCALE_STORAGE_KEY } from '@kiki/session-core/i18n';
import { I18nProvider } from '../../i18n';
import { Preview } from './Preview';

const params = new URLSearchParams(location.search);
document.documentElement.dataset['theme'] = params.get('theme') === 'dark' ? 'dark' : 'light';
try {
  localStorage.setItem(LOCALE_STORAGE_KEY, params.get('lang') === 'en' ? 'en' : 'zh');
} catch {
  // Storage can be unavailable; the navigator locale applies then.
}

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <I18nProvider>
      <Preview
        variant={params.get('composer') ?? 'a'}
        stateKey={params.get('state') ?? 'idle'}
        chrome={params.get('chrome') !== '0'}
      />
    </I18nProvider>
  </StrictMode>,
);
