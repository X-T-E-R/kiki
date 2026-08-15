/**
 * App shell — route-aware three-column layout.
 *
 * Routes:
 *   /                → redirect to last session or /new
 *   /new             → full-page draft conversation
 *   /s/:id           → live session view
 *   /settings/:section? → settings panel
 *
 * Global overlays: Ctrl+N / the sidebar button open the NewSessionDialog from
 * any route, Ctrl+K opens the QuickSwitcher, Ctrl+Tab jumps to the most recent
 * other session, and Ctrl+/ (or a bare `?`) opens the shortcuts panel. Ctrl+N
 * and Ctrl+Tab are browser-reserved and register only in the desktop runtime.
 * `document.title` follows the active route; toasts mount at the root.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
} from 'react-router-dom';

import { NewSessionDialog } from './components/NewSessionDialog';
import { NewSessionPage } from './components/NewSessionPage';
import { CapabilitiesPage } from './components/capabilities/CapabilitiesPage';
import { QuickSwitcher } from './components/QuickSwitcher';
import { RestartBanner } from './components/RestartBanner';
import { SessionRouteView } from './components/SessionView';
import { SettingsPage } from './components/SettingsPage';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toasts';
import { UsagePage } from './components/UsagePage';
import {
  isDesktopRuntime,
  onTrayNewSession,
  readNativeDesktopPrefs,
  writeNativeDesktopPrefs,
} from './lib/desktop';
import { dedupeSessions, mergeSessionFirstPage, type SessionListData } from './lib/sessionList';
import { readLastSessionId, writeDesktopPrefs } from './lib/settings';
import { anyOverlayOpen } from './lib/uiBusy';
import { resolveWindowTitle, type WindowRoute } from './lib/windowTitle';
import { useI18n } from './i18n';
import { useConnection } from './state/connection';

function RootRedirect() {
  const lastSessionId = useMemo(() => readLastSessionId(), []);
  return <Navigate to={lastSessionId !== undefined ? `/s/${lastSessionId}` : '/new'} replace />;
}

/**
 * True while focus sits in a text input surface. Global navigation shortcuts
 * that would yank focus away (Ctrl+Tab session hopping) must yield to it;
 * deliberate app shortcuts (Ctrl+K, Ctrl+, …) stay active by design.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLInputElement === 'undefined') return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function App() {
  const { client, socket, wsStatus } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const desktop = isDesktopRuntime();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Sync native desktop prefs into localStorage on boot; listen for tray
  // "New Session" events.
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void readNativeDesktopPrefs().then((prefs) => {
      if (prefs !== null) writeDesktopPrefs(prefs);
    });
    return onTrayNewSession(() => void navigate('/new'));
  }, [navigate]);

  // Keep the native side (tray menu labels) on the active UI locale.
  useEffect(() => {
    void writeNativeDesktopPrefs({ locale });
  }, [locale]);

  const sessionMatch = useMatch('/s/:id/*');
  const activeSessionId = sessionMatch?.params.id;
  const isNewRoute = useMatch('/new') !== null;
  const isSettingsRoute = useMatch('/settings/*') !== null;
  const isUsageRoute = useMatch('/usage') !== null;
  const isCapabilitiesRoute = useMatch('/capabilities') !== null;

  const sessionsQuery = useInfiniteQuery({
    queryKey: ['sessions', showArchived],
    queryFn: ({ pageParam }) =>
      client.listSessions({
        page_size: 100,
        include_archive: showArchived || undefined,
        before_id: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.items.at(-1)?.id : undefined,
    initialPageParam: undefined as string | undefined,
  });
  // Poll only the first page (where every change lands). Interval-refetching
  // an infinite query refetches ALL loaded pages on every tick; older pages
  // instead refresh on demand (load-more) or on invalidation.
  const queryClient = useQueryClient();
  useEffect(() => {
    const timer = setInterval(() => {
      void client
        .listSessions({ page_size: 100, include_archive: showArchived || undefined })
        .then((first) => {
          queryClient.setQueryData(['sessions', showArchived], (old: SessionListData | undefined) =>
            mergeSessionFirstPage(old, first),
          );
        })
        .catch(() => undefined);
    }, 5000);
    return () => { clearInterval(timer); };
  }, [client, queryClient, showArchived]);
  const sessions = useMemo(() => dedupeSessions(sessionsQuery.data), [sessionsQuery.data]);

  // document.title follows the route: session title, page name, or bare Kiki.
  useEffect(() => {
    const route: WindowRoute =
      activeSessionId !== undefined
        ? { kind: 'session', sessionId: activeSessionId }
        : isNewRoute
          ? { kind: 'new' }
          : isSettingsRoute
            ? { kind: 'settings' }
            : isUsageRoute
              ? { kind: 'usage' }
              : isCapabilitiesRoute
                ? { kind: 'capabilities' }
                : { kind: 'other' };
    document.title = resolveWindowTitle(route, sessions, {
      untitled: t('sidebar.untitled'),
      newSession: t('new.title'),
      settings: t('st.title'),
      usage: t('usage.title'),
      capabilities: t('cap.title'),
    });
  }, [activeSessionId, isNewRoute, isSettingsRoute, isUsageRoute, isCapabilitiesRoute, sessions, t]);

  // ⌘N / Ctrl+N opens the new-session dialog from any route; ⌘K / Ctrl+K
  // toggles the quick switcher; Ctrl+Tab jumps to the most recent other
  // session (the list arrives sorted by updated_at, newest first).
  // ⌘, / Ctrl+, opens settings.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'n' && !event.shiftKey && !event.altKey) {
        // Browsers reserve Ctrl+N (new window) — preventDefault cannot stop
        // it, so the binding stays desktop-only instead of half-firing.
        if (!desktop) return;
        event.preventDefault();
        setQuickSwitcherOpen(false);
        setNewSessionOpen(true);
      } else if (key === 'k' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setNewSessionOpen(false);
        setQuickSwitcherOpen((open) => !open);
      } else if (key === ',' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void navigate('/settings');
      } else if (key === '/' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setNewSessionOpen(false);
        setQuickSwitcherOpen(false);
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [navigate, desktop]);

  // A bare `?` (outside editable targets and other overlays) also opens the
  // shortcuts panel — the discoverability path for keyboard-first users.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (anyOverlayOpen()) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, []);

  // Esc on the settings route returns to the last non-settings page. Editable
  // targets, open dialogs, and the mobile sidebar consume their own Escape
  // first (dialogs stop propagation / the flags below short-circuit us).
  const location = useLocation();
  const lastNonSettingsRef = useRef('/');
  useEffect(() => {
    if (!isSettingsRoute) lastNonSettingsRef.current = `${location.pathname}${location.search}`;
  }, [isSettingsRoute, location]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isSettingsRoute || sidebarOpen || newSessionOpen || quickSwitcherOpen || shortcutsOpen) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void navigate(lastNonSettingsRef.current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [isSettingsRoute, sidebarOpen, newSessionOpen, quickSwitcherOpen, shortcutsOpen, navigate]);

  // Ctrl+Tab jumps to the most recent other session. Browser tab switching
  // owns Ctrl+Tab (preventDefault cannot intercept it), so the binding only
  // registers in the desktop runtime — the shortcuts panel marks it
  // desktop-only. While focus sits in an editable surface the keystroke stays
  // with it: hopping sessions here would silently rip focus from the draft.
  useEffect(() => {
    if (!desktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      const next = sessions.find((session) => session.id !== activeSessionId);
      if (next !== undefined) {
        setQuickSwitcherOpen(false);
        void navigate(`/s/${next.id}`);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [sessions, activeSessionId, navigate, desktop]);

  // Close mobile sidebar on route change.
  useEffect(() => {
    setSidebarOpen(false);
  }, [activeSessionId, isNewRoute, isSettingsRoute, isUsageRoute, isCapabilitiesRoute]);

  // Escape closes the mobile sidebar drawer (the backdrop swallows pointer
  // events, so the key must be handled globally while it is open).
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [sidebarOpen]);

  return (
    <div className="flex h-full overflow-hidden bg-paper">
      <Sidebar
        className={`app-sidebar ${sidebarOpen ? 'open' : ''}`}
        activeSessionId={activeSessionId}
        sessions={sessions}
        sessionsQuery={sessionsQuery}
        showArchived={showArchived}
        onToggleArchived={() => { setShowArchived((value) => !value); }}
        onNewSession={() => { setNewSessionOpen(true); }}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {wsStatus !== 'open' && !isSettingsRoute ? (
          <div className="shrink-0 border-b border-amber-rule/40 bg-amber-card px-4 py-1.5 text-center text-[12px] font-medium text-amber-ink">
            <span>{wsStatus === 'connecting' ? t('app.reconnecting') : t('app.disconnected')}</span>
            {wsStatus === 'closed' ? (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => { socket.nudge(); }}
                  className="rounded-sm border border-amber-ink/40 px-1.5 py-px font-semibold transition-colors hover:bg-amber-ink/10"
                >
                  {t('app.reconnectNow')}
                </button>
                {' · '}
                <span className="font-normal">{t('app.disconnectedSendHint')}</span>
              </>
            ) : null}
          </div>
        ) : null}
        <RestartBanner />
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route
            path="/new"
            element={<NewSessionPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          <Route
            path="/s/:id/*"
            element={
              <SessionRouteView
                sessionId={activeSessionId}
                onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
                sessions={sessions}
              />
            }
          />
          <Route
            path="/settings/:section?"
            element={<SettingsPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          <Route
            path="/usage"
            element={<UsagePage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          <Route
            path="/capabilities"
            element={<CapabilitiesPage onToggleSidebar={() => { setSidebarOpen((value) => !value); }} />}
          />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </div>

      {sidebarOpen ? (
        <div
          role="button"
          tabIndex={-1}
          aria-label={t('app.closeSidebar')}
          className="app-overlay-backdrop md:hidden"
          onClick={() => { setSidebarOpen(false); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSidebarOpen(false);
          }}
        />
      ) : null}

      {newSessionOpen ? <NewSessionDialog onClose={() => { setNewSessionOpen(false); }} /> : null}
      {quickSwitcherOpen ? (
        <QuickSwitcher sessions={sessions} onClose={() => { setQuickSwitcherOpen(false); }} />
      ) : null}
      {shortcutsOpen ? <ShortcutsOverlay onClose={() => { setShortcutsOpen(false); }} /> : null}
      <Toasts />
    </div>
  );
}
