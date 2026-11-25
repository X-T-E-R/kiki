import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import { HostProvider } from './host';
import { resolveHostAdapter } from './host/resolveHost';
import { installAppShellCredentialListener } from './lib/appShell';
import { installDocumentVisibilityMotionGuard } from './lib/motion';
import { initializeSpaceStorage, activeSpace } from './lib/spaceStorage';
import { placeHrefForSpaceKey } from './lib/placeRoutes';
import { restoreSpaceViewAtBoot } from './lib/spaceViewState';
import { adoptWindowModeFromHost } from './lib/workModeStartup';
import { applyColdNavigationIntent, beginNavWindow, consumeScopeReload, pendingScopeReloadScope } from './lib/navScope';
import { writeLayoutPreferences } from '@kiki/session-core/settings/layoutPrefs';
import { setWebAccessBootstrap, takeAccessCode } from './lib/webAccess';
import { prefetchDeepLinkMeta } from './lib/bootMetaPrefetch';
import { shouldUseMobileShell } from './mobile/mobileShellRoute';
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
  const outcome = takeAccessCode(window.location);
  if (outcome.kind !== 'code') {
    if (outcome.kind === 'rejected') setWebAccessBootstrap({ kind: 'failed', reason: 'retargeted' });
    return;
  }
  try {
    // Loaded only when there is a code to redeem: an ordinary boot must not
    // wait on the client module before it may start fetching the app graph.
    const { KikiClient } = await import('./lib/client');
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
  // Start `/api/meta`, `/api/sessions/:id`, and the klient WS session-view
  // bootstrap immediately in parallel with JS bundle loading on deep links.
  prefetchDeepLinkMeta();
  // On plain browser hosts (no Tauri multi-space WebView switch and no pending
  // `#access=` exchange), kick off the shell, connection, and locale chunks
  // immediately so network download overlaps host/storage setup.
  const isPlainWebBoot = typeof window !== 'undefined'
    && !('__TAURI_INTERNALS__' in window)
    && !('__KIKI_VSCODE__' in window)
    && !window.location.hash.includes('access=');
  if (isPlainWebBoot) {
    const earlyMobileShell = shouldUseMobileShell();
    let earlyLocale: string | null = null;
    try {
      earlyLocale = localStorage.getItem('kiki.locale');
    } catch {
      earlyLocale = null;
    }
    const earlyZh = earlyLocale === 'zh'
      || (earlyLocale !== 'en' && typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language ?? ''));
    void import('./ShellEntry').catch(() => undefined);
    void import('./state/connection').catch(() => undefined);
    void import('./i18n').catch(() => undefined);
    void (earlyMobileShell ? import('./mobile/MobileAppShell') : import('./App')).catch(() => undefined);
    void (earlyZh ? import('@kiki/session-core/i18n/zh') : import('@kiki/session-core/i18n/en')).catch(() => undefined);
  }
  // A `#access=<one-time code>` link is taken out of the address bar before
  // anything else runs, and redeemed before the app graph loads. Nothing else
  // in boot can observe the code: it is cleared first, held in module memory
  // for the one exchange below, and never written anywhere.
  await redeemWebAccessLink();
  installAppShellCredentialListener();
  // Dev-only palette comparison (`?tokens=a|b|c|p923`). Read before the
  // connection module loads, since it scrubs the deep-link query; a
  // production build drops this branch and the stylesheet with it.
  if (import.meta.env.DEV) {
    const { startTokenPreview } = await import('./dev/tokenPreview');
    startTokenPreview();
  }
  const hostAdapter = await resolveHostAdapter();
  await initializeSpaceStorage(hostAdapter);
  const intent = await hostAdapter.takeNavigationIntent?.().catch(() => null);
  const pendingScope = pendingScopeReloadScope();
  const pendingRemoteId =
    pendingScope !== null && /^remote:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pendingScope.scopeId)
      ? pendingScope.scopeId.slice('remote:'.length)
      : null;
  const intentRemoteId =
    intent !== undefined && intent !== null && 'connectionId' in intent && typeof intent.connectionId === 'string'
      ? intent.connectionId
      : null;
  const normalizedRemoteId = intentRemoteId ?? pendingRemoteId;
  let remoteBoot = false;
  if (normalizedRemoteId !== null) {
    // Recover gracefully from any legacy `remote:<id>` reload handoff or remote
    // window launch: stay anchored on the local Kiki home and route in-place
    // via `/p/<connectionId>/...` with the sidebar focused on that computer.
    if (pendingRemoteId !== null) consumeScopeReload(`remote:${pendingRemoteId}`);
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const baseRoute = /^\/(?:s|rooms|r)\//.test(window.location.pathname) ? currentPath : '/new';
    const targetRoute = placeHrefForSpaceKey(`remote:${normalizedRemoteId}`, baseRoute);
    window.history.replaceState(null, '', targetRoute);
    writeLayoutPreferences({ spaceScope: `remote:${normalizedRemoteId}` });
    remoteBoot = true;
  }
  const homeId = activeSpace()?.homeId ?? 'main';
  // The mode this window was launched in must be known before the first route
  // is chosen: it decides which window slot the route belongs to, and a
  // `--preset work` window must not restore the Kiki window's view.
  await adoptWindowModeFromHost(hostAdapter, homeId);
  const controlled = consumeScopeReload(homeId);
  const reloading = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload';
  beginNavWindow(controlled, reloading);
  const explicit = remoteBoot || (intent !== undefined && intent !== null && 'route' in intent && applyColdNavigationIntent(intent, homeId));
  const connectionDeepLink = new URLSearchParams(window.location.search).has('server') || new URLSearchParams(window.location.search).has('url');
  if (!controlled && !explicit && !connectionDeepLink) restoreSpaceViewAtBoot(hostAdapter);
  // Preload the active shell and active locale dictionary in the same parallel
  // wave as ShellEntry/i18n to eliminate serial RTT hops on mobile cold open.
  const mobileShell = shouldUseMobileShell();
  let preferredLocale: string | null = null;
  try {
    preferredLocale = localStorage.getItem('kiki.locale');
  } catch {
    preferredLocale = null;
  }
  const bootZh = preferredLocale === 'zh'
    || (preferredLocale !== 'en' && typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language ?? ''));
  const [
    { ShellEntry },
    { AppErrorBoundary },
    { I18nProvider },
    { ConnectionProvider },
    { startThemeSync },
    { startSkinSync },
    { startZoomSync },
    { NavScopeBoundary },
  ] = await Promise.all([
    import('./ShellEntry').then((mod) => {
      void mod.preloadActiveShell();
      return mod;
    }),
    import('./components/AppErrorBoundary'),
    import('./i18n').then(async (mod) => {
      await mod.ensureInitialLocaleLoaded();
      return mod;
    }),
    import('./state/connection'),
    import('./lib/theme'),
    import('./lib/skins'),
    import('./lib/uiZoom'),
    import('./components/NavScopeBoundary'),
    (mobileShell ? import('./mobile/MobileAppShell') : import('./App')).catch(() => undefined),
    (bootZh ? import('@kiki/session-core/i18n/zh') : import('@kiki/session-core/i18n/en')).catch(() => undefined),
  ]);

  // Before the first render: the palette must be right on the first frame, or a
  // dark-theme user gets a paper-white flash on every launch.
  startThemeSync(hostAdapter);
  // The skin rides on top of the resolved theme and follows it from here on.
  startSkinSync();
  // Apply device interface zoom (native WebView zoom on desktop, CSS root zoom on web).
  startZoomSync(hostAdapter);
  installDocumentVisibilityMotionGuard();

  // ConnectionProvider consumes/scrubs deep-link credentials before mounting
  // its children. Create history afterwards so that scrub cannot erase the
  // initial router idx, which React Router needs to roll back a blocked POP.
  // Keep one instance across StrictMode's repeated renders and reconnection.
  let router: ReturnType<typeof createBrowserRouter> | undefined;
  function ConnectedRouter() {
    router ??= createBrowserRouter([
      { path: '*', element: <AppErrorBoundary><NavScopeBoundary><ShellEntry /></NavScopeBoundary></AppErrorBoundary> },
    ]);
    return <RouterProvider router={router} />;
  }
  createRoot(document.querySelector('#root')!).render(
    <StrictMode>
      <HostProvider host={hostAdapter}>
        <I18nProvider>
          <ConnectionProvider>
            <ConnectedRouter />
          </ConnectionProvider>
        </I18nProvider>
      </HostProvider>
    </StrictMode>,
  );
}

const PRELOAD_RELOAD_KEY = 'kiki.vite-preload-reloaded';

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  try {
    if (sessionStorage.getItem(PRELOAD_RELOAD_KEY) === '1') return;
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, '1');
  } catch {
    return;
  }
  window.location.reload();
});

function renderBootFailure(error: unknown): void {
  const root = document.querySelector('#root');
  if (!(root instanceof HTMLElement)) return;
  const detail = error instanceof Error ? error.message : String(error);
  const zh = (navigator.language || '').toLowerCase().startsWith('zh');
  const title = zh ? '页面加载失败' : 'Failed to load';
  const reloadLabel = zh ? '重新加载' : 'Reload';
  root.replaceChildren();
  const wrapper = document.createElement('main');
  wrapper.setAttribute('role', 'alert');
  wrapper.style.cssText = "min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:'Instrument Sans Variable','Segoe UI','PingFang SC','Microsoft YaHei UI','Microsoft YaHei','Noto Sans SC','Hiragino Sans GB',sans-serif;font-synthesis:none;";
  const card = document.createElement('div');
  card.style.cssText = 'max-width:420px;width:100%;display:flex;flex-direction:column;gap:12px;';
  const heading = document.createElement('h1');
  heading.textContent = title;
  heading.style.cssText = 'margin:0;font-size:18px;line-height:26px;font-weight:700;';
  const msg = document.createElement('p');
  msg.textContent = detail;
  msg.style.cssText = 'margin:0;font-size:13px;line-height:20px;color:#4b453e;word-break:break-word;';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = reloadLabel;
  button.style.cssText = 'align-self:flex-start;padding:7px 14px;border-radius:6px;border:1px solid currentColor;background:transparent;cursor:pointer;font-size:13px;line-height:20px;';
  button.addEventListener('click', () => { window.location.reload(); });
  card.append(heading, msg, button);
  wrapper.append(card);
  root.append(wrapper);
}

void start()
  .then(() => {
    try { sessionStorage.removeItem(PRELOAD_RELOAD_KEY); } catch { /* ignore */ }
  })
  .catch((error: unknown) => {
    renderBootFailure(error);
  });