import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';

import { shouldUseMobileShell } from './mobile/mobileShellRoute';

const MobileAppShell = lazy(() =>
  import('./mobile/MobileAppShell').then((mod) => ({ default: mod.MobileAppShell })),
);
const DesktopApp = lazy(() =>
  import('./App').then((mod) => ({ default: mod.App })),
);

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
