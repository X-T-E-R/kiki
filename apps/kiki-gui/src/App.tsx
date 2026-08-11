/**
 * App shell — route-aware three-column layout.
 *
 * Routes:
 *   /                → redirect to last session or /new
 *   /new             → full-page draft conversation
 *   /s/:id           → live session view
 *   /settings/:section? → settings panel
 */

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  Navigate,
  Route,
  Routes,
  useMatch,
  useNavigate,
} from 'react-router-dom';

import { NewSessionPage } from './components/NewSessionPage';
import { SessionRouteView } from './components/SessionView';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar } from './components/Sidebar';
import {
  isDesktopRuntime,
  onTrayNewSession,
  readNativeDesktopPrefs,
} from './lib/desktop';
import { dedupeSessions, mergeSessionFirstPage, type SessionListData } from './lib/sessionList';
import { readLastSessionId, writeDesktopPrefs } from './lib/settings';
import { useI18n } from './i18n';
import { useConnection } from './state/connection';

function RootRedirect() {
  const lastSessionId = useMemo(() => readLastSessionId(), []);
  return <Navigate to={lastSessionId !== undefined ? `/s/${lastSessionId}` : '/new'} replace />;
}

export function App() {
  const { client, wsStatus } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Sync native desktop prefs into localStorage on boot; listen for tray
  // "New Session" events.
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void readNativeDesktopPrefs().then((prefs) => {
      if (prefs !== null) writeDesktopPrefs(prefs);
    });
    return onTrayNewSession(() => void navigate('/new'));
  }, [navigate]);

  const sessionMatch = useMatch('/s/:id/*');
  const activeSessionId = sessionMatch?.params.id;
  const isNewRoute = useMatch('/new') !== null;
  const isSettingsRoute = useMatch('/settings/*') !== null;

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

  // Close mobile sidebar on route change.
  useEffect(() => {
    setSidebarOpen(false);
  }, [activeSessionId, isNewRoute, isSettingsRoute]);

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
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {wsStatus !== 'open' && !isSettingsRoute ? (
          <div className="shrink-0 border-b border-amber-rule/40 bg-amber-card px-4 py-1.5 text-center text-[12px] font-medium text-amber-ink">
            {wsStatus === 'connecting' ? t('app.reconnecting') : t('app.disconnected')}
          </div>
        ) : null}
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
    </div>
  );
}
