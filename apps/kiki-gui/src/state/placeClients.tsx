/**
 * PlaceClientsProvider & PlaceClientProvider — unified pooled remote-computer
 * client/QueryClient registry and in-place conversation scope override.
 *
 * Under the Two-Tier architecture, the window's root ConnectionProvider stays
 * permanently anchored to its local Kiki space. Paired remote computers
 * (`/p/:connectionId/...`) mount their center conversation / new-session / room
 * canvas and Right Inspector Rail inside `<PlaceClientProvider>`, while the
 * Left Sidebar and Settings stay bound to the local home.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';

import type { TerminalConnectionStatus as WsStatus } from '@kiki/klient';
import type { MetaResponse, RemoteConnection } from '@kiki/protocol';
import { settingsServerSnapshot, settingsSnapshot, subscribeSettings } from '@kiki/session-core/settings';

import { useI18n } from '../i18n';
import { createRemoteSpaceClient, type KikiClient } from '../lib/client';
import {
  ConnectionScope,
  refreshSessionAttention,
  useConnection,
  useOptionalControllerRegistry,
  type ConnectionValue,
} from './connection';

export interface PooledPlaceEntry {
  readonly connectionId: string;
  readonly generationKey: string;
  readonly client: KikiClient;
  readonly queryClient: QueryClient;
  meta: MetaResponse | null;
  metaPromise: Promise<MetaResponse> | null;
}

export interface PlaceClientPoolValue {
  readonly getOrCreateEntry: (connectionId: string) => PooledPlaceEntry | null;
  readonly getOrCreateClient: (connectionId: string) => KikiClient | null;
  readonly revoke: (connectionId: string) => void;
  readonly retainOnly: (activeIds: ReadonlySet<string>) => void;
  readonly subscribeMutation: (listener: (connectionId: string, sessionId: string) => void) => () => void;
}

export const PlaceClientPoolContext = createContext<PlaceClientPoolValue | null>(null);

export function useOptionalPlaceClientPool(): PlaceClientPoolValue | null {
  return useContext(PlaceClientPoolContext);
}

export function PlaceClientsProvider({ children }: { readonly children: ReactNode }) {
  const { client, localClient, config } = useConnection();
  const controllerRegistry = useOptionalControllerRegistry();
  const controllerRegistryRef = useRef(controllerRegistry);
  controllerRegistryRef.current = controllerRegistry;
  const localSettings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  );
  const requestTimeoutMs = localSettings.requestTimeoutSeconds * 1000;
  const controlClient = localClient ?? client;
  const controlBaseUrl = controlClient.baseUrl ?? config.url;
  const controlToken = config.token;

  const poolRef = useRef(new Map<string, PooledPlaceEntry>());
  const mutationListenersRef = useRef(new Set<(connectionId: string, sessionId: string) => void>());

  const disposeEntry = useCallback((entry: PooledPlaceEntry) => {
    controllerRegistryRef.current?.evictScope?.(entry.client);
    entry.queryClient.clear();
    entry.queryClient.unmount();
    void entry.client.dispose?.().catch?.(() => undefined);
  }, []);

  const revoke = useCallback((connectionId: string) => {
    const existing = poolRef.current.get(connectionId);
    if (existing === undefined) return;
    poolRef.current.delete(connectionId);
    disposeEntry(existing);
  }, [disposeEntry]);

  const retainOnly = useCallback((activeIds: ReadonlySet<string>) => {
    for (const [id, entry] of Array.from(poolRef.current.entries())) {
      if (!activeIds.has(id)) {
        poolRef.current.delete(id);
        disposeEntry(entry);
      }
    }
  }, [disposeEntry]);

  // Drop stale entries if the control server endpoint/token changes.
  useEffect(() => {
    const expectedPrefix = `${controlBaseUrl}|${controlToken}|`;
    for (const [id, entry] of Array.from(poolRef.current.entries())) {
      if (!entry.generationKey.startsWith(expectedPrefix)) {
        poolRef.current.delete(id);
        disposeEntry(entry);
      }
    }
  }, [controlBaseUrl, controlToken, disposeEntry]);

  // Clean up all pooled clients when the provider unmounts.
  useEffect(() => {
    const pool = poolRef.current;
    return () => {
      for (const entry of pool.values()) {
        disposeEntry(entry);
      }
      pool.clear();
    };
  }, [disposeEntry]);

  const getOrCreateEntry = useCallback((connectionId: string): PooledPlaceEntry | null => {
    if (connectionId.trim() === '') return null;
    const generationKey = `${controlBaseUrl}|${controlToken}|${connectionId}`;
    const existing = poolRef.current.get(connectionId);
    if (existing !== undefined && existing.generationKey === generationKey) {
      return existing;
    }
    if (existing !== undefined) {
      poolRef.current.delete(connectionId);
      disposeEntry(existing);
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, staleTime: 0, refetchOnWindowFocus: false } },
    });
    const remoteClient = createRemoteSpaceClient({
      endpoint: controlBaseUrl,
      token: controlToken,
      connectionId,
      timeoutMs: requestTimeoutMs,
      onSessionMutation: (sessionId) => {
        refreshSessionAttention(queryClient, sessionId);
        for (const listener of mutationListenersRef.current) {
          listener(connectionId, sessionId);
        }
      },
    });
    const created: PooledPlaceEntry = {
      connectionId,
      generationKey,
      client: remoteClient,
      queryClient,
      meta: null,
      metaPromise: null,
    };
    poolRef.current.set(connectionId, created);
    return created;
  }, [controlBaseUrl, controlToken, requestTimeoutMs, disposeEntry]);

  const getOrCreateClient = useCallback((connectionId: string): KikiClient | null => {
    return getOrCreateEntry(connectionId)?.client ?? null;
  }, [getOrCreateEntry]);

  const subscribeMutation = useCallback((listener: (connectionId: string, sessionId: string) => void) => {
    mutationListenersRef.current.add(listener);
    return () => {
      mutationListenersRef.current.delete(listener);
    };
  }, []);

  const value = useMemo<PlaceClientPoolValue>(() => ({
    getOrCreateEntry,
    getOrCreateClient,
    revoke,
    retainOnly,
    subscribeMutation,
  }), [getOrCreateEntry, getOrCreateClient, revoke, retainOnly, subscribeMutation]);

  return (
    <PlaceClientPoolContext.Provider value={value}>
      {children}
    </PlaceClientPoolContext.Provider>
  );
}

export interface PlaceClientProviderProps {
  readonly connectionId: string | undefined;
  readonly remoteConnections?: readonly RemoteConnection[];
  readonly remoteLoaded?: boolean;
  readonly children: ReactNode;
}

export function PlaceClientProvider({
  connectionId,
  remoteConnections,
  remoteLoaded = false,
  children,
}: PlaceClientProviderProps) {
  const rootConn = useConnection();
  const pool = useOptionalPlaceClientPool();
  const { t } = useI18n();

  const record = useMemo(
    () => (connectionId === undefined ? undefined : remoteConnections?.find((r) => r.id === connectionId)),
    [connectionId, remoteConnections],
  );
  const unpaired = connectionId !== undefined && remoteLoaded && record === undefined;

  const entry = useMemo(
    () => (connectionId === undefined || unpaired || pool === null ? null : pool.getOrCreateEntry(connectionId)),
    [connectionId, unpaired, pool],
  );

  const [metaState, setMetaState] = useState<{
    readonly connectionId: string | undefined;
    readonly meta: MetaResponse | null;
    readonly error: string | null;
  }>(() => ({
    connectionId,
    meta: entry?.meta ?? null,
    error: null,
  }));
  const [attempt, setAttempt] = useState(0);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [wsBannerSuppressed, setWsBannerSuppressed] = useState(true);

  const expectedHomeId = record?.target.homeId;
  const localServerHomeId = rootConn.meta.server_home_id;

  useEffect(() => {
    if (entry === null || connectionId === undefined) return;
    let cancelled = false;

    if (entry.meta !== null) {
      if (
        (localServerHomeId !== undefined && entry.meta.server_home_id === localServerHomeId) ||
        (expectedHomeId !== undefined && entry.meta.server_home_id !== expectedHomeId)
      ) {
        setMetaState({ connectionId, meta: null, error: t('sidebar.space.fail.identityChanged') });
        return;
      }
      setMetaState({ connectionId, meta: entry.meta, error: null });
      return;
    }

    setMetaState({ connectionId, meta: null, error: null });
    const promise = entry.metaPromise ?? entry.client.meta();
    entry.metaPromise = promise;
    void promise.then(
      (remoteMeta) => {
        if (entry.metaPromise === promise) entry.metaPromise = null;
        if (
          (localServerHomeId !== undefined && remoteMeta.server_home_id === localServerHomeId) ||
          (expectedHomeId !== undefined && remoteMeta.server_home_id !== expectedHomeId)
        ) {
          if (!cancelled) {
            setMetaState({ connectionId, meta: null, error: t('sidebar.space.fail.identityChanged') });
          }
          return;
        }
        entry.meta = remoteMeta;
        if (!cancelled) {
          setMetaState({ connectionId, meta: remoteMeta, error: null });
        }
      },
      (err: unknown) => {
        if (entry.metaPromise === promise) entry.metaPromise = null;
        if (!cancelled) {
          setMetaState({
            connectionId,
            meta: null,
            error: err instanceof Error && err.message !== '' ? err.message : t('sidebar.space.fail.unreachable'),
          });
        }
      },
    );

    return () => { cancelled = true; };
  }, [entry, connectionId, expectedHomeId, localServerHomeId, attempt, t]);

  // Bind live WS status for the open remote conversation only while mounted.
  useEffect(() => {
    if (entry === null) return;
    setWsStatus('connecting');
    setWsBannerSuppressed(true);
    const graceTimer = setTimeout(() => { setWsBannerSuppressed(false); }, 1800);
    const terminal = entry.client.klient.terminal;
    const unsubscribe = terminal.onStatus((status) => {
      setWsStatus(status);
      if (status === 'open') setWsBannerSuppressed(false);
    });
    terminal.nudge();
    return () => {
      clearTimeout(graceTimer);
      unsubscribe();
    };
  }, [entry]);

  const resolvedMeta =
    connectionId !== undefined && metaState.connectionId === connectionId
      ? (metaState.meta ?? entry?.meta ?? null)
      : (entry?.meta ?? null);
  const resolvedError =
    connectionId !== undefined && metaState.connectionId === connectionId ? metaState.error : null;

  const placeScopeKey = connectionId === undefined ? rootConn.scopeId : `remote:${connectionId}`;

  const placeConnectionValue = useMemo<ConnectionValue | null>(() => {
    if (connectionId === undefined || entry === null || resolvedMeta === null) return null;
    return {
      ...rootConn,
      connectionId,
      connectionSource: 'remote',
      spaceKey: placeScopeKey,
      scopeId: placeScopeKey,
      localSpaceKey: rootConn.localSpaceKey ?? rootConn.spaceKey,
      localScopeId: rootConn.localScopeId ?? rootConn.scopeId,
      localServerHomeId: rootConn.localServerHomeId ?? rootConn.meta.server_home_id,
      connectionRef: connectionId,
      sshLabel: null,
      client: entry.client,
      localClient: rootConn.localClient ?? rootConn.client,
      klient: entry.client.klient,
      socket: entry.client.klient.terminal,
      meta: resolvedMeta,
      wsStatus,
      wsBannerSuppressed,
      nudge: () => { entry.client.klient.terminal.nudge(); },
    };
  }, [connectionId, entry, resolvedMeta, rootConn, placeScopeKey, wsStatus, wsBannerSuppressed]);

  if (connectionId === undefined) return <>{children}</>;
  if (unpaired) return <Navigate to="/new" replace />;

  if (resolvedError !== null) {
    const targetName = record?.label ?? t('sidebar.space.fail.unreachable');
    return (
      <div
        role="alert"
        data-place-error={connectionId}
        className="m-6 flex max-w-md flex-col gap-3 rounded-xl border border-hairline bg-panel p-5 text-[13px] text-ink"
      >
        <p className="font-medium text-ink">{targetName}</p>
        <p className="text-[12.5px] text-ink-soft">{resolvedError}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-place-retry
            onClick={() => {
              if (entry !== null) entry.meta = null;
              setAttempt((n) => n + 1);
            }}
            className="rounded-lg border border-hairline-strong px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-paper"
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (entry === null || placeConnectionValue === null) {
    return (
      <div data-place-loading={connectionId} className="p-8 text-[12.5px] text-ink-faint">
        {t('sidebar.loadingSessions')}
      </div>
    );
  }

  return (
    <ConnectionScope value={placeConnectionValue}>
      <QueryClientProvider key={placeScopeKey} client={entry.queryClient}>
        {children}
      </QueryClientProvider>
    </ConnectionScope>
  );
}
