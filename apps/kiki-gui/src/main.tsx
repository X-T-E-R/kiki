import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { HostProvider, hostAdapter } from './host';
import { initializeSpaceStorage } from './lib/spaceStorage';
import './index.css';
import './styles/motion.css';
import './styles/new-session.css';

/**
 * Resolve the active space first: in desktop switch mode every space shares one
 * WebView data directory, so its `localStorage` keys are namespaced per space
 * (isolation design §6.4). A module that reads a namespaced key while it is
 * evaluated — the skin pack cache does — would otherwise read the main space's
 * namespace, which is why the app graph below is imported only after the space
 * is known. CLI and browser hosts resolve to the main space immediately.
 */
async function start(): Promise<void> {
  await initializeSpaceStorage(hostAdapter);
  const [
    { App },
    { AppErrorBoundary },
    { I18nProvider },
    { ConnectionProvider },
    { startThemeSync },
    { startSkinSync },
  ] = await Promise.all([
    import('./App'),
    import('./components/AppErrorBoundary'),
    import('./i18n'),
    import('./state/connection'),
    import('./lib/theme'),
    import('./lib/skins'),
  ]);

  // Before the first render: the palette must be right on the first frame, or a
  // dark-theme user gets a paper-white flash on every launch.
  startThemeSync(hostAdapter);
  // The skin rides on top of the resolved theme and follows it from here on.
  startSkinSync();

  createRoot(document.querySelector('#root')!).render(
    <StrictMode>
      <HostProvider>
        <I18nProvider>
          <ConnectionProvider>
            <BrowserRouter>
              <AppErrorBoundary>
                <App />
              </AppErrorBoundary>
            </BrowserRouter>
          </ConnectionProvider>
        </I18nProvider>
      </HostProvider>
    </StrictMode>,
  );
}

void start();