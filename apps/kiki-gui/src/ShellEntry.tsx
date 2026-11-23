import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';

import { shouldUseMobileShell } from './mobile/mobileShellRoute';

let mobileShellPromise: Promise<{ default: (typeof import('./mobile/MobileAppShell'))['MobileAppShell'] }> | undefined;
let desktopAppPromise: Promise<{ default: (typeof import('./App'))['App'] }> | undefined;

function loadMobileShell() {
  mobileShellPromise ??= import('./mobile/MobileAppShell').then((mod) => ({ default: mod.MobileAppShell }));
  return mobileShellPromise;
}

function loadDesktopApp() {
  desktopAppPromise ??= import('./App').then((mod) => ({ default: mod.App }));
  return desktopAppPromise;
}

export function preloadActiveShell(
  location: Pick<Location, 'pathname' | 'search'> = window.location,
): Promise<unknown> {
  return shouldUseMobileShell(location) ? loadMobileShell() : loadDesktopApp();
}

const MobileAppShell = lazy(loadMobileShell);
const DesktopApp = lazy(loadDesktopApp);

/**
 * Route-level code-split entry. `/m/*` and mobile app-shell visits load ONLY
 * `MobileAppShell` without ever downloading or parsing the desktop monoliths
 * (`App.tsx`, `SessionView.tsx`, `Transcript.tsx`, `Composer.tsx`, `Sidebar.tsx`,
 * `RightRail`, `TerminalManager`, `xterm`, `mermaid`, `katex`).
 */
export function ShellEntry() {
  const location = useLocation();
  const useMobile = shouldUseMobileShell(location);

  return (
    <Suspense fallback={<div className="min-h-dvh w-full bg-paper" aria-busy="true" />}>
      {useMobile ? <MobileAppShell /> : <DesktopApp />}
    </Suspense>
  );
}
