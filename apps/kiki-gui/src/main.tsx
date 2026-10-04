import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import { HostProvider, hostAdapter } from './host';
import { initializeSpaceStorage, activeSpace, configureSpaceStorage } from './lib/spaceStorage';
import { restoreSpaceViewAtBoot } from './lib/spaceViewState';
import { applyColdNavigationIntent, beginNavWindow, consumeScopeReload, pendingScopeReloadScope, stageRemoteSpaceBoot } from './lib/navScope';
import { setWebAccessBootstrap, takeAccessCode } from './lib/webAccess';
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
/**
 * Redeem a web entry link, if this page was opened with one.
 *
 * The exchange is same-origin and cookie-based: the code is spent once and the
 * server answers with an HttpOnly session cookie, so no secret survives in
 * JavaScript. A browser that arrives without a link skips this entirely and
 * the app boots exactly as it always has.
 */
async function redeemWebAccessLink(): Promise<void> {
  const { KikiClient } = await import('./lib/client');
  const outcome = takeAccessCode(window.location);
  if (outcome.kind !== 'code') {
    if (outcome.kind === 'rejected') setWebAccessBootstrap({ kind: 'failed', reason: 'retargeted' });
    return;
  }
  try {
    // Same-origin: an empty baseUrl makes the transport resolve against this
    // page, and an empty token means no Authorization header is sent at all —
    // the browser authenticates with the cookie it is about to receive.
    const client = new KikiClient({ baseUrl: '', token: '' });
    try {
      const result = await client.klient.rest!.webAccess.exchange({ code: outcome.code });
      setWebAccessBootstrap(result.authenticated ? { kind: 'signed-in' } : { kind: 'failed', reason: 'rejected' });
    } finally {
      void client.klient.close();
    }
  } catch (error) {
    setWebAccessBootstrap({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
  }
}

async function start(): Promise<void> {
  // A `#access=<one-time code>` link is taken out of the address bar before
  // anything else runs, and redeemed before the app graph loads. Nothing else
  // in boot can observe the code: it is cleared first, held in module memory
  // for the one exchange below, and never written anywhere.
  void await redeemWebAccessLink();
  // Dev-only palette comparison (`?tokens=a|b|c|p923`). Read before the
  // connection module loads, since it scrubs the deep-link query; a
  // production build drops this branch and the stylesheet with it.
  if (import.meta.env.DEV) {
    const { startTokenPreview } = await import('./dev/tokenPreview');
    startTokenPreview();
  }
  await initializeSpaceStorage(hostAdapter);
  const intent = await hostAdapter.takeNavigationIntent?.().catch(() => null);
  const remoteBoot = intent !== undefined && intent !== null && 'connectionId' in intent && stageRemoteSpaceBoot(intent.connectionId);
  const pendingScope = pendingScopeReloadScope();
  if (pendingScope !== null && pendingScope.homeId === pendingScope.scopeId && /^remote:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pendingScope.scopeId)) {
    configureSpaceStorage({ homeId: pendingScope.scopeId });
  }
  const homeId = activeSpace()?.homeId ?? 'main';
  const controlled = consumeScopeReload(homeId);
  const reloading = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload';
  beginNavWindow(controlled, reloading);
  const explicit = remoteBoot || (intent !== undefined && intent !== null && 'route' in intent && applyColdNavigationIntent(intent, homeId));
  const connectionDeepLink = new URLSearchParams(window.location.search).has('server') || new URLSearchParams(window.location.search).has('url');
  if (!controlled && !explicit && !connectionDeepLink) restoreSpaceViewAtBoot(hostAdapter);
  const [
    { App },
    { AppErrorBoundary },
    { I18nProvider },
    { ConnectionProvider },
    { startThemeSync },
    { startSkinSync },
    { NavScopeBoundary },
  ] = await Promise.all([
    import('./App'),
    import('./components/AppErrorBoundary'),
    import('./i18n'),
    import('./state/connection'),
    import('./lib/theme'),
    import('./lib/skins'),
    import('./components/NavScopeBoundary'),
  ]);

  // Before the first render: the palette must be right on the first frame, or a
  // dark-theme user gets a paper-white flash on every launch.
  startThemeSync(hostAdapter);
  // The skin rides on top of the resolved theme and follows it from here on.
  startSkinSync();

  // ConnectionProvider consumes/scrubs deep-link credentials before mounting
  // its children. Create history afterwards so that scrub cannot erase the
  // initial router idx, which React Router needs to roll back a blocked POP.
  // Keep one instance across StrictMode's repeated renders and reconnection.
  let router: ReturnType<typeof createBrowserRouter> | undefined;
  function ConnectedRouter() {
    router ??= createBrowserRouter([
      { path: '*', element: <AppErrorBoundary><NavScopeBoundary><App /></NavScopeBoundary></AppErrorBoundary> },
    ]);
    return <RouterProvider router={router} />;
  }
  createRoot(document.querySelector('#root')!).render(
    <StrictMode>
      <HostProvider>
        <I18nProvider>
          <ConnectionProvider>
            <ConnectedRouter />
          </ConnectionProvider>
        </I18nProvider>
      </HostProvider>
    </StrictMode>,
  );
}

void start();