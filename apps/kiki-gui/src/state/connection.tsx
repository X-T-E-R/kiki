/**
 * Connection context — owns the REST client + the single shared WebSocket for
 * a (server URL, token) pair.
 *
 * Config sources, in priority order:
 *   1. the Tauri-owned desktop backend (memory-only credentials)
 *   2. deep link `?server=&token=` query params (`?url=` is also honored, but
 *      Vite's dev server 403s document requests carrying a `url` query key —
 *      its asset-import convention — so `server` is the dev-safe alias; `url`
 *      still works when the build is served by a plain static host)
 *   3. `#token=` URL fragment (token-only handoff; URL stays as-is)
 *   4. localStorage `kiki.connection` from a previous explicit connect
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
import { translate, type I18nKey, type I18nParams } from '../i18n/locale';
import { useI18n } from '../i18n';
import { ApiError, KikiClient } from '../lib/client';
import { detectLocalConnection, isDesktopRuntime } from '../lib/localServer';
import { KikiSocket, type WsStatus } from '../lib/ws';
import {
  readDeepLinkConfig,
  readStoredConfig,
  selectInitialConnection,
  type ConnectionConfig,
  type ConnectionSelection,
} from './connectionConfig';
import type { SessionController } from './sessionController';

export type { ConnectionConfig } from './connectionConfig';

const STORAGE_KEY = 'kiki.connection';

/**
 * Connect-screen error: client-authored text carries a dictionary key so it
 * re-renders in the active locale; server/envelope text passes through raw.
 */
type ConnectError =
  | { readonly kind: 'key'; readonly key: I18nKey; readonly params?: I18nParams }
  | { readonly kind: 'raw'; readonly text: string };

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
  const desktopRuntime = isDesktopRuntime();
  const { locale } = useI18n();
  const [selection, setSelection] = useState<ConnectionSelection | null>(() =>
    desktopRuntime
      ? null
      : selectInitialConnection({
          deepLink: readDeepLinkConfig(),
          stored: readStoredConfig(),
        }),
  );
  const config = selection?.config ?? null;
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [connectError, setConnectError] = useState<ConnectError | null>(null);
  const [desktopBooting, setDesktopBooting] = useState(desktopRuntime);
  const [wsStatus, setWsStatus] = useState<WsStatus>('closed');
  const controllersRef = useRef(new Set<SessionController>());

  // The desktop shell owns its backend. Resolve that connection before
  // considering browser handoffs or persisted remote connections, and keep
  // the bearer token in React memory only.
  useEffect(() => {
    if (!desktopRuntime) return;
    let cancelled = false;
    void detectLocalConnection().then(
      (connection) => {
        if (cancelled) return;
        setDesktopBooting(false);
        if (connection === null) {
          setConnectError({ kind: 'key', key: 'conn.desktopNoServer' });
          return;
        }
        setSelection({
          config: connection.config,
          persist: false,
          source: 'desktop',
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        setDesktopBooting(false);
        setConnectError({
          kind: 'key',
          key: 'conn.desktopStartFailed',
          params: { detail: error instanceof Error ? error.message : String(error) },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [desktopRuntime]);

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
        if (selection?.persist === true) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        }
        scrubUrl();
      },
      (error: unknown) => {
        if (cancelled) return;
        setMeta(null);
        setConnectError({
          kind: 'raw',
          text:
            error instanceof ApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, config, selection?.persist]);

  // One socket per connection; frames route to registered session controllers.
  const socket = useMemo(() => {
    if (config === null || meta === null) return null;
    return new KikiSocket({
      baseUrl: config.url.trim().replace(/\/+$/, ''),
      token: config.token.trim(),
      events: {
        onStatus: (status) => {
          // A drop mid-turn loses volatile deltas permanently (they are never
          // journaled or replayed); controllers mark themselves for resync.
          if (status !== 'open') {
            for (const controller of controllersRef.current) controller.handleWsDrop();
          }
          setWsStatus(status);
        },
        onFrame: (frame) => {
          for (const controller of controllersRef.current) controller.handleFrame(frame);
        },
        onResyncRequired: (payload) => {
          for (const controller of controllersRef.current) {
            controller.handleResyncRequired(payload);
          }
        },
        onSubscribeAck: (accepted, resyncRequired, cursors, reconnected) => {
          for (const controller of controllersRef.current) {
            if (!accepted.includes(controller.sessionId)) continue;
            if (reconnected) controller.handleReconnectAck();
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
    setSelection(null);
    setConnectError(null);
  }, []);

  const connect = useCallback((next: ConnectionConfig, persist = true) => {
    setConnectError(null);
    setMeta(null);
    setSelection({
      config: next,
      persist,
      source: persist ? 'manual' : 'local-detection',
    });
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
          connecting={desktopBooting || (config !== null && connectError === null)}
          error={
            connectError === null
              ? null
              : connectError.kind === 'key'
                ? translate(locale, connectError.key, connectError.params)
                : connectError.text
          }
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
