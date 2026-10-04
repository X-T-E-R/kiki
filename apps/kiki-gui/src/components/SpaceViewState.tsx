import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Navigate, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { readLastSessionId, writeLastSessionId } from '@kiki/session-core/settings';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { createBotRoomApi } from '../lib/botRooms';
import { API_CODES, ApiError, isSessionNotFoundMessage } from '../lib/client';
import { markSpaceViewRoute, writeSpaceViewRoute } from '../lib/spaceViewState';
import { useConnection } from '../state/connection';

export function SpaceViewMemory() {
  const { scopeId } = useConnection();
  const host = useHost();
  const location = useLocation();
  const idRoute = /^\/(?:s|rooms|r)\//.test(location.pathname);
  const route = `${location.pathname}${location.search}${location.hash}`;
  useEffect(() => {
    if (host.kind !== 'tauri' || idRoute) return;
    writeSpaceViewRoute(route, scopeId);
    markSpaceViewRoute(route);
  }, [route, scopeId, host.kind, idRoute]);
  return null;
}

/** Check id-bearing routes before their controllers or task queries mount. */
export function SpaceViewState({ children }: { readonly children: ReactNode }) {
  const { client, scopeId } = useConnection();
  const host = useHost();
  const { t } = useI18n();
  const location = useLocation();
  const sessionMatch = useMatch('/s/:id/*');
  const roomMatch = useMatch('/rooms/:id');
  const roomLinkMatch = useMatch('/r/:id');
  const sessionId = sessionMatch?.params.id;
  const roomId = roomMatch?.params.id ?? roomLinkMatch?.params.id;
  const targetId = sessionId ?? roomId;
  const route = `${location.pathname}${location.search}${location.hash}`;
  const queryClient = useQueryClient();
  const queryKey = ['space-view-target', scopeId, sessionId === undefined ? 'room' : 'session', targetId];
  const targetKey = JSON.stringify(queryKey);
  const admittedTarget = useRef<{ queryClient: QueryClient; key: string } | null>(null);
  const createdSession = (location.state as { createdSession?: { id?: string; scopeId?: string } } | null)?.createdSession;
  const createdHere = sessionId !== undefined && createdSession?.id === sessionId && createdSession.scopeId === scopeId;
  const target = useQuery({
    queryKey,
    enabled: targetId !== undefined,
    retry: false,
    queryFn: async () => {
      if (sessionId !== undefined) {
        try {
          await client.getSession(sessionId);
          return true;
        } catch (error) {
          if ((error instanceof ApiError && error.code === API_CODES.SESSION_NOT_FOUND) ||
            (error instanceof Error && isSessionNotFoundMessage(error.message))) return false;
          throw error;
        }
      }
      return (await createBotRoomApi(client).getRoom(roomId ?? '')) !== undefined;
    },
  });
  // Only this visit's creation result or an already admitted target can keep
  // its controller mounted during revalidation; an old cache entry cannot.
  const confirmed = target.data === true && (createdHere ||
    (admittedTarget.current?.queryClient === queryClient && admittedTarget.current.key === targetKey));
  const checking = targetId !== undefined && (target.isPending || (target.isFetching && !confirmed));
  const missing = !checking && targetId !== undefined && target.data === false;
  const navigate = useNavigate();
  useLayoutEffect(() => {
    admittedTarget.current = !checking && target.data === true ? { queryClient, key: targetKey } : null;
    if (!createdHere || checking || missing) return;
    // Consume only the creation fact, including empty/failed-load handoffs.
    // The initial prompt/skill still belongs to SessionView's existing flow.
    const nextState = { ...(location.state as Record<string, unknown>) };
    delete nextState['createdSession'];
    void navigate(route, { replace: true, state: nextState });
  }, [queryClient, targetKey, checking, target.data, createdHere, missing, location.state, navigate, route]);

  useEffect(() => {
    if (missing && sessionId !== undefined && readLastSessionId() === sessionId) writeLastSessionId(undefined);
    if (host.kind !== 'tauri' || checking || missing || (targetId !== undefined && target.isError)) return;
    writeSpaceViewRoute(route, scopeId);
    markSpaceViewRoute(route);
  }, [checking, missing, targetId, target.isError, sessionId, route, scopeId, host.kind]);

  if (missing) return <Navigate to="/new" replace />;
  if (checking) return <div className="p-8 text-[12.5px] text-ink-faint">{t('sidebar.loadingSessions')}</div>;
  return children;
}
