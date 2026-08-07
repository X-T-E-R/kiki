/**
 * Connection context — owns the REST client + the single shared WebSocket for
 * a (server URL, token) pair.
 *
 * Config sources, in priority order:
 *   1. deep link `?server=&token=` query params (`?url=` is also honored, but
 *      Vite's dev server 403s document requests carrying a `url` query key —
 *      its asset-import convention — so `server` is the dev-safe alias; `url`
 *      still works when the build is served by a plain static host)
 *   2. `#token=` URL fragment (token-only handoff; URL stays as-is)
 *   3. localStorage `kiki.connection` from a previous explicit connect
 * Manual connects persist to localStorage; deep links do too (they are an
 * explicit handoff). `disconnect()` clears storage and returns to the connect
 * screen.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { MetaResponse } from '@moonshot-ai/protocol';

import { ConnectScreen } from '../components/ConnectScreen';
import { ApiError, KikiClient } from '../lib/client';
import { KikiSocket, type WsStatus } from '../lib/ws';
import type { SessionController } from './sessionController';

export interface ConnectionConfig {
  /** Server base URL; '' means same-origin (the Vite dev proxy). */
  readonly url: string;
  readonly token: string;
}

const STORAGE_KEY = 'kiki.connection';

export function readDeepLinkConfig(): ConnectionConfig | null {
  const params = new URLSearchParams(window.location.search);
  const qUrl = params.get('server') ?? params.get('url');
  const qToken = params.get('token');
  if (qUrl !== null || qToken !== null) {
    return { url: qUrl ?? '', token: qToken ?? '' };
  }
  const hash = window.location.hash;
  const match = /(?:^|#|&)token=([^&]+)/.exec(hash);
  if (match !== null) {
    return { url: '', token: decodeURIComponent(match[1] ?? '') };
  }
  return null;
}

function readStoredConfig(): ConnectionConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>;
    if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return null;
    return { url: parsed.url, token: parsed.token };
  } catch {
    return null;
  }
}

/** Strip credentials from the address bar once they have been consumed. */
function scrubUrl(): void {
  if (window.location.hash !== '' || window.location.search !== '') {
    window.history.replaceState(null, '', window.location.pathname);
  }
}

interface ConnectionValue {
  readonly config: ConnectionConfig;
  readonly client: KikiClient;
  readonly socket: KikiSocket;
  readonly meta: MetaResponse;
  readonly wsStatus: WsStatus;
  readonly disconnect: () => void;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConnectionConfig | null>(() => {
    const deepLink = readDeepLinkConfig();
    if (deepLink !== null) return deepLink;
    return readStoredConfig();
  });
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('closed');
  const controllersRef = useRef(new Set<SessionController>());

  const client = useMemo(
    () =>
      config === null
        ? null
        : new KikiClient({
            baseUrl: config.url.trim().replace(/\/+$/, ''),
            token: config.token.trim(),
          }),
    [config],
  );

  // Validate the config against /meta before entering the app.
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    setConnectError(null);
    client.meta().then(
      (value) => {
        if (cancelled) return;
        setMeta(value);
        // Deep-link / stored credentials verified — keep them for next launch.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        scrubUrl();
      },
      (error: unknown) => {
        if (cancelled) return;
        setMeta(null);
        setConnectError(
          error instanceof ApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, config]);

  // One socket per connection; frames route to registered session controllers.
  const socket = useMemo(() => {
    if (config === null || meta === null) return null;
    return new KikiSocket({
      baseUrl: config.url.trim().replace(/\/+$/, ''),
      token: config.token.trim(),
      events: {
        onStatus: (status) => setWsStatus(status),
        onFrame: (frame) => {
          for (const controller of controllersRef.current) controller.handleFrame(frame);
        },
        onResyncRequired: (payload) => {
          for (const controller of controllersRef.current) {
            controller.handleResyncRequired(payload);
          }
        },
        onSubscribeAck: (accepted, resyncRequired, cursors) => {
          for (const controller of controllersRef.current) {
            if (!accepted.includes(controller.sessionId)) continue;
            const offered = cursors?.[controller.sessionId];
            // Identity change: the journal epoch the server reports no longer
            // matches ours — rebuild from a fresh snapshot and resubscribe
            // (the ack's seq watermark itself is never adopted: replayed
            // frames advance our cursor, so adopting a newer seq here could
            // skip unapplied events after a later reconnect).
            const localEpoch = controller.getState().cursor.epoch;
            const epochChanged =
              offered?.epoch !== undefined &&
              localEpoch !== undefined &&
              offered.epoch !== localEpoch;
            if (resyncRequired.includes(controller.sessionId) || epochChanged) {
              void controller.resync();
            }
          }
        },
      },
    });
  }, [config, meta]);

  useEffect(() => {
    if (socket === null) return;
    socket.connect();
    return () => socket.close();
  }, [socket]);

  // Wake signals (liveagent's foreground-nudge pattern): on network recovery,
  // tab focus, pageshow, and visibility restore, nudge the socket — it
  // reconnects immediately when down and leaves a healthy stream untouched.
  useEffect(() => {
    if (socket === null) return;
    const nudge = () => {
      if (document.visibilityState === 'hidden') return;
      socket.nudge();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') socket.nudge();
    };
    window.addEventListener('online', nudge);
    window.addEventListener('focus', nudge);
    window.addEventListener('pageshow', nudge);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', nudge);
      window.removeEventListener('focus', nudge);
      window.removeEventListener('pageshow', nudge);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [socket]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setMeta(null);
    setConfig(null);
    setConnectError(null);
  }, []);

  const connect = useCallback((next: ConnectionConfig) => {
    setConnectError(null);
    setMeta(null);
    setConfig(next);
  }, []);

  const value = useMemo<ConnectionValue | null>(() => {
    if (config === null || client === null || socket === null || meta === null) return null;
    return { config, client, socket, meta, wsStatus, disconnect };
  }, [config, client, socket, meta, wsStatus, disconnect]);

  return (
    <ConnectionContext.Provider value={value}>
      {value !== null ? (
        <ControllerRegistryContext.Provider value={controllersRef.current}>
          {children}
        </ControllerRegistryContext.Provider>
      ) : (
        <ConnectScreen
          initial={config ?? { url: '', token: '' }}
          connecting={config !== null && connectError === null}
          error={connectError}
          onConnect={connect}
          onBack={config !== null ? disconnect : undefined}
        />
      )}
    </ConnectionContext.Provider>
  );
}

const ControllerRegistryContext = createContext<Set<SessionController> | null>(null);

export function useControllerRegistry(): Set<SessionController> {
  const value = useContext(ControllerRegistryContext);
  if (value === null) throw new Error('useControllerRegistry outside provider');
  return value;
}

export function useConnection(): ConnectionValue {
  const value = useContext(ConnectionContext);
  if (value === null) throw new Error('useConnection used before connecting');
  return value;
}
